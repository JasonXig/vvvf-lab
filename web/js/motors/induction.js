// Three-phase induction motor (squirrel cage): the rotor is an iron core + copper bars + two end rings.
// The bar colour shows the induced current: the larger the slip and the closer a bar is to where the field changes fastest, the larger the current.
(function (NS) {
  'use strict';

  const T = THREE;
  const K = NS.MotorKit;
  const P = K.palette;
  const H = K.helpers;
  const TAU = K.TAU;

  K.register('induction', {
    label: 'Three-phase induction motor (squirrel cage)',
    synchronous: false, // the rotor speed is below the synchronous speed, so there is slip
    defaults: { poles: 4, statorSlots: 36, rotorBars: 28 },
    presets: {
      'Induction · 4 poles · 36 slots · 28 bars': { poles: 4, statorSlots: 36, rotorBars: 28 },
      'Induction · 6 poles · 54 slots · 44 bars': { poles: 6, statorSlots: 54, rotorBars: 44 },
    },
    validate(s, need) {
      need(Number.isInteger(s.rotorBars) && s.rotorBars >= 8 && s.rotorBars <= 80, 'Rotor bar count rotorBars must be an integer from 8 to 80');
    },

    buildRotor(ctx) {
      const { spec, g } = ctx;
      const n = spec.rotorBars;
      const Lr = g.L * 0.98;
      const group = new T.Group();

      const coreMat = H.stdMat(P.steelDark, 0.6, 0.45);
      group.add(
        H.piece(new T.Mesh(H.cyl(g.Rr, Lr, 96), coreMat), {
          id: 'rotorCore',
          name: 'Rotor core',
          dir: [0, 0, 1],
          dist: g.xNear,
          info: {
            role: 'Laminated steel like the stator, with slots just under the surface for the cage bars. It carries the flux across from the stator and back.',
            material: 'Silicon-steel laminations',
            facts: [n + ' slots for the bars'],
          },
        })
      );
      // the cage: bars + end rings, one piece in the exploded view
      const cage = H.piece(new T.Group(), {
        id: 'cage',
        name: 'Squirrel cage (bars + end rings)',
        dir: [0, 0, 1],
        dist: g.xFar,
        step: 2,
        info: {
          role: 'Bars in the rotor slots, shorted together by a ring at each end. The rotating field sweeps past the bars at the slip frequency and induces currents in them; the force on those currents drives the rotor. That is why the rotor always turns a little slower than the field.',
          material: 'Copper bars brazed to copper end rings (common in traction motors), or die-cast aluminium',
          facts: [n + ' bars against ' + spec.statorSlots + ' stator slots: the two numbers are kept different on purpose, to avoid cogging and magnetic noise'],
          note: 'A die-cast cage is one piece with the core and cannot be pulled out; copper bars are pushed into the slots before the end rings are brazed on.',
        },
      });
      group.add(cage);

      const barDepth = Math.min(0.1, (g.Rr - g.Rsh) * 0.3);
      const barWidth = Math.min(0.09, ((TAU * g.Rr) / n) * 0.5);
      const barMat = new T.MeshStandardMaterial({ color: 0xffffff, metalness: 0.7, roughness: 0.34 });
      const bars = new T.InstancedMesh(new T.BoxGeometry(barDepth, barWidth, Lr + 0.16), barMat, n);
      bars.frustumCulled = false;
      const base = new T.Color(P.copper);
      const hot = new T.Color(0xffe08a);
      const m4 = new T.Matrix4();
      const q = new T.Quaternion();
      const pos = new T.Vector3();
      const one = new T.Vector3(1, 1, 1);
      const zAxis = new T.Vector3(0, 0, 1);
      for (let j = 0; j < n; j++) {
        const a = (j * TAU) / n;
        const r = g.Rr - barDepth / 2 + 0.012;
        q.setFromAxisAngle(zAxis, a);
        pos.set(r * Math.cos(a), r * Math.sin(a), 0);
        m4.compose(pos, q, one);
        bars.setMatrixAt(j, m4);
        bars.setColorAt(j, base);
      }
      bars.instanceColor.needsUpdate = true;
      cage.add(bars);

      const ringMat = H.stdMat(P.copper, 0.75, 0.3);
      [-1, 1].forEach((sg) => {
        const ring = new T.Mesh(H.ring(g.Rr, g.Rr - 0.13, 0, TAU, 0.06), ringMat);
        ring.position.z = sg * (Lr / 2 + 0.05);
        cage.add(ring);
      });

      const tmp = new T.Color();
      return {
        group,
        fadeMats: [coreMat, barMat, ringMat],
        labels: [{ text: 'Squirrel-cage rotor (bars + end rings)', pos: new T.Vector3(g.Rr * 0.55, g.Rr * 0.4, Lr / 2 + 0.12) }],
        update(st) {
          // bar current ∝ slip × |sin(p·(bar position − field position))|: the faster the field sweeps past a bar, the larger the current
          for (let j = 0; j < n; j++) {
            const a = st.rotorAngle + (j * TAU) / n;
            const k = st.showRotorCurrent ? st.slipAmp * Math.abs(Math.sin(st.polePairs * (a - st.fieldAngle))) : 0;
            tmp.copy(base).lerp(hot, Math.min(1, k * 1.2));
            bars.setColorAt(j, tmp);
          }
          bars.instanceColor.needsUpdate = true;
        },
      };
    },
  });
})(window.VVVF3D);
