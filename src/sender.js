// Sender: webcam -> MediaPipe tracking -> motion frames -> WebRTC to every viewer.
// The webcam image never leaves this page; only numbers are sent.
import * as THREE from 'three';
import { FaceLandmarker, PoseLandmarker, HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { AvatarStage } from './shared/avatar.js';
import {
  ARKIT, PEER_PREFIX, HOTKEY_EXPRESSIONS, MODEL_CHUNK, DEFAULT_POS, DEFAULT_VIEW, AVATAR_ASPECT, effectiveZone,
  HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, MOTION_MAX_BUFFERED, peerOptions,
} from './shared/protocol.js';
import { buildArmPayload } from './shared/arms.js';
import { OneEuroArray } from './shared/filters.js';
import { PROP_ATTACH } from './shared/props.js';

const $ = (id) => document.getElementById(id);
const MODEL_URLS = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};
const SEND_INTERVAL_MS = 33; // ~30 Hz

// ---------------- settings ----------------
const settings = loadSettings();
function loadSettings() {
  const defaults = { v: 2, mirror: true, swapLR: true, hideCam: false, autoExpr: true, arms: false, linkEyes: false, smoothing: 0.5, mouthGain: 1.6, blinkGain: 1.5, bodyX: 1, bodyY: 1, bodyZ: 0.5, exprTune: {}, maxViewers: 0, camId: '' };
  try {
    const saved = JSON.parse(localStorage.getItem('vt-settings') || '{}');
    if (!saved.v) delete saved.mirror; // v1 defaulted mirror off, which felt backwards
    return { ...defaults, ...saved, v: 2 };
  } catch { return defaults; }
}
function saveSettings() { try { localStorage.setItem('vt-settings', JSON.stringify(settings)); } catch {} }
const applyToggles = () => {
  document.body.classList.toggle('camHidden', settings.hideCam);
  $('armsHint').hidden = !settings.arms;
  if (settings.arms) initBodyTrackers();
};
for (const k of ['mirror', 'swapLR', 'hideCam', 'autoExpr', 'arms', 'linkEyes']) {
  $(k).checked = settings[k];
  $(k).onchange = () => { settings[k] = $(k).checked; saveSettings(); applyToggles(); };
}
for (const k of ['mouthGain', 'blinkGain', 'smoothing', 'bodyX', 'bodyY', 'bodyZ']) {
  $(k).value = settings[k];
  $(k).oninput = () => { settings[k] = parseFloat($(k).value); saveSettings(); if (k === 'smoothing') tuneFilters(); };
}

// ---------------- avatar preview + view controls (viewers see the same framing) ----------------
const stage = new AvatarStage($('stage'));
let view = stage.setView(loadJSON('vt-view', DEFAULT_VIEW));
function loadJSON(k, d) { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch { return { ...d }; } }

let viewSendTimer = null;
function updateView(patch) {
  view = stage.setView({ ...view, ...patch });
  $('frBtn').textContent = 'Framing: ' + (view.fr === 'full' ? 'Full body' : 'Bust');
  try { localStorage.setItem('vt-view', JSON.stringify(view)); } catch {}
  if (!viewSendTimer) viewSendTimer = setTimeout(() => { viewSendTimer = null; broadcastControl({ t: 'view', ...view }); }, 50);
}
updateView({});
$('frBtn').onclick = () => updateView({ fr: view.fr === 'full' ? 'bust' : 'full', px: 0, py: 0 });
$('resetView').onclick = () => updateView({ ...DEFAULT_VIEW, fr: view.fr });

const canvas = $('stage');
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY || e.deltaX; // Shift+wheel arrives as horizontal scroll on Windows
  const hit = stage.props.pick(rayAt(e));
  if (hit) { // scroll on a prop: resize it (Shift: rotate it)
    selectProp(hit.id);
    const d = props.find((p) => p.id === hit.id);
    if (e.shiftKey) updateProp(hit.id, { rot: d.rot + (delta < 0 ? 1 : -1) * Math.PI / 36 });
    else updateProp(hit.id, { size: Math.max(0.02, Math.min(4, d.size * (delta < 0 ? 1.08 : 1 / 1.08))) });
    return;
  }
  updateView({ zoom: view.zoom * (delta < 0 ? 1.08 : 1 / 1.08) });
}, { passive: false });
let viewDrag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 1 && e.button !== 2) return; // middle = move, right = rotate
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  viewDrag = { mode: e.button === 1 ? 'pan' : 'rot', x: e.clientX, y: e.clientY, start: { ...view } };
  canvas.style.cursor = viewDrag.mode === 'pan' ? 'move' : 'ew-resize';
});
canvas.addEventListener('pointermove', (e) => {
  if (!viewDrag) return;
  const dx = e.clientX - viewDrag.x, dy = e.clientY - viewDrag.y, H = canvas.clientHeight || 1;
  if (viewDrag.mode === 'pan') updateView({ px: viewDrag.start.px + dx / H, py: viewDrag.start.py - dy / H });
  else updateView({ yaw: viewDrag.start.yaw + dx * 0.01, el: viewDrag.start.el + dy * 0.005 });
});
const endViewDrag = () => { viewDrag = null; canvas.style.cursor = ''; };
canvas.addEventListener('pointerup', endViewDrag);
canvas.addEventListener('pointercancel', endViewDrag);
canvas.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); }); // no autoscroll

// ---------------- model ----------------
let modelBuf = null, modelName = '', modelId = null;

async function hashId(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return [...d.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function useModel(buf, name) {
  try {
    const id = await hashId(buf);
    const info = await stage.loadVRM(buf.slice(0), id);
    modelBuf = buf; modelName = name; modelId = id;
    $('empty').hidden = true;
    $('modelName').textContent = name;
    $('modelName').classList.remove('muted');
    $('syncBadge').hidden = !info.perfectSync;
    buildExpressionButtons(info.expressions);
    storeLastModel(buf, name);
    for (const v of viewers.values()) if (v.model?.open) offerModel(v);
    renderPlacement();
  } catch (err) {
    alert('Could not load this model:\n' + err.message);
  }
}

$('load').onclick = () => $('file').click();
$('file').onchange = async () => {
  const f = $('file').files[0];
  if (f) useModel(await f.arrayBuffer(), f.name.replace(/\.vrm$/i, ''));
  $('file').value = '';
};
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', async (e) => {
  e.preventDefault();
  const f = [...e.dataTransfer.files].find((x) => /\.vrm$/i.test(x.name));
  if (f) useModel(await f.arrayBuffer(), f.name.replace(/\.vrm$/i, ''));
});

// remember the last model between launches (IndexedDB)
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('vtoverlay', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function storeLastModel(buf, name) {
  try { const db = await idb(); db.transaction('kv', 'readwrite').objectStore('kv').put({ buf, name }, 'lastModel'); } catch {}
}
async function restoreLastModel() {
  try {
    const db = await idb();
    const rec = await new Promise((res) => { const r = db.transaction('kv').objectStore('kv').get('lastModel'); r.onsuccess = () => res(r.result); r.onerror = () => res(null); });
    if (rec?.buf) await useModel(rec.buf, rec.name);
  } catch {}
}
restoreLastModel();

// ---------------- custom hotkeys (global: they work while another app has focus) ----------------
// Bindings: { 'expr:<name>' | 'clear' | 'pause' | 'prop:<id>': accel } — accel in Electron syntax, e.g. "Ctrl+Alt+H".
// There are no default hotkeys: only the ones you set.
let hotkeys = (() => { try { return JSON.parse(localStorage.getItem('vt-hotkeys') || '{}') || {}; } catch { return {}; } })();
let hotkeyStatus = {}; // id -> registered OK?
const saveHotkeys = () => { try { localStorage.setItem('vt-hotkeys', JSON.stringify(hotkeys)); } catch {} };
const prettyAccel = (a) => a.replace(/\bnum(\d)\b/, 'Numpad $1').replace(/\bnum(add|sub|mult|div|dec)\b/, (_, k) => 'Numpad ' + { add: '+', sub: '−', mult: '×', div: '÷', dec: '.' }[k]).replace(/\+/g, ' + ');

let applyTimer = null;
function applyHotkeys() { clearTimeout(applyTimer); applyTimer = setTimeout(applyHotkeysNow, 30); }
async function applyHotkeysNow() {
  const list = [];
  for (const [id, accel] of Object.entries(hotkeys)) {
    const live = id === 'pause' || id === 'clear' || (id.startsWith('expr:') ? exprList.includes(id.slice(5)) : props.some((p) => 'prop:' + p.id === id));
    if (live) list.push({ accel, id });
  }
  hotkeyStatus = await window.vt.setHotkeys(list);
  refreshHotkeyBadges();
}
function refreshHotkeyBadges() {
  const pa = hotkeys.pause;
  $('pauseHk').textContent = pa ? '⌨ ' + prettyAccel(pa) : '⌨';
  $('pauseHk').classList.toggle('bad', hotkeyStatus.pause === false);
  if (activeExpr) { const a = hotkeys['expr:' + activeExpr]; $('tuneHk').textContent = a ? '⌨ ' + prettyAccel(a) : '⌨ Hotkey'; }
  document.querySelectorAll('#xrow [data-expr], #xrow [data-clear]').forEach((b) => {
    b.querySelector('small')?.remove();
    const id = b.dataset.clear ? 'clear' : 'expr:' + b.dataset.expr, accel = hotkeys[id];
    if (accel) b.insertAdjacentHTML('beforeend', `<small class="${hotkeyStatus[id] === false ? 'bad' : ''}" title="${hotkeyStatus[id] === false ? 'Another app already uses this combination' : ''}">${prettyAccel(accel)}</small>`);
  });
  document.querySelectorAll('#propList .prop').forEach((row) => {
    const id = 'prop:' + row.dataset.id, accel = hotkeys[id], hk = row.querySelector('[data-a=hk]');
    hk.textContent = accel ? '⌨ ' + prettyAccel(accel) : '⌨ Hotkey';
    hk.classList.toggle('bad', hotkeyStatus[id] === false);
    hk.title = hotkeyStatus[id] === false ? 'Another app already uses this combination' : 'Click to set a hotkey that shows/hides this prop';
  });
}
window.vt.onHotkey((id) => {
  if (id === 'pause') return setPaused(!paused);
  if (id === 'clear') return setExpr(null);
  if (id.startsWith('expr:')) return toggleExpr(id.slice(5));
  if (id.startsWith('prop:')) { const p = props.find((x) => x.id === id.slice(5)); if (p) updateProp(p.id, { visible: !p.visible }); }
});

// key capture → accelerator. Letters follow your keyboard layout (AZERTY "A" is A);
// digits/F-keys/numpad use the physical key, so they work on every layout.
let layoutMap = null;
navigator.keyboard?.getLayoutMap?.().then((m) => { layoutMap = m; }).catch(() => {});
const NAMED_KEYS = {
  ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Space: 'Space', Tab: 'Tab', Enter: 'Enter',
  NumpadEnter: 'Enter', Insert: 'Insert', Delete: 'Delete', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
  NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv', NumpadDecimal: 'numdec',
  Pause: 'Pause', ScrollLock: 'Scrolllock',
};
function keyFromEvent(e) {
  let m;
  if ((m = /^Key([A-Z])$/.exec(e.code))) { const l = layoutMap?.get(e.code); return l && /^[a-z]$/i.test(l) ? l.toUpperCase() : m[1]; }
  if ((m = /^Digit(\d)$/.exec(e.code))) return m[1];
  if ((m = /^Numpad(\d)$/.exec(e.code))) return 'num' + m[1];
  if ((m = /^F(\d{1,2})$/.exec(e.code))) return 'F' + m[1];
  return NAMED_KEYS[e.code] || null;
}
function captureHotkey(title, current) {
  return new Promise((resolve) => {
    $('hkTitle').textContent = title;
    $('hkCombo').textContent = current ? prettyAccel(current) : '…';
    $('hkMsg').textContent = '';
    $('hkModal').hidden = false;
    const done = (v) => { removeEventListener('keydown', onKey, true); removeEventListener('keyup', onUp, true); $('hkModal').hidden = true; resolve(v); };
    const mods = (e) => [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Super'].filter(Boolean);
    const onUp = (e) => { e.preventDefault(); e.stopPropagation(); };
    const onKey = (e) => {
      e.preventDefault(); e.stopPropagation();
      const m = mods(e);
      if (['Control', 'Alt', 'Shift', 'Meta', 'AltGraph'].includes(e.key)) { $('hkCombo').textContent = m.join(' + ') + ' + …'; return; }
      if (e.code === 'Escape' && !m.length) return done(null);
      if (e.code === 'Backspace' && !m.length) return done('');
      const key = keyFromEvent(e);
      if (!key) { $('hkMsg').textContent = 'That key can’t be used — try a letter, digit, F-key, numpad key or arrow.'; return; }
      const special = /^(F\d+|num\w+|Pause|Scrolllock)$/.test(key);
      if (!special && !m.some((x) => x !== 'Shift')) {
        $('hkMsg').textContent = 'Add Ctrl or Alt — on its own (or with just Shift) this key would stop typing everywhere else.';
        $('hkCombo').textContent = [...m, key].join(' + ');
        return;
      }
      done([...m, key].join('+'));
    };
    addEventListener('keydown', onKey, true);
    addEventListener('keyup', onUp, true);
    $('hkCancel').onclick = () => done(null);
    $('hkClear').onclick = () => done('');
  });
}
async function bindHotkey(id, title) {
  await window.vt.setHotkeys([]); // our own global hotkeys would swallow the keys while capturing
  const accel = await captureHotkey(title, hotkeys[id]);
  if (accel === '') delete hotkeys[id];
  else if (accel) {
    for (const [other, a] of Object.entries(hotkeys)) if (a === accel && other !== id) delete hotkeys[other]; // one action per combo
    hotkeys[id] = accel;
  }
  saveHotkeys();
  await applyHotkeysNow();
}

// ---------------- expressions (whatever the loaded model offers) ----------------
// Click to toggle; right-click to give one your own (global) hotkey.
let activeExpr = null;
let exprList = [];
const prettyExpr = (n) => n.replace(/^Fcl_/, '').replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').trim();

function buildExpressionButtons(list) {
  const changed = list.join('|') !== exprList.join('|');
  exprList = list;
  if (changed) applyHotkeys();
  if (activeExpr && !list.includes(activeExpr)) activeExpr = null;
  const row = $('xrow');
  row.innerHTML = '';
  if (!list.length) { row.innerHTML = '<span class="muted hint">This model has no extra expressions.</span>'; return; }
  list.forEach((name) => {
    const b = document.createElement('button');
    b.className = 'xbtn'; b.dataset.expr = name; b.title = name;
    b.textContent = prettyExpr(name);
    b.onclick = () => toggleExpr(name);
    b.oncontextmenu = (e) => { e.preventDefault(); bindHotkey('expr:' + name, `Hotkey for “${prettyExpr(name)}”`); };
    row.appendChild(b);
  });
  const clr = document.createElement('button');
  clr.className = 'xbtn'; clr.dataset.clear = '1'; clr.textContent = 'neutral'; clr.title = 'Back to your normal face';
  clr.onclick = () => setExpr(null);
  clr.oncontextmenu = (e) => { e.preventDefault(); bindHotkey('clear', 'Hotkey for “neutral” (clears the expression)'); };
  row.appendChild(clr);
  setExpr(activeExpr);
  refreshHotkeyBadges();
}
function setExpr(name) {
  activeExpr = name;
  document.querySelectorAll('#xrow [data-expr]').forEach((b) => b.classList.toggle('on', b.dataset.expr === name));
  showExprTune();
}
const tuneOf = (name) => ({ mouth: 1, blink: 1, ...(settings.exprTune[name] || {}) });
function showExprTune() {
  $('exprTune').hidden = !activeExpr;
  if (!activeExpr) return;
  const t = tuneOf(activeExpr);
  $('tuneName').textContent = prettyExpr(activeExpr);
  $('tuneMouth').value = t.mouth;
  $('tuneBlink').value = t.blink;
  const a = hotkeys['expr:' + activeExpr];
  $('tuneHk').textContent = a ? '⌨ ' + prettyAccel(a) : '⌨ Hotkey';
}
function setTune(patch) {
  if (!activeExpr) return;
  const t = { ...tuneOf(activeExpr), ...patch };
  if (t.mouth === 1 && t.blink === 1) delete settings.exprTune[activeExpr]; else settings.exprTune[activeExpr] = t;
  saveSettings();
}
$('tuneMouth').oninput = () => setTune({ mouth: Number($('tuneMouth').value) });
$('tuneBlink').oninput = () => setTune({ blink: Number($('tuneBlink').value) });
$('tuneReset').onclick = () => { setTune({ mouth: 1, blink: 1 }); showExprTune(); };
$('tuneHk').onclick = () => activeExpr && bindHotkey('expr:' + activeExpr, `Hotkey for “${prettyExpr(activeExpr)}”`);
const toggleExpr = (name) => setExpr(activeExpr === name ? null : name);
buildExpressionButtons([]);

// ---------------- networking (PeerJS / WebRTC) ----------------
const viewers = new Map(); // peerId -> { n, motion, model, state, pos, stream, lastHeard }
let peer = null, viewerCount = 0, stopping = false;

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion
  let s = ''; for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
// keep the same code across restarts so friends can just reconnect
const savedCode = () => { try { return localStorage.getItem('vt-code'); } catch { return null; } };

function setNet(state, text) { $('netDot').className = 'dot ' + state; $('netText').textContent = text; }

let sigTimer = null, sigFailures = 0, idTakenTries = 0;
function startPeer(code = savedCode() || randomCode()) {
  clearTimeout(sigTimer);
  const p = peer = new window.Peer(PEER_PREFIX + code, peerOptions());
  p.on('open', () => {
    if (p !== peer) return;
    sigFailures = 0; idTakenTries = 0;
    try { localStorage.setItem('vt-code', code); } catch {}
    $('code').textContent = code;
    updateViewers();
    if (!viewers.size) setNet('ok', 'Online — waiting for viewers');
  });
  p.on('connection', (conn) => {
    const id = conn.peer;
    // optional viewer limit: newcomers beyond it are told the room is full (they retry by themselves)
    if (!viewers.has(id) && settings.maxViewers > 0 && viewers.size >= settings.maxViewers) {
      conn.on('open', () => {
        if (conn.label === 'model') { try { conn.send({ t: 'bye', reason: 'full', max: settings.maxViewers }); } catch {} }
        setTimeout(() => conn.close(), 500);
      });
      return;
    }
    let v = viewers.get(id);
    if (!v) { v = { n: ++viewerCount, pos: { ...DEFAULT_POS }, lastHeard: performance.now() }; viewers.set(id, v); }
    if (conn.label === 'model') {
      v.model = conn;
      v.hello = false;
      conn.on('data', (d) => onViewerMessage(id, v, d));
      conn.on('open', () => {
        // old viewers never say hello: fall back to just sending the model
        setTimeout(() => { if (!v.hello && v.model === conn && conn.open) sendModel(conn); }, 3000);
      });
    } else {
      v.motion = conn;
      conn.on('data', () => { v.lastHeard = performance.now(); });
    }
    conn.on('open', updateViewers);
    conn.on('close', () => {
      if (v.model === conn) v.model = null;
      if (v.motion === conn) v.motion = null;
      if (!v.model && !v.motion) dropViewer(id);
      updateViewers();
    });
    conn.on('error', () => conn.close());
  });
  // optional screen preview from a viewer (they opt in on their side)
  p.on('call', (call) => {
    const v = viewers.get(call.peer);
    if (!v || call.metadata?.kind !== 'screen') { call.close(); return; }
    v.call?.close();
    v.call = call;
    call.answer(); // receive only — we never send anything back on this call
    call.on('stream', (stream) => { v.stream = stream; renderPlacement(); });
    const end = () => { if (v.call === call) { v.call = null; v.stream = null; renderPlacement(); } };
    call.on('close', end); call.on('error', end);
  });
  // Losing the signalling server does NOT end the broadcast: viewers stay connected peer-to-peer.
  // We only need it back so new viewers (or reconnecting ones) can find us, under the SAME code.
  const retrySignalling = () => {
    clearTimeout(sigTimer);
    const delay = Math.min(10000, 1500 * 2 ** Math.min(sigFailures++, 3)); // 1.5 s … 10 s
    sigTimer = setTimeout(() => {
      if (p !== peer || stopping) return;
      if (p.destroyed) startPeer(code);            // never registered: start over, same code
      else if (p.disconnected) { try { p.reconnect(); } catch {} }
    }, delay);
  };
  p.on('disconnected', () => {
    if (p !== peer || stopping || p.destroyed) return;
    setNet('warn', viewers.size ? 'Streaming — reconnecting to the signalling server…' : 'Reconnecting…');
    retrySignalling();
  });
  p.on('error', (err) => {
    if (p !== peer || stopping) return;
    if (err.type === 'peer-unavailable') return;
    console.warn('peer error', err.type, err.message);
    if (err.type === 'unavailable-id') {
      // Usually our own previous registration that the server hasn't timed out yet: wait and retry
      // the same code. Only a code that stays taken on a fresh start (≈1.5 min) is replaced.
      if (p.destroyed && !viewers.size && ++idTakenTries > 8) {
        idTakenTries = 0;
        try { localStorage.removeItem('vt-code'); } catch {}
        setNet('warn', `Code ${code} is used by someone else — getting a new one…`);
        startPeer(randomCode());
        return;
      }
      setNet('warn', `Code ${code} is still registered from before — retrying…`);
      retrySignalling();
      return;
    }
    if (!viewers.size) setNet('bad', 'Signalling server unreachable — retrying…');
    if (p.destroyed || p.disconnected) retrySignalling();
  });
}
startPeer();

function dropViewer(id) {
  const v = viewers.get(id);
  if (!v) return;
  viewers.delete(id);
  try { v.call?.close(); v.model?.close(); v.motion?.close(); } catch {}
  updateViewers();
}

// heartbeat both ways: ping viewers, drop the ones that went silent
setInterval(() => {
  const now = performance.now();
  for (const [id, v] of viewers) {
    if (v.model?.open) { try { v.model.send({ t: 'hb' }); } catch {} }
    if (now - v.lastHeard > HEARTBEAT_TIMEOUT_MS) dropViewer(id);
  }
}, HEARTBEAT_MS);

function broadcastControl(msg) {
  for (const v of viewers.values()) if (v.model?.open) { try { v.model.send(msg); } catch {} }
}

async function sayBye(reason) {
  stopping = true;
  broadcastControl({ t: 'bye', reason });
  await new Promise((r) => setTimeout(r, 150)); // let it flush
  for (const id of [...viewers.keys()]) dropViewer(id);
  try { peer?.destroy(); } catch {}
}
$('stop').onclick = async () => {
  await sayBye('ended');
  stream?.getTracks().forEach((t) => t.stop());
  window.vt.backToMenu();
};
$('newCode').onclick = async () => {
  if (viewers.size && !confirm('Viewers on the current code will be disconnected. Continue?')) return;
  await sayBye('ended');
  stopping = false;
  sigFailures = 0; idTakenTries = 0;
  try { localStorage.removeItem('vt-code'); } catch {}
  $('code').textContent = '······';
  setNet('warn', 'Getting a new code…');
  startPeer(randomCode());
};
window.vt.onAppClosing(async () => { await sayBye('ended'); window.vt.goodbyeSent(); });

const MODE_LABEL = { floating: 'floating widget', window: 'window', screen: 'full screen' };
const viewerLabel = (v) => v.state?.name || `Viewer ${v.n}`;

$('maxViewers').value = String(settings.maxViewers || 0);
$('maxViewers').onchange = () => { settings.maxViewers = Number($('maxViewers').value) || 0; saveSettings(); updateViewers(); };

function updateViewers() {
  const live = [...viewers.entries()].filter(([, v]) => v.motion?.open || v.model?.open);
  $('viewerCount').textContent = settings.maxViewers ? `(${live.length} / ${settings.maxViewers})` : live.length ? `(${live.length})` : '';
  const box = $('viewers');
  box.classList.toggle('muted', !live.length);
  if (!live.length) box.textContent = 'Nobody yet — share the code.';
  else {
    box.innerHTML = '';
    for (const [id, v] of live) {
      const row = document.createElement('div');
      row.className = 'vrow';
      const extra = v.state ? ` — ${MODE_LABEL[v.state.mode] || v.state.mode}${v.state.sharing ? ', sharing screen' : ''}` : '';
      const label = document.createElement('span');
      label.textContent = viewerLabel(v) + extra;
      const kick = document.createElement('button');
      kick.textContent = '✕'; kick.title = 'Disconnect this viewer';
      kick.onclick = async () => {
        try { v.model?.send({ t: 'bye', reason: 'kicked' }); } catch {}
        await new Promise((r) => setTimeout(r, 150));
        dropViewer(id);
      };
      row.append(label, kick);
      box.appendChild(row);
    }
  }
  if (peer?.open) setNet('ok', live.length ? 'Online — streaming' : 'Online — waiting for viewers');
  refreshViewerSelect();
}

function offerModel(v) {
  if (!modelBuf || !v.model?.open) return;
  if (v.state?.have && v.state.have === modelId) v.model.send({ t: 'model-use', id: modelId });
  else sendModel(v.model);
}

function onViewerMessage(id, v, d) {
  v.lastHeard = performance.now();
  if (!d || typeof d !== 'object') return;
  if (d.t === 'bye') { dropViewer(id); return; }
  if (d.t === 'need-model') { if (v.model?.open) sendModel(v.model); return; }
  if (d.t === 'need-prop') { if (v.model?.open) sendPropImage(v.model, String(d.hash)); return; }
  if (d.t !== 'viewer') return;
  const first = !v.hello;
  v.hello = true;
  v.state = {
    name: String(d.name || '').slice(0, 24), mode: d.mode, aspect: Number(d.aspect) || 16 / 9,
    zone: d.zone || { x: 0, y: 0, w: 1, h: 1 }, work: d.work || { x: 0, y: 0, w: 1, h: 1 }, sharing: !!d.sharing, have: d.have || null,
  };
  if (d.pos && !v.dragging) v.pos = { ...DEFAULT_POS, ...d.pos };
  if (first) {
    v.model.send({ t: 'props', list: publicProps() });
    v.model.send({ t: 'view', ...view });
    offerModel(v);
  }
  updateViewers();
  renderPlacement();
}

// send a big binary in chunks with back-pressure: kind-begin / kind-chunk / kind-end
async function sendChunked(conn, kind, meta, buf, stillWanted = () => true) {
  const chunks = Math.ceil(buf.byteLength / MODEL_CHUNK);
  conn.send({ t: kind + '-begin', ...meta, size: buf.byteLength, chunks });
  for (let i = 0; i < chunks; i++) {
    if (!conn.open || !stillWanted()) return false;
    while (conn.dataChannel && conn.dataChannel.bufferedAmount > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 30));
    conn.send({ t: kind + '-chunk', ...meta, i, data: buf.slice(i * MODEL_CHUNK, (i + 1) * MODEL_CHUNK) });
    if (i % 16 === 15) await new Promise((r) => setTimeout(r, 0));
  }
  conn.send({ t: kind + '-end', ...meta });
  return true;
}

async function sendPropImage(conn, hash) {
  const blob = await getPropImage(hash);
  if (!blob) return;
  await sendChunked(conn, 'prop', { hash, mime: blob.type }, await blob.arrayBuffer());
}

async function sendModel(conn) {
  if (!modelBuf) return;
  const id = modelId, buf = modelBuf;
  const chunks = Math.ceil(buf.byteLength / MODEL_CHUNK);
  conn.send({ t: 'model-begin', id, size: buf.byteLength, chunks }); // no file name: viewers don't need it
  for (let i = 0; i < chunks; i++) {
    if (!conn.open || id !== modelId) return; // closed or replaced by a newer model
    // back-pressure: don't flood the data channel buffer
    while (conn.dataChannel && conn.dataChannel.bufferedAmount > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 30));
    conn.send({ t: 'model-chunk', id, i, data: buf.slice(i * MODEL_CHUNK, (i + 1) * MODEL_CHUNK) });
    if (i % 16 === 15) await new Promise((r) => setTimeout(r, 0));
  }
  conn.send({ t: 'model-end', id });
}

$('copy').onclick = () => { window.vt.copyText($('code').textContent); $('copy').textContent = 'Copied'; setTimeout(() => ($('copy').textContent = 'Copy'), 1200); };

// ---------------- placement on the viewer's screen ----------------
let selectedViewer = null;
document.querySelectorAll('#tabs button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  const placing = b.dataset.tab === 'place';
  document.body.classList.toggle('placing', placing);
  $('placeView').hidden = !placing;
  renderPlacement();
}));

function refreshViewerSelect() {
  const live = [...viewers.entries()].filter(([, v]) => v.motion?.open || v.model?.open);
  if (!live.some(([id]) => id === selectedViewer)) {
    const scr = live.find(([, v]) => v.state?.mode === 'screen');
    selectedViewer = (scr || live[0] || [null])[0];
  }
  $('viewerSel').innerHTML = live.map(([id, v]) => `<option value="${id}">${viewerLabel(v).replace(/</g, '&lt;')}</option>`).join('')
    || '<option value="">No viewers</option>';
  if (selectedViewer) $('viewerSel').value = selectedViewer;
  renderPlacement();
}
$('viewerSel').onchange = () => { selectedViewer = $('viewerSel').value; renderPlacement(); };

function zoneRectPx() {
  const zb = $('zoneBox');
  return { w: zb.clientWidth || 1, h: zb.clientHeight || 1 };
}

function clampPos(p, zp) {
  const s = Math.max(0.08, Math.min(1, p.s));
  const boxH = s * zp.h, boxW = boxH * AVATAR_ASPECT;
  const halfW = Math.min(0.5, boxW / 2 / zp.w);
  return { ...p, s, x: Math.max(halfW, Math.min(1 - halfW, p.x)), y: Math.max(Math.min(1, boxH / zp.h), Math.min(1, p.y)) };
}

function renderPlacement() {
  if ($('placeView').hidden) return;
  const v = viewers.get(selectedViewer);
  const msg = $('placeMsg');
  const show = (text) => { msg.hidden = false; msg.innerHTML = text; $('screenArea').hidden = true; $('placeBar').hidden = !v; };
  if (!v) return show('Nobody is watching yet. Once a friend joins in <b>Full screen</b> mode you can place your avatar on their screen here.');
  if (!v.state) return show('Waiting for this viewer’s screen info…');
  if (v.state.mode !== 'screen') {
    return show(`<b>${viewerLabel(v).replace(/</g, '&lt;')}</b> is using the ${MODE_LABEL[v.state.mode] || v.state.mode} mode, so the avatar sits in their own window.<br>Framing, zoom and rotation from the <b>My avatar</b> tab still apply.<br>They can switch to <b>Full screen</b> any time from their tray icon.`);
  }
  msg.hidden = true; $('screenArea').hidden = false; $('placeBar').hidden = false;

  // fit the viewer's monitor into the available area
  const area = $('screenArea'), ar = v.state.aspect;
  let w = area.clientWidth, h = w / ar;
  if (h > area.clientHeight) { h = area.clientHeight; w = h * ar; }
  const sb = $('screenBox').style;
  sb.width = w + 'px'; sb.height = h + 'px';
  sb.left = (area.clientWidth - w) / 2 + 'px'; sb.top = (area.clientHeight - h) / 2 + 'px';

  // the taskbar (whatever the work area leaves out) is drawn as a strip; the avatar stays out of it
  const wk = v.state.work;
  const bars = [
    wk.y > 0.005 && { left: 0, top: 0, width: 100, height: wk.y * 100 },
    wk.y + wk.h < 0.995 && { left: 0, top: (wk.y + wk.h) * 100, width: 100, height: (1 - wk.y - wk.h) * 100 },
    wk.x > 0.005 && { left: 0, top: 0, width: wk.x * 100, height: 100 },
    wk.x + wk.w < 0.995 && { left: (wk.x + wk.w) * 100, top: 0, width: (1 - wk.x - wk.w) * 100, height: 100 },
  ].filter(Boolean);
  document.querySelectorAll('#screenBox .taskbar').forEach((el) => el.remove());
  for (const b of bars) {
    const el = document.createElement('div');
    el.className = 'taskbar';
    el.textContent = 'taskbar';
    Object.assign(el.style, { left: b.left + '%', top: b.top + '%', width: b.width + '%', height: b.height + '%' });
    $('screenBox').insertBefore(el, $('zoneBox'));
  }
  const z = effectiveZone(v.state.zone, wk), zb = $('zoneBox').style;
  zb.left = z.x * 100 + '%'; zb.top = z.y * 100 + '%'; zb.width = z.w * 100 + '%'; zb.height = z.h * 100 + '%';

  const vid = $('screenVid');
  if (vid.srcObject !== (v.stream || null)) vid.srcObject = v.stream || null;
  $('noVideo').hidden = !!v.stream;
  $('noVideo').innerHTML = v.state.sharing ? 'Connecting to screen preview…'
    : 'Screen preview is off.<br>Your friend can turn it on from their tray icon — until then you\'re placing the avatar on a blank outline of their monitor.';

  const zp = zoneRectPx();
  const p = clampPos(v.pos, zp);
  const boxH = p.s * zp.h, boxW = boxH * AVATAR_ASPECT;
  const ab = $('avBox').style;
  ab.left = p.x * zp.w - boxW / 2 + 'px'; ab.top = p.y * zp.h - boxH + 'px';
  ab.width = boxW + 'px'; ab.height = boxH + 'px';
  $('avName').textContent = modelName || 'Avatar';
}
new ResizeObserver(() => renderPlacement()).observe($('stageWrap'));

let lastPosSend = 0, posSendTimer = null;
function sendPos(v, force = false) {
  const now = performance.now();
  clearTimeout(posSendTimer);
  if (!force && now - lastPosSend < 50) { posSendTimer = setTimeout(() => sendPos(v, true), 50); return; }
  lastPosSend = now;
  if (v.model?.open) v.model.send({ t: 'pos', x: v.pos.x, y: v.pos.y, s: v.pos.s });
}

function updatePos(v, patch) {
  v.pos = clampPos({ ...v.pos, ...patch }, zoneRectPx());
  renderPlacement();
  sendPos(v);
}

// drag to move, drag the dot to resize
let drag = null;
$('avBox').addEventListener('pointerdown', (e) => {
  const v = viewers.get(selectedViewer);
  if (!v || e.button !== 0) return;
  e.preventDefault();
  $('avBox').setPointerCapture(e.pointerId);
  drag = { v, resize: e.target.id === 'avHandle', x: e.clientX, y: e.clientY, start: { ...v.pos } };
  v.dragging = true;
  $('avBox').classList.add('dragging');
});
$('avBox').addEventListener('pointermove', (e) => {
  if (!drag) return;
  const zp = zoneRectPx(), dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  if (drag.resize) updatePos(drag.v, { s: drag.start.s + Math.max(-dy / zp.h, dx / zp.h / AVATAR_ASPECT * 2) });
  else updatePos(drag.v, { x: drag.start.x + dx / zp.w, y: drag.start.y + dy / zp.h });
});
const endDrag = () => { if (!drag) return; drag.v.dragging = false; sendPos(drag.v, true); drag = null; $('avBox').classList.remove('dragging'); };
$('avBox').addEventListener('pointerup', endDrag);
$('avBox').addEventListener('pointercancel', endDrag);
$('screenArea').addEventListener('wheel', (e) => {
  const v = viewers.get(selectedViewer);
  if (!v) return;
  e.preventDefault();
  updatePos(v, { s: v.pos.s * (e.deltaY < 0 ? 1.06 : 1 / 1.06) });
}, { passive: false });
$('resetPos').onclick = () => { const v = viewers.get(selectedViewer); if (v) updatePos(v, { ...DEFAULT_POS }); };

// ---------------- props (2D images in the scene or on the model) ----------------
// Defs are what viewers receive (see shared/props.js). File names stay on this computer.
let props = [];
let propLabels = {};
let selectedProp = null;
const propImgs = new Map(); // hash -> Blob
const propThumbs = new Map(); // hash -> object URL

function idbOp(mode, fn) {
  return idb().then((db) => new Promise((res) => {
    const tx = db.transaction('kv', mode); const r = fn(tx.objectStore('kv'));
    r.onsuccess = () => res(r.result ?? null); r.onerror = () => res(null);
  })).catch(() => null);
}
const idbGet = (k) => idbOp('readonly', (st) => st.get(k));
const idbPut = (k, v) => idbOp('readwrite', (st) => st.put(v, k));
const idbDel = (k) => idbOp('readwrite', (st) => st.delete(k));

async function getPropImage(hash) {
  if (propImgs.has(hash)) return propImgs.get(hash);
  const blob = await idbGet('pimg:' + hash);
  if (blob) propImgs.set(hash, blob);
  return blob;
}
stage.props.setLoader(getPropImage);

const publicProps = () => props.map(({ id, img, attach, pos, rot, size, face, flip, visible }) => ({ id, img, attach, pos, rot, size, face, flip, visible }));

let propPersistTimer = null, propSendTimer = null;
function commitProps({ rebuild = true } = {}) {
  stage.props.sync(props);
  stage.props.setSelected(selectedProp);
  if (rebuild) renderPropList(); else syncPropInputs();
  clearTimeout(propPersistTimer);
  propPersistTimer = setTimeout(() => idbPut('props', { list: props, labels: propLabels }), 300);
  if (!propSendTimer) propSendTimer = setTimeout(() => { propSendTimer = null; broadcastControl({ t: 'props', list: publicProps() }); }, 50);
}

function updateProp(id, patch, opts = { rebuild: false }) {
  const d = props.find((p) => p.id === id);
  if (!d) return;
  Object.assign(d, patch);
  commitProps(opts);
}

function selectProp(id) {
  if (selectedProp === id) return;
  selectedProp = id;
  stage.props.setSelected(id);
  document.querySelectorAll('#propList .prop').forEach((r) => r.classList.toggle('sel', r.dataset.id === id));
}

async function addPropFile(file) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return;
  if (file.size > 20 * 1024 * 1024) { alert(`${file.name} is over 20 MB — please use a smaller image.`); return; }
  const buf = await file.arrayBuffer();
  const hash = await hashId(buf);
  const blob = new Blob([buf], { type: file.type });
  propImgs.set(hash, blob);
  idbPut('pimg:' + hash, blob);
  const id = Math.random().toString(36).slice(2, 10);
  // start inside the current shot: a bit right of centre, just in front of the avatar, sized to the framing
  const cam = stage.camera, dir = cam.getWorldDirection(new THREE.Vector3());
  const t = Math.abs(dir.z) > 1e-3 ? (0.1 - cam.position.z) / dir.z : 2;
  const centre = cam.position.clone().addScaledVector(dir, t);
  const vis = stage.visibleHeight();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  const n = props.length % 5;
  const p0 = centre.addScaledVector(right, vis * (0.3 - n * 0.04)).addScaledVector(up, vis * (0.15 - n * 0.06));
  props.push({ id, img: hash, attach: 'scene', pos: p0.toArray().map((v) => +v.toFixed(3)), rot: 0, size: +(vis * 0.22).toFixed(3), face: false, flip: false, visible: true });
  propLabels[id] = file.name.replace(/\.[a-z0-9]+$/i, '');
  selectedProp = id;
  commitProps();
}

async function removeProp(id) {
  const d = props.find((p) => p.id === id);
  props = props.filter((p) => p.id !== id);
  delete propLabels[id];
  if (hotkeys['prop:' + id]) { delete hotkeys['prop:' + id]; saveHotkeys(); }
  if (selectedProp === id) selectedProp = null;
  if (d && !props.some((p) => p.img === d.img)) { propImgs.delete(d.img); idbDel('pimg:' + d.img); }
  commitProps();
  applyHotkeys();
}

$('addProp').onclick = () => $('propFile').click();
$('propFile').onchange = async () => { for (const f of $('propFile').files) await addPropFile(f); $('propFile').value = ''; };
window.addEventListener('drop', async (e) => { for (const f of e.dataTransfer.files) if (f.type.startsWith('image/')) await addPropFile(f); });

const LOG2 = (v) => Math.log2(Math.max(0.02, v));
function renderPropList() {
  const list = $('propList');
  list.innerHTML = '';
  $('propDrop').style.display = props.length ? 'none' : '';
  props.forEach((d, i) => {
    let thumb = propThumbs.get(d.img);
    if (!thumb && propImgs.get(d.img)) { thumb = URL.createObjectURL(propImgs.get(d.img)); propThumbs.set(d.img, thumb); }
    const row = document.createElement('div');
    row.className = 'prop' + (d.id === selectedProp ? ' sel' : '');
    row.dataset.id = d.id;
    row.innerHTML = `
      <div class="top"><img alt="">
        <span class="nm"></span>
        <button data-a="vis" title="Show / hide"></button>
        <button data-a="hk" class="hk"></button>
        <button data-a="del" title="Remove">✕</button></div>
      <div class="more">
        <select data-k="attach">${PROP_ATTACH.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <label class="toggle">Always face the camera <input type="checkbox" data-k="face"></label>
        <label class="toggle">Mirror image <input type="checkbox" data-k="flip"></label>
        <div class="slider"><span>Size</span><input type="range" data-k="size" min="-5" max="2" step="0.01"></div>
        <div class="slider"><span>Rotation</span><input type="range" data-k="rot" min="-180" max="180" step="1"></div>
        <div class="slider"><span>Depth</span><input type="range" data-k="z" min="-1" max="1" step="0.01" title="Toward the camera (right) or behind the avatar (left)"></div>
        <div class="row" style="margin-top:4px"><button data-a="up" ${i === props.length - 1 ? 'disabled' : ''}>Bring forward</button><button data-a="down" ${i === 0 ? 'disabled' : ''}>Send back</button></div>
      </div>`;
    if (thumb) row.querySelector('img').src = thumb;
    else getPropImage(d.img).then((b) => { if (b) { const u = URL.createObjectURL(b); propThumbs.set(d.img, u); row.querySelector('img').src = u; } });
    row.querySelector('.nm').textContent = propLabels[d.id] || 'Prop';
    row.querySelector('.nm').onclick = () => selectProp(selectedProp === d.id ? null : d.id);
    row.querySelector('img').onclick = () => selectProp(d.id);
    row.querySelector('[data-a=vis]').onclick = () => updateProp(d.id, { visible: !d.visible });
    row.querySelector('[data-a=hk]').onclick = () => bindHotkey('prop:' + d.id, `Hotkey to show / hide “${propLabels[d.id] || 'prop'}”`);
    row.querySelector('[data-a=del]').onclick = () => removeProp(d.id);
    row.querySelector('[data-a=up]').onclick = () => { props.splice(i, 1); props.splice(i + 1, 0, d); commitProps(); };
    row.querySelector('[data-a=down]').onclick = () => { props.splice(i, 1); props.splice(i - 1, 0, d); commitProps(); };
    row.querySelector('[data-k=attach]').onchange = (e) => {
      const attach = e.target.value;
      const pos = stage.props.posKeepingPlace(d.id, attach) || (attach === 'scene' ? [0.35, 1.35, 0.1] : [0, 0.1, 0.1]);
      updateProp(d.id, { attach, pos });
    };
    row.querySelector('[data-k=face]').onchange = (e) => updateProp(d.id, { face: e.target.checked });
    row.querySelector('[data-k=flip]').onchange = (e) => updateProp(d.id, { flip: e.target.checked });
    row.querySelector('[data-k=size]').oninput = (e) => updateProp(d.id, { size: 2 ** Number(e.target.value) });
    row.querySelector('[data-k=rot]').oninput = (e) => updateProp(d.id, { rot: -Number(e.target.value) * Math.PI / 180 });
    row.querySelector('[data-k=z]').oninput = (e) => updateProp(d.id, { pos: [d.pos[0], d.pos[1], Number(e.target.value)] });
    list.appendChild(row);
  });
  syncPropInputs();
  refreshHotkeyBadges();
}
function syncPropInputs() {
  document.querySelectorAll('#propList .prop').forEach((row) => {
    const d = props.find((p) => p.id === row.dataset.id);
    if (!d) return;
    row.querySelector('[data-a=vis]').textContent = d.visible ? 'Hide' : 'Show';
    row.style.opacity = d.visible ? '' : '.6';
    const set = (k, v) => { const el = row.querySelector(`[data-k=${k}]`); if (el && document.activeElement !== el) { if (el.type === 'checkbox') el.checked = v; else el.value = v; } };
    set('attach', d.attach); set('face', !!d.face); set('flip', !!d.flip);
    set('size', LOG2(d.size)); set('rot', Math.round(-(d.rot || 0) * 180 / Math.PI)); set('z', d.pos[2]);
  });
}

// editing in the preview: left-drag moves the prop under the cursor (scroll = size, Shift+scroll = rotate)
const raycaster = new THREE.Raycaster(), ndc = new THREE.Vector2();
function rayAt(e) {
  const r = canvas.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, stage.camera);
  return raycaster;
}
let propDrag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const hit = stage.props.pick(rayAt(e));
  if (!hit) { selectProp(null); return; }
  selectProp(hit.id);
  canvas.setPointerCapture(e.pointerId);
  const normal = stage.camera.getWorldDirection(new THREE.Vector3());
  propDrag = { id: hit.id, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point), start: hit.point.clone(), startWorld: stage.props.worldPosition(hit.id) };
  canvas.style.cursor = 'grabbing';
});
canvas.addEventListener('pointermove', (e) => {
  if (propDrag) {
    const p = rayAt(e).ray.intersectPlane(propDrag.plane, new THREE.Vector3());
    if (!p) return;
    const world = propDrag.startWorld.clone().add(p.sub(propDrag.start));
    const pos = stage.props.posForWorld(propDrag.id, world);
    if (pos) updateProp(propDrag.id, { pos });
    return;
  }
  if (!viewDrag) canvas.style.cursor = stage.props.pick(rayAt(e)) ? 'grab' : '';
});
const endPropDrag = () => { if (propDrag) { propDrag = null; canvas.style.cursor = ''; } };
canvas.addEventListener('pointerup', endPropDrag);
canvas.addEventListener('pointercancel', endPropDrag);
window.addEventListener('keydown', (e) => {
  if (!selectedProp || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Delete') removeProp(selectedProp);
});

(async () => {
  const saved = await idbGet('props');
  if (saved?.list?.length) { props = saved.list; propLabels = saved.labels || {}; commitProps(); applyHotkeys(); }
  else renderPropList();
})();

// ---------------- tracking ----------------
const video = $('cam');
let landmarker = null, poseLandmarker = null, handLandmarker = null, fileset = null;
let stream = null;

async function listCameras() {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  $('camSel').innerHTML = devs.map((d, i) => `<option value="${d.deviceId}">${d.label || 'Camera ' + (i + 1)}</option>`).join('');
  if (settings.camId && devs.some((d) => d.deviceId === settings.camId)) $('camSel').value = settings.camId;
}
$('camSel').onchange = () => { settings.camId = $('camSel').value; saveSettings(); openCamera(); };

async function openCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  setTrack('warn', 'Starting camera…');
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: settings.camId ? { exact: settings.camId } : undefined, width: 640, height: 480, frameRate: 30 },
      audio: false,
    });
  } catch (err) {
    setTrack('bad', 'Camera unavailable: ' + err.message); return false;
  }
  video.srcObject = stream;
  await video.play();
  await listCameras();
  return true;
}

async function loadModelBytes(url) {
  // cache the tracking models so later launches work offline
  try {
    const cache = await caches.open('vt-models');
    let res = await cache.match(url);
    if (!res) { res = await fetch(url); if (res.ok) await cache.put(url, res.clone()); }
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return new Uint8Array(await (await fetch(url)).arrayBuffer());
  }
}

async function getFileset() {
  if (!fileset) fileset = await FilesetResolver.forVisionTasks(location.origin + '/node_modules/@mediapipe/tasks-vision/wasm');
  return fileset;
}

async function createTask(Task, url, extra) {
  const fs = await getFileset();
  const bytes = await loadModelBytes(url);
  const opts = (delegate) => ({ baseOptions: { modelAssetBuffer: bytes, delegate }, runningMode: 'VIDEO', ...extra });
  try { return await Task.createFromOptions(fs, opts('GPU')); }
  catch { return await Task.createFromOptions(fs, opts('CPU')); }
}

async function initTracker() {
  setTrack('warn', 'Loading face tracker…');
  landmarker = await createTask(FaceLandmarker, MODEL_URLS.face, {
    numFaces: 1, outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
  });
}

let bodyInit = null;
function initBodyTrackers() {
  if (bodyInit) return bodyInit;
  $('armsHint').textContent = 'Loading arm & hand trackers…';
  bodyInit = (async () => {
    try {
      poseLandmarker = await createTask(PoseLandmarker, MODEL_URLS.pose, { numPoses: 1 });
      handLandmarker = await createTask(HandLandmarker, MODEL_URLS.hand, { numHands: 2 });
      $('armsHint').textContent = 'Keep your shoulders and hands in the camera view. Uses more CPU/GPU.';
    } catch (err) {
      $('armsHint').textContent = 'Arm/hand tracker failed to load: ' + err.message;
      bodyInit = null;
    }
  })();
  return bodyInit;
}

function setTrack(state, text) { $('trackDot').className = 'dot ' + state; $('trackText').textContent = text; }

// ---- calibration ----
// Head: the pose you hold becomes "straight ahead".
// Face: your relaxed face becomes zero for every blendshape, so a resting face doesn't leak
// half-smiles / raised brows / squints (averaged over ~half a second, remembered between launches).
const calib = { qInv: new THREE.Quaternion(), pos: null };
let neutral = loadNeutral();
let neutralAcc = null; // { sum: number[], n } while capturing
let lastRaw = null;
function loadNeutral() {
  try { const a = JSON.parse(localStorage.getItem('vt-face-neutral') || 'null'); return Array.isArray(a) && a.length === ARKIT.length ? a : null; } catch { return null; }
}
$('calib').onclick = () => {
  if (!lastRaw) return;
  calib.qInv.copy(lastRaw.q).invert();
  calib.pos = lastRaw.p.clone();
  neutralAcc = { sum: new Array(ARKIT.length).fill(0), n: 0 };
  $('calib').textContent = 'Hold still…';
};
function finishNeutral() {
  neutral = neutralAcc.sum.map((v) => Math.min(0.6, v / neutralAcc.n)); // cap so nothing gets disabled
  neutralAcc = null;
  try { localStorage.setItem('vt-face-neutral', JSON.stringify(neutral.map((v) => +v.toFixed(3)))); } catch {}
  filters.head.reset(); filters.face.reset();
  $('calib').textContent = 'Calibrated ✓';
  setTimeout(() => ($('calib').textContent = 'Calibrate (look straight, relaxed face)'), 1200);
}

// ---- One-Euro smoothing, tuned by the Smoothing slider (0 = snappy, 1 = very smooth) ----
const filters = { head: new OneEuroArray(7, 1, 0.5), face: new OneEuroArray(ARKIT.length, 4, 1) };
function tuneFilters() {
  const k = settings.smoothing;
  const lerp = (a, b) => a + (b - a) * k;
  filters.head.set(lerp(4, 0.4), 0.6);
  filters.face.set(lerp(9, 1.5), 1.2);
  for (const i of BLINK_IDX) filters.face.setOne(i, lerp(14, 4), 2); // blinks must stay quick
}
let prevQ = null;

const tmpM = new THREE.Matrix4(), tmpS = new THREE.Vector3();
const SWAP = ARKIT.map((n) => {
  const other = n.includes('Left') ? n.replace('Left', 'Right') : n.includes('Right') ? n.replace('Right', 'Left') : n;
  return ARKIT.indexOf(other);
});
const BLINK_IDX = [ARKIT.indexOf('eyeBlinkLeft'), ARKIT.indexOf('eyeBlinkRight')];
const JAW_IDX = ARKIT.indexOf('jawOpen');
const MOUTH_IDX = ARKIT.map((n, i) => (/^(jaw|mouth)/.test(n) || n === 'cheekPuff' ? i : -1)).filter((i) => i >= 0);
let lastVideoTime = -1, lastSend = 0, lastFace = false;
tuneFilters();

function buildFrame(result, nowMs) {
  const face = !!(result.faceBlendshapes?.length && result.facialTransformationMatrixes?.length);
  if (!face) { prevQ = null; filters.head.reset(); filters.face.reset(); return { t: 'm', f: false, x: activeExpr, ae: settings.autoExpr }; }
  const t = nowMs / 1000;

  // --- head pose ---
  tmpM.fromArray(result.facialTransformationMatrixes[0].data);
  const rawQ = new THREE.Quaternion(), rawP = new THREE.Vector3();
  tmpM.decompose(rawP, rawQ, tmpS);
  lastRaw = { q: rawQ.clone(), p: rawP.clone() };
  if (!calib.pos) { calib.pos = rawP.clone(); } // first frame = default centre (rotation stays absolute until calibrated)
  const q = calib.qInv.clone().multiply(rawQ);
  const p = rawP.clone().sub(calib.pos).multiplyScalar(0.01); // cm -> m
  // how much the body follows the head (viewers move the whole avatar by p)
  p.set(p.x * settings.bodyX, p.y * settings.bodyY, p.z * settings.bodyZ);
  p.clampLength(0, 0.6);
  // Camera space and avatar space share axes (X right, Y up, Z toward camera),
  // so the rotation maps 1:1: turning your head left turns the avatar's head to its left.
  if (settings.mirror) { q.y = -q.y; q.z = -q.z; p.x = -p.x; }
  // smooth (keep the quaternion on the same hemisphere so the filter doesn't flip through zero)
  if (prevQ && prevQ.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w);
  const h = filters.head.filter([q.x, q.y, q.z, q.w, p.x, p.y, p.z], t);
  q.set(h[0], h[1], h[2], h[3]).normalize(); p.set(h[4], h[5], h[6]);
  prevQ = q.clone();

  // --- blendshapes ---
  const cats = result.faceBlendshapes[0].categories;
  const byName = {};
  for (const c of cats) byName[c.categoryName] = c.score;
  let b = ARKIT.map((n) => byName[n] ?? 0);
  if (neutralAcc) {
    b.forEach((v, i) => { neutralAcc.sum[i] += v; });
    if (++neutralAcc.n >= 15) finishNeutral();
  }
  if (neutral) b = b.map((v, i) => Math.max(0, Math.min(1, (v - neutral[i]) / (1 - neutral[i]))));
  if (settings.swapLR !== settings.mirror) b = SWAP.map((j) => b[j]);
  b = filters.face.filter(b, t);
  const blinkFloor = neutral ? 0.05 : 0.15;
  for (const i of BLINK_IDX) b[i] = Math.min(1, Math.max(0, (b[i] - blinkFloor) * settings.blinkGain * 1.3));
  if (settings.linkEyes) { const m = (b[BLINK_IDX[0]] + b[BLINK_IDX[1]]) / 2; b[BLINK_IDX[0]] = b[BLINK_IDX[1]] = m; }
  b[JAW_IDX] = Math.min(1, b[JAW_IDX] * settings.mouthGain);
  // per-expression tuning: e.g. a closed-eye "joy" face shouldn't blink, a pout shouldn't open the mouth
  const tune = activeExpr && settings.exprTune[activeExpr];
  if (tune) {
    for (const i of MOUTH_IDX) b[i] = Math.min(1, b[i] * tune.mouth);
    for (const i of BLINK_IDX) b[i] = Math.min(1, b[i] * tune.blink);
  }

  return {
    t: 'm', f: true, x: activeExpr, ae: settings.autoExpr,
    q: q.toArray().map((v) => +v.toFixed(4)),
    p: p.toArray().map((v) => +v.toFixed(4)),
    b: b.map((v) => +Math.max(0, v).toFixed(3)),
  };
}

// Timer-driven, not requestAnimationFrame: animation frames stop when this window is minimised or
// covered (e.g. by a game), which used to freeze the avatar on the viewers' side.
let frameSeq = 0;
let paused = false, lastPausedSend = 0;
function loop() {
  setTimeout(loop, 8);
  if (paused) {
    // camera is off: keep viewers informed (they show an idle, breathing, blinking avatar)
    const now = performance.now();
    if (now - lastPausedSend > 250) {
      lastPausedSend = now;
      const frame = { t: 'm', f: false, x: null, ae: false };
      stage.setMotion(frame);
      sendFrame(frame, now, true);
    }
    return;
  }
  if (!landmarker || video.readyState < 2) return;
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const now = performance.now();
  const frame = buildFrame(landmarker.detectForVideo(video, now), now);
  if (settings.arms && poseLandmarker && handLandmarker) {
    try {
      frame.a = buildArmPayload(poseLandmarker.detectForVideo(video, now), handLandmarker.detectForVideo(video, now), settings.mirror);
    } catch (err) { console.warn('arm tracking', err); }
  }
  stage.setMotion(frame);
  if (frame.f !== lastFace) { lastFace = frame.f; setTrack(frame.f ? 'ok' : 'warn', frame.f ? 'Tracking' : 'No face detected'); }

  sendFrame(frame, now);
}

function sendFrame(frame, now, force = false) {
  if (force || now - lastSend >= SEND_INTERVAL_MS) {
    lastSend = now;
    frame.n = ++frameSeq; // lets viewers ignore frames that arrive late / out of order
    for (const v of viewers.values()) {
      if (!v.motion?.open) continue;
      // a backed-up channel means the network can't keep up: drop this frame rather than queue it
      if ((v.motion.dataChannel?.bufferedAmount ?? 0) > MOTION_MAX_BUFFERED) { v.skipped = (v.skipped || 0) + 1; continue; }
      try { v.motion.send(frame); } catch {}
    }
  }
}

async function setPaused(on) {
  if (on === paused) return;
  paused = on;
  $('pauseBtn').textContent = on ? '▶ Resume tracking' : '⏸ Pause tracking';
  $('pauseBtn').classList.toggle('on', on);
  $('pausedBanner').hidden = !on;
  if (on) {
    stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    setTrack('warn', 'Tracking paused');
  } else {
    filters.head.reset(); filters.face.reset(); prevQ = null; lastFace = null;
    const ok = await openCamera();
    // the tracking loop may already have found your face while the camera was starting —
    // only show "looking" if it hasn't (it updates the status itself as soon as it does)
    if (ok && lastFace === null) setTrack('warn', 'Looking for your face…');
  }
}
$('pauseBtn').onclick = () => setPaused(!paused);
$('pauseHk').onclick = () => bindHotkey('pause', 'Hotkey to pause / resume tracking');

(async () => {
  applyToggles();
  await openCamera();
  try { await initTracker(); } catch (err) { setTrack('bad', 'Face tracker failed to load: ' + err.message); return; }
  setTrack('warn', 'Looking for your face…');
  loop();
})();
