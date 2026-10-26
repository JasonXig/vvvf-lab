// 模式标尺：横轴是车速，既是速度表，也是拖动跳速的滑杆，还是模式表的编辑器。
//   两条泳道：力行（A 表）、制动（B 表），每一段按调制方式上色，里面的白线是载波频率随车速变化的“锯齿”；
//   竖线是当前车速：拖它（或者在标尺上任意位置按住拖动）就能直接跳到某个速度，声音和 3D 电机跟着变；
//   拖两段之间的分界线改速度范围；点一段打开编辑框，改调制方式、载波频率、脉冲数，可以马上“试听”。
(function (NS) {
  'use strict';

  const T = NS.Table;
  const Drive = NS.Drive;
  const $ = (id) => document.getElementById(id);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const SVGNS = 'http://www.w3.org/2000/svg';

  const LANES = [
    { id: 'A', name: '力行' },
    { id: 'B', name: '制动' },
  ];
  const LANE_NAME = { A: '力行', B: '制动' };
  const HUE = { async: 'var(--m-async)', sync: 'var(--m-sync)', wide3: 'var(--m-wide)', square: 'var(--m-square)' };
  const KIND_SHORT = { async: '异步', sync: '同步', wide3: '宽 3', square: '方波' };
  const SNAP = 0.5; // 拖动分界线时的取整 [km/h]

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
  // 载波 fc 在低速时听到的音高约为 2·fc：写成 “523 Hz（C5）”，音不准时带上音分偏差
  function heardText(fc) {
    const n = T.nearestNote(2 * fc);
    return Math.round(2 * fc) + ' Hz（' + n.name + (n.cents ? (n.cents > 0 ? '+' : '') + n.cents + '¢' : '') + '）';
  }

  // ================================================================ 几何
  function layout() {
    const W = Math.max(280, wrap.clientWidth);
    const narrow = W < 560;
    const padL = narrow ? 40 : 112;
    const padR = 14;
    const top = 24;
    const short = window.innerHeight < 800 && !window.matchMedia('(max-width: 760px)').matches; // 矮屏幕上把泳道压扁
    const LH = narrow ? 42 : short ? 38 : 44; // 上面一行写段名，下面画载波曲线
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

  // 载波频率随车速的曲线：每一段单独一条折线（段与段之间的跳变不连线）
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

  // ================================================================ 绘制
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
      // 纵轴刻度：这一条泳道里满格代表多少 Hz
      const tt = node('text', { class: 'ytop', x: geo.padL + geo.plotW - 4, y: y + 11, 'text-anchor': 'end' }, gLane);
      if (li === 0) tt.textContent = top >= 1000 ? top / 1000 + ' kHz' : top + ' Hz';

      // 电压曲线上的两个标记：满调制（参考波幅值 1）、满电压（方波等效）
      for (const [v, text] of [
        [t.vBase, '满调制 ' + fmt1(t.vBase) + ' km/h（参考波幅值 = 1）'],
        [t.vFull, '满电压 ' + fmt1(t.vFull) + ' km/h（输出等效方波）'],
      ]) {
        const g = node('g', { class: 'vmark' }, gLane);
        node('line', { x1: xOf(v), x2: xOf(v), y1: y + 2, y2: y + LH - 2 }, g);
        node('title', null, g).textContent = text;
      }

      // 各段
      t.segments.forEach((s, i) => {
        const from = T.segmentFrom(t, i);
        const x0 = xOf(from);
        const x1 = xOf(s.to);
        const w = x1 - x0;
        const g = node('g', { class: 'seg', 'data-hit': 'seg', 'data-lane': lane.id, 'data-i': i, style: '--h:' + HUE[s.kind] }, gLane);
        node('rect', { x: x0 + 0.75, y, width: Math.max(1, w - 1.5), height: LH, rx: 6 }, g);
        // 段名和参数写在同一行（放得下才写参数），下面留给载波曲线
        if (w >= 38) {
          const kindText = KIND_SHORT[s.kind];
          const param = s.kind === 'async' ? (s.fc0 === s.fc1 ? hz(s.fc0) : hz(s.fc0) + '→' + hz(s.fc1)) + ' Hz' : s.kind === 'sync' ? s.n + ' 脉冲' : s.kind === 'wide3' ? '过调制' : '单脉冲';
          const textW = (str) => [...str].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 11 : 6.2), 0);
          const lab = node('text', { class: 'lab', x: x0 + 8, y: y + 14 }, g);
          node('tspan', { class: 't1' }, lab).textContent = kindText;
          if (8 + textW(kindText) * 1.1 + 8 + textW(param) + 6 <= w) node('tspan', { class: 't2', dx: 7 }, lab).textContent = param;
        }
        node('title', null, g).textContent = LANE_NAME[lane.id] + ' · ' + fmt1(from) + ' – ' + fmt1(s.to) + ' km/h · ' + T.describe(s) + '（点击编辑）';
        segEls[lane.id][i] = g;
      });

      // 载波曲线
      for (const pts of traces[lane.id]) {
        const d = pts.map((p, k) => (k ? 'L' : 'M') + xOf(p[0]).toFixed(1) + ' ' + (y + LH - 4 - (clamp(p[1], 0, top) / top) * (LH - 24)).toFixed(1)).join('');
        node('path', { class: 'glow', d }, gTrace);
        node('path', { class: 'line', d }, gTrace);
      }

      // 分界线的把手（最后一段延伸到最高速度，没有）
      t.segments.forEach((s, i) => {
        if (i === t.segments.length - 1) return;
        const hx = xOf(s.to);
        // 抓取区的半宽：段很窄（比如一串音阶台阶）时要缩小，否则两边的把手会把整段盖住，点不到这一段
        const wLeft = xOf(s.to) - xOf(T.segmentFrom(t, i));
        const wRight = xOf(t.segments[i + 1].to) - hx;
        const half = clamp(Math.min(wLeft, wRight) / 4, 2.5, 7);
        const h = node('g', { class: 'handle', 'data-hit': 'handle', 'data-lane': lane.id, 'data-i': i }, gHandle);
        node('rect', { class: 'hit', x: hx - half, y: y - 2, width: half * 2, height: LH + 4 }, h);
        node('rect', { class: 'grip', x: hx - 2, y: y + LH / 2 - 8, width: 4, height: 16, rx: 2 }, h);
        node('title', null, h).textContent = '拖动：改 ' + fmt1(s.to) + ' km/h 这条分界线';
      });

      // 泳道名称和表选项按钮（HTML，叠在标尺左侧的空白处）
      const lab = document.createElement('div');
      lab.className = 'lane-lab' + (geo.narrow ? ' narrow' : '');
      lab.style.top = y + 'px';
      lab.style.height = LH + 'px';
      lab.style.width = geo.padL - 6 + 'px'; // 不能比标尺左边的空白更宽，否则会盖住第一段
      lab.innerHTML =
        '<b>' + (geo.narrow ? lane.id : lane.name) + '</b>' + (geo.narrow ? '' : '<small>' + lane.id + '</small>') +
        (geo.narrow ? '' : '<button class="mini" data-scale="' + lane.id + '" aria-label="' + lane.name + '表的音阶台阶" title="音阶台阶：在一段速度范围里铺一串从低到高的异步调制（哆来咪）">♪</button>') +
        '<button class="mini" data-menu="' + lane.id + '" aria-label="' + lane.name + '表的选项" title="' + lane.name + '表的选项：预设、电压曲线、导入导出">⋯</button>';
      labels.appendChild(lab);
    });

    // 横轴
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

    // 载波曲线上跟着车速走的亮点：它的高度就是此刻的音高（载波频率）
    geo.fcTop = top;
    dot = node('circle', { class: 'cdot', r: 4.5, cx: -20, cy: -20 }, svg);

    // 播放头：当前车速
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

  // ================================================================ 每帧：播放头和“正在工作的那一段”
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

  // ================================================================ 编辑框
  function showErr(msg) {
    $('segErr').textContent = msg || '';
  }
  function positionPop(el, cx) {
    if (window.matchMedia('(max-width: 760px)').matches) {
      // 手机上编辑框排在标尺上方，不是浮在上面
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
    $('inspTitle').textContent = LANE_NAME[lane] + ' · 第 ' + (i + 1) + ' 段';
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
    if (s.kind === 'wide3') hint.textContent = '3 个脉冲的同步调制，随电压曲线一路进入过调制，直到输出等效方波。';
    else if (s.kind === 'square') hint.textContent = '每个基波周期只有一个脉冲，电压最大，也就是方波。';
    else if (s.kind === 'async') hint.textContent = '低速（调制比小）时，听到的主要是载波的 2 倍频：约 ' + heardText(s.fc0) + (s.fc1 === s.fc0 ? '' : ' → ' + heardText(s.fc1)) + '。';
    else {
      hint.hidden = true;
      hint.textContent = '';
    }
    $('segDel').disabled = t.segments.length <= 1;
    $('inspPrev').disabled = i === 0;
    $('inspNext').disabled = last;
    positionPop(insp, (xOf(from) + xOf(s.to)) / 2);
  }

  // 先改一份副本，检查通过才生效；不通过就提示并还原编辑框
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
        showErr('这一段太短，没法再拆');
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
          if (i === t.segments.length - 1) t.segments[i - 1].to = t.segments[i].to; // 最后一段删掉：前一段延伸到最高速度
          t.segments.splice(i, 1);
        })
      ) {
        select(lane, clamp(i, 0, S.tables[lane].segments.length - 1));
      }
    });

    // 试听：牵引表里跳到这一段中间并定速；制动表里跳到这一段的高速端，用最轻的制动缓缓滑过
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

  // ================================================================ 泳道菜单（预设、电压曲线、导入导出）
  let menuLane = 'A';
  // 菜单底部的一行提示；ok = true 时是成功的颜色，否则是错误的红色
  function menuNote(text, ok) {
    const el = $('menuMsg');
    el.textContent = text || '';
    el.classList.toggle('ok', !!ok);
  }
  function refreshMenu() {
    const t = S.tables[menuLane];
    $('menuTitle').textContent = LANE_NAME[menuLane] + '表（' + menuLane + '）的选项';
    $('vBase').value = t.vBase;
    $('vFull').value = t.vFull;
    $('tblCopy').textContent = '复制到' + (menuLane === 'A' ? '制动表' : '力行表');
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
      msg('已复制到' + LANE_NAME[other] + '表', true);
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
        const incoming = obj.tables ? obj.tables : { [menuLane]: obj }; // 完整导出（A 和 B）或者单张表
        const next = {};
        Object.keys(incoming).forEach((k) => {
          if (k !== 'A' && k !== 'B') return;
          const t = T.normalize(incoming[k]);
          const problems = T.validate(t);
          if (problems.length) throw new Error(LANE_NAME[k] + '表：' + problems[0]);
          next[k] = t;
        });
        if (!Object.keys(next).length) throw new Error('文件里没有找到 A 或 B 表');
        Object.assign(S.tables, next);
        render();
        refreshMenu();
        hooks.saveTables();
        msg('已导入：' + Object.keys(next).map((k) => LANE_NAME[k]).join('、') + '表', true);
      } catch (err) {
        msg('导入失败：' + err.message);
      }
    });
  }

  // ================================================================ 音阶台阶（哆来咪）
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
    // 弹窗底部的一行提示；ok = true 时是成功的颜色，否则是错误的红色
    const note = (text, ok) => {
      const el = $('scMsg');
      el.textContent = text || '';
      el.classList.toggle('ok', !!ok);
    };

    function openScale(lane, btn) {
      scaleLane = lane;
      select(null); // 收起编辑框和菜单
      $('scTitle').textContent = '音阶台阶 · ' + LANE_NAME[lane] + '表';
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
    // 窄屏上泳道名旁边没有 ♪ 按钮，从“⋯”菜单里进
    $('tblScale').addEventListener('click', () => openScale(menuLane, labels.querySelector('button[data-menu="' + menuLane + '"]') || $('tblScale')));
    $('scClose').addEventListener('click', () => (scalePop.hidden = true));

    // 把输入框里的音符读成载波频率；返回 { carriers, names, error }
    function parse() {
      const tokens = $('scNotes').value.split(/[\s,，、;；]+/).filter(Boolean);
      const freqs = tokens.map(T.noteFrequency);
      const bad = tokens.filter((_, i) => isNaN(freqs[i]));
      if (!tokens.length) return { error: '还没有音符' };
      if (bad.length) return { error: '认不出这些音符：' + bad.join('、') + '（写法如 C4、F#3、Bb4，或者直接写频率 523）' };
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
      el.textContent = n + ' 级，每级约 ' + (isFinite(w) ? Math.round(w * 100) / 100 : '?') + ' km/h；载波 ' + c[0] + (n > 1 ? ' → ' + c[n - 1] : '') + ' Hz' + (p.heard ? '，听到的音高 ' + p.tokens[0] + (n > 1 ? ' → ' + p.tokens[n - 1] : '') : '，听到的音高约为载波的 2 倍');
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
      S.sel = null; // 旧的段没了，选中状态作废（不能用 select(null)，它会把弹窗一起关掉）
      render();
      hooks.saveTables();
      note('已生成 ' + p.carriers.length + ' 级台阶（' + LANE_NAME[scaleLane] + '表 ' + round1(from) + ' – ' + round1(to) + ' km/h）', true);
      if (play) {
        // 从起点开始用满档加速（制动表：从终点开始用 B2 减速），台阶会依次响一遍
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

  // ================================================================ 鼠标 / 触摸
  function initPointer() {
    svg.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const hit = e.target.closest('[data-hit]');
      const kind = hit ? hit.dataset.hit : 'bg';
      try {
        svg.setPointerCapture(e.pointerId);
      } catch (err) {
        /* 某些情况下不支持，忽略 */
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

  // ================================================================ 初始化
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
    // 宽度变了就重画
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
