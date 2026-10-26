// Mode ruler: the horizontal axis is vehicle speed; it is the speedometer, a slider for jumping to a speed, and the editor of the mode tables.
//   Two lanes: Power (table A) and Brake (table B); every segment is coloured by modulation kind, and the white line inside is the "sawtooth" of carrier frequency against speed;
//   the vertical line is the current speed: drag it (or press and drag anywhere on the ruler) to jump straight to a speed, and the sound and the 3D motor follow;
//   drag the boundary between two segments to change the speed range; click a segment to open the editor and change the modulation kind, carrier frequency or pulse count, and listen right away.
(function (NS) {
  'use strict';

  const T = NS.Table;
  const Drive = NS.Drive;
  const $ = (id) => document.getElementById(id);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const SVGNS = 'http://www.w3.org/2000/svg';

  const LANES = [
    { id: 'A', name: 'Power' },
    { id: 'B', name: 'Brake' },
  ];
  const LANE_NAME = { A: 'Power', B: 'Brake' };
  const HUE = { async: 'var(--m-async)', sync: 'var(--m-sync)', wide3: 'var(--m-wide)', square: 'var(--m-square)' };
  const KIND_SHORT = { async: 'Async', sync: 'Sync', wide3: 'Wide 3', square: 'Square' };
  const SNAP = 0.5; // rounding when dragging a boundary [km/h]

  let S = null;
  let hooks = null;
  let wrap = null;
  let svg = null;
  let labels = null;
  let insp = null;
  let menu = null;
  let scalePop = null;
  let geo = null;
  let ph = null;
  let dot = null;
  let phText = null;
  let phLast = '';
  let segEls = { A: [], B: [] };
  let liveKey = '';
  let drag = null;

  function node(name, attrs, parent) {
    const e = document.createElementNS(SVGNS, name);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }
  const fmt1 = (x) => (Math.round(x * 10) / 10).toFixed(1);
  const hz = (x) => String(Math.round(x * 10) / 10);
  // At low speed the pitch you hear for a carrier fc is about 2·fc: written as "523 Hz (C5)", with the deviation in cents when the note is not exact
  function heardText(fc) {
    const n = T.nearestNote(2 * fc);
    return Math.round(2 * fc) + ' Hz (' + n.name + (n.cents ? (n.cents > 0 ? '+' : '') + n.cents + '¢' : '') + ')';
  }

  // ================================================================ Geometry
  function layout() {
    const W = Math.max(280, wrap.clientWidth);
    const narrow = W < 560;
    const padL = narrow ? 40 : 112;
    const padR = 14;
    const top = 24;
    const short = window.innerHeight < 800 && !window.matchMedia('(max-width: 760px)').matches; // squash the lanes on a short screen
    const LH = narrow ? 42 : short ? 38 : 44; // the top row holds the segment name, the carrier curve is drawn below it
    const gap = 6;
    geo = {
      W,
      narrow,
      padL,
      padR,
      top,
      LH,
      gap,
      plotW: W - padL - padR,
      laneY: [top, top + LH + gap],
      axisY: top + 2 * LH + gap + 6,
      H: top + 2 * LH + gap + 6 + 24,
      max: S.maxSpeed,
    };
    svg.setAttribute('width', W);
    svg.setAttribute('height', geo.H);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + geo.H);
    wrap.style.height = geo.H + 'px';
  }
  const xOf = (v) => geo.padL + (clamp(v, 0, geo.max) / geo.max) * geo.plotW;
  const vOf = (x) => ((x - geo.padL) / geo.plotW) * geo.max;
  const speedAt = (clientX) => clamp(Math.round(vOf(clientX - svg.getBoundingClientRect().left) * 10) / 10, 0, geo.max);

  // Carrier frequency against speed: one polyline per segment (the jumps between segments are not connected)
  function carrierTrace(lane) {
    const t = S.tables[lane];
    const m = S.motor;
    const p = m ? m.polePairs : 2;
    const sync = m ? m.synchronous : false;
    const drive = S.spec ? S.spec.drivetrain : undefined;
    return t.segments.map((s, i) => {
      const from = T.segmentFrom(t, i);
      const steps = Math.max(2, Math.ceil((s.to - from) / 0.5));
      const pts = [];
      for (let k = 0; k <= steps; k++) {
        const v = from + ((s.to - from) * k) / steps - (k === steps ? 1e-6 : 0);
        const d = Drive.compute(v, p, sync, drive, lane === 'B', 1);
        pts.push([v, T.carrierAt(t, v, d.f1)]);
      }
      return pts;
    });
  }
  function niceTop(x) {
    for (const c of [300, 600, 1200, 1800, 2400, 3000, 4500, 6000, 9000]) if (x * 1.06 <= c) return c;
    return 12000;
  }

  // ================================================================ Drawing
  function render() {
    if (!svg || !S.tables) return;
    layout();
    svg.textContent = '';
    labels.textContent = '';
    segEls = { A: [], B: [] };
    liveKey = '';

    const traces = { A: carrierTrace('A'), B: carrierTrace('B') };
    let fcMax = 0;
    for (const id of ['A', 'B']) for (const seg of traces[id]) for (const pt of seg) fcMax = Math.max(fcMax, pt[1]);
    const top = niceTop(fcMax);

    const gLane = node('g', null, svg);
    const gTrace = node('g', { class: 'traces' }, svg);
    const gHandle = node('g', null, svg);

    LANES.forEach((lane, li) => {
      const t = S.tables[lane.id];
      const y = geo.laneY[li];
      const LH = geo.LH;
      node('rect', { class: 'lanebg', x: geo.padL, y, width: geo.plotW, height: LH, rx: 8 }, gLane);
      // y-axis scale: how many Hz a full lane height stands for
      const tt = node('text', { class: 'ytop', x: geo.padL + geo.plotW - 4, y: y + 11, 'text-anchor': 'end' }, gLane);
      if (li === 0) tt.textContent = top >= 1000 ? top / 1000 + ' kHz' : top + ' Hz';

      // Two markers on the voltage curve: full modulation (reference amplitude 1) and full voltage (square-wave equivalent)
      for (const [v, text] of [
        [t.vBase, 'Full modulation at ' + fmt1(t.vBase) + ' km/h (reference amplitude = 1)'],
        [t.vFull, 'Full voltage at ' + fmt1(t.vFull) + ' km/h (output equivalent to a square wave)'],
      ]) {
        const g = node('g', { class: 'vmark' }, gLane);
        node('line', { x1: xOf(v), x2: xOf(v), y1: y + 2, y2: y + LH - 2 }, g);
        node('title', null, g).textContent = text;
      }

      // segments
      t.segments.forEach((s, i) => {
        const from = T.segmentFrom(t, i);
        const x0 = xOf(from);
        const x1 = xOf(s.to);
        const w = x1 - x0;
        const g = node('g', { class: 'seg', 'data-hit': 'seg', 'data-lane': lane.id, 'data-i': i, style: '--h:' + HUE[s.kind] }, gLane);
        node('rect', { x: x0 + 0.75, y, width: Math.max(1, w - 1.5), height: LH, rx: 6 }, g);
        // Segment name and parameter on one line (the parameter only if it fits); the carrier curve is drawn below
        if (w >= 38) {
          const kindText = KIND_SHORT[s.kind];
          const param = s.kind === 'async' ? (s.fc0 === s.fc1 ? hz(s.fc0) : hz(s.fc0) + '→' + hz(s.fc1)) + ' Hz' : s.kind === 'sync' ? s.n + ' pulses' : s.kind === 'wide3' ? 'overmod.' : '1 pulse';
          const textW = (str) => [...str].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 11 : 6.2), 0);
          const lab = node('text', { class: 'lab', x: x0 + 8, y: y + 14 }, g);
          node('tspan', { class: 't1' }, lab).textContent = kindText;
          if (8 + textW(kindText) * 1.1 + 8 + textW(param) + 6 <= w) node('tspan', { class: 't2', dx: 7 }, lab).textContent = param;
        }
        node('title', null, g).textContent = LANE_NAME[lane.id] + ' · ' + fmt1(from) + ' – ' + fmt1(s.to) + ' km/h · ' + T.describe(s) + ' (click to edit)';
        segEls[lane.id][i] = g;
      });

      // carrier curve
      for (const pts of traces[lane.id]) {
        const d = pts.map((p, k) => (k ? 'L' : 'M') + xOf(p[0]).toFixed(1) + ' ' + (y + LH - 4 - (clamp(p[1], 0, top) / top) * (LH - 24)).toFixed(1)).join('');
        node('path', { class: 'glow', d }, gTrace);
        node('path', { class: 'line', d }, gTrace);
      }

      // boundary handles (the last segment extends to the top speed and has none)
      t.segments.forEach((s, i) => {
        if (i === t.segments.length - 1) return;
        const hx = xOf(s.to);
        // Half width of the grab area: it must shrink for narrow segments (such as a run of scale steps), otherwise the handles on both sides cover the whole segment and it cannot be clicked
        const wLeft = xOf(s.to) - xOf(T.segmentFrom(t, i));
        const wRight = xOf(t.segments[i + 1].to) - hx;
        const half = clamp(Math.min(wLeft, wRight) / 4, 2.5, 7);
        const h = node('g', { class: 'handle', 'data-hit': 'handle', 'data-lane': lane.id, 'data-i': i }, gHandle);
        node('rect', { class: 'hit', x: hx - half, y: y - 2, width: half * 2, height: LH + 4 }, h);
        node('rect', { class: 'grip', x: hx - 2, y: y + LH / 2 - 8, width: 4, height: 16, rx: 2 }, h);
        node('title', null, h).textContent = 'Drag to move the boundary at ' + fmt1(s.to) + ' km/h';
      });

      // Lane name and table-options buttons (HTML, laid over the blank space at the left of the ruler)
      const lab = document.createElement('div');
      lab.className = 'lane-lab' + (geo.narrow ? ' narrow' : '');
      lab.style.top = y + 'px';
      lab.style.height = LH + 'px';
      lab.style.width = geo.padL - 6 + 'px'; // must not be wider than the blank space left of the ruler, otherwise it covers the first segment
      lab.innerHTML =
        '<b>' + (geo.narrow ? lane.id : lane.name) + '</b>' + (geo.narrow ? '' : '<small>' + lane.id + '</small>') +
        (geo.narrow ? '' : '<button class="mini" data-scale="' + lane.id + '" aria-label="Scale steps of the ' + lane.name + ' table" title="Scale steps: lay a run of rising asynchronous modulations over a speed range (do re mi)">♪</button>') +
        '<button class="mini" data-menu="' + lane.id + '" aria-label="Options of the ' + lane.name + ' table" title="' + lane.name + ' table options: presets, voltage curve, import / export">⋯</button>';
      labels.appendChild(lab);
    });

    // horizontal axis
    const gAxis = node('g', { class: 'axis' }, svg);
    node('line', { x1: geo.padL, x2: geo.padL + geo.plotW, y1: geo.axisY, y2: geo.axisY }, gAxis);
    const major = geo.plotW / geo.max >= 3.2 ? 10 : 20;
    for (let v = 0; v <= geo.max + 1e-6; v += 10) {
      const isMajor = v % major === 0;
      const x = xOf(v);
      node('line', { x1: x, x2: x, y1: geo.axisY, y2: geo.axisY + (isMajor ? 6 : 3) }, gAxis);
      if (isMajor && !(geo.narrow && v % 40 !== 0)) {
        const t = node('text', { x, y: geo.axisY + 18, 'text-anchor': 'middle' }, gAxis);
        t.textContent = v;
      }
    }
    const unit = node('text', { x: geo.padL - 8, y: geo.axisY + 18, 'text-anchor': 'end', class: 'unit' }, gAxis);
    unit.textContent = 'km/h';

    // The dot riding on the carrier curve with the speed: its height is the current pitch (carrier frequency)
    geo.fcTop = top;
    dot = node('circle', { class: 'cdot', r: 4.5, cx: -20, cy: -20 }, svg);

    // playhead: the current speed
    ph = node('g', { class: 'ph', 'data-hit': 'ph' }, svg);
    node('line', { x1: 0, x2: 0, y1: 14, y2: geo.axisY }, ph);
    node('rect', { class: 'flag', x: -25, y: 0, width: 50, height: 19, rx: 9.5 }, ph);
    phText = node('text', { x: 0, y: 13.5, 'text-anchor': 'middle' }, ph);
    node('rect', { class: 'grab', x: -9, y: 0, width: 18, height: geo.axisY }, ph);
    phLast = '';
    markSel();
    refreshInsp();
    update({ lane: '', seg: -1, run: false });
  }

  // ================================================================ Every frame: the playhead and the segment that is working
  // f = { lane, seg, run, fc }
  function update(f) {
    if (!geo || !ph) return;
    const px = xOf(S.speed);
    ph.setAttribute('transform', 'translate(' + px.toFixed(1) + ' 0)');
    if (f.run && f.fc !== undefined) {
      const li = f.lane === 'B' ? 1 : 0;
      dot.setAttribute('cx', px.toFixed(1));
      dot.setAttribute('cy', (geo.laneY[li] + geo.LH - 4 - (clamp(f.fc, 0, geo.fcTop) / geo.fcTop) * (geo.LH - 24)).toFixed(1));
      dot.style.display = '';
    } else dot.style.display = 'none';
    const label = fmt1(S.speed);
    if (label !== phLast) {
      phLast = label;
      phText.textContent = label;
    }
    const key = f.lane + ':' + f.seg + ':' + f.run;
    if (key !== liveKey) {
      liveKey = key;
      for (const id of ['A', 'B']) {
        segEls[id].forEach((g, i) => {
          const isCur = id === f.lane && i === f.seg;
          g.classList.toggle('cur', isCur);
          g.classList.toggle('live', isCur && f.run);
        });
      }
    }
  }

  function markSel() {
    for (const id of ['A', 'B']) segEls[id].forEach((g, i) => g.classList.toggle('sel', !!S.sel && S.sel.lane === id && S.sel.i === i));
  }

  // ================================================================ Editor
  function showErr(msg) {
    $('segErr').textContent = msg || '';
  }
  function positionPop(el, cx) {
    if (window.matchMedia('(max-width: 760px)').matches) {
      // on a phone the editor sits above the ruler instead of floating over it
      el.style.left = '';
      el.style.setProperty('--caret', '-100px');
      if (el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    const w = el.offsetWidth || 352;
    const left = clamp(cx - w / 2, 6, Math.max(6, wrap.clientWidth - w - 6));
    el.style.left = left + 'px';
    el.style.setProperty('--caret', clamp(cx - left, 18, w - 18) + 'px');
  }

  function refreshInsp() {
    if (!S.sel) {
      insp.hidden = true;
      return;
    }
    const lane = S.sel.lane;
    const t = S.tables[lane];
    const i = clamp(S.sel.i, 0, t.segments.length - 1);
    S.sel.i = i;
    const s = t.segments[i];
    const last = i === t.segments.length - 1;
    const from = T.segmentFrom(t, i);
    insp.hidden = false;
    insp.style.setProperty('--h', HUE[s.kind]);
    $('inspTitle').textContent = LANE_NAME[lane] + ' · segment ' + (i + 1);
    $('inspRange').textContent = fmt1(from) + ' – ' + fmt1(s.to) + ' km/h';
    insp.querySelectorAll('#inspKinds button').forEach((b) => b.classList.toggle('on', b.dataset.kind === s.kind));
    $('eTo').value = s.to;
    $('eTo').disabled = last;
    $('rowAsync').hidden = s.kind !== 'async';
    $('rowSync').hidden = s.kind !== 'sync';
    if (s.kind === 'async') {
      $('eFc0').value = s.fc0;
      $('eFc1').value = s.fc1;
    }
    if (s.kind === 'sync') $('eN').value = s.n;
    const hint = $('rowHint');
    hint.hidden = false;
    if (s.kind === 'wide3') hint.textContent = 'Synchronous modulation with 3 pulses; it goes into overmodulation along the voltage curve, all the way to a square-wave equivalent.';
    else if (s.kind === 'square') hint.textContent = 'Only one pulse per fundamental period and the highest voltage, i.e. a square wave.';
    else if (s.kind === 'async') hint.textContent = 'At low speed (small modulation index) what you hear is mostly twice the carrier: about ' + heardText(s.fc0) + (s.fc1 === s.fc0 ? '' : ' → ' + heardText(s.fc1)) + '.';
    else {
      hint.hidden = true;
      hint.textContent = '';
    }
    $('segDel').disabled = t.segments.length <= 1;
    $('inspPrev').disabled = i === 0;
    $('inspNext').disabled = last;
    positionPop(insp, (xOf(from) + xOf(s.to)) / 2);
  }

  // Edit a copy first and apply it only if it passes validation; otherwise show the problem and restore the editor fields
  function edit(lane, mutate) {
    const t = T.clone(S.tables[lane]);
    mutate(t);
    const problems = T.validate(t);
    if (problems.length) {
      showErr(problems[0]);
      refreshInsp();
      return false;
    }
    showErr('');
    S.tables[lane] = t;
    render();
    hooks.saveTables();
    return true;
  }

  function select(lane, i) {
    if (menu) menu.hidden = true;
    if (scalePop) scalePop.hidden = true;
    S.sel = lane ? { lane, i } : null;
    showErr('');
    markSel();
    refreshInsp();
  }

  function initInspector() {
    const cur = () => S.sel;
    $('inspClose').addEventListener('click', () => select(null));
    $('inspKinds').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !cur()) return;
      const { lane, i } = cur();
      edit(lane, (t) => {
        const s = t.segments[i];
        const old = Object.assign({}, s);
        s.kind = b.dataset.kind;
        delete s.fc0;
        delete s.fc1;
        delete s.n;
        if (s.kind === 'async') {
          s.fc0 = old.fc0 || 1050;
          s.fc1 = old.fc1 || s.fc0;
        }
        if (s.kind === 'sync') s.n = old.n && old.n % 2 === 1 && old.n >= 3 ? old.n : 9;
      });
    });
    const bindNum = (id, apply) =>
      $(id).addEventListener('change', (e) => {
        if (!cur()) return;
        const { lane, i } = cur();
        const v = Number(e.target.value);
        edit(lane, (t) => apply(t.segments[i], v, t));
      });
    bindNum('eTo', (s, v) => (s.to = v));
    bindNum('eFc0', (s, v) => (s.fc0 = v));
    bindNum('eFc1', (s, v) => (s.fc1 = v));
    bindNum('eN', (s, v) => (s.n = Math.round(v)));

    $('inspPrev').addEventListener('click', () => cur() && select(cur().lane, cur().i - 1));
    $('inspNext').addEventListener('click', () => cur() && select(cur().lane, cur().i + 1));

    $('segSplit').addEventListener('click', () => {
      if (!cur()) return;
      const { lane, i } = cur();
      const t0 = S.tables[lane];
      const from = T.segmentFrom(t0, i);
      const to = t0.segments[i].to;
      const mid = Math.round(((from + to) / 2) * 2) / 2;
      if (mid - from < T.MIN_GAP || to - mid < T.MIN_GAP) {
        showErr('This segment is too short to split');
        return;
      }
      if (
        edit(lane, (t) => {
          const s = t.segments[i];
          const first = Object.assign({}, s, { to: mid });
          const second = Object.assign({}, s);
          if (s.kind === 'async') {
            const fcm = Math.round((s.fc0 + s.fc1) / 2);
            first.fc1 = fcm;
            second.fc0 = fcm;
          }
          t.segments.splice(i, 1, first, second);
        })
      ) {
        select(lane, i + 1);
      }
    });
    $('segDel').addEventListener('click', () => {
      if (!cur()) return;
      const { lane, i } = cur();
      if (
        edit(lane, (t) => {
          if (t.segments.length <= 1) return;
          if (i === t.segments.length - 1) t.segments[i - 1].to = t.segments[i].to; // deleting the last segment: the previous one extends to the top speed
          t.segments.splice(i, 1);
        })
      ) {
        select(lane, clamp(i, 0, S.tables[lane].segments.length - 1));
      }
    });

    // Listen: in the power table jump to the middle of this segment and hold the speed; in the brake table jump to its high-speed end and glide through with the lightest braking
    $('inspListen').addEventListener('click', () => {
      if (!cur()) return;
      const { lane, i } = cur();
      const t = S.tables[lane];
      const from = T.segmentFrom(t, i);
      const to = t.segments[i].to;
      hooks.stopDemo();
      S.inverterOn = true;
      if (lane === 'A') {
        S.speed = clamp(Math.round(((from + to) / 2) * 10) / 10, 0, S.maxSpeed);
        S.notch = Drive.notchIndex('H');
      } else {
        S.speed = clamp(Math.max(from + 0.1, to - 0.3), 0, S.maxSpeed);
        S.notch = Drive.notchIndex('B1');
      }
      hooks.gesture();
    });
  }

  // ================================================================ Lane menu (presets, voltage curve, import / export)
  let menuLane = 'A';
  // The one-line message at the bottom of the menu; ok = true gives the success colour, otherwise the error red
  function menuNote(text, ok) {
    const el = $('menuMsg');
    el.textContent = text || '';
    el.classList.toggle('ok', !!ok);
  }
  function refreshMenu() {
    const t = S.tables[menuLane];
    $('menuTitle').textContent = LANE_NAME[menuLane] + ' table (' + menuLane + ') options';
    $('vBase').value = t.vBase;
    $('vFull').value = t.vFull;
    $('tblCopy').textContent = 'Copy to the ' + (menuLane === 'A' ? 'Brake' : 'Power') + ' table';
  }
  function openMenu(lane, btn) {
    menuLane = lane;
    select(null);
    menuNote('');
    refreshMenu();
    menu.hidden = false;
    const r = btn.getBoundingClientRect();
    const wr = wrap.getBoundingClientRect();
    positionPop(menu, r.left - wr.left + r.width / 2);
  }
  function initMenu() {
    const presets = T.presets();
    Object.keys(presets).forEach((k) => {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = presets[k].name;
      $('tblPreset').appendChild(o);
    });
    const msg = menuNote;
    $('menuClose').addEventListener('click', () => (menu.hidden = true));
    labels.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-menu]');
      if (!b) return;
      if (!menu.hidden && menuLane === b.dataset.menu) menu.hidden = true;
      else openMenu(b.dataset.menu, b);
    });
    $('tblLoad').addEventListener('click', () => {
      S.tables[menuLane] = T.clone(T.presets()[$('tblPreset').value]);
      msg('');
      render();
      refreshMenu();
      hooks.saveTables();
    });
    const bindV = (id, key) =>
      $(id).addEventListener('change', (e) => {
        const t = T.clone(S.tables[menuLane]);
        t[key] = Number(e.target.value);
        const problems = T.validate(t);
        if (problems.length) {
          msg(problems[0]);
          refreshMenu();
          return;
        }
        msg('');
        S.tables[menuLane] = t;
        render();
        hooks.saveTables();
      });
    bindV('vBase', 'vBase');
    bindV('vFull', 'vFull');
    $('tblCopy').addEventListener('click', () => {
      const other = menuLane === 'A' ? 'B' : 'A';
      S.tables[other] = T.clone(S.tables[menuLane]);
      render();
      hooks.saveTables();
      msg('Copied to the ' + LANE_NAME[other] + ' table', true);
    });
    $('tblReset').addEventListener('click', () => {
      S.tables[menuLane] = T.clone(T.presets().reference);
      msg('');
      render();
      refreshMenu();
      hooks.saveTables();
    });
    $('tblExport').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify({ version: 1, tables: S.tables }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'vvvf-tables.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    $('tblImport').addEventListener('click', () => $('tblFile').click());
    $('tblFile').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const obj = JSON.parse(await file.text());
        const incoming = obj.tables ? obj.tables : { [menuLane]: obj }; // a full export (A and B) or a single table
        const next = {};
        Object.keys(incoming).forEach((k) => {
          if (k !== 'A' && k !== 'B') return;
          const t = T.normalize(incoming[k]);
          const problems = T.validate(t);
          if (problems.length) throw new Error(LANE_NAME[k] + ' table: ' + problems[0]);
          next[k] = t;
        });
        if (!Object.keys(next).length) throw new Error('No A or B table found in the file');
        Object.assign(S.tables, next);
        render();
        refreshMenu();
        hooks.saveTables();
        msg('Imported: ' + Object.keys(next).map((k) => LANE_NAME[k]).join(', ') + ' table', true);
      } catch (err) {
        msg('Import failed: ' + err.message);
      }
    });
  }

  // ================================================================ Scale steps (do re mi)
  const round1 = (x) => Math.round(x * 10) / 10;
  function initScale() {
    Object.keys(T.SCALES).forEach((k) => {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = T.SCALES[k].name;
      $('scKind').appendChild(o);
    });
    for (let oct = 3; oct <= 5; oct++) {
      ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].forEach((n) => {
        const o = document.createElement('option');
        o.value = n + oct;
        o.textContent = n + oct;
        $('scRoot').appendChild(o);
      });
    }
    $('scRoot').value = 'C4';
    let scaleLane = 'A';
    // The one-line message at the bottom of the popover; ok = true gives the success colour, otherwise the error red
    const note = (text, ok) => {
      const el = $('scMsg');
      el.textContent = text || '';
      el.classList.toggle('ok', !!ok);
    };

    function openScale(lane, btn) {
      scaleLane = lane;
      select(null); // close the editor and the menu
      $('scTitle').textContent = 'Scale steps · ' + LANE_NAME[lane] + ' table';
      note('');
      info();
      scalePop.hidden = false;
      const r = btn.getBoundingClientRect();
      const wr = wrap.getBoundingClientRect();
      positionPop(scalePop, r.left - wr.left + r.width / 2);
    }
    labels.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-scale]');
      if (!b) return;
      if (!scalePop.hidden && scaleLane === b.dataset.scale) scalePop.hidden = true;
      else openScale(b.dataset.scale, b);
    });
    // On a narrow screen there is no ♪ button beside the lane name, so enter from the "⋯" menu
    $('tblScale').addEventListener('click', () => openScale(menuLane, labels.querySelector('button[data-menu="' + menuLane + '"]') || $('tblScale')));
    $('scClose').addEventListener('click', () => (scalePop.hidden = true));

    // Read the notes in the text field as carrier frequencies; returns { carriers, names, error }
    function parse() {
      const tokens = $('scNotes').value.split(/[\s,;]+/).filter(Boolean);
      const freqs = tokens.map(T.noteFrequency);
      const bad = tokens.filter((_, i) => isNaN(freqs[i]));
      if (!tokens.length) return { error: 'No notes yet' };
      if (bad.length) return { error: 'Cannot read these notes: ' + bad.join(', ') + ' (write them like C4, F#3, Bb4, or give a frequency such as 523)' };
      const heard = $('scBasis').value === 'heard';
      return { tokens, freqs, carriers: freqs.map((f) => round1(heard ? f / 2 : f)), heard };
    }
    function info() {
      const el = $('scInfo');
      const p = parse();
      const from = Number($('scFrom').value);
      const to = Number($('scTo').value);
      if (p.error) {
        el.textContent = p.error;
        return;
      }
      const n = p.carriers.length;
      const w = (to - from) / n;
      const c = p.carriers;
      el.textContent = n + (n === 1 ? ' step' : ' steps') + ', about ' + (isFinite(w) ? Math.round(w * 100) / 100 : '?') + ' km/h each; carrier ' + c[0] + (n > 1 ? ' → ' + c[n - 1] : '') + ' Hz' + (p.heard ? ', heard pitch ' + p.tokens[0] + (n > 1 ? ' → ' + p.tokens[n - 1] : '') : ', the heard pitch is about twice the carrier');
    }
    function fill() {
      $('scNotes').value = T.scaleNotes($('scRoot').value, $('scKind').value).join(' ');
      info();
    }
    ['scKind', 'scRoot'].forEach((id) => $(id).addEventListener('change', fill));
    ['scNotes', 'scFrom', 'scTo'].forEach((id) => $(id).addEventListener('input', info));
    $('scBasis').addEventListener('change', info);
    fill();

    function generate(play) {
      const p = parse();
      if (p.error) return note(p.error);
      const from = Number($('scFrom').value);
      const to = Number($('scTo').value);
      const t = T.clone(S.tables[scaleLane]);
      try {
        T.staircase(t, from, to, p.carriers);
      } catch (err) {
        return note(err.message);
      }
      const problems = T.validate(t);
      if (problems.length) return note(problems[0]);
      S.tables[scaleLane] = t;
      S.sel = null; // the old segments are gone, so the selection is void (select(null) cannot be used: it would close the popover too)
      render();
      hooks.saveTables();
      note('Generated ' + p.carriers.length + (p.carriers.length === 1 ? ' step' : ' steps') + ' (' + LANE_NAME[scaleLane] + ' table ' + round1(from) + ' – ' + round1(to) + ' km/h)', true);
      if (play) {
        // Start at the beginning at full power (brake table: start at the end and brake with B2), so the steps sound one after another
        hooks.stopDemo();
        S.inverterOn = true;
        if (scaleLane === 'A') {
          S.speed = clamp(round1(from), 0, S.maxSpeed);
          S.notch = Drive.notchIndex('P4');
        } else {
          S.speed = clamp(round1(to), 0, S.maxSpeed);
          S.notch = Drive.notchIndex('B2');
        }
        hooks.gesture();
      }
    }
    $('scGo').addEventListener('click', () => generate(true));
    $('scMake').addEventListener('click', () => generate(false));
  }

  // ================================================================ Mouse / touch
  function initPointer() {
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const hit = e.target.closest('[data-hit]');
      const kind = hit ? hit.dataset.hit : 'bg';
      try {
        svg.setPointerCapture(e.pointerId);
      } catch (err) {
        /* not supported in some cases, ignore */
      }
      drag = { id: e.pointerId, kind, lane: hit && hit.dataset.lane, i: hit ? Number(hit.dataset.i) : -1, x0: e.clientX, moved: false };
      if (menu) menu.hidden = true;
      if (kind === 'handle') {
        hooks.stopDemo();
      } else if (kind !== 'seg') {
        startScrub(e);
      }
    });
    svg.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      if (drag.kind === 'seg' && !drag.moved && Math.abs(e.clientX - drag.x0) > 4) {
        drag.moved = true;
        drag.kind = 'scrub';
        startScrub(e);
      }
      if (drag.kind === 'scrub') S.speed = speedAt(e.clientX);
      else if (drag.kind === 'handle') dragHandle(e);
    });
    const end = (e) => {
      if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.id)) return;
      if (drag.kind === 'seg' && !drag.moved && e.type === 'pointerup') {
        const same = S.sel && S.sel.lane === drag.lane && S.sel.i === drag.i;
        select(same ? null : drag.lane, drag.i);
      }
      if (drag.kind === 'scrub') S.scrub.active = false;
      if (drag.kind === 'handle' && drag.changed) hooks.saveTables();
      drag = null;
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
  }
  function startScrub(e) {
    hooks.stopDemo();
    S.scrub.active = true;
    S.speed = speedAt(e.clientX);
    drag.kind = 'scrub';
    hooks.gesture();
  }
  function dragHandle(e) {
    const { lane, i } = drag;
    const segs = S.tables[lane].segments;
    const lo = (i === 0 ? 0 : segs[i - 1].to) + T.MIN_GAP;
    const hi = segs[i + 1].to - T.MIN_GAP;
    const v = clamp(Math.round(speedAt(e.clientX) / SNAP) * SNAP, lo, hi);
    if (v === segs[i].to) return;
    const t = T.clone(S.tables[lane]);
    t.segments[i].to = v;
    if (T.validate(t).length) return;
    S.tables[lane] = t;
    drag.changed = true;
    render();
  }

  // ================================================================ Initialization
  function init(ctx) {
    S = ctx.S;
    hooks = ctx.hooks;
    wrap = $('plot');
    svg = $('rulerSvg');
    labels = $('laneLabels');
    insp = $('insp');
    menu = $('laneMenu');
    scalePop = $('scalePop');
    initPointer();
    initInspector();
    initMenu();
    initScale();
    // redraw when the width changes
    let raf = 0;
    const redraw = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(render);
    };
    if (window.ResizeObserver) new ResizeObserver(redraw).observe(wrap);
    else window.addEventListener('resize', redraw);
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        select(null);
        menu.hidden = true;
      }
    });
    render();
  }

  NS.Ruler = { init, render, update, select };
})((window.VVVF3D = window.VVVF3D || {}));
