// Axial-flux permanent-magnet synchronous motor with two rotors: the air gap is a flat ring instead of a cylinder, and the flux crosses it along the axis.
// A slotted stator ring sits in the middle with a magnet disc on each side (the TORUS NN arrangement: the same pole faces the stator from both sides).
// The force acts over a flat ring, so torque grows with Ro³ − Ri³: diameter matters far more than length, which suits a slow direct drive (the default here).
// Like js/motors/outer-rotor.js this file brings its own layout and parts, and reuses the shared housing and shaft.
(function (NS) {
  'use strict';

  const T = THREE;
  const K = NS.MotorKit;
  const P = K.palette;
  const H = K.helpers;
  const S = K.shaders;
  const TAU = K.TAU;
  const DEG = Math.PI / 180;

  // Along the axis, from the middle outwards: stator yoke zY < tooth tips zT < air gap < magnet face zM < inside of the disc zR < outside of the disc zO
  const AXIAL_LAYOUT = {
    // Toroidal coils: a positive current runs radially outwards across the front face. Ampere around a loop through the front gap and the iron gives
    // dHz/dθ = +K/g, and the ring counts from rotor into stator, which is towards −Z in the front gap: with K(θ) ≈ A cos(pθ − α) that peaks at pθ = α − 90°,
    // the same as the outward field of an inner rotor, so the same value applies. In the back gap the current and the sense both reverse, so both gaps agree.
    windingPhase: Math.PI / 3,
    defaults: {
      outerRadius: 1.05,
      innerRadius: 0.6, // inner / outer ≈ 0.57: see the stator card
      yokeThickness: 0.22, // the iron of the stator ring between the two slotted faces
      slotDepth: 0.12,
      airGap: 0.03,
      shaftRadius: 0.17,
      toothFraction: 0.5,
    },
    validate(s, need, num) {
      num(s, 'outerRadius', 0.5, 1.15, 'Outer radius');
      num(s, 'innerRadius', 0.2, 1.1, 'Inner radius');
      num(s, 'yokeThickness', 0.05, 0.6, 'Yoke thickness');
      num(s, 'slotDepth', 0.05, 0.4, 'Slot depth');
      num(s, 'airGap', 0.005, 0.1, 'Air gap');
      num(s, 'shaftRadius', 0.05, 0.6, 'Shaft radius');
      num(s, 'toothFraction', 0.3, 0.8, 'Tooth fraction');
      need(s.innerRadius < s.outerRadius - 0.15, 'The active ring is too narrow: innerRadius must be at least 0.15 below outerRadius');
      need(s.shaftRadius < s.innerRadius - 0.1, 'shaftRadius must be at least 0.1 below innerRadius (the end links of the coils pass between them)');
    },
    derive(s) {
      const g = { Ro: s.outerRadius, Ri: s.innerRadius, Rsh: s.shaftRadius, p: s.poles / 2, Z: s.statorSlots, slotDepth: s.slotDepth };
      g.delta = TAU / g.Z;
      g.zY = s.yokeThickness / 2;
      g.zT = g.zY + s.slotDepth;
      g.zM = g.zT + s.airGap;
      g.zR = g.zM + s.magnetThickness;
      g.zO = g.zR + s.discThickness;
      g.endZ = g.zO + 0.2; // end shields
      g.rMid = (g.Ro + g.Ri) / 2;
      g.gapR = g.rMid;
      g.gapZ = g.zT + s.airGap / 2; // where the field rings are drawn
      g.Rframe = g.Ro + 0.1;
      g.hubR = g.Rsh + 0.14;
      g.shaftStub = 0.35; // a short shaft end, so that it does not stand in front of the cut-away
      // How far the pieces move along the axis
      g.xNear = 0.95; // magnets
      g.xFar = 1.8; // discs
      return g;
    },
  };

  const whole = (g) => ({ full: true, k0: 0, k1: g.Z, a0: 0, a1: TAU });
  // The stator stays whole, like the inner member of the other motors; the cut-away goes through the front disc, so the stator's face shows through it
  const flatRing = (rIn, rOut, a0, a1) => (a1 === undefined ? new T.RingGeometry(rIn, rOut, 180, 1) : new T.RingGeometry(rIn, rOut, 128, 1, a0, a1 - a0));

  const parts = {
    // A ring of iron with teeth on both faces; the slots run radially and open towards the two air gaps
    stator(ctx) {
      const { spec, g } = ctx;
      const group = H.piece(new T.Group(), {
        id: 'stator',
        name: 'Stator ring (slots on both faces)',
        dir: [0, 0, 1],
        dist: 0,
        info: {
          role: 'A ring of electrical steel with radial slots on both faces, opening towards the two air gaps. The flux from each magnet enters through the teeth and turns along the ring to the next pole, so the ring has to be thick enough to carry the flux of both discs. The force acts over a flat ring, so torque grows with Ro³ − Ri³: diameter matters far more than length.',
          material: 'Silicon-steel strip wound into a ring, with the slots cut afterwards',
          facts: [
            g.Z + ' slots on each face, ' + Math.round((g.Z / (3 * spec.poles)) * 100) / 100 + ' per pole per phase',
            'Inner / outer radius ' + Math.round((g.Ri / g.Ro) * 100) / 100 + ': the slots are narrowest at the inner radius, which limits the current, and then torque ∝ Ri(Ro² − Ri²) peaks at 1/√3 ≈ 0.58',
          ],
        },
      });
      const mat = H.stdMat(P.steel, 0.55, 0.42);
      group.add(new T.Mesh(H.ring(g.Ro, g.Ri, 0, TAU, 2 * g.zY, 96), mat));
      const tooth = spec.toothFraction * g.delta;
      const teeth = new T.InstancedMesh(H.ring(g.Ro, g.Ri, -tooth / 2, tooth / 2, g.slotDepth, 8), mat, 2 * g.Z);
      teeth.frustumCulled = false;
      const m4 = new T.Matrix4();
      const q = new T.Quaternion();
      const one = new T.Vector3(1, 1, 1);
      const zAxis = new T.Vector3(0, 0, 1);
      for (let k = 0; k < g.Z; k++) {
        q.setFromAxisAngle(zAxis, k * g.delta);
        [-1, 1].forEach((sg, j) => teeth.setMatrixAt(2 * k + j, m4.compose(new T.Vector3(0, 0, sg * (g.zY + g.slotDepth / 2)), q, one)));
      }
      group.add(teeth);
      return group;
    },

    // Toroidal coils, one per slot: a conductor across the front face, a short link over the outer edge of the ring, a conductor back across the rear face, a link over the inner edge
    windings(ctx) {
      const { spec, g, view } = ctx;
      const shared = K.pieces.winding(ctx);
      const group = H.piece(new T.Group(), {
        id: 'winding',
        name: 'Toroidal winding',
        dir: [0, 1, 0.8],
        dist: 3.1,
        step: 2,
        info: {
          role: 'Each coil wraps around the stator ring: across the front face, over the outer edge, back across the rear face, over the inner edge. Only the radial conductors make torque, and each coil has two, one in each air gap. The links over the edges are short, which saves copper compared with the long end turns of a normal winding. Phases A, B and C are yellow, green and red.',
          material: 'Insulated copper, impregnated with resin',
          facts: [g.Z + ' coils'].concat(shared.info.facts),
          note: 'Because each coil goes around the ring, a real winding cannot be lifted off it; the exploded view only moves it aside so you can see it.',
        },
      });
      const slots = H.slotPhases(g, whole(g));
      const width = (1 - spec.toothFraction) * g.delta * g.Ri * 0.85; // the slots are narrowest at the inner radius
      const zc = g.zY + g.slotDepth * 0.45;
      const mat = new T.MeshStandardMaterial({ color: 0xffffff, metalness: 0.25, roughness: 0.45 });
      const rods = new T.InstancedMesh(new T.BoxGeometry(g.Ro - g.Ri + 0.09, width, g.slotDepth * 0.7), mat, 2 * g.Z);
      const links = new T.InstancedMesh(new T.BoxGeometry(0.045, width, 2 * zc + g.slotDepth * 0.7), mat, 2 * g.Z);
      rods.frustumCulled = links.frustumCulled = false;
      const m4 = new T.Matrix4();
      const q = new T.Quaternion();
      const one = new T.Vector3(1, 1, 1);
      const zAxis = new T.Vector3(0, 0, 1);
      const base = P.phase.map((c) => new T.Color(c));
      slots.forEach((s, k) => {
        const c = Math.cos(s.angle);
        const si = Math.sin(s.angle);
        q.setFromAxisAngle(zAxis, s.angle);
        [-1, 1].forEach((sg, j) => rods.setMatrixAt(2 * k + j, m4.compose(new T.Vector3(g.rMid * c, g.rMid * si, sg * zc), q, one)));
        links.setMatrixAt(2 * k, m4.compose(new T.Vector3((g.Ro + 0.045) * c, (g.Ro + 0.045) * si, 0), q, one));
        links.setMatrixAt(2 * k + 1, m4.compose(new T.Vector3((g.Ri - 0.045) * c, (g.Ri - 0.045) * si, 0), q, one));
        [rods, links].forEach((im) => {
          im.setColorAt(2 * k, base[s.ph]);
          im.setColorAt(2 * k + 1, base[s.ph]);
        });
      });
      group.add(rods, links);
      const tmp = new T.Color();
      return {
        group,
        slots,
        update(st) {
          group.visible = view.showWinding;
          slots.forEach((s, k) => {
            tmp.copy(base[s.ph]).multiplyScalar(0.16 + 0.84 * (0.5 + 0.5 * s.s * st.currents[s.ph])); // bright = radially outwards on the front face
            [rods, links].forEach((im) => {
              im.setColorAt(2 * k, tmp);
              im.setColorAt(2 * k + 1, tmp);
            });
          });
          rods.instanceColor.needsUpdate = links.instanceColor.needsUpdate = true;
        },
      };
    },

    // The shared housing and end shields work as they are; only their paths and two of the cards differ
    housing(ctx) {
      const { g } = ctx;
      const h = K.parts.housing(ctx);
      h.group.traverse((o) => {
        const m = o.userData.explode;
        if (!m) return;
        if (m.id === 'housing') {
          Object.assign(m, { dir: [0, 1, -0.8], dist: 3.1 });
          m.info = Object.assign({}, m.info, { role: 'Holds the stator ring by its outer edge and carries the two end shields, and is what the motor is mounted by.' });
        } else {
          m.dist = g.xFar + 0.9;
          m.info = Object.assign({}, m.info, { role: 'Closes the end of the housing and carries a bearing in its hub, which keeps the rotor discs square to the stator, so that both air gaps stay even all the way round.' });
        }
      });
      return h;
    },

    shaft(ctx) {
      const { spec, g } = ctx;
      const s = K.parts.shaft(ctx);
      const gear = spec.drivetrain.gearRatio;
      Object.assign(s.userData.explode, {
        dir: [0, -1, 0],
        dist: g.Ro + g.Rsh + 0.6,
        info: {
          role: 'Carries the torque of both rotor discs out to the wheelset. It joins the two discs, and the bearings in the end shields hold it on the axis.',
          material: 'Forged alloy steel',
          facts: [(gear === 1 ? 'Direct drive (gear ratio 1)' : 'Gear ratio ' + gear) + ': ' + H.rpmAt(spec, 100) + ' rpm at 100 km/h'],
        },
      });
      return s;
    },

    // A field ring in each air gap, flat, and not additive: a light drawn over the bright stator teeth would only wash out
    field(ctx) {
      const { g, view } = ctx;
      const mat = new T.ShaderMaterial({
        uniforms: {
          uP: { value: g.p },
          uPhi: { value: 0 },
          uAmp: { value: 1 },
          uRi: { value: g.Ri },
          uRo: { value: g.Ro },
          uN: { value: new T.Color(P.north) },
          uS: { value: new T.Color(P.south) },
        },
        vertexShader: S.vert,
        fragmentShader: S.fieldFrag(S.ringEdge.flat(), '0.1', '0.5'),
        transparent: true,
        depthWrite: false,
        side: T.DoubleSide,
      });
      const mesh = new T.Group();
      [-1, 1].forEach((sg) => {
        const ring = new T.Mesh(flatRing(g.Ri, g.Ro), mat);
        ring.position.z = sg * g.gapZ;
        ring.renderOrder = 5;
        mesh.add(ring);
      });
      return {
        mesh,
        anchor: new T.Vector3(g.rMid * Math.cos(0.45), g.rMid * Math.sin(0.45), g.gapZ),
        label: 'Air-gap field (orange = flux from rotor into stator)',
        update(st) {
          const amp = st.power === undefined ? 1 : st.power;
          mesh.visible = view.showField && amp > 0.01;
          mat.uniforms.uP.value = st.polePairs;
          mat.uniforms.uPhi.value = st.fieldAngle;
          mat.uniforms.uAmp.value = amp;
        },
      };
    },

    // The blur shell lies on the outside of each disc; on the front one it leaves the notch open
    blur(ctx) {
      const { g, view } = ctx;
      const mat = new T.ShaderMaterial({
        uniforms: { uBlur: { value: 0 }, uPhase: { value: 0 }, uRi: { value: g.Rsh + 0.1 }, uRo: { value: g.Ro }, uColor: { value: new T.Color(0x66aaff) } },
        vertexShader: S.vert,
        fragmentShader: S.blurFrag(S.ringEdge.flat()),
        transparent: true,
        depthWrite: false,
        side: T.DoubleSide,
        blending: T.AdditiveBlending,
      });
      const c = view.cutCenterDeg * DEG;
      const h = view.cutHalfWidthDeg * DEG;
      const mesh = new T.Group();
      [-1, 1].forEach((sg) => {
        const cut = sg > 0 && view.cutaway;
        const ring = new T.Mesh(cut ? flatRing(g.Rsh + 0.1, g.Ro, c + h, c - h + TAU) : flatRing(g.Rsh + 0.1, g.Ro), mat);
        ring.position.z = sg * (g.zO + 0.012);
        ring.renderOrder = 7;
        mesh.add(ring);
      });
      return {
        mesh,
        update(st) {
          mesh.visible = st.blur > 0.01;
          mat.uniforms.uBlur.value = st.blur;
          mat.uniforms.uPhase.value = st.streakPhase;
          mat.uniforms.uColor.value.copy(st.speedColor);
        },
      };
    },
  };

  K.register('axial-flux', {
    label: 'Axial-flux PM synchronous motor (double rotor)',
    synchronous: true,
    layout: AXIAL_LAYOUT,
    parts,
    defaults: { poles: 16, statorSlots: 48, magnetCoverage: 0.78, magnetThickness: 0.06, discThickness: 0.1, loadAngleDeg: 60, drivetrain: { gearRatio: 1 } },
    presets: {
      'Axial flux · 16 poles · 48 slots · direct drive': { poles: 16, statorSlots: 48, magnetCoverage: 0.78, magnetThickness: 0.06, discThickness: 0.1, loadAngleDeg: 60 },
      'Axial flux · 12 poles · 36 slots · direct drive': { poles: 12, statorSlots: 36, magnetCoverage: 0.8, magnetThickness: 0.07, discThickness: 0.1, loadAngleDeg: 60 },
    },
    validate(s, need, num) {
      num(s, 'magnetCoverage', 0.4, 0.95, 'Magnet coverage');
      num(s, 'magnetThickness', 0.02, 0.2, 'Magnet thickness');
      num(s, 'discThickness', 0.03, 0.3, 'Disc thickness');
      num(s, 'loadAngleDeg', -85, 85, 'Load angle (electrical degrees)');
    },

    labels(ctx, built) {
      const { g, view } = ctx;
      const c = view.cutCenterDeg * DEG; // the notch faces the default view; the labels are spread around it
      const at = (r, a, z) => new T.Vector3(r * Math.cos(a), r * Math.sin(a), z);
      return [
        { text: 'Stator ring (slots on both faces)', pos: at(g.Ro, c - 0.62, g.zT) },
        { text: 'Toroidal winding', pos: at(g.Ro + 0.05, c + 0.85, g.zT) },
        { text: built.field.label, pos: at(g.rMid, c - 0.1, g.gapZ) },
        { text: 'Shaft', pos: new T.Vector3(0, g.Rsh + 0.02, g.endZ + 0.28) },
      ];
    },

    // Two discs on the shaft, each carrying magnets; the front one is cut away. The notch stays still while the disc turns through it.
    buildRotor(ctx) {
      const { spec, g, view } = ctx;
      const group = new T.Group();
      const planes = H.cutPlanes(view);
      const fadeMats = [];
      const t = spec.discThickness;
      const pitch = TAU / spec.poles;
      const halfWidth = (spec.magnetCoverage * pitch) / 2;
      [1, -1].forEach((sg) => {
        const clip = sg > 0 ? planes : null;
        const side = sg > 0 ? 'front' : 'back';
        const disc = H.piece(new T.Group(), {
          id: 'disc' + (sg > 0 ? 'Front' : 'Back'),
          name: 'Rotor disc (' + side + ')',
          dir: [0, 0, sg],
          dist: g.xFar,
          step: 1,
          info: {
            role: 'A steel disc on the shaft that carries the magnets and closes their flux from one pole to the next. The two discs pull on the stator with the same force from opposite sides, so the forces along the axis cancel and the bearings do not have to carry them.',
            material: 'Steel',
            facts: [spec.drivetrain.gearRatio === 1 ? 'Direct drive: it turns at the speed of the wheelset' : 'Gear ratio ' + spec.drivetrain.gearRatio],
          },
        });
        disc.add(new T.Mesh(H.ring(g.Ro, g.Rsh + 0.002, 0, TAU, t, 96), H.clip(H.stdMat(P.housing, 0.45, 0.5, { side: T.DoubleSide }), clip)));
        disc.position.z = sg * (g.zR + t / 2);
        group.add(disc);

        const magnets = H.piece(new T.Group(), {
          id: 'magnets' + (sg > 0 ? 'Front' : 'Back'),
          name: 'Magnets (' + side + ')',
          dir: [0, 0, sg],
          dist: g.xNear,
          step: 2,
          labelBelow: true,
          info: {
            role: 'N and S magnets on the disc, wedge-shaped because a pole covers the same angle at every radius. At each angle the same pole faces the stator from both sides (the NN arrangement), so the flux of the two discs meets in the stator ring and turns along it. As in any PM synchronous motor the rotor turns exactly in step with the field.',
            material: 'Neodymium-iron-boron (NdFeB), glued to the disc',
            facts: [spec.poles + ' magnets on this disc, so the rotor turns once every ' + g.p + ' cycles of f₁: that is how a slow direct drive still gets a usable inverter frequency'],
          },
        });
        const north = H.clip(H.stdMat(P.north, 0.35, 0.45, { side: T.DoubleSide }), clip);
        const south = H.clip(H.stdMat(P.south, 0.35, 0.45, { side: T.DoubleSide }), clip);
        fadeMats.push(north, south);
        for (let i = 0; i < spec.poles; i++) {
          const c = i * pitch; // magnet 0 (N) faces the 0° direction of the rotor
          const m = new T.Mesh(H.ring(g.Ro, g.Ri, c - halfWidth, c + halfWidth, spec.magnetThickness, 12), i % 2 === 0 ? north : south);
          m.position.z = sg * (g.zM + spec.magnetThickness / 2);
          magnets.add(m);
        }
        group.add(magnets);
      });
      const a = (view.cutCenterDeg - view.cutHalfWidthDeg) * DEG - 0.75; // on the disc, just past the lower edge of the notch
      return {
        group,
        fadeMats,
        labels: [{ text: 'Rotor disc + magnets (one each side)', pos: new T.Vector3(g.Ro * Math.cos(a), g.Ro * Math.sin(a), g.zO) }],
      };
    },
  });
})(window.VVVF3D);
