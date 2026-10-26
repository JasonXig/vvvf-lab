// 声音：三相 SPWM → 电机电流纹波（代理量）→ 音频，是 vvvflab/synth.py 的 JavaScript 版。
// 合成核心 createSynthCore 完全自成一体（不引用外面的变量，也不碰 DOM），
// 所以同一份源码既能在 AudioWorklet 里实时运行，也能在 Node 里离线测试、和 Python 版对账。
(function (NS) {
  'use strict';

  function createSynthCore() {
    const TAU = Math.PI * 2;
    const SQ3 = 0.8660254037844386;

    // 二阶滤波器系数（RBJ 公式），返回 [b0, b1, b2, a1, a2]（已除以 a0）
    function lowpass(fc, q, fs) {
      const w = (TAU * fc) / fs;
      const cw = Math.cos(w);
      const al = Math.sin(w) / (2 * q);
      const a0 = 1 + al;
      return [(1 - cw) / 2 / a0, (1 - cw) / a0, (1 - cw) / 2 / a0, (-2 * cw) / a0, (1 - al) / a0];
    }
    function highpass(fc, q, fs) {
      const w = (TAU * fc) / fs;
      const cw = Math.cos(w);
      const al = Math.sin(w) / (2 * q);
      const a0 = 1 + al;
      return [(1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0, (-2 * cw) / a0, (1 - al) / a0];
    }

    class Biquad {
      constructor(c) {
        this.b0 = c[0];
        this.b1 = c[1];
        this.b2 = c[2];
        this.a1 = c[3];
        this.a2 = c[4];
        this.z1 = 0;
        this.z2 = 0;
      }
      step(x) {
        const y = this.b0 * x + this.z1;
        this.z1 = this.b1 * x - this.a1 * y + this.z2;
        this.z2 = this.b2 * x - this.a2 * y;
        return y;
      }
      reset() {
        this.z1 = 0;
        this.z2 = 0;
      }
    }

    // 三角载波：输入相位（圈），0 处为 0 并上升，值域 [-1, 1]
    function tri(x) {
      x -= Math.floor(x);
      return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
    }

    // 一个采样间隔内的脉冲平均值：dp、dc 是间隔起点和终点处“参考波 − 载波”的值（大于 0 时输出 +1），
    // 间隔内发生翻转就按交叉点的位置折算面积。这样开关边沿的位置是精确的，不需要靠过采样来逼近。
    function area(dp, dc) {
      const sp = dp > 0 ? 1 : -1;
      const sc = dc > 0 ? 1 : -1;
      if (sp === sc) return sp;
      const x = dp / (dp - dc);
      return sp * x + sc * (1 - x);
    }

    class SynthCore {
      constructor(fs, o) {
        o = o || {};
        this.fs = fs;
        this.os = o.oversample || 1; // 默认不过采样；设成 4 可以和 Python 版（4 倍过采样 + FIR）逐点对照
        const fsOs = fs * this.os;
        this.dt = 1 / fsOs;
        this.alpha = Math.exp(-TAU * (o.leakHz || 20) * this.dt); // 带泄漏的积分器
        this.gdt = (o.rippleGain || 1200) * this.dt;
        const fcLp = 0.45 * fs;
        this.lp1 = new Biquad(lowpass(fcLp, 0.5411961, fsOs)); // 4 阶巴特沃斯抗混叠，拆成两个二阶
        this.lp2 = new Biquad(lowpass(fcLp, 1.3065630, fsOs));
        this.hp = new Biquad(highpass(o.hpfHz || 100, Math.SQRT1_2, fs)); // 滤掉 100 Hz 以下
        this.kp = 1 - Math.exp(-1 / (0.012 * fs)); // 参数平滑：12 ms
        this.kg = 1 - Math.exp(-1 / (0.02 * fs)); // 增益平滑：20 ms
        this.kphi = 1 - Math.exp(-1 / (0.04 * fs)); // 同步载波相位归零的速度：40 ms
        this.t1 = 0; // 基波相位 [圈]
        this.tc = 0; // 异步载波相位 [圈]
        this.phi = 0; // 同步载波相对基波的相位偏移 [圈]
        this.y = 0; // 积分器状态
        this.g = 0; // 当前增益
        this.kind = 'async';
        this.n = 0;
        this.valid = false; // 上一步终点处的“参考波 − 载波”是否有效；换挡或静音后要重新取
        this.da = 0;
        this.db = 0;
        this.dc = 0;
        this.snp = 0;
        this.cur = { f1: 0, m: 0, v1: 0, fc: 0 };
        this.tgt = { f1: 0, m: 0, v1: 0, fc: 0, gate: false, volume: 0.3 };
        this.started = false;
      }

      // 换挡或异步转同步时保持 a 相载波相位连续，避免咔嗒声。
      // 同步调制的载波应该对准参考波的过零点（φ = 0）：那样正弦与三角波的交点是对称的，输出基波的相位
      // 才和参考波一致，低脉冲数时尤其明显。所以切换时先接续，之后让 φ 在几十毫秒里滑到 0。
      switchMode(kind, n) {
        let carrier = this.kind === 'sync' ? this.n * this.t1 + this.phi : this.tc;
        carrier -= Math.floor(carrier);
        if (kind === 'sync') {
          this.phi = carrier - n * this.t1;
          this.phi -= Math.round(this.phi); // 三角波周期是 1，φ 取 (−0.5, 0.5] 里最近的那个
        } else if (kind === 'async') this.tc = carrier;
        this.kind = kind;
        this.n = n;
        this.valid = false;
      }

      // p 可以只含要改的字段：f1 m v1 fc kind n gate volume
      setTarget(p) {
        const t = this.tgt;
        for (const k of ['f1', 'm', 'v1', 'fc', 'gate', 'volume']) if (p[k] !== undefined) t[k] = p[k];
        const kind = p.kind !== undefined ? p.kind : this.kind;
        const n = p.n !== undefined ? p.n : this.n;
        if (kind !== this.kind || n !== this.n) this.switchMode(kind, n);
        if (!this.started) {
          this.cur = { f1: t.f1, m: t.m, v1: t.v1, fc: t.fc };
          this.started = true;
        }
      }

      // 往 out 里写 out.length 个单声道样本
      render(out) {
        const N = out.length;
        const t = this.tgt;
        const c = this.cur;
        const gt = t.gate ? t.volume : 0;
        if (gt === 0 && this.g < 1e-5) {
          // 静音：不做运算，并清空状态，重新打开时不会有瞬态
          out.fill(0);
          this.g = 0;
          this.y = 0;
          this.valid = false;
          this.lp1.reset();
          this.lp2.reset();
          this.hp.reset();
          return;
        }
        const os = this.os;
        const filt = os > 1; // 只有过采样时才需要抽取前的低通
        const dt = this.dt;
        const kind = this.kind;
        const n = this.n;
        let da = this.da;
        let db = this.db;
        let dc = this.dc;
        let snp = this.snp;
        for (let i = 0; i < N; i++) {
          c.f1 += (t.f1 - c.f1) * this.kp;
          c.m += (t.m - c.m) * this.kp;
          c.v1 += (t.v1 - c.v1) * this.kp;
          c.fc += (t.fc - c.fc) * this.kp;
          if (kind === 'sync') this.phi -= this.phi * this.kphi;
          const df1 = c.f1 * dt;
          const dfc = c.fc * dt;
          let z = 0;
          for (let s = 0; s < os; s++) {
            this.t1 += df1;
            if (this.t1 >= 1) this.t1 -= 1;
            const ang = TAU * this.t1;
            const sn = Math.sin(ang);
            const cs = Math.cos(ang);
            const sb = -0.5 * sn - SQ3 * cs; // sin(θ − 120°)
            const sc = -0.5 * sn + SQ3 * cs; // sin(θ + 120°)
            // 这一步终点处，三相“参考波 − 载波”的值；大于 0 时桥臂输出 +1
            let na;
            let nb;
            let nc;
            if (kind === 'square') {
              na = sn + 1e-9 * cs;
              nb = sb;
              nc = sc;
            } else {
              let ta;
              let tb;
              let tcr;
              if (kind === 'sync') {
                // 每一相的载波都锁在自己的参考波上：N 不是 3 的倍数时三相也严格互差 120°
                const base = n * this.t1 + this.phi;
                ta = tri(base);
                tb = tri(base - n / 3);
                tcr = tri(base + n / 3);
              } else {
                this.tc += dfc;
                if (this.tc >= 1) this.tc -= 1;
                ta = tb = tcr = tri(this.tc);
              }
              na = c.m * sn - ta;
              nb = c.m * sb - tb;
              nc = c.m * sc - tcr;
            }
            if (!this.valid) {
              da = na;
              db = nb;
              dc = nc;
              snp = sn;
              this.valid = true;
            }
            const pa = area(da, na);
            const pb = area(db, nb);
            const pc = area(dc, nc);
            da = na;
            db = nb;
            dc = nc;
            const va = pa - (pa + pb + pc) / 3; // a 相电机相电压（中性点悬空）
            const u = va - c.v1 * 0.5 * (snp + sn); // 减去基波（等价于反电势），剩下开关谐波
            snp = sn;
            this.y = this.alpha * this.y + this.gdt * u; // 积分 → 电流纹波
            z = filt ? this.lp2.step(this.lp1.step(this.y)) : this.y;
          }
          this.g += (gt - this.g) * this.kg;
          out[i] = this.g * Math.tanh(this.hp.step(z));
        }
        this.da = da;
        this.db = db;
        this.dc = dc;
        this.snp = snp;
      }
    }

    return SynthCore;
  }

  // ---- 音频引擎：AudioWorklet（首选）或 ScriptProcessor（备用）+ 声谱图用的分析器 ------------------
  function workletSource() {
    return [
      'const createSynthCore = ' + createSynthCore.toString() + ';',
      'const SynthCore = createSynthCore();',
      'class VVVFProcessor extends AudioWorkletProcessor {',
      '  constructor() { super(); this.core = new SynthCore(sampleRate); this.port.onmessage = (e) => this.core.setTarget(e.data); }',
      '  process(inputs, outputs) {',
      '    const out = outputs[0];',
      '    this.core.render(out[0]);',
      '    for (let c = 1; c < out.length; c++) out[c].set(out[0]);',
      '    return true;',
      '  }',
      '}',
      "registerProcessor('vvvf-synth', VVVFProcessor);",
    ].join('\n');
  }

  // 把合成核心作为模块交给音频线程。直接双击打开 index.html（file://）时，Chromium 不允许用 Blob 地址
  // 加载 worklet（页面来源是 null），但 data: 地址可以；有服务器时两种都行，先试 Blob。
  async function loadWorklet(ctx) {
    const src = workletSource();
    const makers = [() => 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src)];
    if (window.location.protocol !== 'file:') makers.unshift(() => URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
    let lastError = null;
    for (const make of makers) {
      const url = make();
      try {
        await ctx.audioWorklet.addModule(url);
        return;
      } catch (e) {
        lastError = e;
      } finally {
        if (url.startsWith('blob:')) URL.revokeObjectURL(url);
      }
    }
    throw lastError;
  }

  class AudioEngine {
    constructor() {
      this.ctx = null;
      this.node = null;
      this.core = null;
      this.master = null;
      this.analyser = null;
      this.mode = 'off'; // off | worklet | script
      this.error = '';
      this._starting = null;
    }
    get running() {
      return !!this.ctx && this.ctx.state === 'running';
    }
    // 必须在用户操作（点击、按键）里调用，浏览器才允许发声
    start(forceFallback) {
      if (!this._starting) this._starting = this._start(forceFallback).catch((e) => {
        this.error = String(e && e.message ? e.message : e);
        this._starting = null;
      });
      return this._starting;
    }
    async _start(forceFallback) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('这个浏览器不支持 Web Audio');
      if (this.ctx) this.ctx.close().catch(() => {}); // 上一次启动失败留下的，别再积累
      this.ctx = new AC({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 4096;
      this.analyser.smoothingTimeConstant = 0.35;
      this.analyser.minDecibels = -100;
      this.analyser.maxDecibels = -30;
      let node = null;
      if (!forceFallback && this.ctx.audioWorklet) {
        try {
          await loadWorklet(this.ctx);
          node = new AudioWorkletNode(this.ctx, 'vvvf-synth', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
          this.mode = 'worklet';
        } catch (e) {
          console.warn('AudioWorklet 加载失败，改用备用方式：', e);
          this.error = 'AudioWorklet 不可用，延迟会稍大一些。';
          node = null;
        }
      } else if (!forceFallback) {
        this.error = '这个浏览器没有 AudioWorklet，延迟会稍大一些。';
      }
      if (!node) {
        const SynthCore = createSynthCore();
        this.core = new SynthCore(this.ctx.sampleRate);
        node = this.ctx.createScriptProcessor(1024, 0, 1);
        node.onaudioprocess = (ev) => this.core.render(ev.outputBuffer.getChannelData(0));
        this.mode = 'script';
      }
      this.node = node;
      node.connect(this.analyser);
      node.connect(this.master);
      this.master.connect(this.ctx.destination);
      if (this.ctx.state !== 'running') await this.ctx.resume();
    }
    send(p) {
      if (this.mode === 'worklet') this.node.port.postMessage(p);
      else if (this.mode === 'script') this.core.setTarget(p);
    }
    setMaster(v) {
      if (this.master) this.master.gain.value = v;
    }
  }

  NS.createSynthCore = createSynthCore;
  NS.SynthCore = createSynthCore();
  NS.AudioEngine = AudioEngine;
})((window.VVVF3D = window.VVVF3D || {}));
