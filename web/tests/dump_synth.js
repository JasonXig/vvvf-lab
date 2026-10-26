// 在 Node 里用页面的声音合成核心离线渲染几个典型工作点，把采样写成二进制文件（float32），
// 并在标准输出打印每个工作点的说明与耗时。tests/test_web_synth.py 拿它和 Python 版对账。
// 用法：node dump_synth.js 输出文件.bin
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
  // N 不是 3 的倍数：Python 版（公共载波）没有对应结果。用很小的增益，让输出停留在 tanh 的线性区，
  // 这样才能从谱线上看出三相是否平衡。
  { name: 'sync7', kind: 'sync', n: 7, f1: 45, m: 0.7, fc: 315, rippleGain: 20 },
  // 宽 3 脉冲时基波有没有被干净地减掉。f1 取 150 Hz（在 100 Hz 高通之上），增益调小，输出停在线性区。
  // raw：按大载波比的公式取 m = v1；cal：用 Table.referenceForSync 反解，让实际基波等于 v1。
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
  core.g = 0.5; // 跳过音量渐入，和 Python 测试里 soft_start=False 一致
  const buf = new Float32Array(WARMUP + KEEP);
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < buf.length; i += 128) core.render(buf.subarray(i, Math.min(i + 128, buf.length))); // 和 AudioWorklet 一样每次 128 个样本
  renderMs += Number(process.hrtime.bigint() - t0) / 1e6;
  chunks.push(buf.subarray(WARMUP));
  return Object.assign({}, c, { v1, m });
});

const all = new Float32Array(chunks.length * KEEP);
chunks.forEach((c, i) => all.set(c, i * KEEP));
fs.writeFileSync(process.argv[2], Buffer.from(all.buffer));
const audioSeconds = (cases.length * (WARMUP + KEEP)) / FS;
console.log(JSON.stringify({ fs: FS, keep: KEEP, cases: meta, renderSeconds: renderMs / 1000, audioSeconds }));
