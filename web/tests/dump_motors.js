// Build every registered 3D motor type in Node (three.js geometry needs no WebGL) and print what came out as JSON.
// tests/test_web_motors.py uses it: every type and preset must build with the cut-away on and off, run a few frames of update(),
// have finite geometry of the expected size, and refuse definitions that do not fit together with a clear message.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
// The only browser API the motors touch is a 2D canvas for the N / S letters; a stub that ignores every call is enough here
const noop = () => {};
const ctx2d = new Proxy({}, { get: () => noop, set: () => true });
const sandbox = {
  console: { log: noop, warn: noop, error: (...a) => process.stderr.write(a.join(' ') + '\n') },
  document: { createElement: () => ({ width: 0, height: 0, getContext: () => ctx2d, style: {} }) },
};
sandbox.window = sandbox;
vm.createContext(sandbox);
const scripts = ['vendor/three.min.js', 'js/drive.js', 'js/motorkit.js'];
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const motorFiles = [...html.matchAll(/<script src="(js\/motors\/[^"]+)"/g)].map((m) => m[1]); // the same motor files, in the same order, as the page
for (const file of scripts.concat(motorFiles)) {
  vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), sandbox, { filename: file });
}
const T = sandbox.THREE;
const K = sandbox.VVVF3D.MotorKit;

function inspect(motor) {
  let meshes = 0;
  let finite = true;
  let clipped = 0;
  let rMaxXY = 0;
  let zMax = 0;
  motor.root.updateMatrixWorld(true);
  const v = new T.Vector3();
  motor.root.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some((m) => m.clippingPlanes && m.clippingPlanes.length)) clipped++;
    const pos = o.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      if (!(isFinite(v.x) && isFinite(v.y) && isFinite(v.z))) finite = false;
      if (o.isInstancedMesh) continue; // the instances are placed by their matrices; their extent is inside the core anyway
      v.applyMatrix4(o.matrixWorld);
      rMaxXY = Math.max(rMaxXY, Math.hypot(v.x, v.y));
      zMax = Math.max(zMax, Math.abs(v.z));
    }
  });
  return { meshes, finite, clipped, rMaxXY, zMax, explode: inspectPieces(motor) };
}

// Pieces of the exploded view: what each one is, and whether every physical mesh belongs to exactly one piece
function inspectPieces(motor) {
  const notPieces = new Set(); // the field ring and the blur shell are not physical parts
  motor.root.traverse((o) => {
    if (o.isMesh && o.material && o.material.isShaderMaterial) notPieces.add(o);
  });
  let untagged = 0;
  let nested = 0;
  motor.root.traverse((o) => {
    let tags = 0;
    for (let a = o; a; a = a.parent) if (a.userData && a.userData.explode) tags++;
    if (o.userData.explode && tags > 1) nested++;
    if (o.isMesh && !notPieces.has(o) && tags === 0) untagged++;
  });
  return {
    untagged,
    nested,
    pieces: motor.pieces.map((p) => ({
      id: p.id,
      name: p.name,
      dir: p.dir.toArray(),
      dist: p.dist,
      step: p.step,
      objects: p.objects.length,
      info: p.info,
    })),
  };
}

const out = { types: K.typeList(), builds: [], errors: {} };
const state = (t) => ({
  rotorAngle: 0.7 * t,
  fieldAngle: 0.9 * t,
  polePairs: 2,
  currents: [Math.cos(t), Math.cos(t - 2.094), Math.cos(t - 4.189)],
  power: 0.6,
  slipAmp: 0.4,
  blur: t > 1 ? 0.8 : 0,
  streakPhase: 0.1 * t,
  speedColor: new T.Color(0x66aaff),
});
const specs = K.typeList().map((t) => ({ name: t.type + ' (default)', spec: K.defaultSpec(t.type) })).concat(K.presetList());
for (const { name, spec } of specs) {
  for (const cutaway of [true, false]) {
    const rec = { name, type: spec.type, cutaway };
    try {
      const m = K.build(spec, { cutaway });
      for (let t = 0; t < 3; t++) m.update(Object.assign(state(t), { polePairs: m.polePairs }));
      m.setView({ shellOpacity: 1 });
      m.setView({ shellOpacity: 0.3 });
      Object.assign(rec, inspect(m), {
        ok: true,
        polePairs: m.polePairs,
        synchronous: m.synchronous,
        spec: m.spec,
        labels: m.labels.map((l) => ({ text: l.text, finite: [l.pos.x, l.pos.y, l.pos.z].every(isFinite) })),
      });
      m.dispose();
    } catch (err) {
      rec.ok = false;
      rec.error = String(err && err.stack ? err.stack : err);
    }
    out.builds.push(rec);
  }
}

// Definitions that must be refused, with the message they get
const bad = {
  outerStatorTooBig: { type: 'outer-rotor', statorRadius: 0.95 },
  outerYokeTooThin: { type: 'outer-rotor', statorInnerRadius: 0.6 },
  outerSpindleTooBig: { type: 'outer-rotor', shaftRadius: 0.34 },
  outerDrumTooThin: { type: 'outer-rotor', magnetThickness: 0.2 },
  innerShaftTooBig: { type: 'induction', shaftRadius: 0.5 },
  oddPoles: { type: 'outer-rotor', poles: 15 },
  unknownType: { type: 'no-such-type' },
};
for (const key of Object.keys(bad)) {
  try {
    K.normalizeSpec(bad[key]);
    out.errors[key] = null;
  } catch (err) {
    out.errors[key] = err.message;
  }
}
// The default spec of every layout only carries the dimensions of that layout
out.defaultKeys = {};
for (const t of K.typeList()) out.defaultKeys[t.type] = Object.keys(K.normalizeSpec(K.defaultSpec(t.type)));

process.stdout.write(JSON.stringify(out));
