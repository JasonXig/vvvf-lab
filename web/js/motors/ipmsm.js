// Interior permanent-magnet synchronous motor (V-shaped magnets): the magnets are buried in the rotor core, two per pole arranged in a V, with only a small piece showing at the two end faces.
// This file is also the template for "how to add a motor type": implement only the rotor, the other parts reuse the common stator, windings and housing.
(function (NS) {
  'use strict';

  const T = THREE;
  const K = NS.MotorKit;
  const P = K.palette;
  const H = K.helpers;
  const TAU = K.TAU;

  K.register('ipmsm', {
    label: 'Permanent-magnet synchronous motor (interior V-shaped)',
    synchronous: true,
    defaults: { poles: 8, statorSlots: 48, magnetWidth: 0.3, magnetThickness: 0.06, vAngleDeg: 35, loadAngleDeg: 25 },
    presets: {
      'Interior PM · 8 poles · 48 slots': { poles: 8, statorSlots: 48, magnetWidth: 0.3, magnetThickness: 0.06, vAngleDeg: 35, loadAngleDeg: 25 },
    },
    validate(s, need, num) {
      num(s, 'magnetWidth', 0.1, 0.5, 'Magnet width');
      num(s, 'magnetThickness', 0.02, 0.15, 'Magnet thickness');
      num(s, 'vAngleDeg', 10, 70, 'V angle (deg)');
      num(s, 'loadAngleDeg', -60, 60, 'Load angle (deg)');
    },

    buildRotor(ctx) {
      const { spec, g } = ctx;
      const Lr = g.L * 0.98;
      const group = new T.Group();

      const coreMat = H.stdMat(P.steelDark, 0.6, 0.45);
      group.add(new T.Mesh(H.cyl(g.Rr, Lr, 96), coreMat));

      const northMat = H.stdMat(P.north, 0.35, 0.45);
      const southMat = H.stdMat(P.south, 0.35, 0.45);
      const pitch = TAU / spec.poles;
      const gamma = (spec.vAngleDeg * Math.PI) / 180;
      const rc = g.Rr - 0.17; // radius of the magnet centre
      const d = 0.13; // distance of the two magnet centres from the pole centre line
      for (let i = 0; i < spec.poles; i++) {
        const c = i * pitch;
        const u = new T.Vector2(Math.cos(c), Math.sin(c)); // pole centre line (radial)
        const t = new T.Vector2(-Math.sin(c), Math.cos(c)); // tangential
        [-1, 1].forEach((side) => {
          const w = t.clone().multiplyScalar(side * Math.cos(gamma)).add(u.clone().multiplyScalar(Math.sin(gamma))); // direction of the magnet width
          const mag = new T.Mesh(new T.BoxGeometry(spec.magnetWidth, spec.magnetThickness, Lr + 0.05), i % 2 === 0 ? northMat : southMat);
          mag.position.set(rc * u.x + side * d * t.x, rc * u.y + side * d * t.y, 0);
          mag.rotation.z = Math.atan2(w.y, w.x);
          group.add(mag);
        });
      }

      return {
        group,
        fadeMats: [coreMat, northMat, southMat],
        labels: [{ text: 'Interior rotor (V-shaped magnets)', pos: new T.Vector3(g.Rr * 0.6, g.Rr * 0.3, Lr / 2 + 0.12) }],
      };
    },
  });
})(window.VVVF3D);
