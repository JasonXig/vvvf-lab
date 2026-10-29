// Motor kit: shared parts (stator, windings, housing, shaft, air-gap field, speed-blur shell) and the "motor type registry".
// A new motor type only has to implement the rotor: write one file in js/motors/ and call MotorKit.register(...).
// A type with another topology also brings its own layout and overrides some parts (js/motors/outer-rotor.js is the example).
// Coordinate convention: the motor axis is Z; seen from the +Z end, counter-clockwise is the positive direction of rotation.
(function (NS) {
  'use strict';

  const T = THREE;
  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;

  const PALETTE = {
    phase: [0xf2c230, 0x3dbb6a, 0xe5484d], // A yellow, B green, C red (phase colours)
    north: 0xff8a3d, // air-gap flux crossing from the rotor into the stator (the rotor N-pole side)
    south: 0x3d8bff, // air-gap flux crossing from the stator into the rotor
    steel: 0x9aa5b4,
    steelDark: 0x5d6877,
    housing: 0x7c93b0,
    shaft: 0xc3cbd6,
    copper: 0xc8793c,
    marker: 0xfff2b0,
  };

  // Geometry shared by all motors (length unit is arbitrary; the motor outer diameter is about 2)
  const COMMON_DEFAULTS = {
    length: 1.4, // core length
    outerRadius: 1.0, // stator outer radius
    boreRadius: 0.62, // stator inner radius (bore)
    slotDepth: 0.24, // slot depth
    airGap: 0.03, // air gap (exaggerated compared with reality so it can be seen)
    shaftRadius: 0.17,
    toothFraction: 0.52, // fraction of the slot pitch taken by the tooth
  };

  const VIEW_DEFAULTS = {
    cutaway: true,
    cutCenterDeg: 36, // direction of the centre of the cut-away notch (in the XY plane, counter-clockwise from +X)
    cutHalfWidthDeg: 52,
    shellOpacity: 0.3,
    showField: true,
    showWinding: true,
    showRotorCurrent: true,
  };

  // Phase belts of the three-phase winding: 6 belts per pole pair, in order A+, C−, B+, A−, C+, B− (phase sequence A→B→C rotates counter-clockwise)
  const BELTS = [
    { ph: 0, s: 1 },
    { ph: 2, s: -1 },
    { ph: 1, s: 1 },
    { ph: 0, s: -1 },
    { ph: 2, s: 1 },
    { ph: 1, s: -1 },
  ];

  const registry = {};

  function register(type, def) {
    registry[type] = def;
  }
  function typeList() {
    return Object.keys(registry).map((type) => ({ type, label: registry[type].label }));
  }
  function presetList() {
    const out = [];
    Object.keys(registry).forEach((type) => {
      const presets = registry[type].presets || {};
      Object.keys(presets).forEach((name) => out.push({ name, spec: Object.assign({ type }, presets[name]) }));
    });
    return out;
  }
  function defaultSpec(type) {
    return Object.assign({ type }, registry[type].defaults);
  }

  // ---- Parameter checks -------------------------------------------------------------
  function need(cond, msg) {
    if (!cond) throw new Error(msg);
  }
  function num(s, key, lo, hi, label) {
    const v = s[key];
    need(typeof v === 'number' && isFinite(v) && v >= lo && v <= hi, label + ' ' + key + ' must be a number between ' + lo + ' and ' + hi);
  }

  // ---- Layouts: the topology of the machine (where the stator, the air gap and the rotor sit) --------------
  // A layout supplies the default dimensions, their checks, and the derived geometry g that the parts read.
  // The default is the classic inner rotor (radial flux, rotor inside the stator bore); a motor type with another
  // topology passes its own layout to register() (see js/motors/outer-rotor.js).
  const INNER_LAYOUT = {
    defaults: COMMON_DEFAULTS,
    validate(s, need, num) {
      num(s, 'length', 0.4, 3, 'Core length');
      num(s, 'outerRadius', 0.5, 2, 'Stator outer radius');
      num(s, 'boreRadius', 0.2, 1.5, 'Bore radius');
      num(s, 'slotDepth', 0.05, 0.6, 'Slot depth');
      num(s, 'airGap', 0.005, 0.1, 'Air gap');
      num(s, 'shaftRadius', 0.05, 0.6, 'Shaft radius');
      num(s, 'toothFraction', 0.3, 0.8, 'Tooth fraction');
      need(s.boreRadius + s.slotDepth < s.outerRadius - 0.05, 'The slot-bottom radius (boreRadius + slotDepth) must be at least 0.05 below outerRadius');
      need(s.shaftRadius < s.boreRadius - s.airGap - 0.12, 'shaftRadius is too large, the rotor will not fit');
    },
    derive(s) {
      const g = {
        L: s.length,
        Ro: s.outerRadius,
        Ri: s.boreRadius,
        Rs: s.boreRadius + s.slotDepth,
        Rr: s.boreRadius - s.airGap,
        Rsh: s.shaftRadius,
        p: s.poles / 2,
        Z: s.statorSlots,
        slotDepth: s.slotDepth,
      };
      g.delta = TAU / g.Z;
      g.endZ = g.L / 2 + 0.42; // end-cap position
      g.Rframe = g.Ro + 0.07;
      g.hubR = g.Rsh + 0.16;
      g.rMid = g.Ri + s.slotDepth * 0.55; // centre radius of the conductors in the slots
      g.gapR = (g.Ri + g.Rr) / 2; // middle of the air gap, where the field ring is drawn
      return g;
    },
  };
  const layoutOf = (def) => def.layout || INNER_LAYOUT;

  function normalizeSpec(input) {
    need(input && typeof input === 'object' && !Array.isArray(input), 'The motor definition must be a JSON object');
    const def = registry[input.type];
    need(def, 'Unknown motor type: ' + input.type + '; available: ' + Object.keys(registry).join(', '));
    const layout = layoutOf(def);
    const s = Object.assign({}, layout.defaults, def.defaults, input);
    s.drivetrain = Object.assign({}, NS.Drive.DEFAULT_DRIVE, (def.defaults || {}).drivetrain, input.drivetrain || {});
    need(Number.isInteger(s.poles) && s.poles >= 2 && s.poles <= 16 && s.poles % 2 === 0, 'poles must be an even number from 2 to 16');
    need(
      Number.isInteger(s.statorSlots) && s.statorSlots >= 3 * s.poles && s.statorSlots <= 96,
      'statorSlots must be an integer, at least 3×poles and at most 96'
    );
    layout.validate(s, need, num);
    if (def.validate) def.validate(s, need, num);
    return s;
  }

  // Range of slots kept after cutting [k0, k1) (the boundaries fall on tooth centres, so the cut is clean)
  function keptRange(g, view) {
    const full = { full: true, k0: 0, k1: g.Z, a0: 0, a1: TAU };
    if (!view.cutaway) return full;
    const c = view.cutCenterDeg * DEG;
    const h = view.cutHalfWidthDeg * DEG;
    const k0 = Math.ceil((c + h) / g.delta - 1e-9);
    const k1 = Math.floor((c - h + TAU) / g.delta + 1e-9);
    if (k1 - k0 < 3) return full;
    return { full: false, k0, k1, a0: k0 * g.delta, a1: k1 * g.delta };
  }

  // ---- Small shared geometry helpers --------------------------------------------------
  const helpers = {
    stdMat(color, metalness, roughness, extra) {
      return new T.MeshStandardMaterial(Object.assign({ color, metalness, roughness }, extra || {}));
    },
    // cylinder along the Z axis
    cyl(r, len, seg) {
      return new T.CylinderGeometry(r, r, len, seg || 64).rotateX(Math.PI / 2);
    },
    // ring (or ring sector) extruded along the Z axis, centred on the origin
    ring(rOut, rIn, a0, a1, depth, curveSegments) {
      const shape = new T.Shape();
      if (a1 - a0 >= TAU - 1e-6) {
        shape.absarc(0, 0, rOut, 0, TAU, false);
        if (rIn > 0) {
          const hole = new T.Path();
          hole.absarc(0, 0, rIn, 0, TAU, true);
          shape.holes.push(hole);
        }
      } else {
        shape.absarc(0, 0, rOut, a0, a1, false);
        shape.absarc(0, 0, rIn, a1, a0, true);
        shape.closePath();
      }
      return helpers.extrude(shape, depth, curveSegments);
    },
    extrude(shape, depth, curveSegments) {
      const geo = new T.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: curveSegments || 48, steps: 1 });
      geo.translate(0, 0, -depth / 2);
      return geo;
    },
    letterTexture(ch, color) {
      const c = document.createElement('canvas');
      c.width = c.height = 128;
      const x = c.getContext('2d');
      x.font = 'bold 100px sans-serif';
      x.textAlign = 'center';
      x.textBaseline = 'middle';
      x.fillStyle = color;
      x.fillText(ch, 64, 70);
      const tex = new T.CanvasTexture(c);
      tex.colorSpace = T.SRGBColorSpace;
      return tex;
    },
    // Slotted lamination stack: one edge carries the teeth (tooth tips at tipR, slot bottoms at bottomR), the other edge is a plain circle at plainR.
    // Inner rotor: teeth on the inside (tipR < bottomR < plainR); outer rotor: teeth on the outside (plainR < bottomR < tipR).
    // kept is the range of slots to build (see keptRange); its boundaries fall on tooth centres, so the cut is clean.
    slottedCore(ctx, tipR, bottomR, plainR, kept) {
      const { spec, g } = ctx;
      const half = ((1 - spec.toothFraction) * g.delta) / 2; // half angular width of a slot
      const P = (r, a) => new T.Vector2(r * Math.cos(a), r * Math.sin(a));
      const arc = (r, a0, a1, n, skipFirst) => {
        const out = [];
        for (let i = skipFirst ? 1 : 0; i <= n; i++) out.push(P(r, a0 + ((a1 - a0) * i) / n));
        return out;
      };
      // Toothed edge: starting from a tooth centre, through tooth tip, slot wall, slot bottom, slot wall, tooth tip...
      const edge = [];
      for (let k = kept.k0; k < kept.k1; k++) {
        const c = (k + 0.5) * g.delta;
        const s0 = c - half;
        const s1 = c + half;
        edge.push(...arc(tipR, k * g.delta, s0, 2, k > kept.k0));
        edge.push(...arc(bottomR, s0, s1, 3, false));
        edge.push(...arc(tipR, s1, (k + 1) * g.delta, 2, false));
      }
      const shape = new T.Shape();
      if (kept.full && plainR > tipR) {
        shape.absarc(0, 0, plainR, 0, TAU, false);
        shape.holes.push(new T.Path(edge));
      } else if (kept.full) {
        shape.setFromPoints(edge);
        const hole = new T.Path();
        hole.absarc(0, 0, plainR, 0, TAU, true);
        shape.holes.push(hole);
      } else {
        shape.setFromPoints(edge);
        shape.lineTo(plainR * Math.cos(kept.a1), plainR * Math.sin(kept.a1));
        shape.absarc(0, 0, plainR, kept.a1, kept.a0, true);
        shape.closePath();
      }
      return helpers.extrude(shape, g.L, 48);
    },
    // Clipping planes that remove the cut-away notch in world space. A part that turns (an outer-rotor drum) cannot have the notch in its
    // geometry, because the notch would turn with it; give its materials these planes instead: material.clippingPlanes = planes,
    // material.clipIntersection = true (only points inside both half-spaces, i.e. inside the wedge, are removed; needs cutHalfWidthDeg < 90).
    // Returns null when the view is not cut away. The renderer has localClippingEnabled on.
    cutPlanes(view) {
      if (!view.cutaway) return null;
      const b1 = (view.cutCenterDeg - view.cutHalfWidthDeg) * DEG;
      const b2 = (view.cutCenterDeg + view.cutHalfWidthDeg) * DEG;
      return [new T.Plane(new T.Vector3(Math.sin(b1), -Math.cos(b1), 0), 0), new T.Plane(new T.Vector3(-Math.sin(b2), Math.cos(b2), 0), 0)];
    },
    // Apply cutPlanes(view) to a material (no-op when planes is null); returns the material
    clip(mat, planes) {
      if (planes) {
        mat.clippingPlanes = planes;
        mat.clipIntersection = true;
      }
      return mat;
    },
  };

  function disposeObject(root) {
    root.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      const mats = o.material ? (Array.isArray(o.material) ? o.material : [o.material]) : [];
      mats.forEach((m) => {
        if (m.map) m.map.dispose();
        m.dispose();
      });
      if (o.isInstancedMesh) o.dispose();
    });
  }

  // ---- Three-phase windings: in-slot conductors (instanced bars) + end connections ----------------
  function buildWindings(ctx) {
    const { g, kept, view } = ctx;
    const group = new T.Group();
    const p = g.p;
    const slots = [];
    for (let k = kept.k0; k < kept.k1; k++) {
      const km = ((k % g.Z) + g.Z) % g.Z;
      const belt = Math.floor(((km + 0.5) / g.Z) * 6 * p) % (6 * p);
      const cfg = BELTS[belt % 6];
      slots.push({ angle: (k + 0.5) * g.delta, ph: cfg.ph, s: cfg.s });
    }

    const slotW = (1 - ctx.spec.toothFraction) * g.delta * g.rMid;
    const rodGeo = new T.BoxGeometry(g.slotDepth * 0.6, slotW * 0.66, g.L + 0.14);
    const rodMat = new T.MeshStandardMaterial({ color: 0xffffff, metalness: 0.25, roughness: 0.45 });
    const rods = new T.InstancedMesh(rodGeo, rodMat, slots.length);
    rods.frustumCulled = false;
    const m4 = new T.Matrix4();
    const q = new T.Quaternion();
    const pos = new T.Vector3();
    const one = new T.Vector3(1, 1, 1);
    const zAxis = new T.Vector3(0, 0, 1);
    const base = PALETTE.phase.map((c) => new T.Color(c));
    slots.forEach((s, i) => {
      q.setFromAxisAngle(zAxis, s.angle);
      pos.set(g.rMid * Math.cos(s.angle), g.rMid * Math.sin(s.angle), 0);
      m4.compose(pos, q, one);
      rods.setMatrixAt(i, m4);
      rods.setColorAt(i, base[s.ph]);
    });
    rods.instanceColor.needsUpdate = true;
    group.add(rods);

    // End connections: between the two phase belts one pole pitch apart in the same phase, one arc at the front and one at the back
    const snap = (a) => (Math.round(a / g.delta - 0.5) + 0.5) * g.delta;
    const inKept = (a) => {
      if (kept.full) return true;
      const x = (((a - kept.a0) % TAU) + TAU) % TAU;
      return x <= kept.a1 - kept.a0;
    };
    const tubeMats = PALETTE.phase.map(
      (c) => new T.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.2, metalness: 0.2, roughness: 0.5 })
    );
    let anchor = null;
    for (let b = 0; b < 6 * p; b++) {
      if (b % 6 > 2) continue;
      const a1 = snap(((b + 0.5) * Math.PI) / (3 * p));
      const a2 = snap(((b + 3.5) * Math.PI) / (3 * p));
      if (!inKept(a1) || !inKept(a2)) continue;
      const span = a2 - a1;
      [-1, 1].forEach((sg) => {
        const pts = [];
        const n = 18;
        const lift = 0.1 + 0.2 * Math.min(1, span / Math.PI);
        for (let i = 0; i <= n; i++) {
          const t = i / n;
          const a = a1 + span * t;
          pts.push(new T.Vector3(g.rMid * Math.cos(a), g.rMid * Math.sin(a), sg * (g.L / 2 + 0.07 + lift * Math.sin(Math.PI * t))));
        }
        const geo = new T.TubeGeometry(new T.CatmullRomCurve3(pts), 40, 0.03, 8, false);
        group.add(new T.Mesh(geo, tubeMats[BELTS[b % 6].ph]));
      });
      const am = a1 + span / 2; // the label is attached to the last coil in the kept range, away from the stator label
      anchor = new T.Vector3(g.rMid * Math.cos(am), g.rMid * Math.sin(am), g.L / 2 + 0.07 + 0.3);
    }

    const tmp = new T.Color();
    return {
      group,
      anchor,
      update(st) {
        group.visible = view.showWinding;
        const cur = st.currents;
        for (let i = 0; i < slots.length; i++) {
          const s = slots[i];
          const b = 0.5 + 0.5 * s.s * cur[s.ph]; // current direction × belt polarity: bright = out of the page, dark = into the page
          tmp.copy(base[s.ph]).multiplyScalar(0.16 + 0.84 * b);
          rods.setColorAt(i, tmp);
        }
        rods.instanceColor.needsUpdate = true;
        tubeMats.forEach((m, ph) => {
          m.emissiveIntensity = 0.1 + 1.1 * Math.abs(cur[ph]);
        });
      },
    };
  }

  // ---- Housing, end caps, bearing hubs ------------------------------------------------------
  function buildHousing(ctx) {
    const { g, kept, view } = ctx;
    const group = new T.Group();
    const opaque = view.shellOpacity >= 0.999;
    const shellMat = new T.MeshStandardMaterial({
      color: PALETTE.housing,
      metalness: 0.4,
      roughness: 0.5,
      transparent: !opaque,
      opacity: view.shellOpacity,
      side: T.DoubleSide,
      depthWrite: opaque,
    });
    const shell = new T.Mesh(helpers.ring(g.Rframe, g.Ro + 0.005, kept.a0, kept.a1, 2 * g.endZ), shellMat);
    shell.renderOrder = 6;
    group.add(shell);
    const hubMat = helpers.stdMat(0x6b7787, 0.7, 0.4);
    [-1, 1].forEach((sg) => {
      const plate = new T.Mesh(helpers.ring(g.Rframe, g.hubR, kept.a0, kept.a1, 0.07), shellMat);
      plate.position.z = sg * g.endZ;
      plate.renderOrder = 6;
      group.add(plate);
      const hub = new T.Mesh(helpers.cyl(g.hubR, 0.3, 48), hubMat);
      hub.position.z = sg * (g.endZ + 0.12);
      group.add(hub);
    });
    return {
      group,
      setOpacity(o) {
        const solid = o >= 0.999;
        shellMat.transparent = !solid;
        shellMat.depthWrite = solid;
        shellMat.opacity = o;
        shellMat.needsUpdate = true;
      },
    };
  }

  // ---- Common rotor-side parts: shaft and rotation marker -----------------------------------
  function buildShaft(ctx) {
    const { g } = ctx;
    const group = new T.Group();
    group.add(new T.Mesh(helpers.cyl(g.Rsh, 2 * (g.endZ + 0.62), 48), helpers.stdMat(PALETTE.shaft, 0.85, 0.28)));
    const markMat = new T.MeshStandardMaterial({ color: PALETTE.marker, emissive: PALETTE.marker, emissiveIntensity: 0.5, roughness: 0.5 });
    [-1, 1].forEach((sg) => {
      const mark = new T.Mesh(new T.BoxGeometry(0.06, 0.06, 0.28), markMat);
      mark.position.set(g.Rsh + 0.02, 0, sg * (g.endZ + 0.46));
      group.add(mark);
    });
    return group;
  }

  // ---- Air-gap field: a colour ring cos(p·(θ − φ)) around the circumference, following the rotating field ----
  const FIELD_VERT = 'varying vec3 vPos;\nvoid main(){ vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }';
  const FIELD_FRAG = [
    'uniform float uP; uniform float uPhi; uniform float uAmp; uniform float uHalf;',
    'uniform vec3 uN; uniform vec3 uS; varying vec3 vPos;',
    'void main(){',
    '  float ang = atan(vPos.y, vPos.x);',
    '  float b = cos(uP * (ang - uPhi));',
    '  vec3 col = mix(uS, uN, 0.5 + 0.5 * b);',
    '  float edge = 1.0 - smoothstep(0.75, 1.0, abs(vPos.z) / uHalf);',
    '  float a = uAmp * (0.08 + 0.42 * abs(b)) * edge;',
    '  gl_FragColor = vec4(col, a);',
    '  #include <colorspace_fragment>',
    '}',
  ].join('\n');

  function buildField(ctx) {
    const { g, view } = ctx;
    const rg = g.gapR;
    const half = g.L * 0.48;
    const mat = new T.ShaderMaterial({
      uniforms: {
        uP: { value: g.p },
        uPhi: { value: 0 },
        uAmp: { value: 1 },
        uHalf: { value: half },
        uN: { value: new T.Color(PALETTE.north) },
        uS: { value: new T.Color(PALETTE.south) },
      },
      vertexShader: FIELD_VERT,
      fragmentShader: FIELD_FRAG,
      transparent: true,
      depthWrite: false,
      side: T.DoubleSide,
      blending: T.AdditiveBlending,
    });
    const mesh = new T.Mesh(new T.CylinderGeometry(rg, rg, 2 * half, 180, 1, true).rotateX(Math.PI / 2), mat);
    mesh.renderOrder = 5;
    return {
      mesh,
      anchor: new T.Vector3(rg * Math.cos(0.9), rg * Math.sin(0.9), half * 0.4),
      update(st) {
        // power: strength of the inverter output, 0..1. When coasting or with the inverter off there is no stator current, hence no rotating field
        const amp = st.power === undefined ? 1 : st.power;
        mesh.visible = view.showField && amp > 0.01;
        mat.uniforms.uP.value = st.polePairs;
        mat.uniforms.uPhi.value = st.fieldAngle;
        mat.uniforms.uAmp.value = amp;
      },
    };
  }

  // ---- Speed "blur" shell: the rotor blurs when it spins fast, and the blur colour follows the speed ----
  const BLUR_FRAG = [
    'uniform float uBlur; uniform float uPhase; uniform float uHalf; uniform vec3 uColor; varying vec3 vPos;',
    'void main(){',
    '  float x = atan(vPos.y, vPos.x) / 6.2831853 + 0.5 + uPhase;',
    '  float s1 = 0.5 + 0.5 * sin(x * 6.2831853 * 23.0 + 2.0 * sin(x * 6.2831853 * 5.0));',
    '  float s2 = 0.5 + 0.5 * sin(x * 6.2831853 * 41.0 + 1.7);',
    '  float s = pow(s1 * s2, 1.5);',
    '  float edge = 1.0 - smoothstep(0.7, 1.0, abs(vPos.z) / uHalf);',
    '  float a = uBlur * (0.16 + 0.62 * s) * edge;',
    '  gl_FragColor = vec4(uColor, a);',
    '  #include <colorspace_fragment>',
    '}',
  ].join('\n');

  // opt: { radius, half, a0, a1 } (default: just outside the inner rotor, full circle). The shell does not turn, so an outer rotor
  // that is cut away passes the kept angles a0..a1 (counter-clockwise) and gets a shell with the notch left open.
  function buildBlur(ctx, opt) {
    const { g } = ctx;
    const o = opt || {};
    const half = o.half || g.L * 0.49;
    const r = o.radius || g.Rr + 0.012;
    const a0 = o.a0 === undefined ? 0 : o.a0;
    const a1 = o.a1 === undefined ? TAU : o.a1;
    const mat = new T.ShaderMaterial({
      uniforms: {
        uBlur: { value: 0 },
        uPhase: { value: 0 },
        uHalf: { value: half },
        uColor: { value: new T.Color(0x66aaff) },
      },
      vertexShader: FIELD_VERT,
      fragmentShader: BLUR_FRAG,
      transparent: true,
      depthWrite: false,
      side: T.DoubleSide,
      blending: T.AdditiveBlending,
    });
    // CylinderGeometry measures its angle θ from +Z towards +X; after rotateX(π/2) a vertex at θ sits at angle θ − π/2 in the XY plane
    const geo = new T.CylinderGeometry(r, r, 2 * half, 128, 1, true, a0 + Math.PI / 2, a1 - a0).rotateX(Math.PI / 2);
    const mesh = new T.Mesh(geo, mat);
    mesh.renderOrder = 7;
    return {
      mesh,
      update(st) {
        mesh.visible = st.blur > 0.01;
        mat.uniforms.uBlur.value = st.blur;
        mat.uniforms.uPhase.value = st.streakPhase;
        mat.uniforms.uColor.value.copy(st.speedColor);
      },
    };
  }

  // ---- Assembling a motor -----------------------------------------------------------------------
  // Default parts. A motor type can override any of them with parts at register time, e.g. outer-rotor, axial-flux
  // and linear motors need their own stator; when overriding you can call MotorKit.parts.xxx(ctx) to reuse the default implementation.
  //   stator(ctx)   → THREE.Object3D
  //   windings(ctx) → { group, anchor, update(state) }
  //   housing(ctx)  → { group, setOpacity(o) } (does not turn)
  //   shaft(ctx)    → THREE.Object3D (turns together with the rotor)
  //   field(ctx)    → { mesh, anchor, label?, update(state) }
  //   blur(ctx)     → { mesh, update(state) } (does not turn)
  const DEFAULT_PARTS = {
    stator: (ctx) => new T.Mesh(helpers.slottedCore(ctx, ctx.g.Ri, ctx.g.Rs, ctx.g.Ro, ctx.kept), helpers.stdMat(PALETTE.steel, 0.55, 0.42)),
    windings: buildWindings,
    housing: buildHousing,
    shaft: buildShaft,
    field: buildField,
    blur: buildBlur,
  };

  // Labels of the shared parts: { text, pos } with positions in the motor local coordinates. A motor type with another
  // layout replaces this with labels(ctx, { winding, field }) at register time; the rotor's own labels are added after it.
  function defaultLabels(ctx, built) {
    const { g, kept } = ctx;
    const a = kept.full ? 0.9 : kept.a0 + 0.04; // along the top edge of the cut, above the motor from the default view
    const labels = [
      { text: 'Stator core (slotted)', pos: new T.Vector3(((g.Rs + g.Ro) / 2) * Math.cos(a), ((g.Rs + g.Ro) / 2) * Math.sin(a), g.L * 0.3) },
      { text: built.field.label || 'Air-gap field (orange / blue = flux direction)', pos: built.field.anchor },
      { text: 'Shaft', pos: new T.Vector3(0, g.Rsh + 0.02, g.endZ + 0.55) },
    ];
    if (built.winding.anchor) labels.splice(1, 0, { text: 'Three-phase winding (slot conductors + end turns)', pos: built.winding.anchor });
    return labels;
  }

  function build(rawSpec, rawView) {
    const spec = normalizeSpec(rawSpec);
    const view = Object.assign({}, VIEW_DEFAULTS, rawView || {});
    const def = registry[spec.type];
    const g = layoutOf(def).derive(spec);
    const kept = keptRange(g, view);
    const ctx = { T, spec, g, view, kept, palette: PALETTE, helpers, TAU };
    const parts = Object.assign({}, DEFAULT_PARTS, def.parts || {});

    const root = new T.Group();
    root.add(parts.stator(ctx));

    const winding = parts.windings(ctx);
    root.add(winding.group);

    const rotorGroup = new T.Group();
    rotorGroup.add(parts.shaft(ctx));
    const rotorImpl = def.buildRotor(ctx);
    rotorGroup.add(rotorImpl.group);
    root.add(rotorGroup);

    const field = parts.field(ctx);
    root.add(field.mesh);
    const blur = parts.blur(ctx);
    root.add(blur.mesh);
    const housing = parts.housing(ctx);
    root.add(housing.group);
    // A rotor that is itself the outer shell (outer rotor) follows the shell-opacity slider too
    const setOpacity = (o) => {
      housing.setOpacity(o);
      if (rotorImpl.setOpacity) rotorImpl.setOpacity(o);
    };
    if (rotorImpl.setOpacity) rotorImpl.setOpacity(view.shellOpacity);

    const labels = (def.labels || defaultLabels)(ctx, { winding, field });
    (rotorImpl.labels || []).forEach((l) => labels.push(l));

    const fadeMats = rotorImpl.fadeMats || [];
    return {
      spec,
      view,
      root,
      labels,
      polePairs: g.p,
      synchronous: !!def.synchronous,
      update(st) {
        rotorGroup.rotation.z = st.rotorAngle;
        winding.update(st);
        field.update(st);
        blur.update(st);
        if (rotorImpl.update) rotorImpl.update(Object.assign({}, st, { showRotorCurrent: view.showRotorCurrent }));
        const opacity = 1 - 0.75 * st.blur; // when blur appears, fade the rotor details to avoid the "wagon-wheel" illusion at high speed
        const fading = st.blur > 0.01;
        fadeMats.forEach((m) => {
          if (m.transparent !== fading) {
            m.transparent = fading;
            m.needsUpdate = true;
          }
          m.opacity = opacity;
        });
      },
      setView(v) {
        Object.assign(view, v);
        setOpacity(view.shellOpacity);
      },
      dispose() {
        disposeObject(root);
      },
    };
  }

  NS.MotorKit = {
    register,
    typeList,
    presetList,
    defaultSpec,
    normalizeSpec,
    build,
    keptRange,
    layouts: { inner: INNER_LAYOUT },
    parts: DEFAULT_PARTS,
    palette: PALETTE,
    helpers,
    registry,
    TAU,
  };
})((window.VVVF3D = window.VVVF3D || {}));
