// 运转台界面：主手柄、车速与读数、逆变器与声音、键盘、顶部按钮、侧边抽屉、新手提示。
// 状态都放在 app.js 的 S 里，这里只负责画出来、接收操作；模式标尺在 ruler.js，示波器在 scopes.js。
(function (NS) {
  'use strict';

  const Drive = NS.Drive;
  const $ = (id) => document.getElementById(id);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const NOTCHES = Drive.NOTCHES;
  const MODE_NAME = { power: '牵引', coast: '空档', hold: '定速', brake: '制动' };
  const COACH_KEY = 'vvvf3d.coach.v2';

  let S = null;
  let hooks = null;

  // ================================================================ 主手柄
  function setNotch(i) {
    hooks.stopDemo();
    S.notch = clamp(i, 0, NOTCHES.length - 1);
  }

  function initLever() {
    const track = $('lvTrack');
    const labels = $('lvLabels');
    labels.textContent = '';
    NOTCHES.forEach((n, i) => {
      const s = document.createElement('span');
      s.textContent = n.id === 'H' ? '定速' : n.id;
      s.dataset.i = i;
      s.className = n.mode + (n.id === 'N' ? ' n' : '');
      s.title = n.id + ' · ' + MODE_NAME[n.mode];
      labels.appendChild(s);
    });
    $('lever').style.setProperty('--n', NOTCHES.length);

    const idxAt = (e) => {
      const r = track.getBoundingClientRect();
      return clamp(Math.floor(((e.clientX - r.left) / r.width) * NOTCHES.length), 0, NOTCHES.length - 1);
    };
    let down = false;
    track.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      down = true;
      try {
        track.setPointerCapture(e.pointerId);
      } catch (err) {
        /* 忽略 */
      }
      $('lever').classList.add('drag');
      setNotch(idxAt(e));
    });
    track.addEventListener('pointermove', (e) => {
      if (down) setNotch(idxAt(e));
    });
    const up = () => {
      down = false;
      $('lever').classList.remove('drag');
    };
    track.addEventListener('pointerup', up);
    track.addEventListener('pointercancel', up);
    labels.addEventListener('click', (e) => {
      const s = e.target.closest('span');
      if (s) setNotch(Number(s.dataset.i));
    });
    $('lvBrake').addEventListener('click', () => setNotch(S.notch - 1));
    $('lvPower').addEventListener('click', () => setNotch(S.notch + 1));
  }

  let shownNotch = -1;
  function syncLever() {
    if (S.notch === shownNotch) return;
    shownNotch = S.notch;
    const n = NOTCHES[S.notch];
    const lv = $('lever');
    lv.style.setProperty('--i', S.notch);
    lv.dataset.mode = n.mode;
    $('lvThumbText').textContent = n.id;
    $('lvName').textContent = n.id + ' · ' + MODE_NAME[n.mode];
    $('lvTrack').setAttribute('aria-valuenow', S.notch);
    $('lvTrack').setAttribute('aria-valuetext', n.id + ' ' + MODE_NAME[n.mode]);
    $('lvLabels')
      .querySelectorAll('span')
      .forEach((s, i) => s.classList.toggle('on', i === S.notch));
  }

  // ================================================================ 逆变器、声音
  const ICON_ON =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11"/></svg>';
  const ICON_OFF =
    '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9v6h4l5 4V5L8 9H4z" fill="currentColor"/><path d="M17 9l5 6M22 9l-5 6"/></svg>';

  let lastSound = null;
  function refreshSound() {
    const btn = $('btnSound');
    const sig = [S.soundOn, S.audio.mode, S.audio.error].join('|');
    if (sig === lastSound) return;
    lastSound = sig;
    btn.innerHTML = S.soundOn ? ICON_ON : ICON_OFF;
    btn.classList.toggle('off', !S.soundOn);
    btn.setAttribute('aria-pressed', String(S.soundOn));
    let text;
    if (!S.soundOn) text = '声音已关闭';
    else if (S.audio.mode === 'worklet') text = '声音已启用';
    else if (S.audio.mode === 'script') text = '声音已启用（兼容模式）';
    else if (S.audio.error) text = '无法启用声音';
    else text = '点一下页面启用声音';
    $('soundNote').textContent = text;
    $('soundNote').title = S.audio.error || '';
  }

  function initControls() {
    $('btnInv').addEventListener('click', () => {
      S.inverterOn = !S.inverterOn;
    });
    $('btnSound').addEventListener('click', () => {
      S.soundOn = !S.soundOn;
      refreshSound();
    });
    $('vol').addEventListener('input', (e) => {
      S.volume = Number(e.target.value) / 100;
      if (!S.soundOn && S.volume > 0) S.soundOn = true;
    });
  }

  // ================================================================ 键盘
  function initKeys() {
    const typing = (e) => /^(TEXTAREA|SELECT)$/.test(e.target.tagName) || (e.target.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(e.target.type));
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
      let handled = true;
      switch (e.code) {
        case 'ArrowUp':
        case 'KeyW':
          if (!e.repeat) setNotch(S.notch + 1);
          break;
        case 'ArrowDown':
        case 'KeyS':
          if (!e.repeat) setNotch(S.notch - 1);
          break;
        case 'Space':
          setNotch(Drive.NOTCH_N);
          break;
        case 'KeyH':
          setNotch(Drive.notchIndex('H'));
          break;
        case 'KeyM':
          if (!e.repeat) {
            S.soundOn = !S.soundOn;
            refreshSound();
          }
          break;
        case 'KeyP':
          if (!e.repeat) hooks.togglePause();
          break;
        default:
          handled = false;
      }
      if (handled) e.preventDefault();
    });
  }

  // ================================================================ 抽屉与提示
  // 顶部按钮：已经开着同一页就收起，否则打开并切到这一页
  function openDrawer(tab) {
    const d = $('drawer');
    if (!d.hidden && d.dataset.tab === tab) {
      closeDrawer();
      return;
    }
    d.hidden = false;
    openDrawerTab(tab);
    $('coach').hidden = true; // 抽屉和提示卡片都在左边，同时开会叠在一起；提示可以随时用右上角的 ? 再叫出来
    $('btnHelp').classList.remove('on');
  }
  // 抽屉里点标签页：只切换内容，不关抽屉
  function openDrawerTab(tab) {
    $('drawer').dataset.tab = tab;
    document.querySelectorAll('#drawerTabs button').forEach((b) => b.classList.toggle('on', b.dataset.pane === tab));
    ['motor', 'view'].forEach((p) => ($('pane-' + p).hidden = p !== tab));
    $('btnMotor').classList.toggle('on', tab === 'motor');
    $('btnView').classList.toggle('on', tab === 'view');
  }
  function closeDrawer() {
    $('drawer').hidden = true;
    $('btnMotor').classList.remove('on');
    $('btnView').classList.remove('on');
  }
  function showCoach(on) {
    $('coach').hidden = !on;
    $('btnHelp').classList.toggle('on', on);
    if (!on) {
      try {
        window.localStorage.setItem(COACH_KEY, '1');
      } catch (err) {
        /* 存不了就算了，下次再提示一次 */
      }
    }
  }

  function initChrome() {
    $('btnMotor').addEventListener('click', () => openDrawer('motor'));
    $('btnView').addEventListener('click', () => openDrawer('view'));
    $('drawerClose').addEventListener('click', closeDrawer);
    $('drawerTabs').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (b) openDrawerTab(b.dataset.pane);
    });
    $('demo').addEventListener('click', () => hooks.toggleDemo());
    $('btnHelp').addEventListener('click', () => showCoach($('coach').hidden));
    $('coachOk').addEventListener('click', () => showCoach(false));
    $('coachGo').addEventListener('click', () => {
      showCoach(false);
      setNotch(Drive.notchIndex('P4'));
      hooks.gesture();
    });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Escape') {
        closeDrawer();
        if (!$('coach').hidden) showCoach(false);
      }
    });
    let seen = false;
    try {
      seen = !!window.localStorage.getItem(COACH_KEY);
    } catch (err) {
      /* 读不到就当没看过 */
    }
    if (!seen && new URLSearchParams(window.location.search).get('coach') !== '0') $('coach').hidden = false;
    $('btnHelp').classList.toggle('on', !$('coach').hidden);
  }
  // ================================================================ 读数
  let last = { spd: '', rpm: -1, inv: null, demo: null, stat: 0, state: '', mode: '', hue: '' };
  const HUE = { async: 'var(--m-async)', sync: 'var(--m-sync)', wide3: 'var(--m-wide)', square: 'var(--m-square)' };

  function setText(id, v) {
    const el = $(id);
    if (el.textContent !== v) el.textContent = v;
  }

  // f = { speed, mode, run, lane, seg, segKind, kind, n, fc, f1, ns, nr, slip, v1, why }
  function update(f, nowMs) {
    syncLever();
    refreshSound();
    NS.Ruler.update(f);

    const spd = String(Math.round(f.speed));
    if (spd !== last.spd) {
      last.spd = spd;
      $('spdNum').textContent = spd;
    }
    if (S.inverterOn !== last.inv) {
      last.inv = S.inverterOn;
      $('btnInv').classList.toggle('on', S.inverterOn);
      $('btnInv').setAttribute('aria-pressed', String(S.inverterOn));
    }
    if (S.demo !== last.demo) {
      last.demo = S.demo;
      $('demo').classList.toggle('on', S.demo);
      $('demo').textContent = S.demo ? '停止演示' : '演示';
    }
    const pct = clamp(f.nr / 6000, 0, 1) * 100;
    if (Math.abs(pct - last.rpm) > 0.3) {
      last.rpm = pct;
      $('rpmFill').style.clipPath = 'inset(0 ' + (100 - pct).toFixed(1) + '% 0 0)';
    }

    if (nowMs - last.stat < 80) return;
    last.stat = nowMs;
    // 状态：力行 / 空档惰行 / 定速 / 制动 / 停车
    let state = f.mode === 'power' ? '力行' : f.mode === 'brake' ? '制动' : f.mode === 'hold' ? '定速' : f.speed < 0.05 ? '停车' : '空档惰行';
    const cls = f.mode === 'coast' && f.speed >= 0.05 ? 'coast' : f.mode;
    const chip = $('stState');
    if (state !== last.state) {
      last.state = state;
      chip.textContent = state;
      chip.className = 'chip st ' + cls;
    }
    // 调制方式：逆变器工作时是当前调制，不工作时说明原因
    let mode;
    let hue = 'var(--dim)';
    if (f.run) {
      hue = HUE[f.segKind] || hue;
      mode = f.segKind === 'async' ? '异步 · ' + Math.round(f.fc) + ' Hz' : f.segKind === 'sync' ? '同步 · ' + f.n + ' 脉冲' : f.segKind === 'wide3' ? '宽 3 脉冲 · 过调制' : '单脉冲 · 方波';
    } else {
      mode = f.why;
    }
    if (mode !== last.mode || hue !== last.hue) {
      last.mode = mode;
      last.hue = hue;
      $('stMode').style.setProperty('--h', hue);
      $('stModeText').textContent = mode;
    }
    setText('sF1', f.run ? f.f1.toFixed(1) : '—');
    setText('sFc', f.run ? String(Math.round(f.fc)) : '—');
    setText('sV1', f.run ? String(Math.round((f.v1 / (4 / Math.PI)) * 100)) : '—');
    setText('sNs', f.run ? String(Math.round(f.ns)) : '—');
    setText('sNr', String(Math.round(f.nr)));
    if (S.motor.synchronous) {
      setText('sSlipL', '转差');
      setText('sSlip', f.run ? '0' : '—');
    } else {
      setText('sSlipL', '转差率');
      setText('sSlip', f.run ? (f.slip * 100).toFixed(1) : '—');
    }
  }

  // ================================================================ 对外接口
  function init(ctx) {
    S = ctx.S;
    hooks = ctx.hooks;
    NS.Scopes.init();
    initLever();
    initControls();
    initKeys();
    initChrome();
    NS.Ruler.init({ S, hooks });
    // 浏览器只在“用户操作”里才允许发声。鼠标是按下时算，触屏是手指抬起时才算，所以两个都接
    ['pointerdown', 'pointerup', 'keydown'].forEach((ev) => document.addEventListener(ev, () => hooks.gesture(), true));
    refreshSound();
    syncLever();
    NS.UI.ready = true;
  }

  NS.UI = {
    ready: false,
    init,
    update,
    refreshTables: () => NS.Ruler.render(),
    drawScopes(analyser, nowMs, waveFrame) {
      NS.Scopes.drawSpectro(analyser, nowMs);
      NS.Scopes.drawLevel(analyser, nowMs);
      NS.Scopes.drawWave(waveFrame, nowMs);
    },
    openDrawer,
  };
})((window.VVVF3D = window.VVVF3D || {}));
