// Receiver: shows a friend's avatar as a floating widget, in a window, or over a whole monitor.
// How the avatar is framed (bust/full, zoom, position, rotation) is controlled by the broadcaster.
import { AvatarStage } from './shared/avatar.js';
import { SpringGrabber } from './shared/grab.js';
import { FxInput } from './shared/fx.js';
import { normalizeProp } from './shared/props.js';
import { Room, rowLayout, rowPos, SLOT_STEP } from './shared/room.js';
import { PEER_PREFIX, DEFAULT_POS, AVATAR_ASPECT, HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, IDLE_HIDE_MS, peerOptions, effectiveZone } from './shared/protocol.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const code = params.get('code');
const MODE = params.get('mode') || 'floating';
const viewerName = params.get('name') || '';
// mirror: the broadcaster's own avatar on their own screen, fed by their broadcaster window
const MIRROR = params.get('mirror') === '1';
if (MIRROR) document.body.classList.add('mirror');
document.body.classList.add(MODE);

let room = null; // co-hosts' avatars (multi-model rooms), set up further down
const store = { // the mirror keeps its own copies, so it never changes what a real viewer remembers
  get(k, d) { try { const v = localStorage.getItem((MIRROR ? 'mirror:' : '') + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem((MIRROR ? 'mirror:' : '') + k, JSON.stringify(v)); } catch {} },
};

// See-through windows (floating / full screen) are composited by the CPU on Windows, so keep their
// pixel count modest; the normal window can afford more. Frame rate picked in the control window (30 / 45 / 60, default 45). Low resource mode overrides it:
// 20 fps, lower resolution and smaller textures (graphics memory).
let fps = [30, 45, 60].includes(Number(params.get('fps'))) ? Number(params.get('fps')) : 45;
const quality = () => ({ maxPixelRatio: MODE === 'window' ? 2 : MODE === 'screen' ? 1 : 1.5, maxFps: fps, maxTexture: 0 });
const LOW_QUALITY = { maxPixelRatio: 1, maxFps: 20, maxTexture: 1024 };
let lowPower = params.get('low') === '1';
const stage = new AvatarStage($('stage'), lowPower ? LOW_QUALITY : quality());
window.vt.onFps?.((f) => { fps = f; if (!lowPower) { stage.setQuality(quality()); room?.setQuality(quality()); } });
window.vt.onLowPower?.(async (on) => {
  lowPower = on;
  stage.setQuality(on ? LOW_QUALITY : quality());
  room?.setQuality(on ? LOW_QUALITY : quality());
  // texture size only applies when the avatar loads: reload it from the local copy
  const rec = hasModel ? await cacheGet() : null;
  if (rec?.id && rec.id === stage.modelId && rec.buf) await showModel(rec.buf, rec.id);
});
if (MODE === 'screen') $('anchor').appendChild($('status'));
stage.setView(store.get('vt-view', {})); // last view from the broadcaster until a fresh one arrives
stage.setStyle(store.get('vt-style', {})); // same for lighting / mouth shapes
window.vtStage = stage; // handy from the dev tools (and for tests)

// ---------------- status pill ----------------
let hasModel = false, statusTimer = null;
function status(state, text, { autoHide = false, retry = false } = {}) {
  if (MIRROR) { $('status').hidden = true; return; } // nothing to report on your own screen
  $('status').hidden = false;
  $('dot').className = 'dot ' + state;
  $('statusText').textContent = text;
  $('retryBtn').hidden = !retry;
  window.vt.reportStatus(state, text);
  clearTimeout(statusTimer);
  if (autoHide) statusTimer = setTimeout(() => { if (!document.body.classList.contains('edit')) $('status').hidden = true; }, 2500);
}
$('retryBtn').onclick = () => reconnectNow();

// ---------------- props placed on the viewer's screen (full screen mode only) ----------------
// (they stay visible when the avatar is hidden for being away)
// Plain images over the whole monitor (not part of the 3D picture, so they can be anywhere and cost
// nothing to draw). Draw 'back' = behind the avatar.
const screenPropEls = new Map(); // id → <img>
const propUrls = new Map(); // image hash → object URL
function renderScreenProps(list) {
  const want = MODE === 'screen' ? list.map(normalizeProp).filter((d) => d.attach === 'screen') : [];
  for (const [id, el] of screenPropEls) if (!want.some((d) => d.id === id)) { el.remove(); screenPropEls.delete(id); }
  for (const d of want) {
    let el = screenPropEls.get(d.id);
    if (!el || el.dataset.img !== d.img) {
      el?.remove();
      el = document.createElement('img');
      el.className = 'sprop'; el.dataset.img = d.img; el.alt = '';
      const url = propUrls.get(d.img);
      if (url) el.src = url;
      else stage.props.loader?.(d.img).then((b) => { if (!b) return; if (!propUrls.has(d.img)) propUrls.set(d.img, URL.createObjectURL(b)); el.src = propUrls.get(d.img); });
      screenPropEls.set(d.id, el);
    }
    const layerEl = $(d.draw === 'back' ? 'spBack' : 'spFront');
    if (el.parentNode !== layerEl) layerEl.appendChild(el);
    const h = d.size * innerHeight;
    Object.assign(el.style, {
      left: d.pos[0] * innerWidth + 'px', top: d.pos[1] * innerHeight + 'px', height: h + 'px',
      transform: `translate(-50%, -50%) scaleX(${d.flip ? -1 : 1})`, // always facing you
      zIndex: want.length - want.indexOf(d), // higher in the broadcaster's list = in front
    });
    el.hidden = !d.visible;
  }
}
let lastPropList = [];
// the host's screen images plus every co-host's (their ids prefixed, so they never clash)
const allScreenProps = () => [...lastPropList, ...(room ? [...room.slots.values()].flatMap((s) => s.props.map((d) => ({ ...d, id: s.id + ':' + d.id }))) : [])];
addEventListener('resize', () => renderScreenProps(allScreenProps()));

// ---------------- tell the broadcaster what we see ----------------
let rxState = { s: 'waiting', p: 0 }, rxSentAt = 0;
function reportRx(s, p = 0) {
  if (MIRROR) return;
  const changed = s !== rxState.s;
  rxState = { s, p };
  // progress updates at most ~4 times a second; state changes right away
  if (!changed && performance.now() - rxSentAt < 250) return;
  sendRx();
}
function sendRx() { rxSentAt = performance.now(); try { if (model?.open) model.send({ t: 'rx', ...rxState }); } catch {} }

// ---------------- full screen: hide the avatar while the broadcaster isn't tracking ----------------
// Paused, face out of view or connection lost for IDLE_HIDE_MS → fade the avatar (and its status
// pill) out and stop rendering; it fades back in on the first live tracking frame.
let lastLiveAt = performance.now(), idleHidden = false;
function setIdleHidden(on) {
  if (on === idleHidden) return;
  idleHidden = on;
  document.body.classList.toggle('idle', on);
  if (hasModel) reportRx(on ? 'hidden' : 'ready');
  if (on) setTimeout(() => { if (idleHidden) stage.suspended = true; }, 900); // after the fade
  else stage.suspended = false;
  if (on) window.vt.reportStatus('warn', 'Avatar hidden, the broadcaster isn\'t tracking');
  else window.vt.reportStatus($('dot').className.replace('dot', '').trim() || 'ok', $('statusText').textContent || 'Connected');
}
if (MODE === 'screen' && !MIRROR) { // the mirror hides exactly when the viewer it copies does (see 'idle')
  setInterval(() => {
    if (!hasModel) { setIdleHidden(false); return; }
    if (performance.now() - lastLiveAt > IDLE_HIDE_MS) setIdleHidden(true);
  }, 1000);
}
const markLive = () => { lastLiveAt = performance.now(); if (idleHidden && !MIRROR) setIdleHidden(false); };

// ---------------- controls: mode switch + disconnect ----------------
const MODE_LABELS = { floating: 'Floating', window: 'Window', screen: 'Full screen' };
function modeButtons() {
  return Object.entries(MODE_LABELS).map(([m, l]) => `<button data-mode="${m}" class="${m === MODE ? 'cur' : ''}">${l}</button>`).join('')
    + '<button data-act="disconnect">Disconnect</button>' + (MODE === 'window' ? '<button data-act="quit">Quit</button>' : '');
}
$('help').innerHTML = (MODE === 'floating'
  ? `<div><b>Drag</b> to move · <b>Scroll</b> to resize · <b>Ctrl+Alt+V</b> lock &amp; click-through</div>
     <div class="btns"><button data-act="lock" class="primary">Lock in place</button><button data-act="quit">Quit</button></div>`
  : '') + `<div class="btns modeBtns">${modeButtons()}</div>`;
document.querySelector('#zoneHelp .modeBtns').innerHTML = modeButtons();
document.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.mode && b.dataset.mode !== MODE) window.vt.switchMode(b.dataset.mode);
  if (b.dataset.act === 'disconnect') leave('left').then(() => window.vt.disconnect());
  if (b.dataset.act === 'lock') window.vt.setLocked(true);
  if (b.dataset.act === 'quit') leave('left').then(() => window.vt.quit());
});

// ---------------- floating: drag to move, scroll to resize the widget ----------------
let locked = false;
if (MODE === 'floating') {
  document.body.classList.add('edit');
  window.vt.onLockChanged((l) => {
    locked = l;
    document.body.classList.toggle('edit', !l);
    $('status').hidden = l && hasModel;
  });
  let drag = null;
  window.addEventListener('mousedown', (e) => {
    if (locked || e.button !== 0 || e.target.closest('button')) return;
    if (grabbing() || overAny(e)) return; // pulling hair / booping, not moving the widget
    drag = { x: e.screenX, y: e.screenY };
    document.body.classList.add('dragging');
  });
  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const dx = e.screenX - drag.x, dy = e.screenY - drag.y;
    if (dx || dy) { window.vt.moveBy(dx, dy); drag = { x: e.screenX, y: e.screenY }; }
  });
  window.addEventListener('mouseup', () => { drag = null; document.body.classList.remove('dragging'); });
  window.addEventListener('wheel', (e) => {
    if (locked) return;
    window.vt.resizeBy(e.deltaY < 0 ? 1.08 : 1 / 1.08);
  }, { passive: true });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !locked) window.vt.setLocked(true); });
}

// ---------------- interacting: pull hair / clothes, headpat, boop ----------------
// Each needs the broadcaster's permission; the viewer can also switch all of it off on their side
// (tray / control window), so clicks always go through to what's behind the avatar.
let grabAllowed = false, patAllowed = false, slapAllowed = false;
let localInteract = params.get('interact') !== '0';
const canInteract = () => localInteract && hasModel && !idleHidden && !document.body.classList.contains('zoning');
const grabber = new SpringGrabber(stage, $('stage'), {
  send: (j, p) => { if (mirrorCh) { mirrorCh.postMessage({ t: 'grab', j, p }); return; } try { if (model?.open) model.send({ t: 'grab', j, p }); } catch {} },
  canGrab: () => grabAllowed && canInteract(),
});
const sendFx = (k, r, d) => { if (mirrorCh) { mirrorCh.postMessage({ t: 'fx', k, r, d }); return; } try { if (model?.open) model.send({ t: 'fx', k, r, d }); } catch {} };
let lastBoop = 0, lastSlap = 0;
const fxIn = new FxInput(stage.fx, $('stage'), {
  onPat: (r) => sendFx('pat', r),
  onBoop: () => { lastBoop = performance.now(); sendFx('boop'); },
  onSlap: (dir) => { lastSlap = performance.now(); sendFx('slap', undefined, dir); },
  enabled: () => patAllowed && canInteract() && performance.now() - lastBoop > 250,
  canSlap: () => slapAllowed && canInteract() && performance.now() - lastSlap > 300,
});
window.vt.onInteract((on) => { localInteract = on; if (!on) setGrabAllowed(grabAllowed); });
// Full screen and a locked widget are click-through: they only take the mouse while it's over
// something grabbable (and while a pull is going on), then hand it straight back to the desktop.
let capturing = false;
const clickThrough = () => MODE === 'screen' || (MODE === 'floating' && locked);
function setCapture(on) {
  if (on === capturing) return;
  capturing = on;
  window.vt.captureMouse(on);
}
// every avatar on this page that can be touched: the host's, then the co-hosts' (multi-model rooms)
const targets = () => [{ grabber, fxIn }, ...(room ? room.targets() : [])];
const grabbing = () => targets().find((t) => t.grabber.grabbing) || null;
function overAny(e) {
  for (const t of targets()) {
    if (t.fxIn.over(e) === 'nose') return 'nose';
    if (t.grabber.over(e) >= 0) return 'grab';
  }
  return null;
}
function updateHover(e) {
  const g = grabbing(), o = g ? 'grab' : overAny(e);
  document.body.style.cursor = g ? 'grabbing' : o === 'nose' ? 'pointer' : o ? 'grab' : '';
  if (clickThrough()) setCapture(!!o);
}
addEventListener('pointermove', (e) => {
  const g = grabbing();
  if (g) g.grabber.move(e);
  else if (!e.buttons) for (const t of targets()) t.fxIn.move(e); // rubbing over the head = headpat (works even while click-through)
  updateHover(e);
});
addEventListener('mousedown', (e) => {
  if (e.button !== 0 || e.target.closest('button, #zoneEditor')) return;
  const ts = targets().reverse(); // co-hosts are drawn over the host: they get first go
  for (const t of ts) if (t.fxIn.down(e)) { e.preventDefault(); return; } // boop!
  for (const t of ts) if (t.grabber.begin(e)) { e.preventDefault(); updateHover(e); return; }
});
addEventListener('mouseup', (e) => { const g = grabbing(); if (g) { g.grabber.end(); updateHover(e); } });
addEventListener('blur', () => grabbing()?.grabber.end());
document.addEventListener('mouseleave', () => { if (!grabbing()) { document.body.style.cursor = ''; if (clickThrough()) setCapture(false); } });
function setGrabAllowed(on) {
  grabAllowed = on;
  if (!on || !localInteract) { grabber.end(); document.body.style.cursor = ''; if (clickThrough()) setCapture(false); }
  if (!on) stage.clearGrabs(); // nobody may pull anymore: drop everyone's pulls
}

// ---------------- screen: zone + remote placement ----------------
const FULL_ZONE = { x: 0, y: 0, w: 1, h: 1 };
let zone = store.get('vt-zone', FULL_ZONE);
let pos = { ...DEFAULT_POS, ...store.get('vt-pos', {}) };
const shown = { ...pos }; // smoothed

let work = { x: 0, y: 0, w: 1, h: 1 }; // monitor minus the taskbar (filled in below)
// the area the avatar may use: the zone minus the taskbar, or the whole zone when the broadcaster
// lets it go over the taskbar (pos.tb; handy when we're watching something full screen)
const usableZone = (p = pos) => effectiveZone(zone, p.tb ? FULL_ZONE : work);
function zonePx(z = usableZone()) {
  const W = innerWidth, H = innerHeight;
  return { x: z.x * W, y: z.y * H, w: z.w * W, h: z.h * H };
}

function clampPos(p, zp) {
  const s = Math.max(0.08, Math.min(1, p.s));
  const boxH = s * zp.h, boxW = boxH * AVATAR_ASPECT;
  const halfW = Math.min(0.5, boxW / 2 / zp.w);
  return { ...p, s, x: Math.max(halfW, Math.min(1 - halfW, p.x)), y: Math.max(Math.min(1, boxH / zp.h), Math.min(1, p.y)) };
}

// The avatar is framed inside a virtual box at the broadcaster's position. The drawing area is that box
// plus generous margins (zoomed-in framing, long hair, arms, the legs below a bust shot, a sideways
// roll… all fit), clipped to the window so no pixels are spent off-screen and the avatar always renders
// at full resolution. The size is rounded up to steps of 64 px, so while the broadcaster drags the
// avatar around the canvas mostly just slides; when it does resize it redraws in the same frame, so
// there's no flicker.
const MARGIN = { side: 0.9, top: 0.6, bottom: 1.6 }; // × box height
const STEP = 64;
function layoutBox() {
  const zp = zonePx();
  const anchor = placeBox($('box'), stage, room ? rowPos(room.order, 'h', shown, zp.w / zp.h, stage.view.roll) : shown, zp);
  Object.assign($('anchor').style, anchor);
  layoutMembers();
  sendHotRects();
}

// Full screen: tell the app where the avatars are drawn. Mouse moves are only passed to this see-through
// window while the cursor is over one of them; elsewhere the window below keeps its own cursor (passing
// every move made the cursor flicker between theirs and ours).
let lastHot = '';
function sendHotRects() {
  if (MODE !== 'screen' || !window.vt.setHotRects) return;
  const els = idleHidden ? [] : [$('box'), ...(room ? [...room.slots.values()].filter((s) => s.hasModel && !s.idle).map((s) => s.el) : [])];
  // the avatar's box, widened a bit for hair and arms that reach out of it
  const rects = els.map((el) => el._box).filter((b) => b && b.w > 0 && b.h > 0)
    .map((b) => [Math.floor(b.left - b.w * 0.3), Math.floor(b.top - b.h * 0.1), Math.ceil(b.w * 1.6), Math.ceil(b.h * 1.25)]);
  const key = JSON.stringify(rects);
  if (key === lastHot) return;
  lastHot = key;
  window.vt.setHotRects(rects);
}
setInterval(sendHotRects, 500); // idle fades, co-hosts coming and going…


/** Full screen, co-hosts: beside the host in the row, or (when the host allows) wherever they put themselves. */
function layoutMembers() {
  if (MODE !== 'screen' || !room) return;
  const zp = zonePx();
  for (const [id, s] of room.slots) {
    const p = room.free && s.pos ? s.shown || (s.shown = { ...s.pos }) : rowPos(room.order, id, shown, zp.w / zp.h, stage.view.roll);
    placeBox(s.el, s.stage, p, zp);
  }
  sendHotRects();
}

/** Put an avatar's drawing area (element `el` holding its canvas) at placement p in zone zp; returns the box's CSS. */
function placeBox(el, st, pIn, zp) {
  const p = clampPos(pIn, zp);
  const boxH = p.s * zp.h, boxW = boxH * AVATAR_ASPECT;
  const left = zp.x + p.x * zp.w - boxW / 2, top = zp.y + p.y * zp.h - boxH;
  el._box = { left, top, w: boxW, h: boxH };
  const mS = boxH * MARGIN.side, mT = boxH * MARGIN.top, mB = boxH * MARGIN.bottom;
  const W = innerWidth, H = innerHeight;
  // wanted area, clipped to the window
  const x0 = Math.max(0, Math.floor(left - mS)), y0 = Math.max(0, Math.floor(top - mT));
  const x1 = Math.min(W, Math.ceil(left + boxW + mS)), y1 = Math.min(H, Math.ceil(top + boxH + mB));
  // round the size up (never past the window), then keep it on screen
  const w = Math.min(W, Math.max(STEP, Math.ceil((x1 - x0) / STEP) * STEP));
  const h = Math.min(H, Math.max(STEP, Math.ceil((y1 - y0) / STEP) * STEP));
  const rx = Math.max(0, Math.min(x0, W - w)), ry = Math.max(0, Math.min(y0, H - h));
  const bs = el.style;
  const resized = bs.width !== w + 'px' || bs.height !== h + 'px';
  Object.assign(bs, { left: rx + 'px', top: ry + 'px', width: w + 'px', height: h + 'px' });
  st.setViewport({ x: left - rx, y: top - ry, w: boxW, h: boxH });
  if (resized) st.syncSize(); // resize + redraw now, not on the next frame
  return { left: left + 'px', top: top + 'px', width: boxW + 'px', height: boxH + 'px' };
}

function animatePlacement() {
  requestAnimationFrame(animatePlacement);
  let moved = false;
  for (const k of ['x', 'y', 's']) {
    const d = pos[k] - shown[k];
    if (Math.abs(d) > 1e-4) { shown[k] += d * 0.35; moved = true; } else shown[k] = pos[k];
  }
  // co-hosts placed on their own glide the same way
  let membersMoved = false;
  if (room) for (const s of room.slots.values()) {
    if (!s.pos) continue;
    if (!s.shown) { s.shown = { ...s.pos }; membersMoved = true; continue; }
    for (const k of ['x', 'y', 's']) {
      const d = s.pos[k] - s.shown[k];
      if (Math.abs(d) > 1e-4) { s.shown[k] += d * 0.35; membersMoved = true; } else s.shown[k] = s.pos[k];
    }
    s.shown.tb = s.pos.tb;
  }
  if (moved) layoutBox(); else if (membersMoved) layoutMembers();
}
// co-hosts' avatars fade out on their own after a while without tracking (full screen, your mirror too)
if (MODE === 'screen') setInterval(() => {
  if (room) for (const s of room.slots.values()) {
    const idle = s.hasModel && performance.now() - s.lastLive > IDLE_HIDE_MS;
    if (idle === s.idle) continue;
    s.idle = idle;
    s.el.classList.toggle('idle', idle);
    s.stage.suspended = false;
    if (idle) setTimeout(() => { if (s.idle) s.stage.suspended = true; }, 900);
  }
}, 1000);

function applyPos(p) {
  const next = { ...pos, ...p };
  pos = clampPos(next, zonePx(usableZone(next)));
  store.set('vt-pos', pos);
}

if (MODE === 'screen') {
  const setWork = (w) => {
    if (!w || !(w.w > 0) || !(w.h > 0)) return;
    work = w;
    applyPos({}); layoutBox(); sendViewerState();
  };
  window.vt.getWorkArea().then(setWork);
  window.vt.onWorkArea(setWork);
  Object.assign(shown, pos);
  layoutBox();
  animatePlacement();
  addEventListener('resize', layoutBox);

  let draft = null, start = null;
  const showRect = (z) => {
    const zp = zonePx(z), r = $('zoneRect').style;
    r.left = zp.x + 'px'; r.top = zp.y + 'px'; r.width = zp.w + 'px'; r.height = zp.h + 'px';
  };
  window.vt.onZoneEdit((on) => {
    document.body.classList.toggle('zoning', on);
    if (on) { draft = { ...zone }; showRect(draft); }
  });
  window.vt.onZoneReset(() => commitZone(FULL_ZONE));
  $('zoneEditor').addEventListener('mousedown', (e) => {
    if (e.button !== 0 || e.target.closest('#zoneHelp')) return;
    start = { x: e.clientX / innerWidth, y: e.clientY / innerHeight };
  });
  addEventListener('mousemove', (e) => {
    if (!start) return;
    const x = e.clientX / innerWidth, y = e.clientY / innerHeight;
    draft = { x: Math.min(start.x, x), y: Math.min(start.y, y), w: Math.abs(x - start.x), h: Math.abs(y - start.y) };
    showRect(draft);
  });
  addEventListener('mouseup', () => { start = null; });
  const finish = (ok) => {
    if (ok && draft) commitZone(minZone(draft));
    window.vt.zoneEditDone();
  };
  $('zoneDone').onclick = () => finish(true);
  $('zoneCancel').onclick = () => finish(false);
  $('zoneAll').onclick = () => { draft = { ...FULL_ZONE }; showRect(draft); };
  addEventListener('keydown', (e) => {
    if (!document.body.classList.contains('zoning')) return;
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
}

/**
 * A zone too small to show the avatars is grown to a usable size, centred where it was drawn: at least a
 * quarter of the screen high, and wide enough for the whole row at that height (co-hosts included).
 */
function minZone(z) {
  const n = Math.max(1, room?.order.length || 1);
  const MH = 0.25; // of the monitor
  const MW = Math.min(1, Math.max(0.12, MH * innerHeight * (AVATAR_ASPECT + (n - 1) * SLOT_STEP) / innerWidth));
  const w = Math.max(z.w, MW), h = Math.max(z.h, MH);
  const cx = z.x + z.w / 2, cy = z.y + z.h / 2;
  return { x: Math.max(0, Math.min(1 - w, cx - w / 2)), y: Math.max(0, Math.min(1 - h, cy - h / 2)), w, h };
}
function commitZone(z) {
  zone = { x: +z.x.toFixed(4), y: +z.y.toFixed(4), w: +z.w.toFixed(4), h: +z.h.toFixed(4) };
  store.set('vt-zone', zone);
  applyPos({});
  layoutBox();
  sendViewerState();
}

// ---------------- model cache (so mode switches / reconnects don't re-download) ----------------
// Broadcasters' models are kept scrambled (AES-GCM with a key made on this PC that can't be read out), so
// the cache can't simply be found and opened as a .vrm. Versions before 0.9.1 kept them as plain data in
// 'vt-rx': that whole database is deleted once (its files go away, not just its entries).
const CACHE_DB = 'vt-rx2';
try {
  if (localStorage.getItem('vt-old-cache-gone') !== '1') {
    const del = indexedDB.deleteDatabase('vt-rx');
    del.onsuccess = () => { try { localStorage.setItem('vt-old-cache-gone', '1'); } catch {} };
  }
} catch {}
let dbPromise = null;
function idb() {
  return dbPromise || (dbPromise = new Promise((res, rej) => {
    const r = indexedDB.open(CACHE_DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => { dbPromise = null; rej(r.error); };
  }));
}
const idbRaw = (mode, fn) => idb().then((db) => new Promise((res) => {
  const r = fn(db.transaction('kv', mode).objectStore('kv')); r.onsuccess = () => res(r.result ?? null); r.onerror = () => res(null);
})).catch(() => null);
let keyPromise = null;
function cacheKey() {
  return keyPromise || (keyPromise = (async () => {
    const k = await idbRaw('readonly', (st) => st.get('key'));
    if (k) return k;
    const nk = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']); // false: never exportable
    await idbRaw('readwrite', (st) => st.put(nk, 'key'));
    return nk;
  })().catch(() => { keyPromise = null; return null; }));
}
async function scramble(buf) {
  const key = await cacheKey();
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  return { iv, data: await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buf) };
}
async function unscramble(rec) {
  try { const key = await cacheKey(); return key && rec?.iv && rec.data ? await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, key, rec.data) : null; } catch { return null; }
}
async function cacheGet() {
  const rec = await idbRaw('readonly', (st) => st.get('model'));
  if (!rec?.id) return null;
  const buf = await unscramble(rec);
  return buf ? { id: rec.id, buf } : null;
}
async function cachePut(rec) {
  const s = await scramble(rec.buf).catch(() => null);
  if (s) idbRaw('readwrite', (st) => st.put({ id: rec.id, ...s }, 'model'));
}
let cachedId = null;
idbRaw('readonly', (st) => st.get('model')).then((rec) => { cachedId = rec?.id ?? null; }); // just the id: no need to unscramble it

// ---------------- props: images arrive on request and are cached by hash ----------------
const idbProp = idbRaw;
const propWaiters = new Map(); // hash -> [resolve]
const incomingProps = new Map(); // hash -> { mime, size, chunks, parts, got }
const propLoader = async (hash) => {
  const cached = await idbProp('readonly', (st) => st.get('prop:' + hash));
  if (cached) return cached;
  return new Promise((resolve) => {
    const list = propWaiters.get(hash) || [];
    list.push(resolve);
    propWaiters.set(hash, list);
    if (list.length === 1) requestProp(hash);
    setTimeout(() => resolve(null), 120000);
  });
};
stage.props.setLoader(propLoader);
let mirrorCh = null;
function requestProp(hash) {
  if (mirrorCh) { mirrorCh.postMessage({ t: 'need-prop', hash }); return; }
  try { if (model?.open) model.send({ t: 'need-prop', hash }); } catch {}
}

async function showModel(buf, id) {
  try {
    await stage.loadVRM(buf, id);
    hasModel = true;
    reportRx(idleHidden ? 'hidden' : 'ready');
    lastLiveAt = performance.now(); // give tracking a full grace period after (re)loading
    status('ok', 'Connected', { autoHide: true });
    return true;
  } catch (err) {
    status('bad', 'Could not load avatar: ' + err.message);
    reportRx('error');
    return false;
  }
}

// ---------------- co-hosts (multi-model rooms) ----------------
// Their avatars come wrapped as { t:'mm', m, d } and stand in a row with the host's (see shared/room.js).
const memberCache = {
  get: async (id) => unscramble(await idbProp('readonly', (st) => st.get('model:' + id))),
  put: async (id, buf) => {
    const s = await scramble(buf).catch(() => null);
    if (!s) return;
    await idbProp('readwrite', (st) => st.put(s, 'model:' + id));
    // keep only the last few co-host models on disk
    let ids = [];
    try { ids = JSON.parse(localStorage.getItem('vt-member-models') || '[]'); } catch {}
    ids = [id, ...ids.filter((x) => x !== id)];
    for (const old of ids.slice(6)) idbProp('readwrite', (st) => st.delete('model:' + old));
    try { localStorage.setItem('vt-member-models', JSON.stringify(ids.slice(0, 6))); } catch {}
  },
};
const toHost = (msg) => { if (mirrorCh) { mirrorCh.postMessage(msg); return; } try { if (model?.open) model.send(msg); } catch {} };
room = window.vtRoom = new Room({
  main: stage,
  container: $('members'),
  stageOptions: () => (lowPower ? LOW_QUALITY : quality()),
  propLoader, cache: memberCache, send: toHost, interactive: true, skip: ['h'], // 'h' (the host) is the main stage
  // the host's avatar being hidden (not tracking) doesn't stop you touching a co-host's
  canInteract: (s) => localInteract && s.hasModel && !s.idle && !document.body.classList.contains('zoning'),
});
room.startDepth({ main: $('box'), base: 2 }); // bigger avatars further back
room.onProps = () => renderScreenProps(allScreenProps());
room.onPos = () => {}; // free placement: picked up by the placement animation
room.onChange = () => {
  window.vt.setMemberCount?.(room.order.length || 1); // the floating widget widens for more avatars
  layoutAll();
  renderScreenProps(allScreenProps());
};

/** Floating / window: everyone in one row, centred, each the size a solo avatar would be (if it fits). */
function layoutRow() {
  if (MODE === 'screen') return;
  if (room.order.length <= 1) { stage.setViewport(null); return; }
  const L = rowLayout(room.order, innerWidth, innerHeight, 'group', stage.view.roll);
  if (L.h) stage.setViewport(L.h);
  for (const [id, s] of room.slots) if (L[id]) s.stage.setViewport(L[id]);
}
function layoutAll() { if (MODE === 'screen') layoutBox(); else layoutRow(); }
addEventListener('resize', layoutRow);

// ---------------- networking ----------------
// One Peer (signalling registration) is kept for the whole session; only the two data channels are
// re-opened when the broadcaster drops. Every channel belongs to a "generation": closing old
// channels bumps it, so their late close/error events can never trigger another reconnect
// (that used to cause an endless connect → drop → connect loop every ~2 s).
let peer = null, motion = null, model = null;
let incoming = null;
let retryTimer = null, hbTimer = null, sigTimer = null, lastHeard = 0;
let stopped = false; // kicked or leaving: don't auto-reconnect
let roomFullUntil = 0;
let gen = 0;           // channel generation
let failures = 0;      // consecutive failed attempts → backoff
let sigFailures = 0;   // consecutive failed signalling reconnects
const target = PEER_PREFIX + code;
// Watchdog: a signalling server that accepts the connection but never answers would leave us
// "Connecting…" forever, if we're not registered in time, throw the Peer away and start over.
let peerAttemptAt = 0, peerHangs = 0;
setInterval(() => {
  if (stopped || !peer || peer.open || model?.open || !peerAttemptAt) return;
  if (performance.now() - peerAttemptAt < Math.min(30000, 10000 + peerHangs * 5000)) return;
  peerHangs++;
  status('bad', `Can't reach the connection server, retrying (attempt ${peerHangs + 1})…`);
  const p = peer; peer = null;
  try { p.destroy(); } catch {}
  ensurePeer();
}, 2000);
const backoff = () => Math.min(15000, 1500 * 2 ** Math.max(0, Math.min(failures - 1, 4))); // 1.5 s, 3 s, 6 s, 12 s, 15 s…

function connect() {
  stopped = false;
  status('warn', `Connecting to room ${code}…`);
  ensurePeer();
}

/** Make sure we're registered with the signalling server, then open the channels. */
function ensurePeer() {
  if (stopped) return;
  if (peer && !peer.destroyed) {
    if (peer.open) { if (!model) openChannels(); return; }
    if (peer.disconnected) reconnectSignalling();
    return; // still registering: 'open' will follow
  }
  const p = peer = new window.Peer(peerOptions());
  peerAttemptAt = performance.now();
  p.on('open', () => {
    if (p !== peer) return;
    sigFailures = 0; peerHangs = 0; peerAttemptAt = 0;
    if (!model && !stopped) openChannels(); // a signalling reconnect must not touch working channels
  });
  p.on('error', (err) => {
    if (p !== peer || stopped) return;
    if (err.type === 'peer-unavailable') {
      if (model?.open) return; // about an old attempt
      status('warn', hasModel ? 'Waiting for the broadcast to come back…' : `Room ${code} isn't online yet. Retrying…`);
      channelsDown(null, 6000);
      return;
    }
    console.warn('peer error', err.type, err.message);
    if (model?.open) return; // signalling hiccup while connected: the avatar keeps working, 'disconnected' handles it
    status('bad', 'Connection problem: ' + (err.type || err.message) + '. Retrying…');
    failures++;
    scheduleRetry(backoff());
  });
  p.on('disconnected', () => {
    if (p !== peer || stopped || p.destroyed) return;
    clearTimeout(sigTimer);
    sigTimer = setTimeout(reconnectSignalling, Math.min(15000, 2000 * 2 ** Math.min(sigFailures, 3)));
  });
  p.on('close', () => { if (p === peer) peer = null; });
}

function reconnectSignalling() {
  clearTimeout(sigTimer);
  const p = peer;
  if (stopped || !p || p.destroyed || !p.disconnected) return;
  peerAttemptAt = performance.now();
  if (++sigFailures > 4 && !model?.open) { // our id seems stuck on the server: start over with a fresh one
    sigFailures = 0;
    peer = null;
    try { p.destroy(); } catch {}
    ensurePeer();
    return;
  }
  try { p.reconnect(); } catch {}
}

function openChannels() {
  if (stopped || !peer?.open) return;
  closeChannels();
  const my = gen;
  const live = () => my === gen && !stopped;
  const m = model = peer.connect(target, { label: 'model', reliable: true, serialization: 'binary' });
  const mo = motion = peer.connect(target, { label: 'motion', reliable: false, serialization: 'json' });
  if (!m || !mo) { channelsDown(null); return; }
  // if nothing opens in time (offer lost, broadcaster busy), try again
  const openTimeout = setTimeout(() => { if (live() && !(m.open && mo.open)) channelsDown('Still connecting… retrying.'); }, 20000);

  m.on('open', () => {
    if (!live()) return;
    lastHeard = performance.now();
    sendViewerState();
    sendRx();
    for (const hash of propWaiters.keys()) requestProp(hash); // anything still missing after a reconnect
    if (sharing) callWithScreen();
    clearInterval(hbTimer);
    hbTimer = setInterval(heartbeat, HEARTBEAT_MS);
  });
  m.on('data', (d) => { if (live()) onModelData(d); });
  mo.on('open', () => {
    if (!live()) return;
    clearTimeout(openTimeout);
    failures = 0;
    status('ok', hasModel ? 'Connected' : 'Connected, waiting for avatar…', { autoHide: hasModel });
  });
  let lastSeq = 0; // per connection: the broadcaster restarts its counter, a new channel starts at 0
  mo.on('data', (d) => {
    if (!live() || !d || d.t !== 'm') return;
    lastHeard = performance.now();
    if (typeof d.m === 'string') { room.motion(d.m, d); return; } // a co-host's movements
    if (typeof d.n === 'number') {
      if (d.n <= lastSeq && lastSeq - d.n < 1000) return; // late / out-of-order frame: a newer one is already shown
      lastSeq = d.n;
    }
    stage.setMotion(d);
    if (d.f && !d.h) markLive(); // a held pose (broadcaster out of view) isn't live tracking
  });
  const lost = () => {
    if (!live()) return;
    clearTimeout(openTimeout);
    if (performance.now() < roomFullUntil) return;
    channelsDown('Connection lost. Reconnecting…');
  };
  for (const c of [m, mo]) { c.on('close', lost); c.on('error', lost); }
}

/** Close the current channels; any events they still fire are ignored. */
function closeChannels() {
  gen++;
  setGrabAllowed(false);
  patAllowed = false; slapAllowed = false;
  clearInterval(hbTimer);
  const a = model, b = motion;
  model = motion = null;
  try { a?.close(); } catch {}
  try { b?.close(); } catch {}
}

/** The channels are gone (or never came up): close what's left and try again later, once. */
function channelsDown(text, maxDelay = Infinity) {
  closeChannels();
  if (stopped) return;
  if (text) status('bad', text);
  failures++;
  scheduleRetry(Math.min(maxDelay, backoff()));
}

function heartbeat() {
  if (model?.open) { try { model.send({ t: 'hb' }); } catch {} }
  if (performance.now() - lastHeard > HEARTBEAT_TIMEOUT_MS) channelsDown('Broadcaster stopped responding. Reconnecting…');
}

function scheduleRetry(ms = 3000) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { if (!stopped) ensurePeer(); }, ms);
}

/** Close everything, including the signalling registration. */
function teardown() {
  closeChannels();
  clearTimeout(retryTimer); clearTimeout(sigTimer);
  try { screenCall?.close(); } catch {}
  screenCall = null;
  const p = peer; peer = null;
  try { p?.destroy(); } catch {}
}

function reconnectNow() { teardown(); failures = 0; sigFailures = 0; connect(); }
window.vt.onReconnect(reconnectNow);

// say goodbye so the broadcaster's list updates immediately
async function leave(reason = 'left') {
  stopped = true;
  try { if (model?.open) model.send({ t: 'bye', reason }); } catch {}
  await new Promise((r) => setTimeout(r, 120)); // let the message flush
  teardown();
}
window.vt.onAppClosing(async () => { await leave('left'); window.vt.goodbyeSent(); });
addEventListener('beforeunload', () => { try { if (model?.open) model.send({ t: 'bye', reason: 'left' }); } catch {} });

function sendViewerState() {
  if (!model?.open) return;
  model.send({
    t: 'viewer', name: viewerName, mode: MODE,
    aspect: +(innerWidth / innerHeight).toFixed(4),
    zone, work, pos, placed: !!store.get('vt-placed', false), sharing, have: stage.modelId || cachedId, rooms: 1, // rooms: understands multi-avatar rooms
  });
}

function toBuffer(data) {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return null;
}

async function onModelData(d) {
  if (!d || typeof d !== 'object') return;
  lastHeard = performance.now();
  switch (d.t) {
    case 'hb': return;
    case 'bye':
      closeChannels();
      stage.clearVRM(); hasModel = false;
      stage.props.sync([]);
      room.setMembers({ order: [] });
      rxState = { s: 'waiting', p: 0 };
      if (d.reason === 'kicked') { stopped = true; teardown(); status('bad', 'The broadcaster disconnected you.', { retry: true }); }
      else if (d.reason === 'full') {
        roomFullUntil = performance.now() + 10000;
        status('warn', `This room is full (${Number(d.max) || '?'} viewers max). You'll join as soon as a spot frees up…`);
        scheduleRetry(10000);
      }
      else if (d.reason === 'obs-only') {
        roomFullUntil = performance.now() + 15000;
        status('warn', 'The broadcaster is in OBS only mode (no viewers). Retrying now and then…');
        scheduleRetry(15000);
      }
      else { status('warn', 'Broadcast ended, waiting for it to start again…'); failures = 0; scheduleRetry(4000); }
      return;
    case 'view': {
      const v = stage.setView(d);
      store.set('vt-view', v);
      room.setView(v);
      if (room.order.length > 1) layoutAll(); // a roll turns the whole row
      return;
    }
    case 'style':
      store.set('vt-style', stage.setStyle(d));
      room.setHostLight(stage.style.light);
      return;
    case 'members': // who's in the room, left to right (multi-model rooms)
      room.setMembers(d);
      return;
    case 'mm': // one of the co-hosts' messages
      if (typeof d.m === 'string') await room.handle(d.m, d.d);
      return;
    case 'perm':
      patAllowed = !!d.pat;
      slapAllowed = !!d.slap;
      setGrabAllowed(!!d.grab);
      return;
    case 'fx': // someone else's headpat / boop
      if (d.k === 'pat') stage.fx.patting(+d.r);
      else if (d.k === 'boop') stage.fx.boop();
      else if (d.k === 'slap') stage.fx.slap(d.d);
      return;
    case 'grab': // someone else (broadcaster or another viewer) pulling hair / clothes
      if (typeof d.k === 'string' && d.k !== 'me') stage.setGrab(d.k, Number.isInteger(d.j) ? d.j : -1, Array.isArray(d.p) ? d.p.slice(0, 3).map(Number) : null, true);
      return;
    case 'props':
      if (Array.isArray(d.list)) { lastPropList = d.list.slice(0, 64); stage.props.sync(lastPropList); renderScreenProps(allScreenProps()); }
      return;
    case 'prop-begin':
      incomingProps.set(d.hash, { mime: String(d.mime || ''), size: d.size, chunks: d.chunks, parts: new Array(d.chunks), got: 0 });
      return;
    case 'prop-chunk': {
      const inc = incomingProps.get(d.hash);
      if (inc && !inc.parts[d.i]) { inc.parts[d.i] = toBuffer(d.data); inc.got++; }
      return;
    }
    case 'prop-end': {
      const inc = incomingProps.get(d.hash);
      incomingProps.delete(d.hash);
      if (!inc || inc.parts.some((x) => !x) || !/^image\/(png|jpeg|gif|webp)$/.test(inc.mime)) return;
      const blob = new Blob(inc.parts, { type: inc.mime });
      idbProp('readwrite', (st) => st.put(blob, 'prop:' + d.hash));
      for (const resolve of propWaiters.get(d.hash) || []) resolve(blob);
      propWaiters.delete(d.hash);
      return;
    }
    case 'pos':
      if (MIRROR && d.zone && typeof d.zone === 'object') zone = { ...FULL_ZONE, ...d.zone }; // the mirrored viewer's area
      if (MODE === 'screen') { applyPos({ x: +d.x, y: +d.y, s: +d.s, tb: !!d.tb }); layoutBox(); }
      if (!MIRROR) store.set('vt-placed', true); // a broadcaster has placed me: not a fresh screen anymore
      return;
    case 'model-use': {
      if (stage.modelId === d.id) return;
      const rec = await cacheGet();
      if (rec?.id === d.id && rec.buf) { reportRx('loading', 1); await showModel(rec.buf, rec.id); return; }
      model?.send({ t: 'need-model' });
      return;
    }
    case 'model-begin':
      incoming = { id: d.id, size: d.size, chunks: d.chunks, parts: new Array(d.chunks), got: 0 };
      $('bar').hidden = false;
      status('warn', 'Receiving avatar…');
      reportRx('loading', 0);
      return;
    case 'model-chunk':
      if (!incoming || d.id !== incoming.id) return;
      if (!incoming.parts[d.i]) { incoming.parts[d.i] = toBuffer(d.data); incoming.got++; }
      $('bar').firstElementChild.style.width = (100 * incoming.got / incoming.chunks).toFixed(1) + '%';
      reportRx('loading', incoming.got / incoming.chunks * 0.95); // the last bit is opening the model
      return;
    case 'model-end': {
      if (!incoming || d.id !== incoming.id) return;
      const { parts, size, id } = incoming;
      incoming = null;
      $('bar').hidden = true;
      if (parts.some((p) => !p)) { channelsDown('Avatar transfer was incomplete. Reconnecting…'); return; }
      const buf = new Uint8Array(size); let off = 0;
      for (const p of parts) { buf.set(new Uint8Array(p), off); off += p.byteLength; }
      if (await showModel(buf.buffer.slice(0), id)) { cachedId = id; cachePut({ id, buf: buf.buffer }); }
      return;
    }
  }
}

// ---------------- optional screen preview for the broadcaster ----------------
let sharing = false, screenStream = null, screenCall = null;

async function callWithScreen() {
  if (!screenStream || !peer?.open || screenCall) return;
  const c = screenCall = peer.call(target, screenStream, { metadata: { kind: 'screen' } });
  if (!c) { screenCall = null; return; }
  const end = () => { if (screenCall === c) screenCall = null; };
  c.on('close', end); c.on('error', end);
}

async function startSharing() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { max: 5 }, width: { max: 1280 }, height: { max: 1280 } }, audio: false,
    });
    const track = screenStream.getVideoTracks()[0];
    try { await track.applyConstraints({ frameRate: { max: 5 }, width: { max: 1280 } }); } catch {}
    track.addEventListener('ended', () => window.vt.setSharing(false));
    sharing = true;
    document.body.classList.add('sharing');
    sendViewerState();
    callWithScreen();
  } catch (err) {
    console.warn('screen share failed', err);
    window.vt.setSharing(false);
  }
}

function stopSharing() {
  sharing = false;
  document.body.classList.remove('sharing');
  try { screenCall?.close(); } catch {}
  screenCall = null;
  screenStream?.getTracks().forEach((t) => t.stop());
  screenStream = null;
  sendViewerState();
}

window.vt.onShareChanged((on) => {
  if (MODE !== 'screen') return;
  if (on && !sharing) startSharing();
  if (!on && sharing) stopSharing();
});

// ---------------- mirror (broadcaster's own screen) ----------------
function startMirror() {
  mirrorCh = new BroadcastChannel('vt-mirror');
  mirrorCh.onmessage = async ({ data: d }) => {
    if (!d || typeof d !== 'object') return;
    switch (d.t) {
      case 'm':
        if (typeof d.m === 'string') { room.motion(d.m, d); return; }
        stage.setMotion(d); if (d.f && !d.h) markLive(); return;
      case 'model': if (stage.modelId !== d.id && d.buf) await showModel(d.buf, d.id); return;
      case 'prop-img':
        for (const resolve of propWaiters.get(d.hash) || []) resolve(d.blob);
        propWaiters.delete(d.hash);
        return;
      case 'close': window.close(); return;
      case 'idle': setIdleHidden(!!d.on); return; // the viewer's avatar faded out (or back in)
      default: onModelData(d); // view, style, props, pos, fx, grab: same as from the network
    }
  };
  mirrorCh.postMessage({ t: 'hello' });
}

if (MIRROR) startMirror(); else connect();
