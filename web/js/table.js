// 模式表：按车速分段，每段指定调制方式。对应参考界面里的“0 – 34.5 km/h 异步 1050 Hz”这一类列表。
// 一张表 = { name, maxSpeed, vBase, vFull, segments: [{ to, kind, fc0, fc1, n }] }
//   to    这一段的速度上限 [km/h]（下限是上一段的上限，第一段从 0 开始，最后一段到 maxSpeed）
//   kind  async 异步 | sync 同步 N 脉冲 | wide3 宽 3 脉冲 | square 单脉冲（方波）
//   fc0/fc1  异步载波在这一段起点、终点的频率 [Hz]（线性变化）；n  同步脉冲数
//   vBase  电压达到满调制（m = 1）的车速；vFull  电压达到最大（方波等效）的车速
(function (NS) {
  'use strict';

  const V1_SQUARE = 4 / Math.PI;
  const M_CAP = 20; // 过调制时参考波幅值的上限，与 Python 版一致
  const MIN_V = 0.08; // 起步时的最小电压（基波幅值）
  const MIN_GAP = 0.5; // 相邻两段速度上限的最小间隔 [km/h]
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  const KINDS = { async: '异步', sync: '同步', wide3: '宽 3 脉冲', square: '单脉冲（方波）' };

  // ---- 过调制：基波幅值 ↔ 参考波幅值（与 vvvflab/pwm.py 对账） ----------------------------
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

  // ---- 低脉冲数的同步调制：反解参考波幅值 ---------------------------------------------------------
  // 载波比很大时，基波幅值就是参考波幅值 m（过调制时用上面的公式换算）。脉冲数少了这个关系不成立：
  // 三脉冲时 m = 0.95 只能给出 0.64 的基波。实际的逆变器会按脉冲数调整开关角度，让输出的基波等于电压指令，
  // 所以这里数值地算出载波锁定在 φ = 0 时的实际基波，再反解 m，让它等于目标 v1。
  // 载波比较高（N > SYNC_CAL_MAX_N）时两者差不到 1%，不必算。
  const SYNC_CAL_MAX_N = 21;
  function tri(x) {
    x -= Math.floor(x);
    return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
  }
  // 采样间隔内输出的平均值（和 synth.js 的 area 一样：开关边沿按交叉点折算，不靠过采样）
  function pulseArea(dp, dc) {
    const sp = dp > 0 ? 1 : -1;
    const sc = dc > 0 ? 1 : -1;
    if (sp === sc) return sp;
    const x = dp / (dp - dc);
    return sp * x + sc * (1 - x);
  }
  // N 个脉冲（奇数）、参考波幅值 m、载波相位 0 时，桥臂输出（±1）的基波幅值。
  // 波形有四分之一周期对称性，只积分 0..π/2。
  function syncFundamental(n, m) {
    const steps = Math.max(240, 24 * n);
    const h = Math.PI / 2 / steps;
    let acc = 0;
    let dPrev = 0; // θ = 0：参考波和载波都是 0
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
      m = M_CAP; // 要的比最大能给的还大：给最大
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

  // ---- 查表 ----------------------------------------------------------------------------------
  function segmentIndex(t, v) {
    for (let i = 0; i < t.segments.length; i++) if (v < t.segments[i].to) return i;
    return t.segments.length - 1;
  }
  function segmentFrom(t, i) {
    return i === 0 ? 0 : t.segments[i - 1].to;
  }

  // V/f：基波幅值先随车速线性上升，到 vBase 满调制，再过调制直到 vFull 达到方波的 4/π
  function v1Target(t, v) {
    if (v <= t.vBase) return Math.max(MIN_V, v / t.vBase);
    if (v >= t.vFull) return V1_SQUARE;
    return 1 + ((V1_SQUARE - 1) * (v - t.vBase)) / (t.vFull - t.vBase);
  }

  // 只算载波频率（画模式标尺时每个车速都要算，不必反解调制比）
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

  // 车速 v、基波频率 f1 对应的逆变器工作点
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
    const hz = (x) => String(Math.round(x * 10) / 10); // 1050 而不是 1050.0
    if (s.kind === 'async') return '异步 : ' + hz(s.fc0) + ' Hz – ' + hz(s.fc1) + ' Hz';
    if (s.kind === 'sync') return '同步 : ' + s.n + ' 脉冲';
    if (s.kind === 'wide3') return '同步 : 宽 3 脉冲';
    return '单脉冲（方波）';
  }

  // ---- 检查与整理 ----------------------------------------------------------------------------
  function validate(t) {
    const out = [];
    if (!t || !Array.isArray(t.segments) || t.segments.length === 0) return ['至少要有一段'];
    if (!(t.maxSpeed >= 20 && t.maxSpeed <= 400)) out.push('最高速度 maxSpeed 须在 20 到 400 km/h 之间');
    let prev = 0;
    t.segments.forEach((s, i) => {
      const tag = '第 ' + (i + 1) + ' 段：';
      if (!KINDS[s.kind]) out.push(tag + '未知的调制方式 ' + s.kind);
      if (!(s.to >= prev + MIN_GAP - 1e-9)) out.push(tag + '速度上限必须比上一段至少大 ' + MIN_GAP + ' km/h');
      if (s.kind === 'async') {
        for (const k of ['fc0', 'fc1']) {
          if (!(s[k] >= 20 && s[k] <= 20000)) out.push(tag + '异步载波须在 20 到 20000 Hz 之间');
        }
      }
      // 只允许奇数：偶数个脉冲会让正、负半周不对称，产生偶次谐波，实际的 VVVF 也从不这样用。
      // 1 个脉冲就是方波，用“单脉冲”这一类。
      if (s.kind === 'sync' && !(Number.isInteger(s.n) && s.n >= 3 && s.n <= 99 && s.n % 2 === 1)) out.push(tag + '同步脉冲数须是 3 到 99 的奇数（偶数会让正负半周不对称；1 个脉冲请选“单脉冲”）');
      prev = s.to;
    });
    if (Math.abs(t.segments[t.segments.length - 1].to - t.maxSpeed) > 1e-6) out.push('最后一段必须延伸到最高速度 ' + t.maxSpeed + ' km/h');
    if (!(t.vBase >= 1 && t.vBase < t.vFull && t.vFull <= t.maxSpeed)) out.push('电压曲线要满足 1 ≤ 满调制车速 < 满电压车速 ≤ 最高速度');
    return out;
  }

  function clone(t) {
    return JSON.parse(JSON.stringify(t));
  }

  // 去掉多余字段，补全缺省值
  function normalize(raw) {
    const t = {
      name: String(raw.name || '未命名'),
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

  // ---- 从按基波频率写的旧模式表（modes.js）转成按车速写的表 ------------------------------------
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

  // ---- 音阶：音名 ↔ 频率，以及“音阶台阶” ----------------------------------------------------------
  // 异步调制时，载波每升一级，听到的音就升一级：在一段速度范围里铺一串载波恒定、从低到高的异步段，
  // 加速时就是“哆来咪”（京急 1000 型 GTO 变频器的起步音）。
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const NOTE_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const NOTE_RE = /^([A-Ga-g])([#♯b♭]?)(-?\d)$/;
  const SCALES = {
    major: { name: '大调（do re mi fa sol la ti do）', steps: [0, 2, 4, 5, 7, 9, 11, 12] },
    minor: { name: '自然小调（la ti do re mi fa sol la）', steps: [0, 2, 3, 5, 7, 8, 10, 12] },
    pentatonic: { name: '五声音阶（do re mi sol la do）', steps: [0, 2, 4, 7, 9, 12] },
    chromatic: { name: '半音阶（13 个音）', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  };

  // "C4"、"F#3"、"Bb4" → MIDI 音号（C4 = 60，A4 = 69）；不是音名就返回 NaN
  function noteToMidi(text) {
    const m = NOTE_RE.exec(String(text).trim());
    if (!m) return NaN;
    const accidental = m[2] === '#' || m[2] === '♯' ? 1 : m[2] ? -1 : 0;
    return 12 * (Number(m[3]) + 1) + NOTE_SEMI[m[1].toUpperCase()] + accidental;
  }
  const midiToFreq = (midi) => 440 * Math.pow(2, (midi - 69) / 12); // 十二平均律，A4 = 440 Hz
  function midiToName(midi) {
    return NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  }
  // 音名（C4、F#3、Bb4）或者直接写频率（523、523.25 Hz）→ 频率 [Hz]；认不出来返回 NaN
  function noteFrequency(text) {
    const midi = noteToMidi(text);
    if (!isNaN(midi)) return midiToFreq(midi);
    const m = /^(\d+(?:\.\d+)?)\s*(?:hz)?$/i.exec(String(text).trim());
    return m ? Number(m[1]) : NaN;
  }
  // 频率 → 最接近的音名，以及偏差（音分，±50 以内）
  function nearestNote(freq) {
    const midi = 69 + 12 * Math.log2(freq / 440);
    const n = Math.round(midi);
    return { name: midiToName(n), cents: Math.round((midi - n) * 100) };
  }
  // 主音 + 音阶 → 音名列表，例如 ("C4", "major") → C4 D4 E4 F4 G4 A4 B4 C5
  function scaleNotes(root, scaleKey) {
    const base = noteToMidi(root);
    const sc = SCALES[scaleKey];
    return isNaN(base) || !sc ? [] : sc.steps.map((s) => midiToName(base + s));
  }

  // 在 [from, to] km/h 里铺一串载波恒定的异步段（freqs 是每一级的载波频率，从前往后），
  // 替换这个范围里原有的段，直接修改 t。范围外的旧段保留；跨过边界的段被截断，
  // 异步斜坡在截断处按线性插值，所以曲线不会跳变。不合理的输入抛出带说明的 Error。
  function staircase(t, from, to, freqs) {
    const r1 = (x) => Math.round(x * 10) / 10;
    const lerp = (a, b, x) => a + (b - a) * x;
    if (!freqs.length) throw new Error('至少要有一个音');
    if (!freqs.every((f) => f >= 20 && f <= 20000)) throw new Error('载波频率须在 20 到 20000 Hz 之间');
    from = r1(from);
    to = r1(to);
    if (!(from >= 0 && to > from && to <= t.maxSpeed)) throw new Error('速度范围要满足 0 ≤ 起点 < 终点 ≤ ' + t.maxSpeed + ' km/h');
    const width = (to - from) / freqs.length;
    const minWidth = MIN_GAP + 0.1; // 边界取整到 0.1，留一点余量，保证相邻分界线至少隔 MIN_GAP
    if (width < minWidth - 1e-9) throw new Error('台阶太窄：每级只有 ' + Math.round(width * 100) / 100 + ' km/h，至少要 ' + minWidth + '。减少音数或加宽速度范围');
    const out = [];
    t.segments.forEach((s, i) => {
      const a = segmentFrom(t, i);
      if (a >= from - 1e-9) return;
      if (from - a < MIN_GAP - 1e-9) throw new Error('起点 ' + from + ' 离前一条分界线 ' + a + ' 太近（不到 ' + MIN_GAP + ' km/h），请把起点挪开一点');
      const seg = Object.assign({}, s, { to: Math.min(s.to, from) });
      if (s.kind === 'async' && s.to > from) seg.fc1 = r1(lerp(s.fc0, s.fc1, (from - a) / (s.to - a)));
      out.push(seg);
    });
    freqs.forEach((fc, k) => out.push({ to: k === freqs.length - 1 ? to : r1(from + width * (k + 1)), kind: 'async', fc0: fc, fc1: fc }));
    t.segments.forEach((s, i) => {
      if (s.to <= to + 1e-9) return;
      if (s.to - to < MIN_GAP - 1e-9) throw new Error('终点 ' + to + ' 离后面的分界线 ' + s.to + ' 太近（不到 ' + MIN_GAP + ' km/h），请把终点挪开一点');
      const a = segmentFrom(t, i);
      const seg = Object.assign({}, s);
      if (s.kind === 'async' && a < to) seg.fc0 = r1(lerp(s.fc0, s.fc1, (to - a) / (s.to - a)));
      out.push(seg);
    });
    t.segments = out;
    return t;
  }

  // ---- 预设 ----------------------------------------------------------------------------------
  // 哆来咪预设：听到的音高从 C4 到 C5，铺在 0–20 km/h（每级 2.5 km/h）；载波取听到音高的一半（原因见 ui 里的说明）
  function scalePreset() {
    const t = {
      name: '音阶式异步（哆来咪：听到的音高 C4–C5）',
      maxSpeed: 160,
      vBase: 38,
      vFull: 100,
      segments: [
        { to: 30, kind: 'sync', n: 15 },
        { to: 42, kind: 'sync', n: 9 },
        { to: 160, kind: 'wide3' },
      ],
    };
    const carriers = scaleNotes('C4', 'major').map((n) => Math.round(noteFrequency(n) * 5) / 10); // 听到的音高 ÷ 2，取到 0.1 Hz
    return staircase(t, 0, 20, carriers);
  }

  function presets() {
    return {
      reference: {
        name: '参考界面示例（异步 1050 Hz → 9 脉冲 → 宽 3 脉冲）',
        maxSpeed: 160,
        vBase: 38,
        vFull: 110,
        segments: [
          { to: 34.5, kind: 'async', fc0: 1050, fc1: 1050 },
          { to: 38, kind: 'sync', n: 9 },
          { to: 160, kind: 'wide3' },
        ],
      },
      gto: fromModeMap(NS.Modes.PRESETS.gto, 'GTO 型（开关频率上限 420 Hz）'),
      igbt: fromModeMap(NS.Modes.PRESETS.igbt, 'IGBT 型（开关频率上限 1.5 kHz）'),
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
