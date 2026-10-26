// 永磁同步电机（表贴式）：转子表面贴着 N / S 交替的永磁体，转子与旋转磁场同步转动，没有转差。
// 磁场只比转子超前一个“负载角”，这个角度越大，输出转矩越大。
(function (NS) {
  'use strict';

  const T = THREE;
  const K = NS.MotorKit;
  const P = K.palette;
  const H = K.helpers;
  const TAU = K.TAU;

  K.register('pmsm', {
    label: '永磁同步电机（表贴式）',
    synchronous: true,
    defaults: { poles: 8, statorSlots: 48, magnetCoverage: 0.78, magnetThickness: 0.08, loadAngleDeg: 18 },
    presets: {
      '永磁 · 8 极 · 48 槽': { poles: 8, statorSlots: 48, magnetCoverage: 0.78, magnetThickness: 0.08, loadAngleDeg: 18 },
      '永磁 · 4 极 · 36 槽': { poles: 4, statorSlots: 36, magnetCoverage: 0.8, magnetThickness: 0.09, loadAngleDeg: 20 },
    },
    validate(s, need, num) {
      num(s, 'magnetCoverage', 0.4, 0.95, '磁钢覆盖率');
      num(s, 'magnetThickness', 0.02, 0.2, '磁钢厚度');
      num(s, 'loadAngleDeg', -60, 60, '负载角（度）');
    },

    buildRotor(ctx) {
      const { spec, g } = ctx;
      const Lr = g.L * 0.98;
      const t = spec.magnetThickness;
      const group = new T.Group();

      const coreMat = H.stdMat(P.steelDark, 0.6, 0.45);
      group.add(new T.Mesh(H.cyl(g.Rr - t, Lr, 96), coreMat));

      const northMat = H.stdMat(P.north, 0.35, 0.45);
      const southMat = H.stdMat(P.south, 0.35, 0.45);
      const letterN = new T.MeshBasicMaterial({ map: H.letterTexture('N', '#ffffff'), transparent: true, depthWrite: false });
      const letterS = new T.MeshBasicMaterial({ map: H.letterTexture('S', '#ffffff'), transparent: true, depthWrite: false });
      const pitch = TAU / spec.poles;
      const halfWidth = (spec.magnetCoverage * pitch) / 2;
      const size = Math.min(0.22, 2 * halfWidth * g.Rr * 0.7);
      for (let i = 0; i < spec.poles; i++) {
        const c = i * pitch; // 第 0 块磁钢（N）正对转子的 0° 方向
        const north = i % 2 === 0;
        group.add(new T.Mesh(H.ring(g.Rr, g.Rr - t, c - halfWidth, c + halfWidth, Lr), north ? northMat : southMat));
        const decal = new T.Mesh(new T.PlaneGeometry(size, size), north ? letterN : letterS);
        decal.position.set((g.Rr + 0.004) * Math.cos(c), (g.Rr + 0.004) * Math.sin(c), 0);
        decal.up.set(0, 0, 1);
        decal.lookAt(decal.position.x * 2, decal.position.y * 2, 0);
        group.add(decal);
      }

      return {
        group,
        fadeMats: [coreMat, northMat, southMat, letterN, letterS],
        labels: [{ text: '永磁转子（表贴磁钢 N / S）', pos: new T.Vector3(g.Rr * 0.6, g.Rr * 0.3, Lr / 2 + 0.12) }],
      };
    },
  });
})(window.VVVF3D);
