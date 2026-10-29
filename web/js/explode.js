// Exploded view: the motor is taken apart and every piece slides out along its own path (see MotorKit helpers.piece).
// Drag a piece to slide it out or back along that path, drag the background to turn the view, click a piece or its label for its card.
// Meanwhile the simulation is frozen and muted; on leaving, the pieces go back together and everything carries on from the same state.
(function (NS) {
  'use strict';

  const T = THREE;
  const $ = (id) => document.getElementById(id);
  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const HOT = new T.Color(0x22d3ee);
  const EASE = 0.16; // time constant of the pieces' motion [s]
  const STEP_DELAY = 0.2; // pieces of a later step start this much later [s]
  const DETAIL_VIEW = { az: 1.02, pol: 1.2, dist: 6.4 }; // camera angle for the exploded view; it is fitted to the spread-out pieces

  let A = null; // the main program: { S, camera, orbit, canvas, resize(), buildExploded(), restore() }
  const X = { active: false, closing: false, pieces: [], meshes: [], hover: null, sel: null, press: null, saved: null, labelsOn: true };
  const ray = new T.Raycaster();
  const ndc = new T.Vector2();

  // ---------------------------------------------------------------- Entering and leaving
  function enter() {
    if (!A || X.active) return;
    const S = A.S;
    X.active = true;
    X.closing = false;
    S.explode = true;
    if (S.audio.mode !== 'off') S.audio.send({ gate: false }); // silence while frozen; the next frame after leaving sends the real state again
    X.saved = { view: A.orbit.view(), home: A.orbit.home };
    X.labelsOn = !window.matchMedia('(max-width: 760px)').matches; // on a phone the labels crowd together: tap a part instead
    $('xLabels').classList.toggle('on', X.labelsOn);
    $('xLabels').setAttribute('aria-pressed', String(X.labelsOn));
    document.body.classList.add('exploded');
    $('xName').textContent = NS.MotorKit.registry[S.spec.type].label;
    $('xFrozen').textContent = frozenText(S);
    setupPieces(A.buildExploded());
    buildLabels();
    frameCamera();
    A.resize();
  }

  // instant: skip the reassembly animation (when something else needs the normal motor right away)
  function exit(instant) {
    if (!X.active) return;
    closeCard();
    setHover(null);
    X.press = null;
    if (instant) return finish();
    if (X.closing) return;
    X.closing = true;
    const last = Math.max(0, ...X.pieces.map((p) => p.step));
    X.pieces.forEach((p) => {
      p.to = 0;
      p.delay = (last - p.step) * STEP_DELAY * 0.7; // reverse order: what came off last goes back first
    });
  }

  function finish() {
    const S = A.S;
    X.active = false;
    X.closing = false;
    X.pieces.forEach((p) => p.el && p.el.remove());
    X.pieces = [];
    X.meshes = [];
    document.body.classList.remove('exploded');
    S.explode = false;
    A.restore(); // the normal motor again, with the cut-away and labels as they were
    A.orbit.home = X.saved.home;
    A.orbit.animateTo(X.saved.view, 0.6);
  }

  function toggle() {
    if (X.active) exit();
    else enter();
  }

  function frozenText(S) {
    const notch = NS.Drive.NOTCHES[S.notch].id;
    if (S.speed < 0.05) return 'The train is standing still (' + notch + ').';
    return 'The train is frozen at ' + Math.round(S.speed) + ' km/h (' + notch + ') and carries on when you leave.';
  }

  // ---------------------------------------------------------------- Pieces
  function setupPieces(motor) {
    motor.root.updateMatrixWorld(true);
    X.meshes = [];
    X.pieces = motor.pieces.map((p, index) => {
      const piece = Object.assign({}, p, { index, off: 0, to: p.dist, delay: p.step * STEP_DELAY, max: p.dist * 1.5, mats: [], el: null });
      // the path in the frame of each object's parent (the rotor group is turned by the frozen rotor angle)
      piece.parts = p.objects.map((o) => {
        const q = new T.Quaternion();
        o.parent.getWorldQuaternion(q);
        return { o, base: o.position.clone(), dir: p.dir.clone().applyQuaternion(q.invert()) };
      });
      // own copies of the materials, so that highlighting one piece does not light up another that shared a material
      const copies = new Map();
      p.objects.forEach((o) =>
        o.traverse((c) => {
          if (!c.isMesh) return;
          if (!copies.has(c.material)) copies.set(c.material, c.material.clone());
          c.material = copies.get(c.material);
          c.userData.piece = index;
          X.meshes.push(c);
        })
      );
      piece.mats = [...copies.values()].filter((m) => m.emissive);
      piece.mats.forEach((m) => (m.userData.emissive = { color: m.emissive.clone(), intensity: m.emissiveIntensity }));
      // label anchor: the top of the piece, in motor coordinates
      const box = new T.Box3();
      p.objects.forEach((o) => box.expandByObject(o, true));
      const c = box.getCenter(new T.Vector3());
      piece.anchor = new T.Vector3(c.x, box.max.y, c.z);
      piece.pos = piece.anchor.clone();
      return piece;
    });
    X.root = motor.root;
  }

  function place(p) {
    p.parts.forEach((s) => s.o.position.copy(s.base).addScaledVector(s.dir, p.off));
    p.pos.copy(p.anchor).addScaledVector(p.dir, p.off);
  }

  // Aim the camera at the pieces as they will be when spread out; fitDistance() then says how far back it has to be
  function frameCamera() {
    X.pieces.forEach((p) => {
      p.off = p.dist;
      place(p);
    });
    X.root.updateMatrixWorld(true);
    const all = new T.Box3();
    const boxes = X.pieces.map((p) => {
      const b = new T.Box3();
      p.objects.forEach((o) => b.expandByObject(o, true));
      all.union(b);
      return b;
    });
    const center = all.getCenter(new T.Vector3());
    // the corners of every piece's box, relative to the centre: a tight enough outline of the spread-out motor
    X.corners = [];
    boxes.forEach((b) => {
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) X.corners.push(new T.Vector3(x, y, z).sub(center));
    });
    X.pieces.forEach((p) => {
      p.off = 0;
      place(p);
    });
    const home = Object.assign({}, DETAIL_VIEW, { target: center });
    A.orbit.home = home;
    A.orbit.animateTo(home, 0.7);
  }

  // Camera distance at which every corner fits in the view from the exploded view's angle, with room for the labels
  function fitDistance(camera) {
    const tanV = Math.tan((camera.fov * Math.PI) / 360) * 0.86;
    const tanH = tanV * camera.aspect;
    const { az, pol } = DETAIL_VIEW;
    const u = new T.Vector3(Math.sin(pol) * Math.sin(az), Math.cos(pol), Math.sin(pol) * Math.cos(az)); // from the target to the camera
    const right = new T.Vector3().crossVectors(u.clone().negate(), new T.Vector3(0, 1, 0)).normalize();
    const up = new T.Vector3().crossVectors(right, u.clone().negate());
    let d = 0;
    X.corners.forEach((c) => {
      const z = c.dot(u);
      d = Math.max(d, z + Math.abs(c.dot(right)) / tanH, z + Math.abs(c.dot(up)) / tanV);
    });
    return d;
  }

  function frame(dt) {
    if (!X.active) return;
    let moving = false;
    X.pieces.forEach((p) => {
      if (p.delay > 0) {
        p.delay -= dt;
        moving = true;
        return;
      }
      if (p.off !== p.to) {
        p.off += (p.to - p.off) * (1 - Math.exp(-dt / EASE));
        if (Math.abs(p.to - p.off) < 1e-3) p.off = p.to;
        moving = true;
      }
      place(p);
    });
    // labels: a piece still inside the others has no room for one, unless it is under the mouse or selected
    A.S.labelEls.forEach((l) => {
      const p = l.piece;
      l.show = X.labelsOn && (p.max === 0 || p.off > 0.35 * p.dist || p === X.hover || p === X.sel);
      l.el.classList.toggle('hot', p === X.hover || p === X.sel);
    });
    if (X.closing && !moving) finish();
  }

  function buildLabels() {
    const box = $('labels');
    box.innerHTML = '';
    A.S.labelEls = X.pieces.map((p) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'tag xtag';
      el.textContent = p.name;
      el.addEventListener('click', () => openCard(p));
      el.addEventListener('pointerenter', () => setHover(p));
      el.addEventListener('pointerleave', () => setHover(null));
      box.appendChild(el);
      p.el = el;
      return { el, pos: p.pos, piece: p, show: true };
    });
  }

  // ---------------------------------------------------------------- Highlight
  function light(p, on) {
    if (!p) return;
    p.mats.forEach((m) => {
      const o = m.userData.emissive;
      if (on) {
        // the glow it already had (colour × intensity), a little towards cyan
        m.emissive.copy(o.color).multiplyScalar(o.intensity).lerp(HOT, 0.16);
        m.emissiveIntensity = 1;
      } else {
        m.emissive.copy(o.color);
        m.emissiveIntensity = o.intensity;
      }
    });
  }
  function relight() {
    X.pieces.forEach((p) => light(p, p === X.hover || p === X.sel));
  }
  function setHover(p) {
    if (X.hover === p) return;
    X.hover = p;
    relight();
    A.canvas.style.cursor = p ? (p.max > 0 ? 'grab' : 'pointer') : '';
  }

  // ---------------------------------------------------------------- Picking and dragging
  function pick(e) {
    const r = A.canvas.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, A.camera);
    const hit = ray.intersectObjects(X.meshes, false)[0];
    return hit ? { piece: X.pieces[hit.object.userData.piece], point: hit.point } : null;
  }
  function toScreen(v) {
    const r = A.canvas.getBoundingClientRect();
    const p = v.clone().project(A.camera);
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }

  // Called by the camera on pointerdown: returns true when the pointer grabs a piece (then the view does not turn)
  function intercept(e) {
    if (!X.active || X.closing) return false;
    const hit = pick(e);
    X.press = { id: e.pointerId, x: e.clientX, y: e.clientY, piece: hit ? hit.piece : null, moved: false, drag: null };
    if (!hit || hit.piece.max <= 0) return false; // a piece that stays put: dragging it turns the view, a click still opens its card
    // The piece's path through the grabbed point, projected to the screen: its direction there and how many pixels one unit is
    const a = toScreen(hit.point);
    const b = toScreen(hit.point.clone().add(hit.piece.dir));
    let sx = b.x - a.x;
    let sy = b.y - a.y;
    let ppu = Math.hypot(sx, sy);
    if (ppu < 12) {
      // the path points almost straight at the camera: dragging upwards pulls the piece out
      sx = 0;
      sy = -1;
      ppu = 60;
    } else {
      sx /= ppu;
      sy /= ppu;
    }
    const p = hit.piece;
    p.delay = 0;
    p.to = p.off;
    X.press.drag = { off0: p.off, sx, sy, ppu };
    A.canvas.setPointerCapture(e.pointerId);
    A.canvas.style.cursor = 'grabbing';
    return true;
  }

  function onMove(e) {
    if (!X.active) return;
    const pr = X.press;
    if (pr && pr.id === e.pointerId) {
      const dx = e.clientX - pr.x;
      const dy = e.clientY - pr.y;
      if (Math.hypot(dx, dy) > 5) pr.moved = true;
      if (pr.drag) {
        const p = pr.piece;
        p.off = p.to = clamp(pr.drag.off0 + (dx * pr.drag.sx + dy * pr.drag.sy) / pr.drag.ppu, 0, p.max);
        place(p);
      }
      return;
    }
    if (e.pointerType === 'mouse' && !e.buttons && !X.closing) {
      const hit = pick(e);
      setHover(hit ? hit.piece : null);
    }
  }

  function onUp(e) {
    const pr = X.press;
    if (!X.active || !pr || pr.id !== e.pointerId) return;
    X.press = null;
    if (pr.drag) A.canvas.style.cursor = 'grab';
    if (!pr.moved && e.type === 'pointerup') {
      if (pr.piece) openCard(pr.piece);
      else closeCard();
    }
  }

  // ---------------------------------------------------------------- Info card
  function openCard(p) {
    if (!X.active || X.closing) return;
    X.sel = p;
    relight();
    $('xcTitle').textContent = p.name;
    $('xcRole').textContent = p.info.role;
    $('xcMat').textContent = p.info.material;
    const facts = $('xcFacts');
    facts.innerHTML = '';
    (p.info.facts || []).forEach((f) => {
      const li = document.createElement('li');
      li.textContent = f;
      facts.appendChild(li);
    });
    facts.hidden = !facts.children.length;
    $('xcNote').textContent = p.info.note || '';
    $('xcMove').hidden = p.max <= 0;
    $('xcStay').hidden = p.max > 0;
    $('xcard').hidden = false;
  }
  function closeCard() {
    $('xcard').hidden = true;
    if (X.sel) {
      X.sel = null;
      relight();
    }
  }
  function slideAll(toDist) {
    if (!X.active || X.closing) return;
    X.pieces.forEach((p) => {
      p.to = toDist ? p.dist : 0;
      p.delay = 0;
    });
  }

  // ---------------------------------------------------------------- Wiring
  function init(api) {
    A = api;
    A.orbit.intercept = intercept;
    A.canvas.addEventListener('pointermove', onMove);
    A.canvas.addEventListener('pointerup', onUp);
    A.canvas.addEventListener('pointercancel', onUp);
    A.canvas.addEventListener('pointerleave', () => setHover(null));
    $('btnExplode').addEventListener('click', enter);
    $('xDone').addEventListener('click', () => exit());
    $('xSpread').addEventListener('click', () => slideAll(true));
    $('xJoin').addEventListener('click', () => slideAll(false));
    $('xLabels').addEventListener('click', (e) => {
      X.labelsOn = !X.labelsOn;
      e.currentTarget.classList.toggle('on', X.labelsOn);
      e.currentTarget.setAttribute('aria-pressed', String(X.labelsOn));
    });
    $('xcClose').addEventListener('click', closeCard);
    $('xcOut').addEventListener('click', () => X.sel && Object.assign(X.sel, { to: X.sel.dist, delay: 0 }));
    $('xcBack').addEventListener('click', () => X.sel && Object.assign(X.sel, { to: 0, delay: 0 }));
    const typing = (e) => /^(TEXTAREA|SELECT)$/.test(e.target.tagName) || (e.target.tagName === 'INPUT' && !['range', 'checkbox', 'button'].includes(e.target.type));
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
      if (e.code === 'KeyE' && !e.repeat) {
        toggle();
        e.preventDefault();
      } else if (e.code === 'Escape' && X.active) {
        if (!$('xcard').hidden) closeCard();
        else exit();
        e.preventDefault();
      }
    });
  }

  NS.Explode = {
    init,
    enter,
    exit,
    toggle,
    frame,
    fitDistance,
    get active() {
      return X.active;
    },
    // for tests and the console: the pieces with their current and target offsets
    pieces: () => X.pieces.map((p) => ({ id: p.id, name: p.name, off: p.off, to: p.to, dist: p.dist, max: p.max, step: p.step })),
  };
})(window.VVVF3D);
