// Receiver: shows a friend's avatar as a floating widget, in a window, or over a whole monitor.
// How the avatar is framed (bust/full, zoom, position, rotation) is controlled by the broadcaster.
import { AvatarStage } from './shared/avatar.js';
import { PEER_PREFIX, DEFAULT_POS, AVATAR_ASPECT, HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, peerOptions, effectiveZone } from './shared/protocol.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const code = params.get('code');
const MODE = params.get('mode') || 'floating';
const viewerName = params.get('name') || '';
document.body.classList.add(MODE);

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// See-through windows (floating / full screen) are composited by the CPU on Windows, so keep their
// pixel count and frame rate modest; the normal window can afford more.
const stage = new AvatarStage($('stage'), MODE === 'window' ? { maxPixelRatio: 2 } : { maxPixelRatio: MODE === 'screen' ? 1 : 1.5, maxFps: 45 });
if (MODE === 'screen') $('anchor').appendChild($('status'));
stage.setView(store.get('vt-view', {})); // last view from the broadcaster until a fresh one arrives

// ---------------- status pill ----------------
let hasModel = false, statusTimer = null;
function status(state, text, { autoHide = false, retry = false } = {}) {
  $('status').hidden = false;
  $('dot').className = 'dot ' + state;
  $('statusText').textContent = text;
  $('retryBtn').hidden = !retry;
  window.vt.reportStatus(state, text);
  clearTimeout(statusTimer);
  if (autoHide) statusTimer = setTimeout(() => { if (!document.body.classList.contains('edit')) $('status').hidden = true; }, 2500);
}
$('retryBtn').onclick = () => reconnectNow();

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

// ---------------- screen: zone + remote placement ----------------
const FULL_ZONE = { x: 0, y: 0, w: 1, h: 1 };
let zone = store.get('vt-zone', FULL_ZONE);
let pos = { ...DEFAULT_POS, ...store.get('vt-pos', {}) };
const shown = { ...pos }; // smoothed

let work = { x: 0, y: 0, w: 1, h: 1 }; // monitor minus the taskbar (filled in below)
function zonePx(z = effectiveZone(zone, work)) {
  const W = innerWidth, H = innerHeight;
  return { x: z.x * W, y: z.y * H, w: z.w * W, h: z.h * H };
}

function clampPos(p, zp) {
  const s = Math.max(0.08, Math.min(1, p.s));
  const boxH = s * zp.h, boxW = boxH * AVATAR_ASPECT;
  const halfW = Math.min(0.5, boxW / 2 / zp.w);
  return { ...p, s, x: Math.max(halfW, Math.min(1 - halfW, p.x)), y: Math.max(Math.min(1, boxH / zp.h), Math.min(1, p.y)) };
}

// The avatar is framed inside a virtual box at the broadcaster's position. The canvas covers that box
// plus generous margins (arms, hair, zoomed-in framing still fit — nothing is cut at the box edge),
// clipped to the zone. Covering the whole monitor would make Windows copy a full-screen see-through
// layer every frame, which is what made the avatar laggy.
function layoutBox() {
  const zp = zonePx();
  const p = clampPos(shown, zp);
  const boxH = p.s * zp.h, boxW = boxH * AVATAR_ASPECT;
  const left = zp.x + p.x * zp.w - boxW / 2, top = zp.y + p.y * zp.h - boxH;
  const rx = Math.max(zp.x, left - boxW * 0.8), ry = Math.max(zp.y, top - boxH * 0.35);
  const rr = Math.min(zp.x + zp.w, left + boxW * 1.8), rb = Math.min(zp.y + zp.h, top + boxH * 1.12);
  Object.assign($('box').style, { left: rx + 'px', top: ry + 'px', width: (rr - rx) + 'px', height: (rb - ry) + 'px' });
  Object.assign($('anchor').style, { left: left + 'px', top: top + 'px', width: boxW + 'px', height: boxH + 'px' });
  stage.setViewport({ x: left - rx, y: top - ry, w: boxW, h: boxH });
}

function animatePlacement() {
  requestAnimationFrame(animatePlacement);
  let moved = false;
  for (const k of ['x', 'y', 's']) {
    const d = pos[k] - shown[k];
    if (Math.abs(d) > 1e-4) { shown[k] += d * 0.35; moved = true; } else shown[k] = pos[k];
  }
  if (moved) layoutBox();
}

function applyPos(p) {
  pos = clampPos({ ...pos, ...p }, zonePx());
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
    if (ok && draft && draft.w > 0.04 && draft.h > 0.06) commitZone(draft);
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

function commitZone(z) {
  zone = { x: +z.x.toFixed(4), y: +z.y.toFixed(4), w: +z.w.toFixed(4), h: +z.h.toFixed(4) };
  store.set('vt-zone', zone);
  applyPos({});
  layoutBox();
  sendViewerState();
}

// ---------------- model cache (so mode switches / reconnects don't re-download) ----------------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('vt-rx', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function cacheGet() {
  try {
    const db = await idb();
    return await new Promise((res) => { const r = db.transaction('kv').objectStore('kv').get('model'); r.onsuccess = () => res(r.result || null); r.onerror = () => res(null); });
  } catch { return null; }
}
async function cachePut(rec) {
  try { const db = await idb(); db.transaction('kv', 'readwrite').objectStore('kv').put(rec, 'model'); } catch {}
}
let cachedId = null;
cacheGet().then((rec) => { cachedId = rec?.id ?? null; });

// ---------------- props: images arrive on request and are cached by hash ----------------
const idbProp = (mode, fn) => idb().then((db) => new Promise((res) => {
  const r = fn(db.transaction('kv', mode).objectStore('kv')); r.onsuccess = () => res(r.result ?? null); r.onerror = () => res(null);
})).catch(() => null);
const propWaiters = new Map(); // hash -> [resolve]
const incomingProps = new Map(); // hash -> { mime, size, chunks, parts, got }
stage.props.setLoader(async (hash) => {
  const cached = await idbProp('readonly', (st) => st.get('prop:' + hash));
  if (cached) return cached;
  return new Promise((resolve) => {
    const list = propWaiters.get(hash) || [];
    list.push(resolve);
    propWaiters.set(hash, list);
    if (list.length === 1) requestProp(hash);
    setTimeout(() => resolve(null), 120000);
  });
});
function requestProp(hash) { try { if (model?.open) model.send({ t: 'need-prop', hash }); } catch {} }

async function showModel(buf, id) {
  try {
    await stage.loadVRM(buf, id);
    hasModel = true;
    status('ok', 'Connected', { autoHide: true });
    return true;
  } catch (err) {
    status('bad', 'Could not load avatar: ' + err.message);
    return false;
  }
}

// ---------------- networking ----------------
let peer = null, motion = null, model = null;
let incoming = null;
let retryTimer = null, hbTimer = null, lastHeard = 0;
let stopped = false; // kicked or leaving: don't auto-reconnect
let roomFullUntil = 0;
const target = PEER_PREFIX + code;

function connect() {
  stopped = false;
  status('warn', `Connecting to room ${code}…`);
  peer = new window.Peer(peerOptions());
  peer.on('open', openChannels);
  peer.on('error', (err) => {
    if (stopped) return;
    if (err.type === 'peer-unavailable') status('warn', hasModel ? `Waiting for the broadcast to come back…` : `Room ${code} isn't online yet. Retrying…`);
    else status('bad', 'Connection problem: ' + (err.type || err.message) + '. Retrying…');
    scheduleRetry(4000);
  });
  peer.on('disconnected', () => { if (!peer.destroyed && !stopped) peer.reconnect(); });
}

function openChannels() {
  model = peer.connect(target, { label: 'model', reliable: true, serialization: 'binary' });
  motion = peer.connect(target, { label: 'motion', reliable: false, serialization: 'json' });

  model.on('open', () => {
    lastHeard = performance.now();
    sendViewerState();
    for (const hash of propWaiters.keys()) requestProp(hash); // anything still missing after a reconnect
    if (sharing) callWithScreen();
    clearInterval(hbTimer);
    hbTimer = setInterval(heartbeat, HEARTBEAT_MS);
  });
  model.on('data', onModelData);
  motion.on('open', () => status('ok', hasModel ? 'Connected' : 'Connected — waiting for avatar…', { autoHide: hasModel }));
  let lastSeq = 0; // per connection: the broadcaster restarts its counter, a new channel starts at 0
  motion.on('data', (d) => {
    if (!d || d.t !== 'm') return;
    lastHeard = performance.now();
    if (typeof d.n === 'number') {
      if (d.n <= lastSeq && lastSeq - d.n < 1000) return; // late / out-of-order frame: a newer one is already shown
      lastSeq = d.n;
    }
    stage.setMotion(d);
  });
  const lost = () => { if (stopped || performance.now() < roomFullUntil) return; lostBroadcaster('Connection lost. Reconnecting…'); };
  motion.on('close', lost);
  model.on('close', lost);
}

function heartbeat() {
  if (model?.open) { try { model.send({ t: 'hb' }); } catch {} }
  if (performance.now() - lastHeard > HEARTBEAT_TIMEOUT_MS) lostBroadcaster('Broadcaster stopped responding. Reconnecting…');
}

function lostBroadcaster(text) {
  clearInterval(hbTimer);
  status('bad', text);
  scheduleRetry(2000);
}

function teardown() {
  clearInterval(hbTimer);
  clearTimeout(retryTimer);
  try { motion?.close(); model?.close(); screenCall?.close(); peer?.destroy(); } catch {}
  motion = model = null;
  screenCall = null;
}

function scheduleRetry(ms = 3000) {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => { if (stopped) return; teardown(); connect(); }, ms);
}

function reconnectNow() { teardown(); connect(); }
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
    zone, work, pos, sharing, have: stage.modelId || cachedId,
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
      stopped = d.reason === 'kicked';
      teardown();
      stage.clearVRM(); hasModel = false;
      stage.props.sync([]);
      if (d.reason === 'kicked') status('bad', 'The broadcaster disconnected you.', { retry: true });
      else if (d.reason === 'full') {
        roomFullUntil = performance.now() + 10000; // the channel closing right after must not override this
        status('warn', `This room is full (${Number(d.max) || '?'} viewers max) — you'll join as soon as a spot frees up…`);
        stopped = false; scheduleRetry(10000);
      }
      else { status('warn', 'Broadcast ended — waiting for it to start again…'); stopped = false; scheduleRetry(4000); }
      return;
    case 'view': {
      const v = stage.setView(d);
      store.set('vt-view', v);
      return;
    }
    case 'props':
      if (Array.isArray(d.list)) stage.props.sync(d.list.slice(0, 64));
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
      if (MODE === 'screen') applyPos({ x: +d.x, y: +d.y, s: +d.s });
      return;
    case 'model-use': {
      if (stage.modelId === d.id) return;
      const rec = await cacheGet();
      if (rec?.id === d.id && rec.buf) { await showModel(rec.buf, rec.id); return; }
      model?.send({ t: 'need-model' });
      return;
    }
    case 'model-begin':
      incoming = { id: d.id, size: d.size, chunks: d.chunks, parts: new Array(d.chunks), got: 0 };
      $('bar').hidden = false;
      status('warn', 'Receiving avatar…');
      return;
    case 'model-chunk':
      if (!incoming || d.id !== incoming.id) return;
      if (!incoming.parts[d.i]) { incoming.parts[d.i] = toBuffer(d.data); incoming.got++; }
      $('bar').firstElementChild.style.width = (100 * incoming.got / incoming.chunks).toFixed(1) + '%';
      return;
    case 'model-end': {
      if (!incoming || d.id !== incoming.id) return;
      const { parts, size, id } = incoming;
      incoming = null;
      $('bar').hidden = true;
      if (parts.some((p) => !p)) { status('bad', 'Avatar transfer was incomplete. Reconnecting…'); scheduleRetry(1000); return; }
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
  screenCall = peer.call(target, screenStream, { metadata: { kind: 'screen' } });
  screenCall.on('close', () => { screenCall = null; });
  screenCall.on('error', () => { screenCall = null; });
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

connect();
