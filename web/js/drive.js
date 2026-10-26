// Drivetrain and slip model, longitudinal train dynamics, master-controller notches.
// This is a simplified demo model; once the Python side has real slip and torque from P2/P4, the page will read their results directly.
(function (NS) {
  'use strict';

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));

  const DEFAULT_DRIVE = {
    wheelDiameter: 0.86, // wheel diameter [m]
    gearRatio: 5.6, // gear ratio (motor speed / wheel speed)
    slipLow: 1.5, // slip frequency at full torque in the constant-torque region [Hz]
    slipHigh: 5.0, // slip frequency at full torque in the field-weakening region [Hz]
    slipRiseFrom: 48, // rotor electrical frequency above which the slip frequency starts to rise [Hz]
    slipRiseTo: 150, // rotor electrical frequency at which it reaches slipHigh [Hz]
  };

  // Master controller: from full braking all the way to full power.
  //   mode  power = traction | coast = neutral (coasting) | hold = constant speed | brake = braking
  //   frac  torque command as a fraction of the full notch; sets the acceleration, the slip, and the strength of the field and current
  // In neutral and hold the inverter keeps running (zero torque, or only offsetting the resistance), so the sound continues.
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
  const NOTCH_N = 5; // index of the neutral notch
  function notchIndex(id) {
    return NOTCHES.findIndex((n) => n.id === id);
  }

  // Notch + inverter switch → the actual driving state: with the inverter off there is no tractive effort, so power and hold can only coast;
  // braking remains, but only as mechanical braking.
  function effectiveMode(mode, inverterOn) {
    return !inverterOn && (mode === 'power' || mode === 'hold') ? 'coast' : mode;
  }
  // Torque command fraction: neutral has no torque, the other notches use the frac of the notch
  function torqueLoad(mode, frac) {
    return mode === 'coast' ? 0 : frac;
  }
  // Whether the inverter is switching right now (is there sound, is there a field), and if not, why.
  // In neutral and hold the inverter keeps running (zero torque, only maintaining the field), so the sound continues until the train is almost stopped
  // (fundamental frequency below 0.5 Hz); regenerative braking is released below 1 Hz and handed over to mechanical braking.
  function inverterRun(mode, inverterOn, f1) {
    if (!inverterOn) return { run: false, why: 'Inverter off' };
    if (mode === 'power') return { run: true, why: '' };
    if (mode === 'brake') return f1 >= 1 ? { run: true, why: '' } : { run: false, why: 'Regenerative brake released' };
    return f1 >= 0.5 ? { run: true, why: '' } : { run: false, why: 'Inverter standby' };
  }

  // speedKmh: vehicle speed; polePairs: pole pairs; synchronous: true for a permanent-magnet synchronous motor (no slip);
  // braking: in regenerative braking the motor runs as a generator and the rotating field is one slip frequency slower than the rotor;
  // load: torque command fraction 0..1 (default 1). Slip is proportional to torque, 0 in neutral, so the rotating field is exactly in sync with the rotor.
  function compute(speedKmh, polePairs, synchronous, drive, braking, load) {
    const d = Object.assign({}, DEFAULT_DRIVE, drive || {});
    const k = load === undefined ? 1 : clamp(load, 0, 1);
    const v = speedKmh / 3.6;
    const rotorRps = (v / (Math.PI * d.wheelDiameter)) * d.gearRatio; // rotor mechanical speed [rev/s]
    const fr = polePairs * rotorRps; // rotor electrical frequency [Hz]
    let fs = 0; // slip frequency [Hz]
    if (!synchronous) {
      const x = clamp((fr - d.slipRiseFrom) / (d.slipRiseTo - d.slipRiseFrom), 0, 1);
      fs = (d.slipLow + (d.slipHigh - d.slipLow) * x) * k;
    }
    if (braking) fs = -fs;
    const f1 = Math.max(0, fr + fs); // fundamental frequency output by the inverter [Hz]
    return {
      speedKmh,
      rotorRps,
      nr: rotorRps * 60, // rotor speed [rpm]
      fr,
      fs, // signed: negative when braking
      f1,
      ns: f1 > 0 ? (60 * f1) / polePairs : 0, // synchronous speed [rpm]
      slip: f1 > 1e-9 ? fs / f1 : 0,
      braking: !!braking,
    };
  }

  // Longitudinal train dynamics (km/h and km/h/s): traction is constant acceleration at low speed and constant power past the knee; braking is constant;
  // neutral has only running resistance; hold has the tractive effort exactly cancel the resistance so the speed stays constant. dyn.frac is the torque fraction of the notch (default 1).
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
