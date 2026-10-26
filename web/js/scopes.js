// 右上角的两块示波器和一条电平表：
//   声谱图    读音频分析器，每 33 ms 画一列
//   开关波形  把当前工作点的 A 相桥臂输出画出来（参考波、三角载波、±1 的脉冲），一眼看出“几个脉冲”
//   电平条    声音的响度，没有声音时一动不动，用来确认声音真的在出
(function (NS) {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const TAU = Math.PI * 2;
  const HUE = { async: '#2dd4bf', sync: '#818cf8', wide3: '#e879f9', square: '#fbbf24' };

  // 三角载波：输入相位（圈），0 处为 0 并上升，值域 [-1, 1]（和 synth.js 一致）
  function tri(x) {
    x -= Math.floor(x);
    return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
  }

  // ================================================================ 声谱图
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
    // 颜色表：黑 → 深蓝 → 青 → 浅青白（和界面主色一致）
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
    g.drawImage(g.canvas, 1, 0, w - 1, h, 0, 0, w - 1, h); // 整体左移一列（自己画到自己，不读回像素）
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

  // ================================================================ 电平条
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

  // ================================================================ 开关波形
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

  // f = { run, kind, segKind, n, fc, f1, m }；kind 是 async | sync | square（同步里的“宽 3 脉冲”是 sync、n = 3）
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
    // 水平参考线：0、±1
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(255,255,255,.06)';
    g.beginPath();
    for (const k of [-1, 0, 1]) {
      g.moveTo(0, yc - k * amp);
      g.lineTo(w, yc - k * amp);
    }
    g.stroke();

    let cap = '逆变器停止';
    if (f.run) {
      const f1 = Math.max(f.f1, 0.01);
      const sync = f.kind === 'sync';
      const square = f.kind === 'square';
      const ratio = square ? 1 : sync ? f.n : f.fc / f1; // 每个基波周期里的载波个数
      // 异步时载波比可能有几百，一个基波周期画不下：只截取 30 个载波周期
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
      // 参考波和载波（淡）
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
      // 开关波形：带淡淡的填充
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
        ? '一个基波周期 · 1 个脉冲'
        : sync
          ? '一个基波周期 · ' + f.n + ' 个脉冲'
          : win < 1
            ? '放大 · 只截取约 30 个载波周期'
            : '一个基波周期 · 载波 ' + Math.round(ratio) + ' 个';
    } else {
      g.fillStyle = 'rgba(255,255,255,.28)';
      g.font = '12px sans-serif';
      g.textAlign = 'center';
      g.fillText('逆变器不工作，没有开关波形', w / 2, yc + 4);
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
