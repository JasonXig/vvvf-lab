// 页面主程序：手柄 → 动力状态 → 车速 → 逆变器工作点 → 声音与 3D 电机。
(function () {
  'use strict';

  const NS = window.VVVF3D;
  const T = THREE;
  const K = NS.MotorKit;
  const Table = NS.Table;
  const Drive = NS.Drive;
  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;
  const MAX_SPEED = 160; // km/h
  const RPM_MAX = 6000; // 转速条满量程
  const TABLES_KEY = 'vvvf3d.tables.v1';
  const $ = (id) => document.getElementById(id);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  const query = new URLSearchParams(window.location.search);

  // ---------------------------------------------------------------- 模式表的读取与保存
  function loadTables() {
    const presets = Table.presets();
    let tables = { A: Table.clone(presets.reference), B: Table.clone(presets.reference) };
    try {
      const raw = JSON.parse(window.localStorage.getItem(TABLES_KEY) || 'null');
      if (raw && raw.A && raw.B) {
        const a = Table.normalize(raw.A);
        const b = Table.normalize(raw.B);
        if (!Table.validate(a).length && !Table.validate(b).length) tables = { A: a, B: b };
      }
    } catch (err) {
      /* 读不到就用默认的 */
    }
    if (presets[query.get('map')]) tables = { A: Table.clone(presets[query.get('map')]), B: Table.clone(presets[query.get('map')]) };
    return tables;
  }
  function saveTables() {
    try {
      window.localStorage.setItem(TABLES_KEY, JSON.stringify(S.tables));
    } catch (err) {
      /* 浏览器不让存就算了 */
    }
  }

  const S = {
    // 驾驶台
    speed: 0,
    maxSpeed: MAX_SPEED,
    notch: Drive.NOTCH_N, // 主手柄档位（下标）
    scrub: { active: false }, // 正在拖标尺上的竖线：车速由手拖，不按动力学积分
    sel: null, // 标尺上选中的一段 { lane, i }
    inverterOn: true,
    soundOn: true,
    volume: 0.3,
    driveMode: 'coast', // power 牵引 | coast 空档 | hold 定速 | brake 制动（逆变器关掉时牵引和定速都变成空档）
    power: 0, // 逆变器输出的“强度”0..1，平滑变化，控制 3D 里磁场和电流的亮暗
    tables: loadTables(),
    demo: false,
    demoPhase: 'accel',
    demoT: 0,
    paused: false,
    audio: new NS.AudioEngine(),
    waveFrame: { run: false },
    // 显示
    rotMode: 'compress',
    slow: 0.0224,
    labelsOn: true,
    view: { cutaway: true, shellOpacity: 0.3, showField: true, showWinding: true, showRotorCurrent: true },
    spec: null,
    motor: null,
    rotor: 0, // 转子的可视角度 [rad]
    slipAngle: 0, // 旋转磁场相对转子多转（或少转）的角度，也就是转差 [rad]
    streak: 0, // 拖影图案的相位 [圈]
    drive: null,
    labelEls: [],
  };

  // ---------------------------------------------------------------- 渲染器与场景
  const stage = $('stage');
  let renderer;
  try {
    renderer = new T.WebGLRenderer({ canvas: $('gl'), antialias: true, alpha: true });
  } catch (err) {
    $('nogl').hidden = false;
    stage.hidden = true;
    return;
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(36, 1, 0.1, 100);

  scene.add(new T.AmbientLight(0xffffff, 0.9));
  scene.add(new T.HemisphereLight(0xcfe0ff, 0x1a2436, 1.3));
  const key = new T.DirectionalLight(0xffffff, 2.6);
  key.position.set(3, 4, 5);
  const fill = new T.DirectionalLight(0x9ec5ff, 1.1);
  fill.position.set(-4, -1, 2);
  const rim = new T.DirectionalLight(0xffd9b0, 1.0);
  rim.position.set(-1, 3, -5);
  scene.add(key, fill, rim);

  // 舞台就是运转台上方那一块；电机放在正中，舞台太“扁”或太“瘦”时把镜头拉远，保证整台电机放得进去
  function resize() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const tanV = Math.tan((camera.fov * Math.PI) / 360);
    const tanH = tanV * camera.aspect;
    const R = 1.7; // 电机的有效外接球半径（真实外接球约 2.04，默认视角下轮廓要窄得多）
    const dV = (1.08 * R * Math.sqrt(1 + tanV * tanV)) / tanV;
    const dH = (1.08 * R * Math.sqrt(1 + tanH * tanH)) / tanH;
    orbit.fit = Math.max(0.85, Math.max(dV, dH) / orbit.home.dist);
  }
  // 运转台的高度决定舞台的高度（窄屏时由样式表固定为屏幕的 60%）
  const phoneLayout = window.matchMedia('(max-width: 760px)');
  function syncDeckHeight() {
    const root = document.documentElement;
    if (phoneLayout.matches) root.style.removeProperty('--deck-h');
    else root.style.setProperty('--deck-h', $('deck').offsetHeight + 28 + 'px');
    resize();
  }
  window.addEventListener('resize', syncDeckHeight);

  // ---------------------------------------------------------------- 轨道相机（拖动旋转、滚轮缩放、双击复位）
  class Orbit {
    constructor(cam, dom) {
      this.cam = cam;
      this.dom = dom;
      this.target = new T.Vector3(0, 0, 0);
      this.home = { az: 0.78, pol: 1.12, dist: 6.4 };
      Object.assign(this, this.home);
      this.fit = 1; // 舞台形状不合适时额外拉远的倍数，由 resize() 设定
      this.pointers = new Map();
      this.pinch = 0;
      dom.addEventListener('pointerdown', (e) => this.down(e));
      dom.addEventListener('pointermove', (e) => this.move(e));
      dom.addEventListener('pointerup', (e) => this.up(e));
      dom.addEventListener('pointercancel', (e) => this.up(e));
      dom.addEventListener('dblclick', () => this.reset());
      dom.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          this.dist = clamp(this.dist * Math.exp(e.deltaY * 0.001), 2.5, 14);
        },
        { passive: false }
      );
    }
    reset() {
      Object.assign(this, this.home);
    }
    down(e) {
      this.dom.setPointerCapture(e.pointerId);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (this.pointers.size === 2) this.pinch = this.pinchDist();
    }
    move(e) {
      const p = this.pointers.get(e.pointerId);
      if (!p) return;
      const dx = e.clientX - p.x;
      const dy = e.clientY - p.y;
      p.x = e.clientX;
      p.y = e.clientY;
      if (this.pointers.size === 1) {
        this.az -= dx * 0.008;
        this.pol = clamp(this.pol - dy * 0.008, 0.12, Math.PI - 0.12);
      } else if (this.pointers.size === 2) {
        const d = this.pinchDist();
        if (this.pinch) this.dist = clamp((this.dist * this.pinch) / d, 2.5, 14);
        this.pinch = d;
      }
    }
    up(e) {
      this.pointers.delete(e.pointerId);
      this.pinch = 0;
    }
    pinchDist() {
      const [a, b] = [...this.pointers.values()];
      return Math.hypot(a.x - b.x, a.y - b.y) || 1;
    }
    update() {
      const sp = Math.sin(this.pol);
      const dist = this.dist * this.fit;
      this.cam.position.set(
        this.target.x + dist * sp * Math.sin(this.az),
        this.target.y + dist * Math.cos(this.pol),
        this.target.z + dist * sp * Math.cos(this.az)
      );
      this.cam.lookAt(this.target);
    }
  }
  const orbit = new Orbit(camera, $('gl'));

  // ---------------------------------------------------------------- 转速 → 颜色、转速 → 可视转速
  const RPM_STOPS = [
    [0, 0x3b82f6],
    [0.25, 0x22d3ee],
    [0.5, 0x34d399],
    [0.75, 0xfbbf24],
    [1, 0xf43f5e],
  ].map(([t, c]) => [t, new T.Color(c)]);
  function rpmColor(x, out) {
    x = clamp(x, 0, 1);
    for (let i = 1; i < RPM_STOPS.length; i++) {
      if (x <= RPM_STOPS[i][0]) {
        const [t0, c0] = RPM_STOPS[i - 1];
        const [t1, c1] = RPM_STOPS[i];
        return out.copy(c0).lerp(c1, (x - t0) / (t1 - t0));
      }
    }
    return out.copy(RPM_STOPS[RPM_STOPS.length - 1][1]);
  }

  // 真实转速 r [rev/s] → 画面里转子转的转速 [rev/s]：1 圈/秒以内按真实转速转，再快就压缩，
  // 否则 60 帧/秒的画面里会出现“车轮倒转”的假象，也看不出快慢。
  function compress(r) {
    if (r <= 1) return r;
    return 1 + (4.2 * Math.log(r)) / Math.log(80);
  }

  // ---------------------------------------------------------------- 电机的建立与替换
  function showError(msg) {
    $('specErr').textContent = msg || '';
  }
  function syncSpecEditor() {
    $('specText').value = JSON.stringify(S.spec, null, 2);
  }
  function buildLabels() {
    const box = $('labels');
    box.innerHTML = '';
    S.labelEls = S.motor.labels.map((l) => {
      const el = document.createElement('div');
      el.className = 'tag';
      el.textContent = l.text;
      box.appendChild(el);
      return { el, pos: l.pos };
    });
  }
  function rebuild(rawSpec, presetIndex) {
    let motor;
    try {
      motor = K.build(rawSpec, S.view);
    } catch (err) {
      showError(err.message);
      return false;
    }
    if (S.motor) {
      scene.remove(S.motor.root);
      S.motor.dispose();
    }
    S.motor = motor;
    S.spec = motor.spec;
    scene.add(motor.root);
    showError('');
    syncSpecEditor();
    buildLabels();
    $('motorType').value = motor.spec.type;
    $('preset').value = String(presetIndex === undefined ? -1 : presetIndex);
    if (NS.UI && NS.UI.ready) NS.UI.refreshTables(); // 极对数和传动比变了，标尺上的载波曲线要重算
    return true;
  }

  // ---------------------------------------------------------------- 自动演示：加速 → 空档惰行（声音持续）→ 制动停车，循环
  function setDemo(on) {
    S.demo = on;
    S.demoPhase = 'accel';
    S.demoT = 0;
    if (on) S.inverterOn = true; // 没有逆变器就加不了速
  }
  function demoStep(dt) {
    const P4 = Drive.notchIndex('P4');
    const B3 = Drive.notchIndex('B3');
    const N = Drive.NOTCH_N;
    S.demoT += dt;
    switch (S.demoPhase) {
      case 'accel':
        S.notch = P4;
        if (S.speed >= 120) {
          S.demoPhase = 'cruise';
          S.demoT = 0;
          S.notch = N;
        }
        break;
      case 'cruise':
        S.notch = N;
        if (S.demoT > 4) {
          S.demoPhase = 'brake';
          S.demoT = 0;
          S.notch = B3;
        }
        break;
      case 'brake':
        S.notch = B3;
        if (S.speed <= 0.3) {
          S.demoPhase = 'rest';
          S.demoT = 0;
          S.notch = N;
        }
        break;
      default:
        S.notch = N;
        if (S.demoT > 2.5) {
          S.demoPhase = 'accel';
          S.demoT = 0;
          S.notch = P4;
        }
    }
  }

  // ---------------------------------------------------------------- 每帧
  const speedColor = new T.Color();

  function step(dt, nowMs) {
    // 1) 手柄 → 动力状态 → 车速
    if (S.demo) demoStep(dt);
    const nt = Drive.NOTCHES[S.notch];
    const mode = Drive.effectiveMode(nt.mode, S.inverterOn);
    S.driveMode = mode;
    if (!S.scrub.active) S.speed = Drive.stepSpeed(S.speed, mode, dt, { maxSpeed: S.maxSpeed, frac: nt.frac });

    // 2) 车速 → 电机转速、基波频率；模式表 → 逆变器工作点
    const m = S.motor;
    const p = m.polePairs;
    const braking = mode === 'brake';
    const load = Drive.torqueLoad(mode, nt.frac); // 转差与力矩成正比：空档时转差为零，旋转磁场和转子同步
    const d = Drive.compute(S.speed, p, m.synchronous, S.spec.drivetrain, braking, load);
    S.drive = d;
    const tabKey = braking ? 'B' : 'A';
    const table = S.tables[tabKey];
    const pt = Table.operatingPoint(table, S.speed, d.f1);
    const { run, why } = Drive.inverterRun(mode, S.inverterOn, d.f1); // 空档时逆变器仍在运转，声音持续
    const target = run ? 0.3 + 0.7 * load : 0; // 空档时只有励磁电流，磁场和电流比牵引时弱
    S.power += (target - S.power) * (1 - Math.exp(-dt / 0.12));

    // 3) 声音
    if (S.audio.mode !== 'off') {
      S.audio.send({
        kind: pt.kind,
        n: pt.n,
        f1: d.f1,
        fc: pt.fc,
        m: pt.m,
        v1: pt.v1,
        gate: run && S.soundOn && !document.hidden,
        volume: S.soundOn ? S.volume : 0,
      });
    }

    // 4) 3D 电机：可视转速、旋转磁场、绕组电流
    let vr;
    let vs;
    if (S.rotMode === 'compress') {
      vr = compress(d.rotorRps);
      vs = clamp(d.fs / p, -2.2, 2.2);
    } else {
      vr = d.rotorRps * S.slow;
      vs = (d.fs / p) * S.slow;
    }
    S.rotor = (S.rotor + TAU * vr * dt) % TAU;
    S.slipAngle = (S.slipAngle + TAU * vs * dt) % TAU;
    // 异步电机：磁场比转子多转（牵引）或少转（制动）一个转差；永磁电机：磁场超前（牵引）或滞后（制动）一个负载角，空档时没有负载角
    const lead = (S.spec.loadAngleDeg || 0) * DEG * Math.min(1, load * 1.2);
    const field = S.rotor + (m.synchronous ? (braking ? -lead : lead) : S.slipAngle);
    const psi = p * field; // 电角度
    const amp = S.power;
    const currents = [Math.cos(psi) * amp, Math.cos(psi - TAU / 3) * amp, Math.cos(psi - (2 * TAU) / 3) * amp];
    S.streak = (S.streak + Math.min(vr, 1.6) * dt) % 1;
    rpmColor(d.nr / RPM_MAX, speedColor);
    m.update({
      rotorAngle: S.rotor,
      fieldAngle: field,
      polePairs: p,
      currents,
      power: amp,
      slipAmp: m.synchronous ? 0 : clamp(Math.abs(d.fs) / 5, 0, 1) * amp,
      blur: smooth(1.2, 4.5, vr),
      streakPhase: S.streak,
      speedColor,
    });

    // 5) 界面
    const segKind = table.segments[pt.seg].kind;
    S.waveFrame = { run, kind: pt.kind, segKind, n: pt.n, fc: pt.fc, f1: d.f1, m: pt.m };
    NS.UI.update(
      {
        speed: S.speed,
        mode,
        run,
        why,
        lane: tabKey,
        seg: pt.seg,
        segKind,
        kind: pt.kind,
        n: pt.n,
        fc: pt.fc,
        v1: pt.v1,
        f1: d.f1,
        ns: d.ns,
        nr: d.nr,
        slip: d.slip,
      },
      nowMs
    );
  }

  // ---------------------------------------------------------------- 部件标注
  const tmpV = new T.Vector3();
  function placeLabels() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    S.motor.root.updateMatrixWorld();
    S.labelEls.forEach(({ el, pos }) => {
      tmpV.copy(pos).applyMatrix4(S.motor.root.matrixWorld).project(camera);
      const visible = S.labelsOn && tmpV.z < 1;
      el.style.display = visible ? '' : 'none';
      if (visible) {
        el.style.transform = 'translate(' + ((tmpV.x * 0.5 + 0.5) * w).toFixed(1) + 'px,' + ((-tmpV.y * 0.5 + 0.5) * h).toFixed(1) + 'px) translate(-50%,-130%)';
      }
    });
  }

  // ---------------------------------------------------------------- 抽屉里的电机、显示选项
  function slowFactor(x) {
    return Math.pow(10, -3 + 3 * (x / 100)); // 滑条 0..100 → 1/1000 .. 1
  }
  function slowText(f) {
    return f >= 0.995 ? '1×（真实）' : '1/' + Math.round(1 / f) + '×';
  }
  function updateRotNote() {
    $('slowRow').hidden = S.rotMode !== 'real';
    $('slowOut').textContent = slowText(S.slow);
    $('rotNote').textContent =
      S.rotMode === 'compress'
        ? '低速按真实转速转；转得更快时画面里的转速被压缩，并出现拖影，拖影颜色随转速变化。真实转速看运转台上的转速条。'
        : '转子和旋转磁场都按真实转速的固定比例放慢。转速很高时，要把倍数调得很小才看得清。';
  }

  function wire() {
    K.typeList().forEach((t) => {
      const o = document.createElement('option');
      o.value = t.type;
      o.textContent = t.label;
      $('motorType').appendChild(o);
    });
    const presets = K.presetList();
    const none = document.createElement('option');
    none.value = '-1';
    none.textContent = '（当前电机定义）';
    $('preset').appendChild(none);
    presets.forEach((p, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = p.name;
      $('preset').appendChild(o);
    });

    const carryDrive = (spec) => Object.assign({}, spec, { drivetrain: S.spec ? S.spec.drivetrain : undefined });
    $('motorType').addEventListener('change', (e) => rebuild(carryDrive(K.defaultSpec(e.target.value))));
    $('preset').addEventListener('change', (e) => {
      const i = Number(e.target.value);
      if (i >= 0) rebuild(carryDrive(presets[i].spec), i);
    });
    $('applySpec').addEventListener('click', () => {
      let raw;
      try {
        raw = JSON.parse($('specText').value);
      } catch (err) {
        showError('JSON 格式有误：' + err.message);
        return;
      }
      rebuild(raw);
    });
    $('resetSpec').addEventListener('click', () => rebuild(carryDrive(K.defaultSpec(S.spec.type))));

    $('pause').addEventListener('click', () => hooks.togglePause());
    $('rotMode').addEventListener('change', (e) => {
      S.rotMode = e.target.value;
      updateRotNote();
    });
    $('slow').addEventListener('input', (e) => {
      S.slow = slowFactor(Number(e.target.value));
      updateRotNote();
    });
    $('optCut').addEventListener('change', (e) => {
      S.view.cutaway = e.target.checked;
      rebuild(S.spec, Number($('preset').value));
    });
    const toggle = (id, keyName) =>
      $(id).addEventListener('change', (e) => {
        S.view[keyName] = e.target.checked;
        S.motor.setView({ [keyName]: e.target.checked });
      });
    toggle('optField', 'showField');
    toggle('optWinding', 'showWinding');
    toggle('optRotCur', 'showRotorCurrent');
    $('optLabels').addEventListener('change', (e) => {
      S.labelsOn = e.target.checked;
    });
    $('shell').addEventListener('input', (e) => {
      const v = Number(e.target.value);
      S.view.shellOpacity = v;
      S.motor.setView({ shellOpacity: v });
      $('shellOut').textContent = Math.round(v * 100) + '%';
    });
    $('resetView').addEventListener('click', () => orbit.reset());
    window.addEventListener('blur', () => {
      S.scrub.active = false;
    });
  }

  // 界面模块回调主程序用的接口
  const hooks = {
    saveTables,
    gesture() {
      // 浏览器规定：必须在用户的点击或按键里才能创建 / 恢复音频；这里在任何一次点击、按键时尝试
      if (S.soundOn && S.audio.mode === 'off') S.audio.start(query.get('worklet') === '0');
      else if (S.audio.ctx && S.audio.ctx.state === 'suspended') S.audio.ctx.resume();
    },
    stopDemo() {
      if (S.demo) setDemo(false);
    },
    toggleDemo() {
      setDemo(!S.demo);
    },
    togglePause() {
      S.paused = !S.paused;
      $('pause').textContent = S.paused ? '继续动画' : '暂停动画';
    },
  };

  // ---------------------------------------------------------------- 启动
  wire();
  if (phoneLayout.matches) {
    S.labelsOn = false; // 小屏幕上标注会挤成一团，默认关掉，需要时在“显示”里打开
    $('optLabels').checked = false;
  }
  if (query.get('cut') === '0') {
    S.view.cutaway = false;
    $('optCut').checked = false;
  }
  rebuild(K.defaultSpec(K.registry[query.get('type')] ? query.get('type') : 'induction'), -1);
  if (query.has('speed')) S.speed = clamp(Number(query.get('speed')) || 0, 0, MAX_SPEED);
  if (query.has('notch') && Drive.notchIndex(query.get('notch').toUpperCase()) >= 0) S.notch = Drive.notchIndex(query.get('notch').toUpperCase());
  if (query.get('pedal') === 'power') S.notch = Drive.notchIndex('P4'); // 旧版网址参数，保留兼容
  if (query.get('pedal') === 'brake') S.notch = Drive.notchIndex('B3');
  if (query.get('demo') === '1') setDemo(true);
  S.slow = slowFactor(Number($('slow').value));
  updateRotNote();

  NS.UI.init({ S, hooks });
  if ('ResizeObserver' in window) new ResizeObserver(syncDeckHeight).observe($('deck'));
  syncDeckHeight();

  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!S.paused) step(dt, now);
    NS.UI.drawScopes(S.audio.analyser, now, S.waveFrame);
    orbit.update();
    renderer.render(scene, camera);
    placeLabels();
  }
  requestAnimationFrame(frame);

  // 给控制台、测试和以后的数据回放预留的接口
  NS.App = {
    state: S,
    audio: S.audio,
    setSpeed(kmh) {
      S.speed = clamp(Number(kmh), 0, MAX_SPEED);
    },
    setNotch(id) {
      const i = Drive.notchIndex(String(id).toUpperCase());
      if (i >= 0) S.notch = i;
      return i >= 0;
    },
    loadSpec(spec) {
      return rebuild(spec);
    },
  };
})();
