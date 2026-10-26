// Sound: three-phase SPWM → motor current ripple (proxy) → audio; the JavaScript version of vvvflab/synth.py.
// The synthesis core createSynthCore is fully self-contained (it references no outside variables and does not touch the DOM),
// so the same source can run in real time inside an AudioWorklet and also be tested offline in Node and cross-checked against the Python version.
(function (NS) {
  'use strict';

  function createSynthCore() {
    const TAU = Math.PI * 2;
    const SQ3 = 0.8660254037844386;

    // Second-order filter coefficients (RBJ formulas), returns [b0, b1, b2, a1, a2] (already divided by a0)
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

    // Triangle carrier: input is the phase (in turns), 0 at 0 and rising, range [-1, 1]
    function tri(x) {
      x -= Math.floor(x);
      return x < 0.25 ? 4 * x : x < 0.75 ? 2 - 4 * x : 4 * x - 4;
    }

    // Mean of the pulse over one sample interval: dp and dc are the values of "reference − carrier" at the start and end of the interval (+1 is output when above 0);
    // if it flips within the interval, the area is scaled by the position of the crossing. This makes the switching edges exact, with no oversampling needed to approximate them.
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
        this.os = o.oversample || 1; // no oversampling by default; set to 4 to compare point by point with the Python version (4x oversampling + FIR)
        const fsOs = fs * this.os;
        this.dt = 1 / fsOs;
        this.alpha = Math.exp(-TAU * (o.leakHz || 20) * this.dt); // leaky integrator
        this.gdt = (o.rippleGain || 1200) * this.dt;
        const fcLp = 0.45 * fs;
        this.lp1 = new Biquad(lowpass(fcLp, 0.5411961, fsOs)); // 4th-order Butterworth anti-aliasing, split into two second-order sections
        this.lp2 = new Biquad(lowpass(fcLp, 1.3065630, fsOs));
        this.hp = new Biquad(highpass(o.hpfHz || 100, Math.SQRT1_2, fs)); // filters out everything below 100 Hz
        this.kp = 1 - Math.exp(-1 / (0.012 * fs)); // parameter smoothing: 12 ms
        this.kg = 1 - Math.exp(-1 / (0.02 * fs)); // gain smoothing: 20 ms
        this.kphi = 1 - Math.exp(-1 / (0.04 * fs)); // speed at which the synchronous carrier phase returns to zero: 40 ms
        this.t1 = 0; // fundamental phase [turns]
        this.tc = 0; // asynchronous carrier phase [turns]
        this.phi = 0; // phase offset of the synchronous carrier relative to the fundamental [turns]
        this.y = 0; // integrator state
        this.g = 0; // current gain
        this.kind = 'async';
        this.n = 0;
        this.valid = false; // whether "reference − carrier" at the end of the previous step is valid; must be re-taken after a shift or after muting
        this.da = 0;
        this.db = 0;
        this.dc = 0;
        this.snp = 0;
        this.cur = { f1: 0, m: 0, v1: 0, fc: 0 };
        this.tgt = { f1: 0, m: 0, v1: 0, fc: 0, gate: false, volume: 0.3 };
        this.started = false;
      }

      // When shifting or going from asynchronous to synchronous, keep the phase-a carrier phase continuous to avoid clicks.
      // The carrier of synchronous modulation should be aligned with the zero crossing of the reference (φ = 0): then the crossings of the sine and the triangle are symmetric and the phase of the output fundamental
      // matches the reference, which matters most with few pulses. So on a switch we first continue the phase, then let φ glide to 0 over a few tens of milliseconds.
      switchMode(kind, n) {
        let carrier = this.kind === 'sync' ? this.n * this.t1 + this.phi : this.tc;
        carrier -= Math.floor(carrier);
        if (kind === 'sync') {
          this.phi = carrier - n * this.t1;
          this.phi -= Math.round(this.phi); // the triangle period is 1; take the φ nearest to 0 in (−0.5, 0.5]
        } else if (kind === 'async') this.tc = carrier;
        this.kind = kind;
        this.n = n;
        this.valid = false;
      }

      // p may contain only the fields to change: f1 m v1 fc kind n gate volume
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

      // Write out.length mono samples into out
      render(out) {
        const N = out.length;
        const t = this.tgt;
        const c = this.cur;
        const gt = t.gate ? t.volume : 0;
        if (gt === 0 && this.g < 1e-5) {
          // Muted: do no work and clear the state, so there is no transient when it is turned back on
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
        const filt = os > 1; // the low-pass before decimation is only needed with oversampling
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
            // "reference − carrier" of the three phases at the end of this step; the leg outputs +1 when above 0
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
                // each phase carrier is locked to its own reference: the three phases are exactly 120° apart even when N is not a multiple of 3
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
            const va = pa - (pa + pb + pc) / 3; // phase-a motor phase voltage (floating neutral)
            const u = va - c.v1 * 0.5 * (snp + sn); // subtract the fundamental (equivalent to the back-EMF), leaving the switching harmonics
            snp = sn;
            this.y = this.alpha * this.y + this.gdt * u; // integrate → current ripple
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

  // ---- Audio engine: AudioWorklet (preferred) or ScriptProcessor (fallback) + an analyser for the spectrogram ------------------
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

  // Hand the synthesis core to the audio thread as a module. When index.html is opened by double-click (file://), Chromium does not allow loading a worklet from a Blob URL
  // (the page origin is null), but a data: URL works; with a server both work, so try Blob first.
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
    // Must be called from a user action (click, key press), otherwise the browser will not allow sound
    start(forceFallback) {
      if (!this._starting) this._starting = this._start(forceFallback).catch((e) => {
        this.error = String(e && e.message ? e.message : e);
        this._starting = null;
      });
      return this._starting;
    }
    async _start(forceFallback) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) throw new Error('This browser does not support Web Audio');
      if (this.ctx) this.ctx.close().catch(() => {}); // left over from a failed earlier start, do not let them pile up
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
          console.warn('AudioWorklet failed to load, falling back:', e);
          this.error = 'AudioWorklet is unavailable; latency will be slightly higher.';
          node = null;
        }
      } else if (!forceFallback) {
        this.error = 'This browser has no AudioWorklet; latency will be slightly higher.';
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
