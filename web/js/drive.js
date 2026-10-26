// 传动与转差模型、列车纵向动力学、主手柄档位。
// 这是演示用的简化模型；等 Python 端有了 P2/P4 的真实转差与转矩，页面会改为直接读它们的结果。
(function (NS) {
  'use strict';

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  const DEFAULT_DRIVE = {
    wheelDiameter: 0.86, // 车轮直径 [m]
    gearRatio: 5.6, // 齿轮比（电机转速 / 车轮转速）
    slipLow: 1.5, // 恒转矩区满力矩时的转差频率 [Hz]
    slipHigh: 5.0, // 弱磁区满力矩时的转差频率 [Hz]
    slipRiseFrom: 48, // 转子电频率超过此值后，转差频率开始增大 [Hz]
    slipRiseTo: 150, // 增大到 slipHigh 的转子电频率 [Hz]
  };

  // 主手柄：从最大制动一路推到最大牵引。
  //   mode  power 牵引 | coast 空档（惰行） | hold 定速 | brake 制动
  //   frac  力矩指令占满档的比例，决定加减速度的大小、转差的大小、磁场和电流的强弱
  // 空档和定速时逆变器仍然在运转（零转矩或只补偿阻力），所以声音是持续的。
  const NOTCHES = [
    { id: 'B5', mode: 'brake', frac: 1.0 },
    { id: 'B4', mode: 'brake', frac: 0.8 },
    { id: 'B3', mode: 'brake', frac: 0.6 },
    { id: 'B2', mode: 'brake', frac: 0.4 },
    { id: 'B1', mode: 'brake', frac: 0.2 },
    { id: 'N', mode: 'coast', frac: 0 },
    { id: 'H', mode: 'hold', frac: 0.1 },
    { id: 'P1', mode: 'power', frac: 0.25 },
    { id: 'P2', mode: 'power', frac: 0.5 },
    { id: 'P3', mode: 'power', frac: 0.75 },
    { id: 'P4', mode: 'power', frac: 1.0 },
  ];
  const NOTCH_N = 5; // 空档的下标
  function notchIndex(id) {
    return NOTCHES.findIndex((n) => n.id === id);
  }

  // 手柄档位 + 逆变器开关 → 实际的动力状态：逆变器关掉就没有牵引力，牵引和定速只能惰行；
  // 制动还在，但只剩机械制动。
  function effectiveMode(mode, inverterOn) {
    return !inverterOn && (mode === 'power' || mode === 'hold') ? 'coast' : mode;
  }
  // 力矩指令的比例：空档没有力矩，其余档位按档位的 frac
  function torqueLoad(mode, frac) {
    return mode === 'coast' ? 0 : frac;
  }
  // 逆变器此刻在不在开关（有没有声音、有没有磁场），不在的话给出原因。
  // 空档和定速时逆变器仍然运转（零转矩，只维持磁场），所以声音是持续的，一直到车快停下来
  // （基波频率低于 0.5 Hz）才安静；再生制动在基波频率低于 1 Hz 时退出，由机械制动接手。
  function inverterRun(mode, inverterOn, f1) {
    if (!inverterOn) return { run: false, why: '逆变器已关' };
    if (mode === 'power') return { run: true, why: '' };
    if (mode === 'brake') return f1 >= 1 ? { run: true, why: '' } : { run: false, why: '再生制动已退出' };
    return f1 >= 0.5 ? { run: true, why: '' } : { run: false, why: '逆变器待机' };
  }

  // speedKmh：车速；polePairs：极对数；synchronous：永磁同步电机为 true（没有转差）；
  // braking：再生制动时电机运行在发电状态，旋转磁场比转子慢一个转差频率；
  // load：力矩指令的比例 0..1（默认 1）。转差与力矩成正比，空档时为 0，旋转磁场正好和转子同步。
  function compute(speedKmh, polePairs, synchronous, drive, braking, load) {
    const d = Object.assign({}, DEFAULT_DRIVE, drive || {});
    const k = load === undefined ? 1 : clamp(load, 0, 1);
    const v = speedKmh / 3.6;
    const rotorRps = (v / (Math.PI * d.wheelDiameter)) * d.gearRatio; // 转子机械转速 [rev/s]
    const fr = polePairs * rotorRps; // 转子电频率 [Hz]
    let fs = 0; // 转差频率 [Hz]
    if (!synchronous) {
      const x = clamp((fr - d.slipRiseFrom) / (d.slipRiseTo - d.slipRiseFrom), 0, 1);
      fs = (d.slipLow + (d.slipHigh - d.slipLow) * x) * k;
    }
    if (braking) fs = -fs;
    const f1 = Math.max(0, fr + fs); // 逆变器输出的基波频率 [Hz]
    return {
      speedKmh,
      rotorRps,
      nr: rotorRps * 60, // 转子转速 [rpm]
      fr,
      fs, // 带符号：制动时为负
      f1,
      ns: f1 > 0 ? (60 * f1) / polePairs : 0, // 同步转速 [rpm]
      slip: f1 > 1e-9 ? fs / f1 : 0,
      braking: !!braking,
    };
  }

  // 列车纵向动力学（单位 km/h 与 km/h/s）：牵引时低速恒加速度、过了拐点恒功率；制动为常数；
  // 空档只有运行阻力；定速时牵引力刚好抵消阻力，车速不变。dyn.frac 是手柄档位的力矩比例（默认 1）。
  const DEFAULT_DYN = { accel: 3.0, accelKnee: 40, brake: 3.5, resist0: 0.1, resist2: 1.5e-5, maxSpeed: 160 };

  function stepSpeed(v, mode, dt, dyn) {
    const d = Object.assign({}, DEFAULT_DYN, dyn || {});
    const frac = d.frac === undefined ? 1 : d.frac;
    const resist = d.resist0 + d.resist2 * v * v;
    let a = -resist;
    if (mode === 'power') a = ((v <= d.accelKnee ? d.accel : (d.accel * d.accelKnee) / v) * frac) - resist;
    else if (mode === 'brake') a = -(d.brake * frac + resist);
    else if (mode === 'hold') a = 0;
    return clamp(v + a * dt, 0, d.maxSpeed);
  }

  NS.Drive = { DEFAULT_DRIVE, DEFAULT_DYN, NOTCHES, NOTCH_N, notchIndex, effectiveMode, torqueLoad, inverterRun, compute, stepSpeed };
})((window.VVVF3D = window.VVVF3D || {}));
