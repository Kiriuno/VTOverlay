// Sender: webcam -> MediaPipe tracking -> motion frames -> WebRTC to every viewer.
// The webcam image never leaves this page; only numbers are sent.
import * as THREE from 'three';
import { FaceLandmarker, PoseLandmarker, HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { AvatarStage, autoExpression } from './shared/avatar.js';
import {
  ARKIT, PEER_PREFIX, HOTKEY_EXPRESSIONS, MODEL_CHUNK, DEFAULT_POS, DEFAULT_VIEW, AVATAR_ASPECT, effectiveZone,
  VISEMES, AUTO_EXPR, POSES, DEFAULT_STYLE, DEFAULT_FX, normalizeStyle, IS_DEV, DEV_CODE,
  HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, MOTION_MAX_BUFFERED, peerOptions,
} from './shared/protocol.js';
import { buildArmPayload, ArmTracker } from './shared/arms.js';
import { OneEuroArray } from './shared/filters.js';
import { PROP_ATTACH, DRAW_MODES, normalizeProp } from './shared/props.js';
import { SpringGrabber } from './shared/grab.js';

const $ = (id) => document.getElementById(id);
const MODEL_URLS = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};
const SEND_INTERVAL_MS = 33; // ~30 Hz

// ---------------- settings ----------------
const settings = loadSettings();
function loadSettings() {
  const defaults = { v: 2, mirror: true, swapLR: true, hideCam: false, autoExpr: true, arms: false, linkEyes: false, smoothing: 0.5, mouthGain: 1.6, blinkGain: 1.5, bodyX: 1, bodyY: 1, bodyZ: 0.5, mouthMax: 1, blinkMax: 1, armSmoothing: 0.6, viewerGrab: false, viewerPat: true, exprTune: {}, maxViewers: 0, camId: '', style: DEFAULT_STYLE, models: {}, lightPresets: {} };
  try {
    const saved = JSON.parse(localStorage.getItem('vt-settings') || '{}');
    if (!saved.v) delete saved.mirror; // v1 defaulted mirror off, which felt backwards
    return { ...defaults, ...saved, v: 2 };
  } catch { return defaults; }
}
function saveSettings() {
  snapshotModelProfile();
  try { localStorage.setItem('vt-settings', JSON.stringify(settings)); } catch {}
}

// ---- sensitivity is remembered per avatar ----
// (each model's mouth, blink, vowel, per-expression and body-movement sensitivities; a model seen for
// the first time starts from whatever is set now)
const PROFILE_KEYS = ['mouthGain', 'blinkGain', 'mouthMax', 'blinkMax', 'bodyX', 'bodyY', 'bodyZ'];
let profileModel = null; // id of the model whose profile the current values belong to
function snapshotModelProfile() {
  if (!profileModel || !settings.style) return;
  settings.models[profileModel] = {
    ...Object.fromEntries(PROFILE_KEYS.map((k) => [k, settings[k]])),
    exprTune: JSON.parse(JSON.stringify(settings.exprTune || {})), vg: { ...(settings.style.vg || {}) }, vm: { ...(settings.style.vm || {}) },
  };
}
function loadModelProfile(id, name) {
  snapshotModelProfile(); // keep the outgoing model's values
  profileModel = id;
  const prof = settings.models[id];
  if (prof) {
    for (const k of PROFILE_KEYS) if (prof[k] !== undefined) { settings[k] = prof[k]; $(k).value = prof[k]; }
    settings.exprTune = prof.exprTune || {};
    if (prof.vg || prof.vm) updateStyle({ vg: prof.vg || {}, vm: prof.vm || DEFAULT_STYLE.vm });
    showLimits();
    showExprTune();
  }
  $('sensFor').textContent = `Saved for “${name}”${prof ? '' : ' (new: started from your current settings)'}. Each avatar remembers its own.`;
  saveSettings();
}
const applyToggles = () => {
  document.body.classList.toggle('camHidden', settings.hideCam);
  $('armsHint').hidden = !settings.arms;
  $('armSmoothRow').hidden = !settings.arms;
  if (settings.arms) initBodyTrackers();
};
for (const k of ['mirror', 'swapLR', 'hideCam', 'autoExpr', 'arms', 'linkEyes', 'viewerGrab', 'viewerPat']) {
  $(k).checked = settings[k];
  $(k).onchange = () => {
    settings[k] = $(k).checked; saveSettings(); applyToggles();
    if (k === 'arms' && !paused) openCamera(); // switch camera resolution (720p for hands)
    if (k === 'viewerGrab') setViewerGrab(settings.viewerGrab);
    if (k === 'viewerPat') broadcastControl({ t: 'perm', grab: !!settings.viewerGrab, pat: !!settings.viewerPat });
  };
}
for (const k of ['mouthGain', 'blinkGain', 'mouthMax', 'blinkMax', 'smoothing', 'bodyX', 'bodyY', 'bodyZ', 'armSmoothing']) {
  $(k).value = settings[k];
  $(k).oninput = () => {
    settings[k] = parseFloat($(k).value); saveSettings();
    if (k === 'smoothing') tuneFilters();
    if (k === 'armSmoothing') armTracker.setSmoothing(settings.armSmoothing);
    showLimits();
  };
}

// sidebar sections remember whether they were open
{
  let open = {};
  try { open = JSON.parse(localStorage.getItem('vt-sections') || '{}'); } catch {}
  document.querySelectorAll('details.sec[data-sec]').forEach((d) => {
    if (open[d.dataset.sec] !== undefined) d.open = open[d.dataset.sec];
    d.addEventListener('toggle', () => { open[d.dataset.sec] = d.open; try { localStorage.setItem('vt-sections', JSON.stringify(open)); } catch {} });
  });
}

// ---------------- avatar preview + view controls (viewers see the same framing) ----------------
const stage = new AvatarStage($('stage'));
let view = stage.setView(loadJSON('vt-view', DEFAULT_VIEW));
window.vtStage = stage; // handy from the dev tools (and for tests)
function loadJSON(k, d) { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch { return { ...d }; } }

let viewSendTimer = null;
function updateView(patch) {
  view = stage.setView({ ...view, ...patch });
  $('frBtn').textContent = 'Framing: ' + (view.fr === 'full' ? 'Full body' : 'Bust');
  try { localStorage.setItem('vt-view', JSON.stringify(view)); } catch {}
  if (!viewSendTimer) viewSendTimer = setTimeout(() => { viewSendTimer = null; broadcastControl({ t: 'view', ...view }); }, 50);
}
updateView({});
// roll: turn the whole picture (sideways, upside down…)
function showRoll() { $('roll').value = Math.round(view.roll || 0); $('rollOut').textContent = Math.round(view.roll || 0) + '°'; }
$('roll').oninput = () => { updateView({ roll: Number($('roll').value) }); showRoll(); };
document.querySelectorAll('[data-roll]').forEach((b) => { b.onclick = () => { updateView({ roll: Number(b.dataset.roll) }); showRoll(); }; });
showRoll();

// ---------------- look: lighting + per-vowel mouth sensitivity (viewers get the same) ----------------
let style = stage.setStyle(settings.style);
let styleSendTimer = null;
function updateStyle(patch) {
  style = stage.setStyle({ vg: { ...style.vg, ...patch.vg }, vm: { ...style.vm, ...patch.vm }, ag: { ...style.ag, ...patch.ag }, light: { ...style.light, ...patch.light }, fx: { ...style.fx, ...patch.fx }, pose: patch.pose ?? style.pose });
  settings.style = style; saveSettings();
  if (!styleSendTimer) styleSendTimer = setTimeout(() => { styleSendTimer = null; broadcastControl({ t: 'style', ...style }); }, 80);
  showStyle();
}
$('vowelSliders').innerHTML = '<div class="slider dual head"><span></span><small>sensitivity</small><small>limit</small></div>' + VISEMES.map(([k, l]) =>
  `<div class="slider dual"><span>${l} <output id="vgOut_${k}"></output></span><input type="range" id="vg_${k}" min="0" max="3" step="0.05" title="Sensitivity">` +
  `<input type="range" id="vm_${k}" min="0" max="1" step="0.02" title="Limit: never opens past this"></div>`).join('');
for (const [k] of VISEMES) {
  $('vg_' + k).oninput = (e) => updateStyle({ vg: { [k]: +e.target.value } });
  $('vm_' + k).oninput = (e) => updateStyle({ vm: { [k]: +e.target.value } });
}
$('vowelReset').onclick = () => updateStyle({ vg: DEFAULT_STYLE.vg, vm: DEFAULT_STYLE.vm });
// auto expressions: sensitivity per emotion + a live meter of what's read from your face
$('autoRows').innerHTML = AUTO_EXPR.map(([k, l]) =>
  `<div class="slider dual"><span>${l} <output id="agOut_${k}"></output></span><input type="range" id="ag_${k}" min="0" max="3" step="0.05" title="Sensitivity"><span class="meter" title="Read from your face now (the line is where it starts to show)"><i id="agBar_${k}"></i><b></b></span></div>`).join('');
for (const [k] of AUTO_EXPR) $('ag_' + k).oninput = (e) => updateStyle({ ag: { [k]: +e.target.value } });
$('autoReset').onclick = () => updateStyle({ ag: DEFAULT_STYLE.ag });
let autoScores = null; // what the auto expressions read from your face (set per tracked frame)
(function meters() {
  requestAnimationFrame(meters);
  if (!$('autoTune').open) return;
  const sc = autoScores || stage.autoScores || {};
  for (const [k] of AUTO_EXPR) $('agBar_' + k).style.width = Math.round((sc[k] || 0) * 100) + '%';
})();

// limits next to the sensitivity sliders: the value shown as "max NN%"
function showLimits() {
  for (const k of ['mouthMax', 'blinkMax']) $(k + 'Out').textContent = settings[k] < 1 ? `max ${Math.round(settings[k] * 100)}%` : '';
}
const LIGHT_INPUTS = { lightColor: 'color', lightI: 'i', lightX: 'x', lightY: 'y', lightZ: 'z', lightAmb: 'amb', lightAmbColor: 'ambColor' };
for (const [id, k] of Object.entries(LIGHT_INPUTS)) {
  $(id).oninput = (e) => updateStyle({ light: { [k]: e.target.type === 'color' ? e.target.value : +e.target.value } });
}
$('lightReset').onclick = () => { updateStyle({ light: DEFAULT_STYLE.light }); $('lightPreset').value = ''; };
// lighting presets (kept on this computer)
function renderLightPresets(selected = '') {
  const names = Object.keys(settings.lightPresets).sort((a, b) => a.localeCompare(b));
  $('lightPreset').innerHTML = `<option value="">${names.length ? 'Presets…' : 'No presets yet'}</option>` +
    names.map((n) => `<option>${n.replace(/</g, '&lt;')}</option>`).join('');
  $('lightPreset').value = names.includes(selected) ? selected : '';
  $('lightDelPreset').hidden = !$('lightPreset').value;
}
$('lightPreset').onchange = () => {
  const n = $('lightPreset').value;
  if (n && settings.lightPresets[n]) updateStyle({ light: settings.lightPresets[n] });
  $('lightDelPreset').hidden = !n;
  $('lightPresetName').value = n;
};
$('lightSavePreset').onclick = () => {
  const n = $('lightPresetName').value.trim();
  if (!n) { $('lightPresetName').focus(); return; }
  settings.lightPresets[n] = { ...style.light };
  saveSettings(); renderLightPresets(n);
};
$('lightPresetName').onkeydown = (e) => { if (e.key === 'Enter') $('lightSavePreset').click(); };
$('lightDelPreset').onclick = () => {
  const n = $('lightPreset').value;
  if (!n) return;
  delete settings.lightPresets[n]; saveSettings(); renderLightPresets(); $('lightPresetName').value = '';
};
renderLightPresets();

// headpat / boop areas (fine-tuning; outlined in the preview while the panel is open)
const FX_INPUTS = { fxHy: 'hy', fxHz: 'hz', fxHs: 'hs', fxNy: 'ny', fxNz: 'nz', fxNs: 'ns' };
for (const [id, k] of Object.entries(FX_INPUTS)) $(id).oninput = (e) => updateStyle({ fx: { [k]: +e.target.value } });
$('fxReset').onclick = () => updateStyle({ fx: DEFAULT_FX });
$('poseSel').innerHTML = POSES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('');
$('poseSel').onchange = (e) => updateStyle({ pose: e.target.value });
$('fxAreas').addEventListener('toggle', () => { stage.fx.showAreas = $('fxAreas').open; });
function showStyle() {
  for (const [k] of AUTO_EXPR) { $('ag_' + k).value = style.ag[k]; $('agOut_' + k).textContent = '×' + style.ag[k].toFixed(2); }
  for (const [k] of VISEMES) {
    $('vg_' + k).value = style.vg[k]; $('vm_' + k).value = style.vm[k];
    $('vgOut_' + k).textContent = '×' + style.vg[k].toFixed(2) + (style.vm[k] < 1 ? ` · max ${Math.round(style.vm[k] * 100)}%` : '');
  }
  for (const [id, k] of Object.entries(LIGHT_INPUTS)) $(id).value = style.light[k];
  for (const [id, k] of Object.entries(FX_INPUTS)) $(id).value = style.fx[k];
  $('poseSel').value = style.pose;
  $('lightColorHex').textContent = style.light.color; $('lightAmbColorHex').textContent = style.light.ambColor;
  const { x, y, z } = style.light, words = [];
  if (z > 0.35) words.push('the front'); else if (z < -0.35) words.push('behind');
  if (x > 0.3) words.push('the right'); else if (x < -0.3) words.push('the left');
  if (y > 0.3) words.push('above'); else if (y < -0.3) words.push('below');
  $('lightDesc').textContent = 'From ' + (words.length ? words.join(', ') : 'the front');
}
showStyle();
showLimits();
$('frBtn').onclick = () => updateView({ fr: view.fr === 'full' ? 'bust' : 'full', px: 0, py: 0 });
$('resetView').onclick = () => { updateView({ ...DEFAULT_VIEW, fr: view.fr, roll: view.roll }); showRoll(); }; // roll has its own buttons

const canvas = $('stage');
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const delta = e.deltaY || e.deltaX; // Shift+wheel arrives as horizontal scroll on Windows
  const hit = pickProp(e);
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
  viewDrag = { mode: e.button === 1 ? 'pan' : e.shiftKey ? 'roll' : 'rot', x: e.clientX, y: e.clientY, start: { ...view } };
  canvas.style.cursor = viewDrag.mode === 'pan' ? 'move' : 'ew-resize';
});
canvas.addEventListener('pointermove', (e) => {
  if (!viewDrag) return;
  const dx = e.clientX - viewDrag.x, dy = e.clientY - viewDrag.y, H = canvas.clientHeight || 1;
  if (viewDrag.mode === 'pan') {
    // the drag is on screen; with the picture rolled, screen directions are turned in the world
    const r = (view.roll || 0) * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
    updateView({ px: viewDrag.start.px + (dx * c - dy * sn) / H, py: viewDrag.start.py + (-dx * sn - dy * c) / H });
  } else if (viewDrag.mode === 'roll') { updateView({ roll: ((viewDrag.start.roll || 0) - dx * 0.5 + 540) % 360 - 180 }); showRoll(); }
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
    loadModelProfile(id, name);
    $('empty').hidden = true;
    $('modelName').textContent = name;
    $('modelName').classList.remove('muted');
    $('syncBadge').hidden = !info.perfectSync;
    buildExpressionButtons(info.expressions);
    storeLastModel(buf, name);
    for (const v of viewers.values()) if (v.model?.open) offerModel(v);
    toOutput({ t: 'model', id, buf: buf.slice(0) });
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
// Bindings: { 'expr:<name>' | 'clear' | 'pause' | 'prop:<id>': accel }, accel in Electron syntax, e.g. "Ctrl+Alt+H".
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
    const live = id === 'pause' || id === 'clear' || (id.startsWith('expr:') ? exprList.includes(id.slice(5))
      : id.startsWith('group:') ? props.some((p) => p.group === id.slice(6)) : props.some((p) => 'prop:' + p.id === id));
    if (live) list.push({ accel, id });
  }
  hotkeyStatus = await window.vt.setHotkeys(list);
  refreshHotkeyBadges();
}
function refreshHotkeyBadges() {
  const pa = hotkeys.pause;
  $('pauseHk').textContent = pa ? '⌨︎ ' + prettyAccel(pa) : '⌨︎';
  $('pauseHk').classList.toggle('bad', hotkeyStatus.pause === false);
  if (activeExpr) { const a = hotkeys['expr:' + activeExpr]; $('tuneHk').textContent = a ? '⌨︎ ' + prettyAccel(a) : '⌨︎ Hotkey'; }
  document.querySelectorAll('#xrow [data-expr], #xrow [data-clear]').forEach((b) => {
    b.querySelector('small')?.remove();
    const id = b.dataset.clear ? 'clear' : 'expr:' + b.dataset.expr, accel = hotkeys[id];
    if (accel) b.insertAdjacentHTML('beforeend', `<small class="${hotkeyStatus[id] === false ? 'bad' : ''}" title="${hotkeyStatus[id] === false ? 'Another app already uses this combination' : ''}">${prettyAccel(accel)}</small>`);
  });
  document.querySelectorAll('#propGroups .grow').forEach((row) => {
    const id = 'group:' + row.dataset.group, accel = hotkeys[id], hk = row.querySelector('[data-a=ghk]');
    hk.textContent = accel ? '⌨︎ ' + prettyAccel(accel) : '⌨︎ Hotkey';
    hk.classList.toggle('bad', hotkeyStatus[id] === false);
  });
  document.querySelectorAll('#propList .prop').forEach((row) => {
    const id = 'prop:' + row.dataset.id, accel = hotkeys[id], hk = row.querySelector('[data-a=hk]');
    hk.textContent = accel ? '⌨︎ ' + prettyAccel(accel) : '⌨︎ Hotkey';
    hk.classList.toggle('bad', hotkeyStatus[id] === false);
    hk.title = hotkeyStatus[id] === false ? 'Another app already uses this combination' : 'Click to set a hotkey that shows/hides this prop';
  });
}
window.vt.onHotkey((id) => {
  if (id === 'pause') return setPaused(!paused);
  if (id === 'clear') return setExpr(null);
  if (id.startsWith('expr:')) return toggleExpr(id.slice(5));
  if (id.startsWith('prop:')) { const p = props.find((x) => x.id === id.slice(5)); if (p) updateProp(p.id, { visible: !p.visible }); }
  if (id.startsWith('group:')) { toggleGroup(id.slice(6)); renderGroups(); }
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
      if (!key) { $('hkMsg').textContent = 'That key can’t be used. Try a letter, digit, F-key, numpad key or arrow.'; return; }
      const special = /^(F\d+|num\w+|Pause|Scrolllock)$/.test(key);
      if (!special && !m.some((x) => x !== 'Shift')) {
        $('hkMsg').textContent = 'Add Ctrl or Alt: on its own (or with just Shift) this key would stop typing everywhere else.';
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
  $('tuneHk').textContent = a ? '⌨︎ ' + prettyAccel(a) : '⌨︎ Hotkey';
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

// the code can be hidden (e.g. while streaming your screen); Copy still copies it
let shownCode = null;
function showCode(code) {
  if (code !== undefined) shownCode = code;
  $('code').textContent = !shownCode ? '······' : settings.hideCode ? '•'.repeat(shownCode.length) : shownCode;
  $('code').dataset.code = shownCode || '';
  $('hideCode').textContent = settings.hideCode ? 'Show' : 'Hide';
  $('hideCode').title = settings.hideCode ? 'Show the room code' : 'Hide the room code (Copy still works)';
}
$('hideCode').onclick = () => { settings.hideCode = !settings.hideCode; saveSettings(); showCode(); };
let sigTimer = null, sigFailures = 0, idTakenTries = 0;
// Watchdog: an overloaded signalling server can accept the connection and then never answer, which
// used to leave "Connecting…" on screen forever. If we're not registered within a while, start over.
let sigAttemptAt = 0, sigHangs = 0, currentCode = null;
const SIG_TIMEOUT_MS = () => Math.min(30000, 10000 + sigHangs * 5000); // 10 s, 15 s, 20 s … 30 s
setInterval(() => {
  const p = peer;
  if (!p || stopping || p.open || !sigAttemptAt || performance.now() - sigAttemptAt < SIG_TIMEOUT_MS()) return;
  sigHangs++;
  const msg = `Can't reach the connection server, retrying (attempt ${sigHangs + 1})…` + (sigHangs >= 3 ? ' Check your internet connection / firewall.' : '');
  if (!p.destroyed && viewers.size) {
    // viewers are connected directly: keep them, just redo the signalling registration
    sigAttemptAt = performance.now();
    try { p.disconnect(); } catch {}
    try { p.reconnect(); } catch {}
  } else {
    peer = null; // first, so the dying Peer's own 'disconnected' event is ignored
    try { p.destroy(); } catch {}
    startPeer(currentCode);
  }
  setNet('bad', msg);
}, 2000);

function startPeer(code = savedCode() || randomCode()) {
  clearTimeout(sigTimer);
  currentCode = code;
  sigAttemptAt = performance.now();
  // the code is known before the server confirms it (it's saved from last time): show it right away
  showCode(code);
  const p = peer = new window.Peer(PEER_PREFIX + code, peerOptions());
  p.on('open', () => {
    if (p !== peer) return;
    sigFailures = 0; idTakenTries = 0; sigHangs = 0; sigAttemptAt = 0;
    try { localStorage.setItem('vt-code', code); } catch {}
    showCode(code);
    updateViewers();
    if (!viewers.size) setNet('ok', 'Online, waiting for viewers');
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
    call.answer(); // receive only, we never send anything back on this call
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
      else if (p.disconnected) { sigAttemptAt = performance.now(); try { p.reconnect(); } catch {} }
    }, delay);
  };
  p.on('disconnected', () => {
    if (p !== peer || stopping || p.destroyed) return;
    setNet('warn', viewers.size ? 'Streaming, reconnecting to the signalling server…' : 'Reconnecting…');
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
        setNet('warn', `Code ${code} is used by someone else, getting a new one…`);
        startPeer(randomCode());
        return;
      }
      setNet('warn', `Code ${code} is still registered from before, retrying…`);
      retrySignalling();
      return;
    }
    if (!viewers.size) setNet('bad', 'Signalling server unreachable, retrying…');
    if (p.destroyed || p.disconnected) retrySignalling();
  });
}
startPeer(DEV_CODE || undefined); // dev: the code `npm run dev` gave both windows
if (IS_DEV) document.body.classList.add('dev');

function dropViewer(id) {
  const v = viewers.get(id);
  if (!v) return;
  viewers.delete(id);
  if (stage.grabs.has('v' + v.n)) { stage.setGrab('v' + v.n, -1, null); relayGrab(id, { t: 'grab', k: 'v' + v.n, j: -1, p: null }); }
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

/** Send a viewer's grab to everyone else. */
function relayGrab(fromId, msg) {
  toOutput(msg);
  for (const [id, v] of viewers) if (id !== fromId && v.model?.open) { try { v.model.send(msg); } catch {} }
}
function setViewerGrab(on) {
  broadcastControl({ t: 'perm', grab: on, pat: !!settings.viewerPat });
  if (!on) for (const v of viewers.values()) {
    if (!stage.grabs.has('v' + v.n)) continue;
    stage.setGrab('v' + v.n, -1, null);
    broadcastControl({ t: 'grab', k: 'v' + v.n, j: -1, p: null });
  }
}

// ---- camera output window (for OBS / a virtual camera): mirrors what viewers get, locally ----
const outCh = new BroadcastChannel('vt-output');
let outputOpen = false;
const toOutput = (msg) => { if (outputOpen) { try { outCh.postMessage(msg); } catch {} } };
outCh.onmessage = async ({ data: d }) => {
  if (d?.t === 'hello') {
    outputOpen = true;
    if (modelBuf) outCh.postMessage({ t: 'model', id: modelId, buf: modelBuf.slice(0) });
    outCh.postMessage({ t: 'view', ...view });
    outCh.postMessage({ t: 'style', ...style });
    outCh.postMessage({ t: 'props', list: publicProps() });
    showOutputState(true);
  }
  if (d?.t === 'need-prop') { const blob = await getPropImage(String(d.hash)); if (blob) outCh.postMessage({ t: 'prop-img', hash: d.hash, blob }); }
};
function showOutputState(open) {
  outputOpen = open;
  $('outputBtn').textContent = open ? 'Close camera output' : 'Open camera output';
  $('outputBtn').classList.toggle('on', open);
}
$('outputBtn').onclick = () => {
  if (outputOpen) { window.vt.closeOutput(); showOutputState(false); return; }
  const [w, h] = $('outputSize').value.split('x').map(Number);
  settings.output = { bg: $('outputBg').value, size: $('outputSize').value }; saveSettings();
  window.vt.openOutput({ w, h, bg: $('outputBg').value });
};
window.vt.onOutputClosed(() => showOutputState(false));
if (settings.output) { $('outputBg').value = settings.output.bg; $('outputSize').value = settings.output.size; }
$('outputBg').onchange = $('outputSize').onchange = () => { settings.output = { bg: $('outputBg').value, size: $('outputSize').value }; saveSettings(); if (outputOpen) $('outputBtn').click(), $('outputBtn').click(); };

function broadcastControl(msg) {
  toOutput(msg);
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
  showCode(null);
  setNet('warn', 'Getting a new code…');
  startPeer(randomCode());
};
window.vt.onAppClosing(async () => { await sayBye('ended'); window.vt.goodbyeSent(); });

// an update released while you're broadcasting: say so (installing happens from the start screen)
async function pollUpdate() {
  try {
    const r = await window.vt.checkUpdate();
    if (r?.state === 'available') { $('updateVer').textContent = 'v' + r.latest; $('updatePill').hidden = false; }
  } catch {}
}
setTimeout(pollUpdate, 30000);
setInterval(pollUpdate, 30 * 60000);
$('updateGo').onclick = () => $('stop').click();

// What this viewer currently sees (reported by the viewer itself; older viewers don't report).
function viewerSees(v) {
  const rx = v.rx;
  if (!v.motion?.open || !v.model?.open) return ['warn', 'Connecting…', 'The connection is still being set up'];
  if (!rx) return [modelBuf ? 'warn' : 'muted', modelBuf ? 'Connected' : 'Waiting for your avatar', 'This viewer runs an older version and doesn\'t report what it sees'];
  if (rx.s === 'loading') return ['warn', `Loading your avatar… ${Math.round((rx.p || 0) * 100)}%`, 'Your model is being sent / loaded on their side'];
  if (rx.s === 'error') return ['bad', 'Avatar failed to load', 'Their app couldn\'t open your model'];
  if (rx.s === 'hidden') return ['muted', 'Avatar hidden (you\'re not tracking)', 'Full screen hides your avatar after 30 s without tracking'];
  if (rx.s === 'ready') return ['ok', '● Sees you', 'Your avatar is on their screen'];
  return ['muted', modelBuf ? 'Waiting for your avatar' : 'Waiting for you to load an avatar', ''];
}

const MODE_LABEL = { floating: 'floating widget', window: 'window', screen: 'full screen' };
const viewerLabel = (v) => v.state?.name || `Viewer ${v.n}`;

$('maxViewers').value = String(settings.maxViewers || 0);
$('maxViewers').onchange = () => { settings.maxViewers = Number($('maxViewers').value) || 0; saveSettings(); updateViewers(); };

function updateViewers() {
  const live = [...viewers.entries()].filter(([, v]) => v.motion?.open || v.model?.open);
  $('viewerCount').textContent = settings.maxViewers ? `(${live.length} / ${settings.maxViewers})` : live.length ? `(${live.length})` : '';
  const box = $('viewers');
  box.classList.toggle('muted', !live.length);
  if (!live.length) box.textContent = 'Nobody yet. Share the code.';
  else {
    box.innerHTML = '';
    for (const [id, v] of live) {
      const row = document.createElement('div');
      row.className = 'vrow';
      const extra = v.state ? `, ${MODE_LABEL[v.state.mode] || v.state.mode}${v.state.sharing ? ', sharing screen' : ''}` : '';
      const label = document.createElement('span');
      label.className = 'vlabel';
      label.textContent = viewerLabel(v) + extra;
      const [cls, text, tip] = viewerSees(v);
      const badge = document.createElement('span');
      badge.className = 'vsee ' + cls; badge.textContent = text; badge.title = tip;
      label.append(document.createElement('br'), badge);
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
  if (peer?.open) setNet('ok', live.length ? 'Online, streaming' : 'Online, waiting for viewers');
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
  if (d.t === 'fx') { // a viewer's headpat / boop
    if (!settings.viewerPat || (d.k !== 'pat' && d.k !== 'boop')) return;
    const now = performance.now();
    if (d.k === 'boop' && now - (v.lastBoop || 0) < 250) return; // no machine-gun boops
    if (d.k === 'boop') v.lastBoop = now;
    const r = Number.isFinite(+d.r) ? +d.r : undefined; // pat speed
    if (d.k === 'pat') stage.fx.patting(r); else stage.fx.boop();
    relayGrab(id, { t: 'fx', k: d.k, r });
    return;
  }
  if (d.t === 'grab') {
    if (!settings.viewerGrab) return;
    const j = Number.isInteger(d.j) ? d.j : -1;
    const p = Array.isArray(d.p) && d.p.length === 3 && d.p.every(Number.isFinite) ? d.p : null;
    stage.setGrab('v' + v.n, j, p, true);
    relayGrab(id, { t: 'grab', k: 'v' + v.n, j, p });
    return;
  }
  if (d.t === 'rx') { v.rx = { s: String(d.s), p: Math.max(0, Math.min(1, +d.p || 0)) }; updateViewers(); return; }
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
  if (!v.pos.tb) { toFullArea(v); sendPos(v, true); }
  if (first) {
    v.model.send({ t: 'props', list: publicProps() });
    v.model.send({ t: 'view', ...view });
    v.model.send({ t: 'style', ...style });
    v.model.send({ t: 'perm', grab: !!settings.viewerGrab, pat: !!settings.viewerPat });
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

$('copy').onclick = () => { if (!shownCode) return; window.vt.copyText(shownCode); $('copy').textContent = 'Copied'; setTimeout(() => ($('copy').textContent = 'Copy'), 1200); };

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

const FULL_AREA = { x: 0, y: 0, w: 1, h: 1 };
// The avatar may go anywhere in the viewer's zone, taskbar included (when they watch something full
// screen the taskbar is hidden, and an avatar parked above it would float over nothing). Dragging its
// feet near the top of the taskbar snaps them onto it; keep pushing to go past.
// Positions are expressed in the whole zone (pos.tb = true); older viewers' positions (relative to
// the zone minus the taskbar) are converted so the avatar stays where it is on their screen.
function toFullArea(v) {
  if (v.pos.tb || !v.state) return;
  const from = effectiveZone(v.state.zone, v.state.work), to = effectiveZone(v.state.zone, FULL_AREA);
  const ax = from.x + v.pos.x * from.w, ay = from.y + v.pos.y * from.h, ah = v.pos.s * from.h;
  v.pos = { ...v.pos, tb: true, x: (ax - to.x) / to.w, y: (ay - to.y) / to.h, s: ah / to.h };
}
/** The taskbar's top edge as a y position in the zone (where feet snap), or null if it has none there. */
function taskbarSnapY(v) {
  if (!v?.state) return null;
  const z = effectiveZone(v.state.zone, FULL_AREA), w = v.state.work;
  const top = w.y + w.h; // bottom of the usable area = top of a bottom taskbar
  if (top > 0.995) return null;
  const y = (top - z.y) / z.h;
  return y > 0.05 && y < 1 ? y : null;
}
const SNAP_PX = 14; // how close (in the placement view) the feet must come to stick

// props placed on the viewer's screen: shown and dragged here (fractions of their whole monitor)
const screenPropEls = new Map(); // id → <img>
function renderScreenProps() {
  const box = $('screenBox');
  const list = props.filter((p) => p.attach === 'screen');
  for (const [id, el] of screenPropEls) if (!list.some((p) => p.id === id)) { el.remove(); screenPropEls.delete(id); }
  for (const d of list) {
    let el = screenPropEls.get(d.id);
    if (!el) {
      el = document.createElement('img');
      el.className = 'sprop'; el.draggable = false; el.dataset.id = d.id;
      getPropImage(d.img).then((b) => { if (b) el.src = propThumbs.get(d.img) || (propThumbs.set(d.img, URL.createObjectURL(b)), propThumbs.get(d.img)); });
      el.addEventListener('pointerdown', (e) => {
        const p = props.find((x) => x.id === d.id);
        if (e.button !== 0 || p.locked || propsLocked) return;
        e.preventDefault(); e.stopPropagation(); el.setPointerCapture(e.pointerId);
        selectProp(d.id);
        const r = box.getBoundingClientRect();
        el._drag = { x: e.clientX, y: e.clientY, sx: p.pos[0], sy: p.pos[1], w: r.width, h: r.height };
      });
      el.addEventListener('pointermove', (e) => {
        const g = el._drag; if (!g) return;
        const x = Math.max(0, Math.min(1, g.sx + (e.clientX - g.x) / g.w)), y = Math.max(0, Math.min(1, g.sy + (e.clientY - g.y) / g.h));
        updateProp(d.id, { pos: [+x.toFixed(4), +y.toFixed(4), 0] });
      });
      const end = () => { el._drag = null; };
      el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
      el.addEventListener('wheel', (e) => {
        const p = props.find((x) => x.id === d.id);
        if (p.locked || propsLocked) return;
        e.preventDefault(); e.stopPropagation(); selectProp(d.id);
        updateProp(d.id, { size: Math.max(0.02, Math.min(1.5, p.size * ((e.deltaY || e.deltaX) < 0 ? 1.08 : 1 / 1.08))) });
      }, { passive: false });
      box.appendChild(el);
      screenPropEls.set(d.id, el);
    }
    Object.assign(el.style, screenPropStyle(d, 100, 100, '%', props.length - props.indexOf(d)));
    el.hidden = !d.visible;
    el.classList.toggle('sel', d.id === selectedProp);
    el.classList.toggle('locked', !!(d.locked || propsLocked));
  }
}
/** CSS for a screen prop in a W×H area (also used by the viewer, same maths). */
function screenPropStyle(d, W, H, unit, rank) {
  return {
    left: d.pos[0] * W + unit, top: d.pos[1] * H + unit, height: d.size * H + unit,
    transform: `translate(-50%, -50%) scaleX(${d.flip ? -1 : 1})`,
    zIndex: (d.draw === 'back' ? 100 : 300) + rank, // behind (100s) or above (300s) the avatar box (200)
  };
}

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
  const z = effectiveZone(v.state.zone, FULL_AREA), zb = $('zoneBox').style;
  zb.left = z.x * 100 + '%'; zb.top = z.y * 100 + '%'; zb.width = z.w * 100 + '%'; zb.height = z.h * 100 + '%';

  const vid = $('screenVid');
  if (vid.srcObject !== (v.stream || null)) vid.srcObject = v.stream || null;
  $('noVideo').hidden = !!v.stream;
  $('noVideo').innerHTML = v.state.sharing ? 'Connecting to screen preview…'
    : 'Screen preview is off.<br>Your friend can turn it on from their tray icon. Until then you\'re placing the avatar on a blank outline of their monitor.';

  const zp = zoneRectPx();
  const p = clampPos(v.pos, zp);
  const boxH = p.s * zp.h, boxW = boxH * AVATAR_ASPECT;
  const ab = $('avBox').style;
  ab.left = p.x * zp.w - boxW / 2 + 'px'; ab.top = p.y * zp.h - boxH + 'px';
  ab.width = boxW + 'px'; ab.height = boxH + 'px';
  $('avName').textContent = modelName || 'Avatar';
  renderScreenProps();
}
new ResizeObserver(() => renderPlacement()).observe($('stageWrap'));

let lastPosSend = 0, posSendTimer = null;
function sendPos(v, force = false) {
  const now = performance.now();
  clearTimeout(posSendTimer);
  if (!force && now - lastPosSend < 50) { posSendTimer = setTimeout(() => sendPos(v, true), 50); return; }
  lastPosSend = now;
  if (v.model?.open) v.model.send({ t: 'pos', x: v.pos.x, y: v.pos.y, s: v.pos.s, tb: !!v.pos.tb });
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
  else {
    let y = drag.start.y + dy / zp.h;
    const snap = taskbarSnapY(drag.v);
    drag.snapped = snap !== null && Math.abs(y - snap) * zp.h < SNAP_PX;
    if (drag.snapped) y = snap;
    $('avBox').classList.toggle('snapped', drag.snapped);
    updatePos(drag.v, { x: drag.start.x + dx / zp.w, y });
  }
});
const endDrag = () => { if (!drag) return; drag.v.dragging = false; sendPos(drag.v, true); drag = null; $('avBox').classList.remove('dragging', 'snapped'); };
$('avBox').addEventListener('pointerup', endDrag);
$('avBox').addEventListener('pointercancel', endDrag);
$('screenArea').addEventListener('wheel', (e) => {
  const v = viewers.get(selectedViewer);
  if (!v) return;
  e.preventDefault();
  updatePos(v, { s: v.pos.s * (e.deltaY < 0 ? 1.06 : 1 / 1.06) });
}, { passive: false });
$('placeAdd').onclick = () => $('placeFile').click();
$('placeFile').onchange = async () => { for (const f of $('placeFile').files) await addPropFile(f, { onScreen: true }); $('placeFile').value = ''; };
$('resetPos').onclick = () => { const v = viewers.get(selectedViewer); if (v) updatePos(v, { ...DEFAULT_POS, tb: true, y: taskbarSnapY(v) ?? 1 }); };

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

// what viewers get: everything that affects the picture (not labels, locks or groups, those stay here)
const publicProps = () => props.map(({ id, img, attach, pos, rot, rx, ry, size, face, flip, visible, w, fp, fr, draw }) =>
  ({ id, img, attach, pos, rot, rx, ry, size, face, flip, visible, w, fp, fr, draw }));

let propPersistTimer = null, propSendTimer = null;
function commitProps({ rebuild = true } = {}) {
  stage.props.sync(props);
  renderScreenProps();
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
  for (const [pid, el] of screenPropEls) el.classList.toggle('sel', pid === id);
}

async function addPropFile(file, { onScreen = false } = {}) {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(file.type)) return;
  if (file.size > 20 * 1024 * 1024) { alert(`${file.name} is over 20 MB. Please use a smaller image.`); return; }
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
  props.push(normalizeProp(onScreen
    ? { id, img: hash, attach: 'screen', pos: [+(0.5 + n * 0.04).toFixed(3), +(0.4 + n * 0.04).toFixed(3), 0], size: 0.18, flip: false, visible: true, draw: 'front' }
    : { id, img: hash, attach: 'scene', pos: p0.toArray().map((v) => +v.toFixed(3)), size: +(vis * 0.22).toFixed(3), face: false, flip: false, visible: true, draw: 'front' }));
  propLabels[id] = file.name.replace(/\.[a-z0-9]+$/i, '');
  selectedProp = id;
  commitProps();
  if (onScreen) renderPlacement();
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
// images dropped while placing things on the viewer's screen go onto their screen
window.addEventListener('drop', async (e) => { for (const f of e.dataTransfer.files) if (f.type.startsWith('image/')) await addPropFile(f, { onScreen: !$('placeView').hidden }); });

const LOG2 = (v) => Math.log2(Math.max(0.02, v));
const DEG = 180 / Math.PI;
// prop groups: one hotkey shows / hides every prop of a group
const groupNames = () => [...new Set(props.map((p) => p.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
function toggleGroup(name) {
  const members = props.filter((p) => p.group === name);
  const show = !members.some((p) => p.visible); // any shown → hide all; all hidden → show all
  for (const p of members) p.visible = show;
  commitProps({ rebuild: false });
}
function renderPropList() {
  const list = $('propList');
  list.innerHTML = '';
  $('propDrop').style.display = props.length ? 'none' : '';
  $('groupList').innerHTML = groupNames().map((g) => `<option value="${g.replace(/"/g, '&quot;')}">`).join('');
  // newest / front-most first reads more naturally; the array itself is in paint order (first = back)
  props.forEach((d, i) => {
    let thumb = propThumbs.get(d.img);
    if (!thumb && propImgs.get(d.img)) { thumb = URL.createObjectURL(propImgs.get(d.img)); propThumbs.set(d.img, thumb); }
    const row = document.createElement('div');
    row.className = 'prop' + (d.id === selectedProp ? ' sel' : '');
    row.dataset.id = d.id;
    const attached = d.attach !== 'scene';
    row.innerHTML = `
      <div class="top"><img alt="">
        <span class="nm"></span>
        <span class="arrows"><button data-a="up" title="Bring forward (higher in the list = drawn in front)" ${i === 0 ? 'disabled' : ''}>▲</button><button data-a="down" title="Send back" ${i === props.length - 1 ? 'disabled' : ''}>▼</button></span>
        <button data-a="lock" title="Lock: can't be moved in the preview by accident"></button>
        <button data-a="vis" title="Show / hide"></button>
        <button data-a="hk" class="hk"></button>
        <button data-a="del" title="Remove">✕</button></div>
      <div class="more">
        <select data-k="attach">${PROP_ATTACH.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <div class="hint muted onscreen" ${d.attach === 'screen' ? '' : 'hidden'} style="margin:4px 0">Shown on full-screen viewers' monitors, anywhere you like, always facing them: move it in <b>Place on viewer's screen</b>.</div>
        <div class="follow" ${attached && d.attach !== 'screen' ? '' : 'hidden'}>
          <div class="slider" title="1 = moves exactly with that body part · 0.5 = halfway · 0 = stays where it is at rest"><span>Follow strength</span><input type="range" data-k="w" min="0" max="1" step="0.05"></div>
          <label class="toggle" title="Off: it stays in place, but still turns exactly as it does when following">Follow its position <input type="checkbox" data-k="fp"></label>
          <label class="toggle" title="Off: it moves exactly as it does when following, but keeps its own angle">Follow its rotation <input type="checkbox" data-k="fr"></label>
        </div>
        <div class="slider" title="Behind / in front of the avatar, or by its real distance (then it can go e.g. between an arm and the body). Among props drawn the same way, higher in this list = in front."><span>Draw</span><select data-k="draw">${DRAW_MODES.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
        <label class="toggle">Always face the camera <input type="checkbox" data-k="face"></label>
        <label class="toggle">Mirror image <input type="checkbox" data-k="flip"></label>
        <div class="slider"><span>Size</span><input type="range" data-k="size" min="-5" max="2" step="0.01"></div>
        <div class="slider"><span>Rotate (flat)</span><input type="range" data-k="rot" min="-180" max="180" step="1"></div>
        <div class="slider" title="Tilt toward / away from the camera"><span>Tilt ↕</span><input type="range" data-k="rx" min="-180" max="180" step="1"></div>
        <div class="slider" title="Turn left / right"><span>Turn ↔</span><input type="range" data-k="ry" min="-180" max="180" step="1"></div>
        <div class="slider" title="How far it is: toward the camera (right) or behind the avatar (left)"><span>Distance</span><input type="range" data-k="z" min="-1" max="1" step="0.01"></div>
        <div class="slider" title="Props in the same group share one show / hide hotkey (see Groups below)"><span>Group</span><input type="text" data-k="group" list="groupList" placeholder="none" maxlength="24"></div>
      </div>`;
    if (thumb) row.querySelector('img').src = thumb;
    else getPropImage(d.img).then((b) => { if (b) { const u = URL.createObjectURL(b); propThumbs.set(d.img, u); row.querySelector('img').src = u; } });
    row.querySelector('.nm').textContent = propLabels[d.id] || 'Prop';
    row.querySelector('.nm').onclick = () => selectProp(selectedProp === d.id ? null : d.id);
    row.querySelector('img').onclick = () => selectProp(d.id);
    row.querySelector('[data-a=vis]').onclick = () => updateProp(d.id, { visible: !d.visible });
    row.querySelector('[data-a=lock]').onclick = () => { updateProp(d.id, { locked: !d.locked }); if (d.locked && selectedProp === d.id) selectProp(null); };
    row.querySelector('[data-a=hk]').onclick = () => bindHotkey('prop:' + d.id, `Hotkey to show / hide “${propLabels[d.id] || 'prop'}”`);
    row.querySelector('[data-a=del]').onclick = () => removeProp(d.id);
    row.querySelector('[data-a=up]').onclick = () => { props.splice(i, 1); props.splice(i - 1, 0, d); commitProps(); };
    row.querySelector('[data-a=down]').onclick = () => { props.splice(i, 1); props.splice(i + 1, 0, d); commitProps(); };
    row.querySelector('[data-k=draw]').onchange = (e) => { updateProp(d.id, { draw: e.target.value }); renderPlacement(); };
    // changing what it hangs from (or how it follows) keeps the prop where it is on screen
    const keepPlace = (patch) => updateProp(d.id, { ...patch, pos: stage.props.posKeepingPlace(d.id, patch) || d.pos }, { rebuild: 'attach' in patch });
    row.querySelector('[data-k=attach]').onchange = (e) => {
      const attach = e.target.value;
      // to / from the viewer's screen: positions mean something else there, start somewhere sensible
      if (attach === 'screen') return updateProp(d.id, { attach, pos: [0.5, 0.4, 0], size: 0.18 }, { rebuild: true }), renderPlacement();
      if (d.attach === 'screen') return updateProp(d.id, { attach, pos: attach === 'scene' ? [0.35, 1.35, 0.1] : [0, 0.1, 0.1], size: 0.2 }, { rebuild: true }), renderPlacement();
      keepPlace({ attach });
    };
    row.querySelector('[data-k=w]').oninput = (e) => keepPlace({ w: Number(e.target.value) });
    row.querySelector('[data-k=fp]').onchange = (e) => keepPlace({ fp: e.target.checked });
    row.querySelector('[data-k=fr]').onchange = (e) => keepPlace({ fr: e.target.checked });
    row.querySelector('[data-k=face]').onchange = (e) => updateProp(d.id, { face: e.target.checked });
    row.querySelector('[data-k=flip]').onchange = (e) => updateProp(d.id, { flip: e.target.checked });
    row.querySelector('[data-k=size]').oninput = (e) => updateProp(d.id, { size: 2 ** Number(e.target.value) });
    row.querySelector('[data-k=rot]').oninput = (e) => updateProp(d.id, { rot: -Number(e.target.value) / DEG });
    row.querySelector('[data-k=rx]').oninput = (e) => updateProp(d.id, { rx: Number(e.target.value) / DEG });
    row.querySelector('[data-k=ry]').oninput = (e) => updateProp(d.id, { ry: Number(e.target.value) / DEG });
    row.querySelector('[data-k=z]').oninput = (e) => updateProp(d.id, { pos: [d.pos[0], d.pos[1], Number(e.target.value)] });
    row.querySelector('[data-k=group]').onchange = (e) => { updateProp(d.id, { group: e.target.value.trim() || null }, { rebuild: true }); applyHotkeys(); };
    list.appendChild(row);
  });
  renderGroups();
  syncPropInputs();
  refreshHotkeyBadges();
}
function renderGroups() {
  const names = groupNames(), box = $('propGroups');
  box.hidden = !names.length;
  box.querySelector('.list').innerHTML = '';
  for (const g of names) {
    const members = props.filter((p) => p.group === g);
    const row = document.createElement('div');
    row.className = 'grow'; row.dataset.group = g;
    row.innerHTML = `<span class="gname"></span><span class="muted"> · ${members.length}</span>
      <button data-a="gvis"></button><button data-a="ghk" class="hk"></button>`;
    row.querySelector('.gname').textContent = g;
    row.querySelector('[data-a=gvis]').textContent = members.some((p) => p.visible) ? 'Hide all' : 'Show all';
    row.querySelector('[data-a=gvis]').onclick = () => { toggleGroup(g); renderGroups(); };
    row.querySelector('[data-a=ghk]').onclick = () => bindHotkey('group:' + g, `Hotkey to show / hide every prop in “${g}”`);
    box.querySelector('.list').appendChild(row);
  }
}
function syncPropInputs() {
  document.querySelectorAll('#propList .prop').forEach((row) => {
    const d = props.find((p) => p.id === row.dataset.id);
    if (!d) return;
    row.querySelector('[data-a=vis]').textContent = d.visible ? 'Hide' : 'Show';
    row.querySelector('[data-a=lock]').textContent = d.locked ? '🔒' : '🔓';
    row.querySelector('[data-a=lock]').classList.toggle('on', !!d.locked);
    row.style.opacity = d.visible ? '' : '.6';
    const set = (k, v) => { const el = row.querySelector(`[data-k=${k}]`); if (el && document.activeElement !== el) { if (el.type === 'checkbox') el.checked = v; else if (el.tagName === 'B') el.textContent = v; else el.value = v; } };
    set('attach', d.attach); set('face', !!d.face); set('flip', !!d.flip);
    set('w', d.w); set('fp', d.fp); set('fr', d.fr); set('draw', d.draw); set('group', d.group || '');
    set('size', LOG2(d.size)); set('rot', Math.round(-(d.rot || 0) * DEG)); set('rx', Math.round(d.rx * DEG)); set('ry', Math.round(d.ry * DEG)); set('z', d.pos[2]);
    row.querySelector('.follow').hidden = d.attach === 'scene' || d.attach === 'screen';
    const onScreen = d.attach === 'screen';
    // screen props always face the viewer: no rotation / facing settings; distance only matters "by distance"
    row.querySelector('[data-k=z]').closest('.slider').hidden = onScreen || d.draw !== 'depth';
    row.querySelector('[data-k=face]').closest('label').hidden = onScreen;
    for (const k of ['rot', 'rx', 'ry']) row.querySelector(`[data-k=${k}]`).closest('.slider').hidden = onScreen;
    row.querySelector('[data-k=draw] option[value=depth]').hidden = onScreen;
  });
  document.querySelectorAll('#propGroups .grow').forEach((row) => {
    const members = props.filter((p) => p.group === row.dataset.group);
    row.querySelector('[data-a=gvis]').textContent = members.some((p) => p.visible) ? 'Hide all' : 'Show all';
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
// locked props (or all of them with "Lock all") can't be grabbed, resized or rotated in the preview
let propsLocked = !!settings.propsLocked;
const pickProp = (e) => (propsLocked ? null : stage.props.pick(rayAt(e), (d) => !props.find((p) => p.id === d.id)?.locked));
$('lockAll').onclick = () => {
  propsLocked = settings.propsLocked = !propsLocked; saveSettings(); showLockAll();
  if (propsLocked) selectProp(null);
};
function showLockAll() {
  $('lockAll').textContent = propsLocked ? '🔒 All props locked' : '🔓 Lock all';
  $('lockAll').classList.toggle('on', propsLocked);
}
showLockAll();
// pulling hair / clothes: your own pulls are shown to every viewer
const grabber = new SpringGrabber(stage, canvas, { send: (j, p) => broadcastControl({ t: 'grab', k: 'b', j, p }) });
let propDrag = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const hit = pickProp(e);
  if (!hit) {
    selectProp(null);
    if (grabber.begin(e)) { canvas.setPointerCapture(e.pointerId); canvas.style.cursor = 'grabbing'; }
    return;
  }
  selectProp(hit.id);
  canvas.setPointerCapture(e.pointerId);
  const normal = stage.camera.getWorldDirection(new THREE.Vector3());
  propDrag = { id: hit.id, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point), start: hit.point.clone(), startWorld: stage.props.worldPosition(hit.id) };
  canvas.style.cursor = 'grabbing';
});
canvas.addEventListener('pointermove', (e) => {
  if (grabber.grabbing) { grabber.move(e); return; }
  if (propDrag) {
    const p = rayAt(e).ray.intersectPlane(propDrag.plane, new THREE.Vector3());
    if (!p) return;
    const world = propDrag.startWorld.clone().add(p.sub(propDrag.start));
    const pos = stage.props.posForWorld(propDrag.id, world);
    if (pos) updateProp(propDrag.id, { pos });
    return;
  }
  if (!viewDrag) canvas.style.cursor = pickProp(e) || grabber.over(e) >= 0 ? 'grab' : '';
});
const endPropDrag = () => {
  if (grabber.grabbing) { grabber.end(); canvas.style.cursor = ''; }
  if (propDrag) { propDrag = null; canvas.style.cursor = ''; }
};
canvas.addEventListener('pointerup', endPropDrag);
canvas.addEventListener('pointercancel', endPropDrag);
window.addEventListener('keydown', (e) => {
  if (!selectedProp || e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Delete') removeProp(selectedProp);
});

(async () => {
  const saved = await idbGet('props');
  if (saved?.list?.length) { props = saved.list.map(normalizeProp); propLabels = saved.labels || {}; commitProps(); applyHotkeys(); }
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
      // arm/hand tracking needs more pixels (hands are small in the image); face alone is fine at 480p
      video: { deviceId: settings.camId ? { exact: settings.camId } : undefined, ...(settings.arms ? { width: 1280, height: 720 } : { width: 640, height: 480 }), frameRate: 30 },
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

// ---- hold the last pose when you leave the frame / turn away ----
// When the face disappears we look at the last frames before it did: if the face was touching (or
// moving toward) the edge of the image, or the head was turned / tilted far, you've gone out of view
// on purpose → keep sending that last pose. If it vanished in the middle of the frame while facing
// the camera (bad light, hand over the face…), behave as before and ease back to rest.
const HOLD_EDGE = 0.04, HOLD_YAW = 32 * Math.PI / 180, HOLD_PITCH = 26 * Math.PI / 180;
let lastGood = null; // { frame, box:{x0,y0,x1,y1}, cx, cy, vx, vy, yaw, pitch, t }
let holding = false;
function shouldHold(g, nowMs) {
  if (!g || nowMs - g.t > 1500) return false; // stale: we'd been without a face for a while already
  const { box } = g;
  if (box.x0 < HOLD_EDGE || box.y0 < HOLD_EDGE || box.x1 > 1 - HOLD_EDGE || box.y1 > 1 - HOLD_EDGE) return true;
  const px = g.cx + g.vx * 0.25, py = g.cy + g.vy * 0.25; // where the face was heading (¼ s ahead)
  const hw = (box.x1 - box.x0) / 2, hh = (box.y1 - box.y0) / 2;
  if (px - hw < 0 || px + hw > 1 || py - hh < 0 || py + hh > 1) return true;
  return Math.abs(g.yaw) > HOLD_YAW || Math.abs(g.pitch) > HOLD_PITCH;
}
function holdFrame() {
  const f = lastGood.frame;
  const b = f.b.slice();
  for (const i of BLINK_IDX) b[i] = 0; // viewers blink on their own while holding
  return { ...f, b, h: true, x: activeExpr, ae: settings.autoExpr };
}

function buildFrame(result, nowMs) {
  const face = !!(result.faceBlendshapes?.length && result.facialTransformationMatrixes?.length);
  if (!face) {
    prevQ = null; filters.head.reset(); filters.face.reset();
    if (holding || shouldHold(lastGood, nowMs)) { holding = true; return holdFrame(); }
    lastGood = null;
    return { t: 'm', f: false, x: activeExpr, ae: settings.autoExpr };
  }
  holding = false;
  const t = nowMs / 1000;

  // --- head pose ---
  tmpM.fromArray(result.facialTransformationMatrixes[0].data);
  const rawQ = new THREE.Quaternion(), rawP = new THREE.Vector3();
  tmpM.decompose(rawP, rawQ, tmpS);
  lastRaw = { q: rawQ.clone(), p: rawP.clone() };
  if (!calib.pos) { calib.pos = rawP.clone(); } // first frame = default centre (rotation stays absolute until calibrated)
  const q = calib.qInv.clone().multiply(rawQ);
  const p = rawP.clone().sub(calib.pos).multiplyScalar(0.01); // cm -> m
  const eul = new THREE.Euler().setFromQuaternion(q, 'YXZ'); // for the "turned away" check
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
  // Auto expressions use their expression's tuning too, as strongly as the expression shows. They're
  // read here, before the tuning, so e.g. tuning the smile away for "happy" doesn't switch happy off.
  const auto = autoExpression(b, style.ag);
  autoScores = auto.scores;
  const ax = settings.autoExpr && !activeExpr ? auto.top : null;
  const tuneName = activeExpr || ax?.[0], tw = activeExpr ? 1 : Math.min(1, (ax?.[1] || 0) * 2);
  const tune = tuneName && settings.exprTune[tuneName];
  if (tune) {
    const mul = (v) => 1 + (v - 1) * tw;
    for (const i of MOUTH_IDX) b[i] = Math.min(1, b[i] * mul(tune.mouth));
    for (const i of BLINK_IDX) b[i] = Math.min(1, b[i] * mul(tune.blink));
  }
  // hard limits (after every sensitivity): the mouth / eyelids never go past these
  if (settings.mouthMax < 1) for (const i of MOUTH_IDX) b[i] = Math.min(settings.mouthMax, b[i]);
  if (settings.blinkMax < 1) for (const i of BLINK_IDX) b[i] = Math.min(settings.blinkMax, b[i]);

  const frame = {
    t: 'm', f: true, x: activeExpr, ae: settings.autoExpr, ax: ax && [ax[0], +ax[1].toFixed(3)],
    q: q.toArray().map((v) => +v.toFixed(4)),
    p: p.toArray().map((v) => +v.toFixed(4)),
    b: b.map((v) => +Math.max(0, v).toFixed(3)),
  };
  // remember where the face was (image space) for the out-of-frame check
  const lm = result.faceLandmarks?.[0];
  if (lm?.length) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const pt of lm) { if (pt.x < x0) x0 = pt.x; if (pt.x > x1) x1 = pt.x; if (pt.y < y0) y0 = pt.y; if (pt.y > y1) y1 = pt.y; }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    const dt = lastGood ? Math.max(0.001, (nowMs - lastGood.t) / 1000) : 0;
    const k = 0.4; // smoothed velocity (image widths per second)
    const vx = lastGood && dt < 0.3 ? lastGood.vx + ((cx - lastGood.cx) / dt - lastGood.vx) * k : 0;
    const vy = lastGood && dt < 0.3 ? lastGood.vy + ((cy - lastGood.cy) / dt - lastGood.vy) * k : 0;
    lastGood = { frame, box: { x0, y0, x1, y1 }, cx, cy, vx, vy, yaw: eul.y, pitch: eul.x, t: nowMs };
  }
  return frame;
}

// Timer-driven, not requestAnimationFrame: animation frames stop when this window is minimised or
// covered (e.g. by a game), which used to freeze the avatar on the viewers' side.
let frameSeq = 0, lastArms = null;
const armTracker = new ArmTracker(settings.armSmoothing);
let paused = false, lastPausedSend = 0;
// A black camera image (lens covered, camera switched off in hardware, lights off) means you're away:
// the face is lost, but a pose held because you stepped out of frame is dropped too, so full-screen
// viewers start their "away" countdown. Checked twice a second on a tiny copy of the frame.
const blackCheck = { canvas: null, ctx: null, at: 0, since: 0, black: false };
function cameraIsBlack(now) {
  if (now - blackCheck.at < 500) return blackCheck.black;
  blackCheck.at = now;
  if (!blackCheck.canvas) {
    blackCheck.canvas = document.createElement('canvas'); blackCheck.canvas.width = 32; blackCheck.canvas.height = 18;
    blackCheck.ctx = blackCheck.canvas.getContext('2d', { willReadFrequently: true });
  }
  let max = 255;
  try {
    blackCheck.ctx.drawImage(video, 0, 0, 32, 18);
    const px = blackCheck.ctx.getImageData(0, 0, 32, 18).data;
    max = 0;
    for (let i = 0; i < px.length; i += 4) { const l = px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11; if (l > max) max = l; }
  } catch { return blackCheck.black; }
  const dark = max < 22; // even the brightest pixel is nearly black
  if (!dark) { blackCheck.since = 0; blackCheck.black = false; }
  else if (!blackCheck.since) blackCheck.since = now;
  else if (now - blackCheck.since > 1500) blackCheck.black = true;
  return blackCheck.black;
}

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
  if (cameraIsBlack(now)) {
    holding = false; lastGood = null; lastArms = null; prevQ = null;
    const frame = { t: 'm', f: false, x: activeExpr, ae: settings.autoExpr };
    stage.setMotion(frame);
    if (lastFace !== 'black') { lastFace = 'black'; setTrack('warn', 'Camera image is black (counts as away)'); }
    sendFrame(frame, now);
    return;
  }
  const frame = buildFrame(landmarker.detectForVideo(video, now), now);
  if (settings.arms && poseLandmarker && handLandmarker) {
    try {
      frame.a = buildArmPayload(poseLandmarker.detectForVideo(video, now), handLandmarker.detectForVideo(video, now), settings.mirror, armTracker, now);
    } catch (err) { console.warn('arm tracking', err); }
    if (frame.h && !frame.a) frame.a = lastArms; // out of frame: keep the arms where they were too
    if (frame.f && !frame.h && frame.a) lastArms = frame.a;
  }
  stage.setMotion(frame);
  const state = frame.h ? 'hold' : frame.f;
  if (state !== lastFace) {
    lastFace = state;
    if (state === 'hold') setTrack('warn', 'Out of view, holding your last pose');
    else setTrack(frame.f ? 'ok' : 'warn', frame.f ? 'Tracking' : 'No face detected');
  }

  sendFrame(frame, now);
}

function sendFrame(frame, now, force = false) {
  if (force || now - lastSend >= SEND_INTERVAL_MS) {
    lastSend = now;
    frame.n = ++frameSeq; // lets viewers ignore frames that arrive late / out of order
    toOutput(frame);
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
  $('pauseBtn').textContent = on ? '▶︎ Resume tracking' : '⏸︎ Pause tracking';
  $('pauseBtn').classList.toggle('on', on);
  $('pausedBanner').hidden = !on;
  if (on) {
    stream?.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
    setTrack('warn', 'Tracking paused');
  } else {
    filters.head.reset(); filters.face.reset(); prevQ = null; lastFace = null; lastGood = null; holding = false; lastArms = null; armTracker.reset();
    const ok = await openCamera();
    // the tracking loop may already have found your face while the camera was starting,
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
