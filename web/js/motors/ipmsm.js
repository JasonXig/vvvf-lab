// 内置式永磁同步电机（V 形磁钢）：磁钢埋在转子铁芯里，每个极两块、排成 V 形，只在两个端面露出一小截。
// 这个文件也是“怎么新增一种电机类型”的模板：只实现转子，其余部件沿用公共的定子、绕组、外壳。
(function (NS) {
  'use strict';

  const T = THREE;
  const K = NS.MotorKit;
  const P = K.palette;
  const H = K.helpers;
  const TAU = K.TAU;

  K.register('ipmsm', {
    label: '永磁同步电机（内置式 V 形）',
    synchronous: true,
    defaults: { poles: 8, statorSlots: 48, magnetWidth: 0.3, magnetThickness: 0.06, vAngleDeg: 35, loadAngleDeg: 25 },
    presets: {
      '内置式永磁 · 8 极 · 48 槽': { poles: 8, statorSlots: 48, magnetWidth: 0.3, magnetThickness: 0.06, vAngleDeg: 35, loadAngleDeg: 25 },
    },
    validate(s, need, num) {
      num(s, 'magnetWidth', 0.1, 0.5, '磁钢宽度');
      num(s, 'magnetThickness', 0.02, 0.15, '磁钢厚度');
      num(s, 'vAngleDeg', 10, 70, 'V 形夹角（度）');
      num(s, 'loadAngleDeg', -60, 60, '负载角（度）');
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
      const rc = g.Rr - 0.17; // 磁钢中心所在半径
      const d = 0.13; // 两块磁钢中心离极中心线的距离
      for (let i = 0; i < spec.poles; i++) {
        const c = i * pitch;
        const u = new T.Vector2(Math.cos(c), Math.sin(c)); // 极中心线（径向）
        const t = new T.Vector2(-Math.sin(c), Math.cos(c)); // 切向
        [-1, 1].forEach((side) => {
          const w = t.clone().multiplyScalar(side * Math.cos(gamma)).add(u.clone().multiplyScalar(Math.sin(gamma))); // 磁钢宽度方向
          const mag = new T.Mesh(new T.BoxGeometry(spec.magnetWidth, spec.magnetThickness, Lr + 0.05), i % 2 === 0 ? northMat : southMat);
          mag.position.set(rc * u.x + side * d * t.x, rc * u.y + side * d * t.y, 0);
          mag.rotation.z = Math.atan2(w.y, w.x);
          group.add(mag);
        });
      }

      return {
        group,
        fadeMats: [coreMat, northMat, southMat],
        labels: [{ text: '内置式转子（V 形磁钢）', pos: new T.Vector3(g.Rr * 0.6, g.Rr * 0.3, Lr / 2 + 0.12) }],
      };
    },
  });
})(window.VVVF3D);
