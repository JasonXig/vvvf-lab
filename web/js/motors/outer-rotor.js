// Permanent-magnet synchronous motor with an outer rotor: the stator sits in the middle on a fixed spindle, and the rotor is a drum that
// turns around it with the magnets on its inside. Seen in hub motors, fans and direct drives: the large air-gap diameter gives a lot of
// torque at low speed, so it can turn the axle without a gearbox (the default here is direct drive, gear ratio 1).
// This file is the example of a motor type that changes the topology: it brings its own layout (dimensions, checks, derived geometry)
// and overrides the stator, windings, housing, shaft, field and blur parts, reusing the shared implementations where it can.
(function (NS) {
  'use strict';

  const T = THREE;
  const K = NS.MotorKit;
  const P = K.palette;
  const H = K.helpers;
  const TAU = K.TAU;
  const DEG = Math.PI / 180;

  // Radii from the axis outwards: spindle Rsh < stator support < stator inner radius Rsi < slot bottoms Rs < tooth tips Rso
  //   < air gap < magnet face Rm < inside of the drum (Rm + magnetThickness) < outside of the drum Ro
  const OUTER_LAYOUT = {
    defaults: {
      length: 1.2, // core length
      outerRadius: 1.0, // outer radius of the rotor drum, i.e. of the whole motor
      statorRadius: 0.72, // stator outer radius (tooth tips)
      statorInnerRadius: 0.36, // stator inner radius, where it sits on the support
      slotDepth: 0.2,
      airGap: 0.03,
      shaftRadius: 0.15, // the spindle, which does not turn
      toothFraction: 0.52,
    },
    validate(s, need, num) {
      num(s, 'length', 0.4, 3, 'Core length');
      num(s, 'outerRadius', 0.5, 2, 'Drum outer radius');
      num(s, 'statorRadius', 0.3, 1.8, 'Stator outer radius');
      num(s, 'statorInnerRadius', 0.1, 1.5, 'Stator inner radius');
      num(s, 'slotDepth', 0.05, 0.6, 'Slot depth');
      num(s, 'airGap', 0.005, 0.1, 'Air gap');
      num(s, 'shaftRadius', 0.05, 0.6, 'Spindle radius');
      num(s, 'toothFraction', 0.3, 0.8, 'Tooth fraction');
      need(s.statorInnerRadius < s.statorRadius - s.slotDepth - 0.05, 'The stator yoke is too thin: statorInnerRadius must be at least 0.05 below statorRadius − slotDepth');
      need(s.shaftRadius < s.statorInnerRadius - 0.05, 'shaftRadius must be at least 0.05 below statorInnerRadius (room for the stator support)');
      need(s.statorRadius + s.airGap < s.outerRadius - 0.05, 'The rotor will not fit: outerRadius must be at least 0.05 above statorRadius + airGap');
    },
    derive(s) {
      const g = {
        L: s.length,
        Ro: s.outerRadius,
        Rso: s.statorRadius,
        Rs: s.statorRadius - s.slotDepth,
        Rsi: s.statorInnerRadius,
        Rm: s.statorRadius + s.airGap,
        Rsh: s.shaftRadius,
        p: s.poles / 2,
        Z: s.statorSlots,
        slotDepth: s.slotDepth,
      };
      g.delta = TAU / g.Z;
      g.rMid = g.Rso - s.slotDepth * 0.55; // centre radius of the conductors in the slots
      g.gapR = g.Rso + s.airGap / 2;
      // The shared end turns stand out up to 0.2 + 0.2/p beyond the core; the end plate of the drum sits just behind them,
      // and the front of the drum stays open so the end turns peek out of it
      g.endZ = g.L / 2 + 0.26 + 0.2 / g.p;
      g.frontZ = g.L / 2 + 0.08;
      g.hubR = g.Rsh + 0.12;
      // exploded view: the drum comes off forwards (near step), the magnets further (far step)
      g.xNear = g.L + 0.9;
      g.xFar = 2 * g.L + 1.3;
      return g;
    },
  };

  // The stator is the inner member here, so it stays whole, like the rotor of an inner-rotor motor; the cut-away goes through the drum
  const whole = (g) => ({ full: true, k0: 0, k1: g.Z, a0: 0, a1: TAU });

  const drumPiece = ({ spec, g }) => {
    const gear = spec.drivetrain.gearRatio;
    return {
      id: 'drum',
      name: 'Rotor drum',
      dir: [0, 0, 1],
      dist: g.xNear,
      step: 0,
      info: {
        role: 'The rotor: a steel drum that carries the magnets on its inside and closes their flux path from one pole to the next. It turns around the stator on the bearing at its hub; on a direct drive it turns the wheel or axle without a gearbox.',
        material: 'Steel',
        facts: [(gear === 1 ? 'Direct drive (gear ratio 1)' : 'Gear ratio ' + gear) + ': ' + H.rpmAt(spec, 100) + ' rpm at 100 km/h'],
      },
    };
  };

  // Info cards of the exploded view: the stator card is the shared one with the slots turned outwards
  const statorPiece = (ctx) => {
    const m = K.pieces.stator(ctx);
    return Object.assign(m, {
      name: 'Stator core (slots facing out)',
      dir: [0, 0, -1], // slides off the spindle backwards
      dist: ctx.g.xNear,
      info: Object.assign({}, m.info, {
        role: 'The same slotted stack of electrical-steel sheets as in any motor, turned inside out: the slots open outwards, towards the air gap and the magnets on the drum.',
      }),
    });
  };

  const parts = {
    stator: (ctx) => H.piece(new T.Mesh(H.slottedCore(ctx, ctx.g.Rso, ctx.g.Rs, ctx.g.Rsi, whole(ctx.g)), H.stdMat(P.steel, 0.55, 0.42)), statorPiece(ctx)),
    windings(ctx) {
      const w = K.parts.windings(Object.assign({}, ctx, { kept: whole(ctx.g) }));
      Object.assign(w.group.userData.explode, { dist: ctx.g.xFar + 0.2, step: 2 }); // behind the stator, which comes off first
      return w;
    },

    // Nothing here turns: the fixed spindle, and the support (a spider with lightening holes) that carries the stator
    housing(ctx) {
      const { g } = ctx;
      const group = H.piece(new T.Group(), {
        id: 'spindle',
        name: 'Fixed spindle + stator support',
        dir: [0, 0, -1],
        dist: 0, // the fixed part: everything else comes off it
        info: {
          role: 'The spindle does not turn. It carries the stator through the support (the spider with the round holes), and the drum turns around it on bearings. In hub motors the cables usually come in through a hollow spindle.',
          material: 'Steel spindle; cast or welded support',
          facts: [],
        },
      });
      group.add(new T.Mesh(H.cyl(g.Rsh, 2 * (g.endZ + 0.5), 48), H.stdMat(P.shaft, 0.85, 0.28)));
      const shape = new T.Shape();
      shape.absarc(0, 0, g.Rsi + 0.004, 0, TAU, false);
      const bore = new T.Path();
      bore.absarc(0, 0, g.Rsh, 0, TAU, true);
      shape.holes.push(bore);
      const rc = (g.Rsi + g.Rsh) / 2;
      const rh = (g.Rsi - g.Rsh) * 0.28;
      for (let i = 0; i < 6; i++) {
        const a = ((i + 0.5) * TAU) / 6;
        const hole = new T.Path();
        hole.absarc(rc * Math.cos(a), rc * Math.sin(a), rh, 0, TAU, true);
        shape.holes.push(hole);
      }
      group.add(new T.Mesh(H.extrude(shape, g.L * 0.94, 32), H.stdMat(0x6b7787, 0.7, 0.4)));
      return { group, setOpacity() {} };
    },

    // What turns with the drum besides the drum itself: the hub on its bearing around the spindle, and two light markers (front rim, back hub)
    shaft(ctx) {
      const { spec, g, view } = ctx;
      const group = H.piece(new T.Group(), drumPiece(ctx)); // hub and markers come off together with the drum
      const hub = new T.Mesh(H.ring(g.hubR, g.Rsh + 0.004, 0, TAU, 0.3), H.stdMat(0x6b7787, 0.7, 0.4));
      hub.position.z = -(g.endZ + 0.12);
      group.add(hub);
      const markMat = H.clip(new T.MeshStandardMaterial({ color: P.marker, emissive: P.marker, emissiveIntensity: 0.5, roughness: 0.5 }), H.cutPlanes(view));
      const drumIn = g.Rm + spec.magnetThickness;
      const rim = new T.Mesh(new T.BoxGeometry((g.Ro - drumIn) * 0.8, 0.07, 0.05), markMat);
      rim.position.set((g.Ro + drumIn) / 2, 0, g.frontZ + 0.02);
      group.add(rim);
      const back = new T.Mesh(new T.BoxGeometry(0.06, 0.06, 0.2), markMat);
      back.position.set(g.hubR + 0.02, 0, -(g.endZ + 0.12));
      group.add(back);
      return group;
    },

    // The shared field ring, now just outside the stator teeth; seen from the stator, orange is still where the flux comes in from the rotor N poles
    field(ctx) {
      const f = K.parts.field(ctx);
      f.label = 'Air-gap field (orange = flux from rotor into stator)';
      return f;
    },

    // The blur shell wraps the outside of the drum; when cut away it leaves the notch open
    blur(ctx) {
      const { g, view } = ctx;
      const c = view.cutCenterDeg * DEG;
      const h = view.cutHalfWidthDeg * DEG;
      const arc = view.cutaway ? { a0: c + h, a1: c - h + TAU } : {};
      return K.parts.blur(ctx, Object.assign({ radius: g.Ro + 0.012, half: g.L * 0.5 }, arc));
    },
  };

  K.register('outer-rotor', {
    label: 'Permanent-magnet synchronous motor (outer rotor)',
    synchronous: true,
    layout: OUTER_LAYOUT,
    parts,
    defaults: { poles: 16, statorSlots: 48, magnetCoverage: 0.8, magnetThickness: 0.06, loadAngleDeg: 18, drivetrain: { gearRatio: 1 } },
    presets: {
      'Outer rotor · 16 poles · 48 slots · direct drive': { poles: 16, statorSlots: 48, magnetCoverage: 0.8, magnetThickness: 0.06, loadAngleDeg: 18 },
      'Outer rotor · 12 poles · 36 slots · direct drive': { poles: 12, statorSlots: 36, magnetCoverage: 0.82, magnetThickness: 0.07, loadAngleDeg: 20 },
    },
    validate(s, need, num) {
      num(s, 'magnetCoverage', 0.4, 0.95, 'Magnet coverage');
      num(s, 'magnetThickness', 0.02, 0.2, 'Magnet thickness');
      num(s, 'loadAngleDeg', -60, 60, 'Load angle (deg)');
      need(s.statorRadius + s.airGap + s.magnetThickness < s.outerRadius - 0.05, 'The drum is too thin: outerRadius must be at least 0.05 above statorRadius + airGap + magnetThickness');
    },

    labels(ctx, built) {
      const { g, view } = ctx;
      const c = view.cutCenterDeg * DEG; // the notch faces the default view; the labels are spread around it
      const at = (r, a, z) => new T.Vector3(r * Math.cos(a), r * Math.sin(a), z);
      return [
        { text: 'Stator core (slots facing out)', pos: at(g.Rso, c - 0.75, 0) },
        { text: 'Three-phase winding (slot conductors + end turns)', pos: at(g.rMid, c + 1.1, g.L / 2 + 0.17 + 0.2 / g.p) },
        { text: built.field.label, pos: at(g.gapR, c - 0.25, -g.L * 0.3) },
        { text: 'Fixed spindle + stator support', pos: new T.Vector3(0, g.Rsh + 0.02, g.endZ + 0.42) },
      ];
    },

    buildRotor(ctx) {
      const { spec, g, view } = ctx;
      const planes = H.cutPlanes(view); // the notch is fixed in space while the drum turns through it
      const group = new T.Group();
      const drumIn = g.Rm + spec.magnetThickness;

      // The drum: back iron for the magnets, plus its end plate at the back; it is also the outer shell, so it follows the shell-opacity slider
      const drumMat = H.clip(new T.MeshStandardMaterial({ color: P.housing, metalness: 0.45, roughness: 0.5, side: T.DoubleSide }), planes);
      const shell = H.piece(new T.Group(), drumPiece(ctx));
      group.add(shell);
      const drum = new T.Mesh(H.ring(g.Ro, drumIn, 0, TAU, g.frontZ + g.endZ, 96), drumMat);
      drum.position.z = (g.frontZ - g.endZ) / 2;
      drum.renderOrder = 6;
      shell.add(drum);
      const plate = new T.Mesh(H.ring(drumIn + 0.002, g.hubR - 0.01, 0, TAU, 0.07, 96), drumMat);
      plate.position.z = -g.endZ;
      plate.renderOrder = 6;
      shell.add(plate);

      // Magnets on the inside of the drum, N and S alternating; the colour is the pole that faces the air gap
      const northMat = H.clip(H.stdMat(P.north, 0.35, 0.45, { side: T.DoubleSide }), planes);
      const southMat = H.clip(H.stdMat(P.south, 0.35, 0.45, { side: T.DoubleSide }), planes);
      const pitch = TAU / spec.poles;
      const halfWidth = (spec.magnetCoverage * pitch) / 2;
      const magnets = H.piece(new T.Group(), {
        id: 'magnets',
        name: 'Permanent magnets (on the drum)',
        dir: [0, 0, 1],
        dist: g.xFar,
        info: {
          role: 'N and S magnets on the inside of the drum, facing the air gap. As in any PM synchronous motor they turn exactly in step with the rotating field, so the rotor turns once for every p cycles of f₁.',
          material: 'Neodymium-iron-boron (NdFeB), glued to the drum',
          facts: [spec.poles + ' magnets, so the rotor turns once every ' + g.p + ' cycles of f₁: that is how a slow direct drive still gets a usable inverter frequency'],
        },
      });
      group.add(magnets);
      for (let i = 0; i < spec.poles; i++) {
        const c = i * pitch; // magnet 0 (N) faces the 0° direction of the rotor
        magnets.add(new T.Mesh(H.ring(drumIn, g.Rm, c - halfWidth, c + halfWidth, g.L * 0.98), i % 2 === 0 ? northMat : southMat));
      }

      const a = view.cutCenterDeg * DEG - view.cutHalfWidthDeg * DEG - 0.25; // on the drum, just past the lower edge of the notch
      return {
        group,
        fadeMats: [northMat, southMat],
        labels: [{ text: 'Outer rotor: drum with magnets inside', pos: new T.Vector3(g.Ro * Math.cos(a), g.Ro * Math.sin(a), g.frontZ) }],
        setOpacity(o) {
          const solid = o >= 0.999;
          drumMat.transparent = !solid;
          drumMat.depthWrite = solid;
          drumMat.opacity = o;
          drumMat.needsUpdate = true;
        },
      };
    },
  });
})(window.VVVF3D);
