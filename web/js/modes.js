// Mode map: the JavaScript version of vvvflab/modes.py. The numbers must match the Python version;
// tests/test_web_logic.py cross-checks the two against each other.
(function (NS) {
  'use strict';

  const V1_SQUARE = 4 / Math.PI;
  const DEFAULT_LADDER = [27, 21, 15, 9, 3]; // synchronous carrier ratios, odd multiples of 3

  // Generate the default mode map for a device switching limit fMax (see synthesize in the Python version for the rule)
  function synthesize(fMax, o) {
    o = o || {};
    const ladder = o.ladder || DEFAULT_LADDER;
    const asyncRatio = o.asyncRatio === undefined ? 0.65 : o.asyncRatio;
    const fSquare = o.fSquare === undefined ? 60 : o.fSquare;
    const baseRatio = o.baseRatio === undefined ? 0.8 : o.baseRatio;
    const fcAsync = asyncRatio * fMax;
    const fA = fcAsync / ladder[0];
    const segments = [];
    if (fA < fSquare) {
      segments.push({ start: 0, end: fA, kind: 'async', fc: fcAsync, n: 0 });
      let lo = fA;
      for (const n of ladder) {
        const hi = fMax / n;
        if (lo >= fSquare) break;
        segments.push({ start: lo, end: Math.min(hi, fSquare), kind: 'sync', fc: 0, n });
        lo = hi;
      }
      const last = segments[segments.length - 1];
      if (last.end < fSquare) last.end = fSquare;
    } else {
      segments.push({ start: 0, end: fSquare, kind: 'async', fc: fcAsync, n: 0 });
    }
    segments.push({ start: fSquare, end: Infinity, kind: 'square', fc: 0, n: 0 });
    return { segments, fBase: baseRatio * fSquare, fSquare, fMax };
  }

  function segmentAt(map, f1) {
    for (const s of map.segments) if (f1 < s.end) return s;
    return map.segments[map.segments.length - 1];
  }

  // V/f: the fundamental amplitude rises linearly with frequency, reaches full modulation at fBase, then overmodulates up to the 4/π of a square wave
  function v1Target(map, f1) {
    if (f1 <= map.fBase) return f1 / map.fBase;
    if (f1 >= map.fSquare) return V1_SQUARE;
    return 1 + ((V1_SQUARE - 1) * (f1 - map.fBase)) / (map.fSquare - map.fBase);
  }

  // Operating point for fundamental frequency f1: modulation kind, carrier ratio, carrier frequency (square-wave segments use f1, only as a pitch reference)
  function point(map, f1) {
    const s = segmentAt(map, f1);
    const fc = s.kind === 'async' ? s.fc : s.kind === 'sync' ? s.n * f1 : f1;
    return { f1, kind: s.kind, n: s.n, fc, v1: v1Target(map, f1) };
  }

  function label(p) {
    if (p.kind === 'async') return 'Asynchronous';
    if (p.kind === 'sync') return 'Synchronous ' + p.n + ' pulses';
    return 'Single pulse (square wave)';
  }

  // The switching limits of the presets come from Nagoya University lecture notes: Shinkansen series 300 (GTO) 420 Hz, N700 (IGBT) 1.5 kHz
  const PRESETS = { gto: synthesize(420), igbt: synthesize(1500) };
  const PRESET_LABELS = { gto: 'GTO type (limit 420 Hz)', igbt: 'IGBT type (limit 1.5 kHz)' };

  NS.Modes = { synthesize, segmentAt, v1Target, point, label, PRESETS, PRESET_LABELS };
})((window.VVVF3D = window.VVVF3D || {}));
