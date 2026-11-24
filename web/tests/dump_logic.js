// Run the logic layer of the page (modes.js, drive.js, table.js) in Node and print the results as JSON.
// tests/test_web_logic.py uses it to cross-check against the Python version: the mode tables and drivetrain numbers on both sides must agree.
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
// Fundamental amplitude vs reference amplitude in overmodulation (cross-checked with vvvflab/pwm.py)
out.fund = [0.3, 1, 1.2, 2, 5, 15].map((m) => ({ m, v: Table.fundamentalFromReference(m) }));
out.ref = [0.3, 1, 1.05, 1.1, 1.2, 1.27, 1.2732].map((v) => ({ v, m: Table.referenceForFundamental(v) }));

// Mode tables split by vehicle speed: presets, validation results, lookup
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

// Synchronous modulation with few pulses: the back-solved reference amplitude (pytest checks the actual fundamental with an independent numpy numerical integration)
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

// Braking (generator state) and train dynamics
out.brake = [0, 10, 60, 130].map((v) => Object.assign({ v }, Drive.compute(v, 2, false, undefined, true)));
out.dyn = [];
for (const mode of ['power', 'coast', 'brake']) {
  for (const v of [0, 10, 40, 80, 160]) out.dyn.push({ mode, v, next: Drive.stepSpeed(v, mode, 0.1) });
}
// Master controller: the notch table, slip proportional to torque, acceleration of each notch, when the inverter is running
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
// What the 3D view draws: load angle, where the stator's field goes, how large the winding currents are
out.fieldLead = [[60, 8, false, 1], [60, 8, true, 1], [60, 8, false, 0.25], [70, 4, false, 0], [40, 2, true, 0.5]].map(([a, p, b, l]) => ({ a, p, b, l, lead: Drive.fieldLead(a, p, b, l) }));
out.statorField = [];
for (const synchronous of [true, false]) {
  for (const braking of [false, true]) {
    for (const load of [0, 0.25, 1]) out.statorField.push({ synchronous, braking, load, angle: Drive.statorFieldAngle(synchronous, 0.4, 1.1, braking, load) });
  }
}
out.windingCurrent = [[true, 0], [true, 0.3], [true, 0.65], [true, 1], [false, 0], [false, 0.3], [false, 1]].map(([synchronous, power]) => ({ synchronous, power, amp: Drive.windingCurrent(synchronous, power) }));
console.log(JSON.stringify(out));
