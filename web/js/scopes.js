// Two scopes in the top-right corner and a level meter:
//   spectrogram        reads the audio analyser, one column every 33 ms
//   switching waveform  draws the phase-A leg output of the current operating point (reference, triangle carrier, ±1 pulses), so you can see "how many pulses" at a glance
//   level bar          loudness of the sound; it does not move when there is no sound, so you can confirm the sound is really coming out
(function (NS) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const TAU = Math.PI * 2;
  const HUE = { async: '#2dd4bf', sync: '#818cf8', wide3: '#e879f9', square: '#fbbf24' };

  // Triangle carrier: input is the phase (in turns), 0 at 0 and rising, range [-1, 1] (same as synth.js)
  function tri(x) {
    x -= Math.floor(x);
    return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
  }

  // ================================================================ Spectrogram
  const spec = { g: null, w: 0, h: 0, lut: null, bins: null, last: 0 };
  function initSpectro() {
    const cv = $('spec');
    if (!cv) return;
    cv.width = 240;
    cv.height = 120;
    spec.w = cv.width;
    spec.h = cv.height;
    spec.g = cv.getContext('2d');
    spec.g.fillStyle = '#03060c';
    spec.g.fillRect(0, 0, spec.w, spec.h);
    // Colour map: black → deep blue → cyan → pale cyan-white (matches the main colour of the UI)
    const stops = [
      [0, 3, 6, 12],
      [0.28, 10, 40, 96],
      [0.55, 14, 140, 190],
      [0.8, 120, 230, 230],
      [1, 245, 253, 250],
    ];
    spec.lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      let j = 1;
      while (j < stops.length - 1 && x > stops[j][0]) j++;
      const [x0, r0, g0, b0] = stops[j - 1];
      const [x1, r1, g1, b1] = stops[j];
      const t = clamp((x - x0) / (x1 - x0), 0, 1);
      spec.lut[i * 3] = r0 + (r1 - r0) * t;
      spec.lut[i * 3 + 1] = g0 + (g1 - g0) * t;
      spec.lut[i * 3 + 2] = b0 + (b1 - b0) * t;
    }
  }
  function drawSpectro(analyser, nowMs) {
    if (!analyser || !spec.g || nowMs - spec.last < 33) return;
    spec.last = nowMs;
    const { g, w, h, lut } = spec;
    if (!spec.bins || spec.bins.length !== analyser.frequencyBinCount) spec.bins = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(spec.bins);
    const binHz = analyser.context.sampleRate / analyser.fftSize;
    const maxBin = Math.max(1, Math.floor(4000 / binHz));
    g.drawImage(g.canvas, 1, 0, w - 1, h, 0, 0, w - 1, h); // shift everything left by one column (draw the canvas onto itself, no pixel read-back)
    const col = g.createImageData(1, h);
    for (let y = 0; y < h; y++) {
      const v = spec.bins[Math.min(maxBin, Math.round((1 - y / (h - 1)) * maxBin))];
      col.data[y * 4] = lut[v * 3];
      col.data[y * 4 + 1] = lut[v * 3 + 1];
      col.data[y * 4 + 2] = lut[v * 3 + 2];
      col.data[y * 4 + 3] = 255;
    }
    g.putImageData(col, w - 1, 0);
  }

  // ================================================================ Level bar
  const vu = { buf: null, level: 0, last: 0 };
  function drawLevel(analyser, nowMs) {
    const fill = $('vuFill');
    if (!fill || nowMs - vu.last < 50) return;
    vu.last = nowMs;
    let target = 0;
    if (analyser) {
      if (!vu.buf || vu.buf.length !== analyser.fftSize) vu.buf = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(vu.buf);
      let s = 0;
      for (let i = 0; i < vu.buf.length; i++) s += vu.buf[i] * vu.buf[i];
      const db = 20 * Math.log10(Math.sqrt(s / vu.buf.length) + 1e-9);
      target = clamp((db + 56) / 56, 0, 1);
    }
    vu.level += (target - vu.level) * (target > vu.level ? 0.6 : 0.2);
    fill.style.transform = 'scaleX(' + vu.level.toFixed(3) + ')';
  }

  // ================================================================ Switching waveform
  const wave = { last: 0, cap: '', key: '' };
  function fit(cv) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (!w || !h) return null;
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (cv.width !== pw || cv.height !== ph) {
      cv.width = pw;
      cv.height = ph;
    }
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { g, w, h };
  }

  // f = { run, kind, segKind, n, fc, f1, m }; kind is async | sync | square ("wide 3-pulse" is sync with n = 3)
  function drawWave(f, nowMs) {
    const cv = $('wave');
    if (!cv || nowMs - wave.last < 40) return;
    wave.last = nowMs;
    const box = fit(cv);
    if (!box) return;
    const { g, w, h } = box;
    g.clearRect(0, 0, w, h);
    const yc = h / 2;
    const amp = h / 2 - 8;
    // horizontal reference lines: 0, ±1
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,255,255,.06)';
    g.beginPath();
    for (const k of [-1, 0, 1]) {
      g.moveTo(0, yc - k * amp);
      g.lineTo(w, yc - k * amp);
    }
    g.stroke();

    let cap = 'Inverter stopped';
    if (f.run) {
      const f1 = Math.max(f.f1, 0.01);
      const sync = f.kind === 'sync';
      const square = f.kind === 'square';
      const ratio = square ? 1 : sync ? f.n : f.fc / f1; // carriers per fundamental period
      // With asynchronous modulation the carrier ratio can be in the hundreds and will not fit in one fundamental period: show only 30 carrier periods
      const win = !sync && !square && ratio > 30 ? 30 / ratio : 1;
      const th0 = -Math.PI * win;
      const span = TAU * win;
      const N = Math.min(1600, Math.max(400, Math.round(w * 3)));
      const hue = HUE[f.segKind] || HUE.async;
      const ys = [];
      for (let i = 0; i <= N; i++) {
        const th = th0 + (span * i) / N;
        let p;
        if (square) p = Math.sin(th) + 1e-9 > 0 ? 1 : -1;
        else p = f.m * Math.sin(th) > tri((ratio * th) / TAU) ? 1 : -1;
        ys.push(p);
      }
      // reference and carrier (faint)
      if (!square) {
        g.lineWidth = 1;
        g.strokeStyle = 'rgba(255,255,255,.16)';
        g.beginPath();
        for (let i = 0; i <= N; i++) {
          const th = th0 + (span * i) / N;
          const x = (w * i) / N;
          const y = yc - tri((ratio * th) / TAU) * amp;
          if (i) g.lineTo(x, y);
          else g.moveTo(x, y);
        }
        g.stroke();
      }
      g.strokeStyle = 'rgba(255,255,255,.55)';
      g.setLineDash([3, 3]);
      g.beginPath();
      for (let i = 0; i <= N; i++) {
        const th = th0 + (span * i) / N;
        const x = (w * i) / N;
        const y = yc - clamp(square ? Math.sin(th) : f.m * Math.sin(th), -1.35, 1.35) * amp;
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.stroke();
      g.setLineDash([]);
      // switching waveform: with a faint fill
      g.beginPath();
      g.moveTo(0, yc);
      for (let i = 0; i <= N; i++) {
        const x = (w * i) / N;
        g.lineTo(x, yc - ys[i] * amp);
      }
      g.lineTo(w, yc);
      g.closePath();
      g.fillStyle = hue + '22';
      g.fill();
      g.lineWidth = 1.6;
      g.strokeStyle = hue;
      g.lineJoin = 'round';
      g.beginPath();
      for (let i = 0; i <= N; i++) {
        const x = (w * i) / N;
        const y = yc - ys[i] * amp;
        if (i) g.lineTo(x, y);
        else g.moveTo(x, y);
      }
      g.stroke();
      cap = square
        ? '1 pulse per cycle'
        : sync
          ? f.n + ' pulses per cycle'
          : win < 1
            ? 'zoom: ~30 carrier periods'
            : Math.round(ratio) + ' carriers per cycle';
    } else {
      g.fillStyle = 'rgba(255,255,255,.28)';
      g.font = '12px sans-serif';
      g.textAlign = 'center';
      g.fillText('Inverter is not running, no switching waveform', w / 2, yc + 4);
    }
    if (cap !== wave.cap) {
      wave.cap = cap;
      const el = $('waveCap');
      if (el) el.textContent = cap;
    }
  }

  function init() {
    initSpectro();
  }

  NS.Scopes = { init, drawSpectro, drawLevel, drawWave };
})((window.VVVF3D = window.VVVF3D || {}));
