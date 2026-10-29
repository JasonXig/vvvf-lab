// Permanent-magnet synchronous motor (surface-mounted): N / S magnets alternate on the rotor surface and the rotor turns in sync with the rotating field, so there is no slip.
// The field only leads the rotor by a "load angle"; the larger this angle, the larger the output torque.
(function (NS) {
  'use strict';

  const T = THREE;
  const K = NS.MotorKit;
  const P = K.palette;
  const H = K.helpers;
  const TAU = K.TAU;

  K.register('pmsm', {
    label: 'Permanent-magnet synchronous motor (surface-mounted)',
    synchronous: true,
    defaults: { poles: 8, statorSlots: 48, magnetCoverage: 0.78, magnetThickness: 0.08, loadAngleDeg: 18 },
    presets: {
      'PM · 8 poles · 48 slots': { poles: 8, statorSlots: 48, magnetCoverage: 0.78, magnetThickness: 0.08, loadAngleDeg: 18 },
      'PM · 4 poles · 36 slots': { poles: 4, statorSlots: 36, magnetCoverage: 0.8, magnetThickness: 0.09, loadAngleDeg: 20 },
    },
    validate(s, need, num) {
      num(s, 'magnetCoverage', 0.4, 0.95, 'Magnet coverage');
      num(s, 'magnetThickness', 0.02, 0.2, 'Magnet thickness');
      num(s, 'loadAngleDeg', -60, 60, 'Load angle (deg)');
    },

    buildRotor(ctx) {
      const { spec, g } = ctx;
      const Lr = g.L * 0.98;
      const t = spec.magnetThickness;
      const group = new T.Group();

      const coreMat = H.stdMat(P.steelDark, 0.6, 0.45);
      group.add(
        H.piece(new T.Mesh(H.cyl(g.Rr - t, Lr, 96), coreMat), {
          id: 'rotorCore',
          name: 'Rotor core (yoke)',
          dir: [0, 0, 1],
          dist: g.xNear,
          info: {
            role: 'Steel under the magnets that carries their flux from one pole to the next.',
            material: 'Steel, solid or laminated',
            facts: [],
          },
        })
      );
      const magnets = H.piece(new T.Group(), {
        id: 'magnets',
        name: 'Permanent magnets (on the surface)',
        dir: [0, 0, 1],
        dist: g.xFar,
        step: 2,
        info: {
          role: 'N and S magnets on the rotor surface make the rotor field by themselves, so the rotor turns exactly in step with the rotating field: no slip, and no current in the rotor. The field leads the rotor by the load angle; the larger the angle, the larger the torque.',
          material: 'Neodymium-iron-boron (NdFeB), glued on and often held by a bandage at high speed',
          facts: [spec.poles + ' magnets, ' + spec.poles / 2 + ' N and ' + spec.poles / 2 + ' S', 'They cover ' + Math.round(spec.magnetCoverage * 100) + '% of each pole pitch'],
        },
      });
      group.add(magnets);

      const northMat = H.stdMat(P.north, 0.35, 0.45);
      const southMat = H.stdMat(P.south, 0.35, 0.45);
      const letterN = new T.MeshBasicMaterial({ map: H.letterTexture('N', '#ffffff'), transparent: true, depthWrite: false });
      const letterS = new T.MeshBasicMaterial({ map: H.letterTexture('S', '#ffffff'), transparent: true, depthWrite: false });
      const pitch = TAU / spec.poles;
      const halfWidth = (spec.magnetCoverage * pitch) / 2;
      const size = Math.min(0.22, 2 * halfWidth * g.Rr * 0.7);
      for (let i = 0; i < spec.poles; i++) {
        const c = i * pitch; // magnet 0 (N) faces the 0° direction of the rotor
        const north = i % 2 === 0;
        magnets.add(new T.Mesh(H.ring(g.Rr, g.Rr - t, c - halfWidth, c + halfWidth, Lr), north ? northMat : southMat));
        const decal = new T.Mesh(new T.PlaneGeometry(size, size), north ? letterN : letterS);
        decal.position.set((g.Rr + 0.004) * Math.cos(c), (g.Rr + 0.004) * Math.sin(c), 0);
        decal.up.set(0, 0, 1);
        decal.lookAt(decal.position.x * 2, decal.position.y * 2, 0);
        magnets.add(decal);
      }

      return {
        group,
        fadeMats: [coreMat, northMat, southMat, letterN, letterS],
        labels: [{ text: 'PM rotor (surface magnets N / S)', pos: new T.Vector3(g.Rr * 0.6, g.Rr * 0.3, Lr / 2 + 0.12) }],
      };
    },
  });
})(window.VVVF3D);
