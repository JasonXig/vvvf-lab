// 在 Node 里跑页面的逻辑层（modes.js、drive.js），把结果以 JSON 打印出来。
// tests/test_web_logic.py 用它和 Python 版对账：两边的模式表与传动数值必须一致。
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = {};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const file of ['js/modes.js', 'js/drive.js', 'js/table.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}
const { Modes, Drive, Table } = sandbox.VVVF3D;

const out = { presets: {}, points: [], drive: [] };
for (const key of Object.keys(Modes.PRESETS)) {
  const map = Modes.PRESETS[key];
  out.presets[key] = {
    fBase: map.fBase,
    fSquare: map.fSquare,
    segments: map.segments.map((s) => ({ start: s.start, end: s.end === Infinity ? 'inf' : s.end, kind: s.kind, fc: s.fc, n: s.n })),
  };
  for (const f1 of [0, 5, 12, 18, 24, 30, 40, 50, 55, 59.9, 60, 100, 156]) {
    const p = Modes.point(map, f1);
    out.points.push({ preset: key, f1, kind: p.kind, n: p.n, fc: p.fc, v1: p.v1 });
  }
}
for (const v of [0, 10, 60, 130]) {
  for (const p of [2, 3]) {
    for (const synchronous of [false, true]) {
      out.drive.push(Object.assign({ v, p, synchronous }, Drive.compute(v, p, synchronous)));
    }
  }
}
// 过调制的基波幅值与参考波幅值换算（和 vvvflab/pwm.py 对账）
out.fund = [0.3, 1, 1.2, 2, 5, 15].map((m) => ({ m, v: Table.fundamentalFromReference(m) }));
out.ref = [0.3, 1, 1.05, 1.1, 1.2, 1.27, 1.2732].map((v) => ({ v, m: Table.referenceForFundamental(v) }));

// 按车速分段的模式表：预设、检查结果、查表
const presets = Table.presets();
out.tables = {};
for (const key of Object.keys(presets)) {
  out.tables[key] = { table: presets[key], problems: Table.validate(presets[key]) };
}
out.tablePoints = [];
for (const v of [0, 10, 34.4, 34.5, 36, 38, 100, 160]) {
  const f1 = Drive.compute(v, 2, false).f1;
  out.tablePoints.push(Object.assign({ v, f1 }, Table.operatingPoint(presets.reference, v, f1)));
}
out.v1 = [0, 1, 20, 38, 60, 110, 160].map((v) => ({ v, v1: Table.v1Target(presets.reference, v) }));

// 低脉冲数同步调制：反解出的参考波幅值（pytest 里用独立的 numpy 数值积分验证实际基波）
out.syncCal = [];
for (const n of [3, 5, 9, 15, 21]) {
  for (const v1 of [0.1, 0.5, 0.95, 1.0, 1.15, 1.25]) {
    out.syncCal.push({ n, v1, m: Table.referenceForSync(n, v1), maxFundamental: Table.syncFundamental(n, Table.M_CAP) });
  }
}
out.invalidTables = {};
{
  const bad = Table.clone(presets.reference);
  bad.segments[1].n = 4;
  out.invalidTables.evenN = Table.validate(bad);
  const good = Table.clone(presets.reference);
  good.segments[1].n = 7;
  out.invalidTables.oddN = Table.validate(good);
}

// 制动（发电状态）与列车动力学
out.brake = [0, 10, 60, 130].map((v) => Object.assign({ v }, Drive.compute(v, 2, false, undefined, true)));
out.dyn = [];
for (const mode of ['power', 'coast', 'brake']) {
  for (const v of [0, 10, 40, 80, 160]) out.dyn.push({ mode, v, next: Drive.stepSpeed(v, mode, 0.1) });
}
// 主手柄：档位表、转差与力矩成正比、各档位的加减速、逆变器什么时候在运转
out.notches = Drive.NOTCHES.map((n) => Object.assign({}, n));
out.notchN = Drive.NOTCH_N;
out.load = [];
for (const load of [0, 0.25, 0.5, 1]) {
  for (const braking of [false, true]) out.load.push(Object.assign({ load, braking }, Drive.compute(100, 2, false, undefined, braking, load)));
}
out.dyn2 = [];
for (const [mode, frac] of [['power', 0.25], ['power', 0.5], ['power', 1], ['brake', 0.2], ['brake', 1], ['hold', 0.1], ['coast', 0]]) {
  for (const v of [10, 80]) out.dyn2.push({ mode, frac, v, next: Drive.stepSpeed(v, mode, 0.1, { frac }) });
}
out.run = [];
for (const mode of ['power', 'coast', 'hold', 'brake']) {
  for (const inv of [true, false]) {
    for (const f1 of [0, 0.3, 0.6, 0.9, 1.5, 50]) {
      const em = Drive.effectiveMode(mode, inv);
      out.run.push(Object.assign({ mode, inv, f1, em }, Drive.inverterRun(em, inv, f1)));
    }
  }
}
out.torque = [['power', 0.5], ['coast', 0.7], ['hold', 0.1], ['brake', 0.8]].map(([mode, frac]) => ({ mode, frac, load: Drive.torqueLoad(mode, frac) }));
out.carrier = [];
for (const key of Object.keys(presets)) {
  for (const v of [0, 3, 12, 30, 36, 45, 100, 160]) {
    const f1 = Drive.compute(v, 2, false).f1;
    out.carrier.push({ preset: key, v, a: Table.carrierAt(presets[key], v, f1), b: Table.operatingPoint(presets[key], v, f1).fc });
  }
}
// 音阶台阶：音名 ↔ 频率、音阶、在一段速度范围里铺一串载波恒定的异步段
out.notes = Object.fromEntries(['A4', 'C4', 'F#3', 'Bb4', 'c5', '523.25 Hz', '440', 'hello', 'H4', ''].map((s) => [s, Table.noteFrequency(s)]));
out.scales = {
  major: Table.scaleNotes('C4', 'major'),
  minor: Table.scaleNotes('A3', 'minor'),
  pentatonic: Table.scaleNotes('C4', 'pentatonic'),
  chromatic: Table.scaleNotes('B3', 'chromatic'),
  bad: Table.scaleNotes('nope', 'major'),
};
out.nearest = [440, 261.63, 523.25, 450].map((f) => Object.assign({ f }, Table.nearestNote(f)));
{
  const majorHz = Table.scaleNotes('C4', 'major').map((n) => Table.noteFrequency(n));
  const t1 = Table.clone(presets.reference);
  Table.staircase(t1, 0, 15, majorHz);
  out.stair1 = { table: t1, problems: Table.validate(t1), freqs: majorHz };

  // 范围在中间、跨过好几段，里面有异步斜坡：范围外的载波曲线必须原样不动
  const t2 = { name: 'ramp', maxSpeed: 160, vBase: 38, vFull: 100, segments: [{ to: 40, kind: 'async', fc0: 100, fc1: 900 }, { to: 80, kind: 'sync', n: 9 }, { to: 160, kind: 'wide3' }] };
  const probe = [0, 3, 9.9, 11, 13, 16, 19, 20.1, 25, 39.9, 41, 60, 100];
  const carriers = (t) => probe.map((v) => ({ v, fc: Table.carrierAt(t, v, 50) }));
  const t2b = Table.clone(t2);
  Table.staircase(t2b, 10, 20, [200, 300, 400, 500]);
  out.stair2 = { table: t2b, problems: Table.validate(t2b), before: carriers(t2), after: carriers(t2b) };

  // 横跨好几段（把 GTO 表的 5–45 km/h 换成台阶），以及一直铺到最高速度
  const t3 = Table.clone(presets.gto);
  Table.staircase(t3, 5, 45, [150, 200, 250, 300, 350, 400, 450, 500]);
  const t4 = Table.clone(presets.reference);
  Table.staircase(t4, 100, 160, [300, 400, 500]);
  out.stair3 = { gto: { table: t3, problems: Table.validate(t3) }, tail: { table: t4, problems: Table.validate(t4) } };

  const attempt = (table, ...args) => {
    try {
      Table.staircase(Table.clone(table), ...args);
      return null;
    } catch (e) {
      return e.message;
    }
  };
  out.stairErrors = {
    empty: attempt(presets.reference, 0, 15, []),
    badFreq: attempt(presets.reference, 0, 15, [100, 5]),
    reversed: attempt(presets.reference, 15, 5, [100, 200]),
    overMax: attempt(presets.reference, 0, 200, [100, 200]),
    tooNarrow: attempt(presets.reference, 0, 3, [100, 200, 300, 400, 500, 600, 700, 800]),
    tooCloseStart: attempt(presets.reference, 34.7, 36, [100, 200]),
    tooCloseEnd: attempt(presets.reference, 10, 34.2, [100, 200]),
  };
  out.scalePreset = presets.scale;
}
console.log(JSON.stringify(out));
