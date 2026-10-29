// Page main program: master controller → driving state → speed → inverter operating point → sound and 3D motor.
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
  const TABLES_KEY = 'vvvf3d.tables.v1';
  const $ = (id) => document.getElementById(id);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const smooth = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  const query = new URLSearchParams(window.location.search);

  // ---------------------------------------------------------------- Loading and saving the mode tables
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
      /* if it cannot be read, use the defaults */
    }
    if (presets[query.get('map')]) tables = { A: Table.clone(presets[query.get('map')]), B: Table.clone(presets[query.get('map')]) };
    return tables;
  }
  function saveTables() {
    try {
      window.localStorage.setItem(TABLES_KEY, JSON.stringify(S.tables));
    } catch (err) {
      /* if the browser will not store it, never mind */
    }
  }

  const S = {
    // cab deck
    speed: 0,
    maxSpeed: MAX_SPEED,
    notch: Drive.NOTCH_N, // master controller notch (index)
    scrub: { active: false }, // dragging the vertical line on the ruler: the speed is set by hand, not integrated by the dynamics
    sel: null, // the segment selected on the ruler { lane, i }
    inverterOn: true,
    soundOn: true,
    volume: 0.3,
    driveMode: 'coast', // power = traction | coast = neutral | hold = constant speed | brake = braking (with the inverter off, power and hold both become neutral)
    power: 0, // "strength" of the inverter output, 0..1, smoothed; controls how bright the field and currents are in 3D
    tables: loadTables(),
    demo: false,
    demoPhase: 'accel',
    demoT: 0,
    paused: false,
    audio: new NS.AudioEngine(),
    waveFrame: { run: false },
    // display
    rotMode: 'compress',
    slow: 0.0224,
    labelsOn: true,
    view: { cutaway: true, shellOpacity: 0.3, showField: true, showWinding: true, showRotorCurrent: true },
    spec: null,
    motor: null,
    rpmMax: 6000, // full scale of the rotor-speed bar and of the blur colour, set by rebuild() from the drivetrain
    motorRadius: 2.29, // bounding-sphere radius of the motor, set by rebuild(); the camera frames the motor by it
    rotor: 0, // visual angle of the rotor [rad]
    slipAngle: 0, // how many more (or fewer) turns the rotating field makes than the rotor, i.e. the slip [rad]
    streak: 0, // phase of the blur pattern [turns]
    drive: null,
    labelEls: [],
  };

  // ---------------------------------------------------------------- Renderer and scene
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
  renderer.localClippingEnabled = true; // parts that turn are cut away with clipping planes (MotorKit.helpers.cutPlanes)
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

  // The stage is the part above the cab deck; the motor sits in the middle, and when the stage is too flat or too narrow the camera is pulled back so the whole motor fits
  function resize() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const tanV = Math.tan((camera.fov * Math.PI) / 360);
    const tanH = tanV * camera.aspect;
    // effective radius of the motor's silhouette from the default view: 1.7 was tuned on the default induction motor, whose bounding
    // sphere is 2.29 (the silhouette is much narrower than the sphere); other motors scale with their own bounding sphere
    const R = (1.7 / 2.29) * S.motorRadius;
    const dV = (1.08 * R * Math.sqrt(1 + tanV * tanV)) / tanV;
    const dH = (1.08 * R * Math.sqrt(1 + tanH * tanH)) / tanH;
    orbit.fit = Math.max(0.85, Math.max(dV, dH) / orbit.home.dist);
  }
  // The height of the cab deck sets the height of the stage (on narrow screens the stylesheet fixes it at 60% of the screen)
  const phoneLayout = window.matchMedia('(max-width: 760px)');
  function syncDeckHeight() {
    const root = document.documentElement;
    if (phoneLayout.matches) root.style.removeProperty('--deck-h');
    else root.style.setProperty('--deck-h', $('deck').offsetHeight + 28 + 'px');
    resize();
  }
  window.addEventListener('resize', syncDeckHeight);

  // ---------------------------------------------------------------- Orbit camera (drag to rotate, wheel to zoom, double-click to reset)
  class Orbit {
    constructor(cam, dom) {
      this.cam = cam;
      this.dom = dom;
      this.target = new T.Vector3(0, 0, 0);
      this.home = { az: 0.78, pol: 1.12, dist: 6.4 };
      Object.assign(this, this.home);
      this.fit = 1; // extra pull-back factor when the stage shape is unsuitable, set by resize()
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

  // ---------------------------------------------------------------- Speed → colour, speed → visual speed
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

  // Real speed r [rev/s] → the speed at which the rotor turns on screen [rev/s]: up to 1 rev/s it follows the real speed, beyond that it is compressed,
  // otherwise at 60 frames/s you get the "wagon-wheel" illusion and cannot tell fast from slow.
  function compress(r) {
    if (r <= 1) return r;
    return 1 + (4.2 * Math.log(r)) / Math.log(80);
  }

  // ---------------------------------------------------------------- Building and replacing the motor
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
  // A round number just above the rotor speed at the top speed, so a geared motor (about 5500 rpm) and a direct drive (about 1000 rpm) both use the whole bar
  function rpmFullScale(spec) {
    const nr = Drive.compute(MAX_SPEED, 2, true, spec.drivetrain).nr; // the rotor speed depends only on the drivetrain
    return [600, 1000, 1500, 2000, 3000, 4000, 6000, 8000, 10000].find((c) => nr <= c) || Math.ceil(nr / 5000) * 5000;
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
    S.rpmMax = rpmFullScale(motor.spec);
    $('rpmMax').textContent = S.rpmMax;
    S.motorRadius = new T.Box3().setFromObject(motor.root, true).getBoundingSphere(new T.Sphere()).radius;
    resize();
    scene.add(motor.root);
    showError('');
    syncSpecEditor();
    buildLabels();
    $('motorType').value = motor.spec.type;
    $('preset').value = String(presetIndex === undefined ? -1 : presetIndex);
    if (NS.UI && NS.UI.ready) NS.UI.refreshTables(); // pole pairs and gear ratio changed, so the carrier curves on the ruler must be recomputed
    return true;
  }

  // ---------------------------------------------------------------- Auto demo: accelerate → neutral coasting (sound continues) → brake to a stop, in a loop
  function setDemo(on) {
    S.demo = on;
    S.demoPhase = 'accel';
    S.demoT = 0;
    if (on) S.inverterOn = true; // without the inverter there is no acceleration
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

  // ---------------------------------------------------------------- Every frame
  const speedColor = new T.Color();

  function step(dt, nowMs) {
    // 1) controller → driving state → speed
    if (S.demo) demoStep(dt);
    const nt = Drive.NOTCHES[S.notch];
    const mode = Drive.effectiveMode(nt.mode, S.inverterOn);
    S.driveMode = mode;
    if (!S.scrub.active) S.speed = Drive.stepSpeed(S.speed, mode, dt, { maxSpeed: S.maxSpeed, frac: nt.frac });

    // 2) speed → motor speed and fundamental frequency; mode table → inverter operating point
    const m = S.motor;
    const p = m.polePairs;
    const braking = mode === 'brake';
    const load = Drive.torqueLoad(mode, nt.frac); // slip is proportional to torque: zero slip in neutral, the rotating field is in sync with the rotor
    const d = Drive.compute(S.speed, p, m.synchronous, S.spec.drivetrain, braking, load);
    S.drive = d;
    const tabKey = braking ? 'B' : 'A';
    const table = S.tables[tabKey];
    const pt = Table.operatingPoint(table, S.speed, d.f1);
    const { run, why } = Drive.inverterRun(mode, S.inverterOn, d.f1); // in neutral the inverter keeps running, so the sound continues
    const target = run ? 0.3 + 0.7 * load : 0; // in neutral there is only magnetizing current, so the field and currents are weaker than under power
    S.power += (target - S.power) * (1 - Math.exp(-dt / 0.12));

    // 3) sound
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

    // 4) 3D motor: visual speed, rotating field, winding currents
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
    // Induction motor: the field makes more (power) or fewer (braking) turns than the rotor by one slip; permanent-magnet motor: the field leads (power) or lags (braking) by one load angle, and there is none in neutral
    const lead = (S.spec.loadAngleDeg || 0) * DEG * Math.min(1, load * 1.2);
    const field = S.rotor + (m.synchronous ? (braking ? -lead : lead) : S.slipAngle);
    const psi = p * field; // electrical angle
    const amp = S.power;
    const currents = [Math.cos(psi) * amp, Math.cos(psi - TAU / 3) * amp, Math.cos(psi - (2 * TAU) / 3) * amp];
    S.streak = (S.streak + Math.min(vr, 1.6) * dt) % 1;
    rpmColor(d.nr / S.rpmMax, speedColor);
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

    // 5) UI
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

  // ---------------------------------------------------------------- Part labels
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

  // ---------------------------------------------------------------- Motor and display options in the drawer
  function slowFactor(x) {
    return Math.pow(10, -3 + 3 * (x / 100)); // slider 0..100 → 1/1000 .. 1
  }
  function slowText(f) {
    return f >= 0.995 ? '1× (real)' : '1/' + Math.round(1 / f) + '×';
  }
  function updateRotNote() {
    $('slowRow').hidden = S.rotMode !== 'real';
    $('slowOut').textContent = slowText(S.slow);
    $('rotNote').textContent =
      S.rotMode === 'compress'
        ? 'At low speed the rotor turns at its real speed; faster than that the on-screen speed is compressed and a blur appears, whose colour follows the speed. For the real speed see the speed bar on the cab deck.'
        : 'The rotor and the rotating field are both slowed by a fixed ratio of the real speed. At high speed you have to set the ratio very small to see anything.';
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
    none.textContent = '(current motor definition)';
    $('preset').appendChild(none);
    presets.forEach((p, i) => {
      const o = document.createElement('option');
      o.value = String(i);
      o.textContent = p.name;
      $('preset').appendChild(o);
    });

    // A drivetrain the user has edited is kept when the motor changes; an untouched one gives way to the new type's own default
    // (the outer rotor is a direct drive with gear ratio 1, the others have the 5.6 gearbox)
    const sameDrive = (a, b) => Object.keys(NS.Drive.DEFAULT_DRIVE).every((k) => a[k] === b[k]);
    const carryDrive = (spec) => {
      if (!S.spec || sameDrive(S.spec.drivetrain, K.normalizeSpec(K.defaultSpec(S.spec.type)).drivetrain)) return spec;
      return Object.assign({}, spec, { drivetrain: S.spec.drivetrain });
    };
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
        showError('Invalid JSON: ' + err.message);
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

  // Interface the UI modules call back into the main program
  const hooks = {
    saveTables,
    gesture() {
      // Browsers only allow audio to be created or resumed inside a user click or key press; try it on every click and key press
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
      $('pause').textContent = S.paused ? 'Resume animation' : 'Pause animation';
    },
  };

  // ---------------------------------------------------------------- Startup
  wire();
  if (phoneLayout.matches) {
    S.labelsOn = false; // on a small screen the labels crowd together, so they are off by default; turn them on in Display if needed
    $('optLabels').checked = false;
  }
  if (query.get('cut') === '0') {
    S.view.cutaway = false;
    $('optCut').checked = false;
  }
  rebuild(K.defaultSpec(K.registry[query.get('type')] ? query.get('type') : 'induction'), -1);
  if (query.has('speed')) S.speed = clamp(Number(query.get('speed')) || 0, 0, MAX_SPEED);
  if (query.has('notch') && Drive.notchIndex(query.get('notch').toUpperCase()) >= 0) S.notch = Drive.notchIndex(query.get('notch').toUpperCase());
  if (query.get('pedal') === 'power') S.notch = Drive.notchIndex('P4'); // old URL parameter, kept for compatibility
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

  // Interface reserved for the console, tests, and later data playback
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
