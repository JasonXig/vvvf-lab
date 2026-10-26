// Cab-deck UI: master controller, speed and readouts, inverter and sound, keyboard, top buttons, side drawer, first-run tips.
// All state lives in S in app.js; this file only draws it and receives input. The mode ruler is in ruler.js, the scopes in scopes.js.
(function (NS) {
  'use strict';

  const Drive = NS.Drive;
  const $ = (id) => document.getElementById(id);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const NOTCHES = Drive.NOTCHES;
  const MODE_NAME = { power: 'Power', coast: 'Neutral', hold: 'Hold', brake: 'Brake' };
  const COACH_KEY = 'vvvf3d.coach.v2';

  let S = null;
  let hooks = null;

  // ================================================================ Master controller
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
      s.textContent = n.id === 'H' ? 'Hold' : n.id;
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
        /* ignore */
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

  // ================================================================ Inverter, sound
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
    if (!S.soundOn) text = 'Sound off';
    else if (S.audio.mode === 'worklet') text = 'Sound on';
    else if (S.audio.mode === 'script') text = 'Sound on (compatibility mode)';
    else if (S.audio.error) text = 'Cannot enable sound';
    else text = 'Click the page to enable sound';
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

  // ================================================================ Keyboard
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

  // ================================================================ Drawer and tips
  // Top buttons: if the same page is already open, collapse it; otherwise open and switch to that page
  function openDrawer(tab) {
    const d = $('drawer');
    if (!d.hidden && d.dataset.tab === tab) {
      closeDrawer();
      return;
    }
    d.hidden = false;
    openDrawerTab(tab);
    $('coach').hidden = true; // the drawer and the tip card are both on the left and would overlap; the tip can be brought back any time with the ? at the top
    $('btnHelp').classList.remove('on');
  }
  // Clicking a tab inside the drawer: only switch the content, do not close the drawer
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
        /* if it cannot be stored, never mind; the tip will show once more next time */
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
      /* if it cannot be read, assume it has not been seen */
    }
    if (!seen && new URLSearchParams(window.location.search).get('coach') !== '0') $('coach').hidden = false;
    $('btnHelp').classList.toggle('on', !$('coach').hidden);
  }
  // ================================================================ Readouts
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
      $('demo').textContent = S.demo ? 'Stop demo' : 'Demo';
    }
    const pct = clamp(f.nr / 6000, 0, 1) * 100;
    if (Math.abs(pct - last.rpm) > 0.3) {
      last.rpm = pct;
      $('rpmFill').style.clipPath = 'inset(0 ' + (100 - pct).toFixed(1) + '% 0 0)';
    }

    if (nowMs - last.stat < 80) return;
    last.stat = nowMs;
    // State: power / neutral coasting / hold / brake / stopped
    let state = f.mode === 'power' ? 'Power' : f.mode === 'brake' ? 'Brake' : f.mode === 'hold' ? 'Hold' : f.speed < 0.05 ? 'Stopped' : 'Neutral';
    const cls = f.mode === 'coast' && f.speed >= 0.05 ? 'coast' : f.mode;
    const chip = $('stState');
    if (state !== last.state) {
      last.state = state;
      chip.textContent = state;
      chip.className = 'chip st ' + cls;
    }
    // Modulation: the current modulation while the inverter is running, the reason when it is not
    let mode;
    let hue = 'var(--dim)';
    if (f.run) {
      hue = HUE[f.segKind] || hue;
      mode = f.segKind === 'async' ? 'Async · ' + Math.round(f.fc) + ' Hz' : f.segKind === 'sync' ? 'Sync · ' + f.n + ' pulses' : f.segKind === 'wide3' ? 'Wide 3-pulse · overmodulation' : 'Single pulse · square wave';
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
      setText('sSlipL', 'Slip');
      setText('sSlip', f.run ? '0' : '—');
    } else {
      setText('sSlipL', 'Slip ratio');
      setText('sSlip', f.run ? (f.slip * 100).toFixed(1) : '—');
    }
  }

  // ================================================================ Public interface
  function init(ctx) {
    S = ctx.S;
    hooks = ctx.hooks;
    NS.Scopes.init();
    initLever();
    initControls();
    initKeys();
    initChrome();
    NS.Ruler.init({ S, hooks });
    // Browsers only allow sound inside a "user action". For a mouse it counts on press, for touch only when the finger lifts, so listen to both
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
