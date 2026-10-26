// In Node, render a few typical operating points offline with the sound-synthesis core of the page and write the samples to a binary file (float32),
// and print a description and the timing of each operating point on standard output. tests/test_web_synth.py cross-checks it against the Python version.
// Usage: node dump_synth.js output-file.bin
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const sandbox = {};
sandbox.window = sandbox;
vm.createContext(sandbox);
for (const file of ['js/modes.js', 'js/drive.js', 'js/table.js', 'js/synth.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}
const { Table, SynthCore } = sandbox.VVVF3D;

const FS = 48000;
const WARMUP = FS / 2;
const KEEP = FS;
const cases = [
  { name: 'async', kind: 'async', n: 0, f1: 40, m: 0.8, fc: 1000 },
  { name: 'sync15', kind: 'sync', n: 15, f1: 40, m: 0.6, fc: 600 },
  { name: 'sync9', kind: 'sync', n: 9, f1: 30, m: 0.9, fc: 270 },
  { name: 'wide3', kind: 'sync', n: 3, f1: 70, m: 2.0, fc: 210 },
  { name: 'square', kind: 'square', n: 0, f1: 100, m: 20, fc: 100 },
  // N is not a multiple of 3: the Python version (common carrier) has no corresponding result. Use a very small gain so the output stays in the linear region of tanh,
  // which is the only way to tell from the spectrum whether the three phases are balanced.
  { name: 'sync7', kind: 'sync', n: 7, f1: 45, m: 0.7, fc: 315, rippleGain: 20 },
  // Whether the fundamental is subtracted cleanly with wide 3-pulse. f1 is 150 Hz (above the 100 Hz high-pass), the gain is small, and the output stays in the linear region.
  // raw: m = v1 from the large-carrier-ratio formula; cal: back-solved with Table.referenceForSync so the actual fundamental equals v1.
  { name: 'wide3raw', kind: 'sync', n: 3, f1: 150, v1: 1.0, fc: 450, rippleGain: 20, mFrom: 'formula' },
  { name: 'wide3cal', kind: 'sync', n: 3, f1: 150, v1: 1.0, fc: 450, rippleGain: 20, mFrom: 'calibrated' },
];

const chunks = [];
let renderMs = 0;
const meta = cases.map((c) => {
  const core = new SynthCore(FS, c.rippleGain ? { rippleGain: c.rippleGain } : undefined);
  const v1 = c.kind === 'square' ? Table.V1_SQUARE : c.v1 !== undefined ? c.v1 : Table.fundamentalFromReference(c.m);
  const m = c.mFrom === 'calibrated' ? Table.referenceForSync(c.n, v1) : c.mFrom === 'formula' ? Table.referenceForFundamental(v1) : c.m;
  core.setTarget({ kind: c.kind, n: c.n, f1: c.f1, m, v1, fc: c.fc, gate: true, volume: 0.5 });
  core.g = 0.5; // skip the volume fade-in, same as soft_start=False in the Python test
  const buf = new Float32Array(WARMUP + KEEP);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < buf.length; i += 128) core.render(buf.subarray(i, Math.min(i + 128, buf.length))); // 128 samples at a time, like an AudioWorklet
  renderMs += Number(process.hrtime.bigint() - t0) / 1e6;
  chunks.push(buf.subarray(WARMUP));
  return Object.assign({}, c, { v1, m });
});

const all = new Float32Array(chunks.length * KEEP);
chunks.forEach((c, i) => all.set(c, i * KEEP));
fs.writeFileSync(process.argv[2], Buffer.from(all.buffer));
const audioSeconds = (cases.length * (WARMUP + KEEP)) / FS;
console.log(JSON.stringify({ fs: FS, keep: KEEP, cases: meta, renderSeconds: renderMs / 1000, audioSeconds }));
