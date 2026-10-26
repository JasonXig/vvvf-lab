// 模式表：vvvflab/modes.py 的 JavaScript 版本。数值必须和 Python 版一致，
// tests/test_web_logic.py 会让两边互相对账。
(function (NS) {
  'use strict';

  const V1_SQUARE = 4 / Math.PI;
  const DEFAULT_LADDER = [27, 21, 15, 9, 3]; // 同步载波比，取 3 的奇数倍

  // 按器件开关上限 fMax 生成默认模式表（规则见 Python 版 synthesize）
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

  // V/f：基波幅值先随频率线性上升，到 fBase 满调制，再过调制直到方波的 4/π
  function v1Target(map, f1) {
    if (f1 <= map.fBase) return f1 / map.fBase;
    if (f1 >= map.fSquare) return V1_SQUARE;
    return 1 + ((V1_SQUARE - 1) * (f1 - map.fBase)) / (map.fSquare - map.fBase);
  }

  // 基波频率 f1 对应的工作点：调制方式、载波比、载波频率（方波段取 f1，仅作音调参考）
  function point(map, f1) {
    const s = segmentAt(map, f1);
    const fc = s.kind === 'async' ? s.fc : s.kind === 'sync' ? s.n * f1 : f1;
    return { f1, kind: s.kind, n: s.n, fc, v1: v1Target(map, f1) };
  }

  function label(p) {
    if (p.kind === 'async') return '异步调制';
    if (p.kind === 'sync') return '同步 ' + p.n + ' 脉冲';
    return '单脉冲（方波）';
  }

  // 预设的开关频率上限取自 Nagoya 大学课件：新干线 300 系（GTO）420 Hz，N700 系（IGBT）1.5 kHz
  const PRESETS = { gto: synthesize(420), igbt: synthesize(1500) };
  const PRESET_LABELS = { gto: 'GTO 型（上限 420 Hz）', igbt: 'IGBT 型（上限 1.5 kHz）' };

  NS.Modes = { synthesize, segmentAt, v1Target, point, label, PRESETS, PRESET_LABELS };
})((window.VVVF3D = window.VVVF3D || {}));
