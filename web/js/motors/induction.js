// 三相异步电机（笼型）：转子是铁芯 + 铜导条 + 两个端环。
// 导条上的颜色表示感应电流：转差越大、导条正好处在磁场变化最快的位置，电流越大。
(function (NS) {
  'use strict';

  const T = THREE;
  const K = NS.MotorKit;
  const P = K.palette;
  const H = K.helpers;
  const TAU = K.TAU;

  K.register('induction', {
    label: '三相异步电机（笼型）',
    synchronous: false, // 转子转速低于同步转速，存在转差
    defaults: { poles: 4, statorSlots: 36, rotorBars: 28 },
    presets: {
      '异步 · 4 极 · 36 槽 · 28 导条': { poles: 4, statorSlots: 36, rotorBars: 28 },
      '异步 · 6 极 · 54 槽 · 44 导条': { poles: 6, statorSlots: 54, rotorBars: 44 },
    },
    validate(s, need) {
      need(Number.isInteger(s.rotorBars) && s.rotorBars >= 8 && s.rotorBars <= 80, '转子导条数 rotorBars 须是 8 到 80 的整数');
    },

    buildRotor(ctx) {
      const { spec, g } = ctx;
      const n = spec.rotorBars;
      const Lr = g.L * 0.98;
      const group = new T.Group();

      const coreMat = H.stdMat(P.steelDark, 0.6, 0.45);
      group.add(new T.Mesh(H.cyl(g.Rr, Lr, 96), coreMat));

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
      group.add(bars);

      const ringMat = H.stdMat(P.copper, 0.75, 0.3);
      [-1, 1].forEach((sg) => {
        const ring = new T.Mesh(H.ring(g.Rr, g.Rr - 0.13, 0, TAU, 0.06), ringMat);
        ring.position.z = sg * (Lr / 2 + 0.05);
        group.add(ring);
      });

      const tmp = new T.Color();
      return {
        group,
        fadeMats: [coreMat, barMat, ringMat],
        labels: [{ text: '笼型转子（导条 + 端环）', pos: new T.Vector3(g.Rr * 0.55, g.Rr * 0.4, Lr / 2 + 0.12) }],
        update(st) {
          // 导条电流 ∝ 转差 × |sin(p·(导条位置 − 磁场位置))|：磁场扫过导条越快，电流越大
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
