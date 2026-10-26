// 电机工具包：共用部件（定子、绕组、外壳、轴、气隙磁场、转速模糊壳层）和“电机类型注册表”。
// 新电机类型只需要实现转子：在 js/motors/ 里写一个文件，调用 MotorKit.register(...) 即可。
// 坐标约定：电机轴沿 Z，从 +Z 端看，逆时针为正转方向。
(function (NS) {
  'use strict';

  const T = THREE;
  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;

  const PALETTE = {
    phase: [0xf2c230, 0x3dbb6a, 0xe5484d], // A 黄、B 绿、C 红（国标相序色）
    north: 0xff8a3d, // 气隙磁通向外（转子 N 极一侧）
    south: 0x3d8bff, // 气隙磁通向内
    steel: 0x9aa5b4,
    steelDark: 0x5d6877,
    housing: 0x7c93b0,
    shaft: 0xc3cbd6,
    copper: 0xc8793c,
    marker: 0xfff2b0,
  };

  // 所有电机共用的几何参数（长度单位任意，电机外径约为 2）
  const COMMON_DEFAULTS = {
    length: 1.4, // 铁芯长度
    outerRadius: 1.0, // 定子外半径
    boreRadius: 0.62, // 定子内半径（膛径）
    slotDepth: 0.24, // 槽深
    airGap: 0.03, // 气隙（为了看得见，比真实比例夸大）
    shaftRadius: 0.17,
    toothFraction: 0.52, // 齿占槽距的比例
  };

  const VIEW_DEFAULTS = {
    cutaway: true,
    cutCenterDeg: 36, // 剖开的缺口中心方向（XY 平面内，从 +X 逆时针）
    cutHalfWidthDeg: 52,
    shellOpacity: 0.3,
    showField: true,
    showWinding: true,
    showRotorCurrent: true,
  };

  // 三相绕组的相带：每对极 6 个相带，依次为 A+、C−、B+、A−、C+、B−（相序 A→B→C 逆时针旋转）
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

  // ---- 参数检查 -----------------------------------------------------------------
  function need(cond, msg) {
    if (!cond) throw new Error(msg);
  }
  function num(s, key, lo, hi, label) {
    const v = s[key];
    need(typeof v === 'number' && isFinite(v) && v >= lo && v <= hi, label + ' ' + key + ' 须是 ' + lo + ' 到 ' + hi + ' 之间的数');
  }

  function normalizeSpec(input) {
    need(input && typeof input === 'object' && !Array.isArray(input), '电机定义必须是一个 JSON 对象');
    const def = registry[input.type];
    need(def, '未知的电机类型 type：' + input.type + '，可选：' + Object.keys(registry).join('、'));
    const s = Object.assign({}, COMMON_DEFAULTS, def.defaults, input);
    s.drivetrain = Object.assign({}, NS.Drive.DEFAULT_DRIVE, input.drivetrain || {});
    need(Number.isInteger(s.poles) && s.poles >= 2 && s.poles <= 16 && s.poles % 2 === 0, '极数 poles 须是 2 到 16 的偶数');
    need(
      Number.isInteger(s.statorSlots) && s.statorSlots >= 3 * s.poles && s.statorSlots <= 96,
      '定子槽数 statorSlots 须是整数，不少于 3×极数，不超过 96'
    );
    num(s, 'length', 0.4, 3, '铁芯长度');
    num(s, 'outerRadius', 0.5, 2, '定子外半径');
    num(s, 'boreRadius', 0.2, 1.5, '膛径');
    num(s, 'slotDepth', 0.05, 0.6, '槽深');
    num(s, 'airGap', 0.005, 0.1, '气隙');
    num(s, 'shaftRadius', 0.05, 0.6, '轴半径');
    num(s, 'toothFraction', 0.3, 0.8, '齿比例');
    need(s.boreRadius + s.slotDepth < s.outerRadius - 0.05, '槽底半径（boreRadius + slotDepth）必须比 outerRadius 至少小 0.05');
    need(s.shaftRadius < s.boreRadius - s.airGap - 0.12, '轴半径 shaftRadius 太大，转子装不下');
    if (def.validate) def.validate(s, need, num);
    return s;
  }

  function derive(s) {
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
    g.endZ = g.L / 2 + 0.42; // 端盖位置
    g.Rframe = g.Ro + 0.07;
    g.hubR = g.Rsh + 0.16;
    g.rMid = g.Ri + s.slotDepth * 0.55; // 槽内导体的中心半径
    return g;
  }

  // 剖切后保留的槽范围 [k0, k1)（边界落在齿中心，切口干净）
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

  // ---- 通用几何小工具 --------------------------------------------------------------
  const helpers = {
    stdMat(color, metalness, roughness, extra) {
      return new T.MeshStandardMaterial(Object.assign({ color, metalness, roughness }, extra || {}));
    },
    // 沿 Z 轴的圆柱
    cyl(r, len, seg) {
      return new T.CylinderGeometry(r, r, len, seg || 64).rotateX(Math.PI / 2);
    },
    // 圆环（或圆环扇形）沿 Z 轴拉伸，以原点为中心
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

  // ---- 定子铁芯（带槽） ---------------------------------------------------------------
  function statorGeometry(ctx) {
    const { spec, g, kept } = ctx;
    const half = ((1 - spec.toothFraction) * g.delta) / 2; // 槽的半角宽
    const P = (r, a) => new T.Vector2(r * Math.cos(a), r * Math.sin(a));
    const arc = (r, a0, a1, n, skipFirst) => {
      const out = [];
      for (let i = skipFirst ? 1 : 0; i <= n; i++) out.push(P(r, a0 + ((a1 - a0) * i) / n));
      return out;
    };
    // 内轮廓：从齿中心出发，依次经过齿顶、槽壁、槽底、槽壁、齿顶……
    const inner = [];
    for (let k = kept.k0; k < kept.k1; k++) {
      const c = (k + 0.5) * g.delta;
      const s0 = c - half;
      const s1 = c + half;
      inner.push(...arc(g.Ri, k * g.delta, s0, 2, k > kept.k0));
      inner.push(...arc(g.Rs, s0, s1, 3, false));
      inner.push(...arc(g.Ri, s1, (k + 1) * g.delta, 2, false));
    }
    const shape = new T.Shape();
    if (kept.full) {
      shape.absarc(0, 0, g.Ro, 0, TAU, false);
      shape.holes.push(new T.Path(inner));
    } else {
      shape.setFromPoints(inner);
      shape.lineTo(g.Ro * Math.cos(kept.a1), g.Ro * Math.sin(kept.a1));
      shape.absarc(0, 0, g.Ro, kept.a1, kept.a0, true);
      shape.closePath();
    }
    return helpers.extrude(shape, g.L, 48);
  }

  // ---- 三相绕组：槽内导体（实例化的方条）+ 端部连线 -------------------------------------
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

    // 端部连线：同一相相距一个极距的两个相带之间，前后端各一段弧
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
      const am = a1 + span / 2; // 标注挂在保留范围里最后一个线圈上，避开定子标注
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
          const b = 0.5 + 0.5 * s.s * cur[s.ph]; // 电流方向 × 相带极性：亮 = 流出纸面，暗 = 流入纸面
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

  // ---- 外壳、端盖、轴承座 ------------------------------------------------------------------
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

  // ---- 转子侧的公共部分：轴与转向标记 -------------------------------------------------------
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

  // ---- 气隙磁场：沿圆周的 cos(p·(θ − φ)) 彩色光环，随旋转磁场转动 ------------------------------
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
    const rg = (g.Ri + g.Rr) / 2;
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
        // power：逆变器输出的强度 0..1。惰行或逆变器关闭时，定子里没有电流，也就没有旋转磁场
        const amp = st.power === undefined ? 1 : st.power;
        mesh.visible = view.showField && amp > 0.01;
        mat.uniforms.uP.value = st.polePairs;
        mat.uniforms.uPhi.value = st.fieldAngle;
        mat.uniforms.uAmp.value = amp;
      },
    };
  }

  // ---- 转速的“拖影”壳层：转得快时转子变模糊，拖影颜色随转速变化 ---------------------------------
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

  function buildBlur(ctx) {
    const { g } = ctx;
    const half = g.L * 0.49;
    const r = g.Rr + 0.012;
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
    const mesh = new T.Mesh(new T.CylinderGeometry(r, r, 2 * half, 128, 1, true).rotateX(Math.PI / 2), mat);
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

  // ---- 组装一台电机 ---------------------------------------------------------------------------
  // 默认部件。电机类型可以在 register 时用 parts 覆盖其中任何一个，例如外转子、轴向磁通、
  // 直线电机需要自己的定子；覆盖时可以调用 MotorKit.parts.xxx(ctx) 复用默认实现。
  //   stator(ctx)   → THREE.Object3D
  //   windings(ctx) → { group, anchor, update(state) }
  //   housing(ctx)  → { group, setOpacity(o) }
  //   shaft(ctx)    → THREE.Object3D（随转子一起转）
  //   field(ctx)    → { mesh, anchor, update(state) }
  const DEFAULT_PARTS = {
    stator: (ctx) => new T.Mesh(statorGeometry(ctx), helpers.stdMat(PALETTE.steel, 0.55, 0.42)),
    windings: buildWindings,
    housing: buildHousing,
    shaft: buildShaft,
    field: buildField,
  };

  function build(rawSpec, rawView) {
    const spec = normalizeSpec(rawSpec);
    const view = Object.assign({}, VIEW_DEFAULTS, rawView || {});
    const def = registry[spec.type];
    const g = derive(spec);
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
    const blur = buildBlur(ctx);
    root.add(blur.mesh);
    const housing = parts.housing(ctx);
    root.add(housing.group);

    // 标注：{ text, pos } 的位置都在电机局部坐标里
    const a = kept.full ? 0.9 : kept.a0 + 0.04; // 贴着剖口的上沿，从默认视角看在电机上方
    const labels = [
      { text: '定子铁芯（带槽）', pos: new T.Vector3(((g.Rs + g.Ro) / 2) * Math.cos(a), ((g.Rs + g.Ro) / 2) * Math.sin(a), g.L * 0.3) },
      { text: '气隙磁场（橙 / 蓝 = 磁通方向）', pos: field.anchor },
      { text: '轴', pos: new T.Vector3(0, g.Rsh + 0.02, g.endZ + 0.55) },
    ];
    if (winding.anchor) labels.splice(1, 0, { text: '三相绕组（槽内导体 + 端部）', pos: winding.anchor });
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
        const opacity = 1 - 0.75 * st.blur; // 拖影出现时淡化转子细节，避免高速下的“车轮倒转”假象
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
        housing.setOpacity(view.shellOpacity);
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
    parts: DEFAULT_PARTS,
    palette: PALETTE,
    helpers,
    registry,
    TAU,
  };
})((window.VVVF3D = window.VVVF3D || {}));
