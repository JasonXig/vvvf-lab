// Mode table: split by vehicle speed, each segment names a modulation kind. Corresponds to lists like "0 – 34.5 km/h  async 1050 Hz" in the reference UI.
// A table = { name, maxSpeed, vBase, vFull, segments: [{ to, kind, fc0, fc1, n }] }
//   to    speed limit of this segment [km/h] (the lower bound is the previous limit; the first segment starts at 0 and the last reaches maxSpeed)
//   kind  async = asynchronous | sync = synchronous N pulses | wide3 = wide 3-pulse | square = single pulse (square wave)
//   fc0/fc1  asynchronous carrier frequency at the start and end of the segment [Hz] (linear in between); n  synchronous pulse count
//   vBase  speed at which the voltage reaches full modulation (m = 1); vFull  speed at which the voltage reaches its maximum (square-wave equivalent)
(function (NS) {
  'use strict';

  const V1_SQUARE = 4 / Math.PI;
  const M_CAP = 20; // upper limit of the reference amplitude in overmodulation, same as the Python version
  const MIN_V = 0.08; // minimum voltage when starting (fundamental amplitude)
  const MIN_GAP = 0.5; // minimum spacing between the speed limits of two adjacent segments [km/h]
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  const KINDS = { async: 'Async', sync: 'Sync', wide3: 'Wide 3-pulse', square: 'Single pulse (square wave)' };

  // ---- Overmodulation: fundamental amplitude ↔ reference amplitude (cross-checked with vvvflab/pwm.py) ----------------
  function fundamentalFromReference(m) {
    if (m <= 1) return Math.max(0, m);
    return (2 / Math.PI) * (m * Math.asin(1 / m) + Math.sqrt(1 - 1 / (m * m)));
  }
  const MG = [];
  const VG = [];
  for (let i = 0; i < 400; i++) MG.push(1 + (2 * i) / 400);
  for (let i = 0; i < 400; i++) MG.push(3 * Math.pow(M_CAP / 3, i / 399));
  for (const m of MG) VG.push(fundamentalFromReference(m));

  function referenceForFundamental(v1) {
    if (v1 <= 1) return Math.max(0, v1);
    if (v1 >= VG[VG.length - 1]) return MG[MG.length - 1];
    let lo = 0;
    let hi = VG.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (VG[mid] <= v1) lo = mid;
      else hi = mid;
    }
    return MG[lo] + ((v1 - VG[lo]) / (VG[hi] - VG[lo])) * (MG[hi] - MG[lo]);
  }

  // ---- Synchronous modulation with few pulses: back-solving the reference amplitude -------------------------------
  // With a large carrier ratio the fundamental amplitude is just the reference amplitude m (use the formula above for overmodulation). That relation fails with few pulses:
  // with 3 pulses m = 0.95 gives a fundamental of only 0.64. A real inverter adjusts the switching angles per pulse count so the output fundamental equals the voltage command,
  // so here the actual fundamental with the carrier locked at φ = 0 is computed numerically and m is back-solved to make it equal the target v1.
  // With a high carrier ratio (N > SYNC_CAL_MAX_N) the two differ by under 1%, so no calculation is needed.
  const SYNC_CAL_MAX_N = 21;
  function tri(x) {
    x -= Math.floor(x);
    return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
  }
  // Average of the output over one sampling interval (same as area in synth.js: switching edges are located at the crossing point, with no oversampling)
  function pulseArea(dp, dc) {
    const sp = dp > 0 ? 1 : -1;
    const sc = dc > 0 ? 1 : -1;
    if (sp === sc) return sp;
    const x = dp / (dp - dc);
    return sp * x + sc * (1 - x);
  }
  // Fundamental amplitude of the leg output (±1) for N pulses (odd), reference amplitude m and carrier phase 0.
  // The waveform has quarter-wave symmetry, so only 0..π/2 is integrated.
  function syncFundamental(n, m) {
    const steps = Math.max(240, 24 * n);
    const h = Math.PI / 2 / steps;
    let acc = 0;
    let dPrev = 0; // θ = 0: the reference and the carrier are both 0
    for (let i = 1; i <= steps; i++) {
      const th = i * h;
      const d = m * Math.sin(th) - tri((n * th) / (2 * Math.PI));
      acc += pulseArea(dPrev, d) * Math.sin(th - h / 2) * h;
      dPrev = d;
    }
    return (4 / Math.PI) * acc;
  }
  const syncCache = new Map();
  function referenceForSync(n, v1) {
    const key = n + ':' + Math.round(v1 * 4000);
    let m = syncCache.get(key);
    if (m !== undefined) return m;
    if (syncFundamental(n, M_CAP) <= v1) {
      m = M_CAP; // asked for more than the maximum available: give the maximum
    } else {
      let lo = 0;
      let hi = M_CAP;
      for (let k = 0; k < 28; k++) {
        const mid = (lo + hi) / 2;
        if (syncFundamental(n, mid) < v1) lo = mid;
        else hi = mid;
      }
      m = (lo + hi) / 2;
    }
    if (syncCache.size > 5000) syncCache.clear();
    syncCache.set(key, m);
    return m;
  }

  // ---- Table lookup -----------------------------------------------------------------------------------------------
  function segmentIndex(t, v) {
    for (let i = 0; i < t.segments.length; i++) if (v < t.segments[i].to) return i;
    return t.segments.length - 1;
  }
  function segmentFrom(t, i) {
    return i === 0 ? 0 : t.segments[i - 1].to;
  }

  // V/f: the fundamental amplitude rises linearly with speed, reaches full modulation at vBase, then overmodulates up to the 4/π of a square wave at vFull
  function v1Target(t, v) {
    if (v <= t.vBase) return Math.max(MIN_V, v / t.vBase);
    if (v >= t.vFull) return V1_SQUARE;
    return 1 + ((V1_SQUARE - 1) * (v - t.vBase)) / (t.vFull - t.vBase);
  }

  // Carrier frequency only (needed at every speed when drawing the mode ruler, no need to back-solve the modulation index)
  function carrierAt(t, v, f1) {
    const i = segmentIndex(t, v);
    const s = t.segments[i];
    if (s.kind === 'square') return f1;
    if (s.kind === 'async') {
      const from = segmentFrom(t, i);
      const x = clamp((v - from) / Math.max(1e-9, s.to - from), 0, 1);
      return s.fc0 + (s.fc1 - s.fc0) * x;
    }
    return (s.kind === 'wide3' ? 3 : s.n) * f1;
  }

  // Inverter operating point for speed v and fundamental frequency f1
  function operatingPoint(t, v, f1) {
    const i = segmentIndex(t, v);
    const s = t.segments[i];
    const v1 = v1Target(t, v);
    if (s.kind === 'square') return { kind: 'square', n: 0, fc: f1, m: M_CAP, v1: V1_SQUARE, seg: i };
    const m = referenceForFundamental(v1);
    if (s.kind === 'async') {
      const from = segmentFrom(t, i);
      const x = clamp((v - from) / Math.max(1e-9, s.to - from), 0, 1);
      return { kind: 'async', n: 0, fc: s.fc0 + (s.fc1 - s.fc0) * x, m, v1, seg: i };
    }
    const n = s.kind === 'wide3' ? 3 : s.n;
    return { kind: 'sync', n, fc: n * f1, m: n <= SYNC_CAL_MAX_N ? referenceForSync(n, v1) : m, v1, seg: i };
  }

  function fmt(x) {
    return (Math.round(x * 10) / 10).toFixed(1);
  }
  function describe(s) {
    const hz = (x) => String(Math.round(x * 10) / 10); // 1050 rather than 1050.0
    if (s.kind === 'async') return 'Async: ' + hz(s.fc0) + ' Hz – ' + hz(s.fc1) + ' Hz';
    if (s.kind === 'sync') return 'Sync: ' + s.n + ' pulses';
    if (s.kind === 'wide3') return 'Sync: wide 3-pulse';
    return 'Single pulse (square wave)';
  }

  // ---- Validation and normalization ------------------------------------------------------------------------------
  function validate(t) {
    const out = [];
    if (!t || !Array.isArray(t.segments) || t.segments.length === 0) return ['At least one segment is required'];
    if (!(t.maxSpeed >= 20 && t.maxSpeed <= 400)) out.push('maxSpeed must be between 20 and 400 km/h');
    let prev = 0;
    t.segments.forEach((s, i) => {
      const tag = 'Segment ' + (i + 1) + ': ';
      if (!KINDS[s.kind]) out.push(tag + 'unknown modulation kind ' + s.kind);
      if (!(s.to >= prev + MIN_GAP - 1e-9)) out.push(tag + 'the speed limit must be at least ' + MIN_GAP + ' km/h above the previous segment');
      if (s.kind === 'async') {
        for (const k of ['fc0', 'fc1']) {
          if (!(s[k] >= 20 && s[k] <= 20000)) out.push(tag + 'the async carrier must be between 20 and 20000 Hz');
        }
      }
      // Only odd counts are allowed: an even number of pulses makes the positive and negative half-cycles asymmetric and produces even harmonics; real VVVF never does that.
      // A single pulse is a square wave: use the "single pulse" kind for it.
      if (s.kind === 'sync' && !(Number.isInteger(s.n) && s.n >= 3 && s.n <= 99 && s.n % 2 === 1)) out.push(tag + 'the synchronous pulse count must be an odd number from 3 to 99 (an even count makes the half-cycles asymmetric; for 1 pulse choose "Single pulse")');
      prev = s.to;
    });
    if (Math.abs(t.segments[t.segments.length - 1].to - t.maxSpeed) > 1e-6) out.push('The last segment must extend to the top speed ' + t.maxSpeed + ' km/h');
    if (!(t.vBase >= 1 && t.vBase < t.vFull && t.vFull <= t.maxSpeed)) out.push('The voltage curve must satisfy 1 ≤ full-modulation speed < full-voltage speed ≤ top speed');
    return out;
  }

  function clone(t) {
    return JSON.parse(JSON.stringify(t));
  }

  // Drop extra fields and fill in defaults
  function normalize(raw) {
    const t = {
      name: String(raw.name || 'Untitled'),
      maxSpeed: Number(raw.maxSpeed || 160),
      vBase: Number(raw.vBase),
      vFull: Number(raw.vFull),
      segments: (raw.segments || []).map((s) => {
        const o = { to: Number(s.to), kind: s.kind };
        if (s.kind === 'async') {
          o.fc0 = Number(s.fc0);
          o.fc1 = Number(s.fc1 === undefined ? s.fc0 : s.fc1);
        }
        if (s.kind === 'sync') o.n = Number(s.n);
        return o;
      }),
    };
    return t;
  }

  // ---- Convert an old mode map written by fundamental frequency (modes.js) into a table written by speed ---------------
  function speedForF1(f1, polePairs, drive) {
    let lo = 0;
    let hi = 400;
    for (let i = 0; i < 60; i++) {
      const mid = (lo + hi) / 2;
      if (NS.Drive.compute(mid, polePairs, false, drive).f1 < f1) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  function fromModeMap(map, name) {
    const maxSpeed = 160;
    const r1 = (x) => Math.round(x * 10) / 10;
    const t = { name, maxSpeed, vBase: r1(speedForF1(map.fBase, 2)), vFull: r1(speedForF1(map.fSquare, 2)), segments: [] };
    map.segments.forEach((s) => {
      if (s.kind === 'square') t.segments.push({ to: maxSpeed, kind: 'square' });
      else {
        const to = Math.min(maxSpeed - MIN_GAP, r1(speedForF1(s.end, 2)));
        if (s.kind === 'async') t.segments.push({ to, kind: 'async', fc0: Math.round(s.fc), fc1: Math.round(s.fc) });
        else if (s.n === 3) t.segments.push({ to, kind: 'wide3' });
        else t.segments.push({ to, kind: 'sync', n: s.n });
      }
    });
    return t;
  }

  // ---- Scales: note names ↔ frequencies, and the "scale staircase" ---------------------------------------------------
  // With asynchronous modulation, every step up in carrier is a step up in the pitch you hear: lay a run of asynchronous segments with constant, rising carriers over a speed range,
  // and accelerating plays "do re mi" (the start-up sound of the Keikyu 1000 series GTO inverter).
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const NOTE_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const NOTE_RE = /^([A-Ga-g])([#♯b♭]?)(-?\d)$/;
  const SCALES = {
    major: { name: 'Major (do re mi fa sol la ti do)', steps: [0, 2, 4, 5, 7, 9, 11, 12] },
    minor: { name: 'Natural minor (la ti do re mi fa sol la)', steps: [0, 2, 3, 5, 7, 8, 10, 12] },
    pentatonic: { name: 'Major pentatonic (do re mi sol la do)', steps: [0, 2, 4, 7, 9, 12] },
    chromatic: { name: 'Chromatic (13 notes)', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  };

  // "C4", "F#3", "Bb4" → MIDI note number (C4 = 60, A4 = 69); NaN if it is not a note name
  function noteToMidi(text) {
    const m = NOTE_RE.exec(String(text).trim());
    if (!m) return NaN;
    const accidental = m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0;
    return 12 * (Number(m[3]) + 1) + NOTE_SEMI[m[1].toUpperCase()] + accidental;
  }
  const midiToFreq = (midi) => 440 * Math.pow(2, (midi - 69) / 12); // twelve-tone equal temperament, A4 = 440 Hz
  function midiToName(midi) {
    return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  }
  // Note name (C4, F#3, Bb4) or a plain frequency (523, 523.25 Hz) → frequency [Hz]; NaN if not recognized
  function noteFrequency(text) {
    const midi = noteToMidi(text);
    if (!isNaN(midi)) return midiToFreq(midi);
    const m = /^(\d+(?:\.\d+)?)\s*(?:hz)?$/i.exec(String(text).trim());
    return m ? Number(m[1]) : NaN;
  }
  // Frequency → nearest note name, and the deviation (cents, within ±50)
  function nearestNote(freq) {
    const midi = 69 + 12 * Math.log2(freq / 440);
    const n = Math.round(midi);
    return { name: midiToName(n), cents: Math.round((midi - n) * 100) };
  }
  // Root + scale → list of note names, e.g. ("C4", "major") → C4 D4 E4 F4 G4 A4 B4 C5
  function scaleNotes(root, scaleKey) {
    const base = noteToMidi(root);
    const sc = SCALES[scaleKey];
    return isNaN(base) || !sc ? [] : sc.steps.map((s) => midiToName(base + s));
  }

  // Lay a run of asynchronous segments with constant carriers over [from, to] km/h (freqs is the carrier of each step, in order),
  // replacing the existing segments in that range; modifies t in place. Old segments outside the range are kept; a segment crossing the boundary is truncated,
  // and an asynchronous ramp is linearly interpolated at the cut, so the curve does not jump. Unreasonable input throws an Error with an explanation.
  function staircase(t, from, to, freqs) {
    const r1 = (x) => Math.round(x * 10) / 10;
    const lerp = (a, b, x) => a + (b - a) * x;
    if (!freqs.length) throw new Error('At least one note is required');
    if (!freqs.every((f) => f >= 20 && f <= 20000)) throw new Error('Carrier frequency must be between 20 and 20000 Hz');
    from = r1(from);
    to = r1(to);
    if (!(from >= 0 && to > from && to <= t.maxSpeed)) throw new Error('Speed range must satisfy 0 ≤ start < end ≤ ' + t.maxSpeed + ' km/h');
    const width = (to - from) / freqs.length;
    const minWidth = MIN_GAP + 0.1; // boundaries are rounded to 0.1, so leave a little margin to keep adjacent boundaries at least MIN_GAP apart
    if (width < minWidth - 1e-9) throw new Error('Steps too narrow: each step is only ' + Math.round(width * 100) / 100 + ' km/h, at least ' + minWidth + ' is needed. Use fewer notes or a wider speed range');
    const out = [];
    t.segments.forEach((s, i) => {
      const a = segmentFrom(t, i);
      if (a >= from - 1e-9) return;
      if (from - a < MIN_GAP - 1e-9) throw new Error('The start ' + from + ' is too close to the previous boundary ' + a + ' (less than ' + MIN_GAP + ' km/h); move the start a little');
      const seg = Object.assign({}, s, { to: Math.min(s.to, from) });
      if (s.kind === 'async' && s.to > from) seg.fc1 = r1(lerp(s.fc0, s.fc1, (from - a) / (s.to - a)));
      out.push(seg);
    });
    freqs.forEach((fc, k) => out.push({ to: k === freqs.length - 1 ? to : r1(from + width * (k + 1)), kind: 'async', fc0: fc, fc1: fc }));
    t.segments.forEach((s, i) => {
      if (s.to <= to + 1e-9) return;
      if (s.to - to < MIN_GAP - 1e-9) throw new Error('The end ' + to + ' is too close to the next boundary ' + s.to + ' (less than ' + MIN_GAP + ' km/h); move the end a little');
      const a = segmentFrom(t, i);
      const seg = Object.assign({}, s);
      if (s.kind === 'async' && a < to) seg.fc0 = r1(lerp(s.fc0, s.fc1, (to - a) / (s.to - a)));
      out.push(seg);
    });
    t.segments = out;
    return t;
  }

  // ---- Presets -----------------------------------------------------------------------------------------------------
  // The do-re-mi preset: heard pitch from C4 to C5, laid over 0–20 km/h (2.5 km/h per step); the carrier is half the heard pitch (see the explanation in the UI)
  function scalePreset() {
    const t = {
      name: 'Scale-style async (do re mi: heard pitch C4–C5)',
      maxSpeed: 160,
      vBase: 38,
      vFull: 100,
      segments: [
        { to: 30, kind: 'sync', n: 15 },
        { to: 42, kind: 'sync', n: 9 },
        { to: 160, kind: 'wide3' },
      ],
    };
    const carriers = scaleNotes('C4', 'major').map((n) => Math.round(noteFrequency(n) * 5) / 10); // heard pitch ÷ 2, rounded to 0.1 Hz
    return staircase(t, 0, 20, carriers);
  }

  function presets() {
    return {
      reference: {
        name: 'Reference example (async 1050 Hz → 9 pulses → wide 3-pulse)',
        maxSpeed: 160,
        vBase: 38,
        vFull: 110,
        segments: [
          { to: 34.5, kind: 'async', fc0: 1050, fc1: 1050 },
          { to: 38, kind: 'sync', n: 9 },
          { to: 160, kind: 'wide3' },
        ],
      },
      gto: fromModeMap(NS.Modes.PRESETS.gto, 'GTO type (switching limit 420 Hz)'),
      igbt: fromModeMap(NS.Modes.PRESETS.igbt, 'IGBT type (switching limit 1.5 kHz)'),
      scale: scalePreset(),
    };
  }

  NS.Table = {
    KINDS,
    V1_SQUARE,
    M_CAP,
    MIN_GAP,
    fundamentalFromReference,
    referenceForFundamental,
    syncFundamental,
    referenceForSync,
    SYNC_CAL_MAX_N,
    segmentIndex,
    segmentFrom,
    v1Target,
    carrierAt,
    operatingPoint,
    describe,
    validate,
    clone,
    normalize,
    speedForF1,
    fromModeMap,
    SCALES,
    noteFrequency,
    nearestNote,
    scaleNotes,
    staircase,
    presets,
  };
})((window.VVVF3D = window.VVVF3D || {}));
