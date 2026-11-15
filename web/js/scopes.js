// Two scopes and a level meter:
//   spectrogram        reads the audio analyser, one column every 33 ms, each in the colour of the modulation that made it
//   switching waveform  draws the phase-A leg output of the current operating point (reference, triangle carrier, ±1 pulses), so you can see "how many pulses" at a glance
//   level bar          loudness of the sound; it does not move when there is no sound, so you can confirm the sound is really coming out
// Every colour comes from the stylesheet's tokens (js/theme.js).
(function (NS) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const TAU = Math.PI * 2;
  const Theme = NS.Theme;
  const KIND_TOKEN = { async: '--s-async', sync: '--s-sync', wide3: '--s-wide', square: '--s-square' };
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const rgba = (c, a) => 'rgba(' + c.map(Math.round).join(',') + ',' + a + ')';

  // Triangle carrier: input is the phase (in turns), 0 at 0 and rising, range [-1, 1] (same as synth.js)
  function tri(x) {
    x -= Math.floor(x);
    return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
  }

  // ================================================================ Colours
  const ink = { screen: [8, 9, 10], grid: '', carrier: '', ref: '', idle: '', font: '', hue: {}, fill: {} };
  const spec = { g: null, w: 240, h: 0, luts: {}, bins: null, last: 0 };

  // Colour map of the spectrogram: from the screen colour up through one hue to white. One hue only: brightness is the loudness.
  function makeLut(hue) {
    const bg = ink.screen;
    const stops = [
      [0, bg],
      [0.3, mix(bg, hue, 0.2)],
      [0.62, mix(bg, hue, 0.82)],
      [0.86, mix(hue, [255, 255, 255], 0.45)],
      [1, [255, 255, 255]],
    ];
    const lut = new Uint8ClampedArray(256 * 3);
    for (let i = 0; i < 256; i++) {
      const x = i / 255;
      let j = 1;
      while (j < stops.length - 1 && x > stops[j][0]) j++;
      const [x0, c0] = stops[j - 1];
      const [x1, c1] = stops[j];
      const c = mix(c0, c1, clamp((x - x0) / (x1 - x0), 0, 1));
      lut[i * 3] = c[0];
      lut[i * 3 + 1] = c[1];
      lut[i * 3 + 2] = c[2];
    }
    return lut;
  }

  function readTheme() {
    const s = Theme.rgb('--screen');
    const t = Theme.rgb('--screen-ink');
    ink.screen = s;
    ink.grid = rgba(t, 0.07);
    ink.carrier = rgba(t, 0.18);
    ink.ref = rgba(t, 0.6);
    ink.idle = rgba(t, 0.4);
    ink.font = '12px ' + (Theme.css('--font') || 'sans-serif');
    Object.keys(KIND_TOKEN).forEach((k) => {
      const c = Theme.rgb(KIND_TOKEN[k]);
      ink.hue[k] = rgba(c, 1);
      ink.fill[k] = rgba(c, 0.16);
      spec.luts[k] = makeLut(c);
    });
    spec.luts.mono = makeLut(t); // while the inverter is not running
    if (spec.g) {
      spec.h = 0; // repaint: the old columns were drawn with the old colours
      fitSpectro();
    }
  }

  // ================================================================ Spectrogram
  // 240 columns wide (one per 33 ms, about 8 s); as tall as the box on screen, so a taller box shows more frequency detail
  function fitSpectro() {
    const cv = $('spec');
    if (!cv) return false;
    const h = clamp(Math.round(cv.clientHeight * Math.min(window.devicePixelRatio || 1, 2)), 96, 420);
    if (h !== spec.h || cv.width !== spec.w) {
      cv.width = spec.w;
      cv.height = h;
      spec.h = h;
      spec.g = cv.getContext('2d');
      spec.g.fillStyle = rgba(ink.screen, 1);
      spec.g.fillRect(0, 0, spec.w, h);
    }
    return true;
  }
  function drawSpectro(analyser, nowMs, f) {
    if (!analyser || nowMs - spec.last < 33 || !fitSpectro()) return;
    spec.last = nowMs;
    const { g, w, h } = spec;
    const lut = (f && f.run && spec.luts[f.segKind]) || spec.luts.mono; // the column wears the colour of the modulation that is sounding
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
    g.strokeStyle = ink.grid;
    g.beginPath();
    for (const k of [-1, 0, 1]) {
      g.moveTo(0, Math.round(yc - k * amp) + 0.5);
      g.lineTo(w, Math.round(yc - k * amp) + 0.5);
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
      const kind = ink.hue[f.segKind] ? f.segKind : 'async';
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
        g.strokeStyle = ink.carrier;
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
      g.strokeStyle = ink.ref;
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
      g.fillStyle = ink.fill[kind];
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = ink.hue[kind];
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
            ? 'zoomed: 30 carrier periods'
            : Math.round(ratio) + ' carriers per cycle';
    } else {
      g.fillStyle = ink.idle;
      g.font = ink.font;
      g.textAlign = 'center';
      g.fillText('Inverter is not running', w / 2, yc + 4);
    }
    if (cap !== wave.cap) {
      wave.cap = cap;
      const el = $('waveCap');
      if (el) el.textContent = cap;
    }
  }

  function init() {
    readTheme();
    fitSpectro();
    Theme.onChange(readTheme);
  }

  NS.Scopes = { init, drawSpectro, drawLevel, drawWave };
})((window.VVVF3D = window.VVVF3D || {}));
