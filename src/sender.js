// Sender: webcam -> MediaPipe tracking -> motion frames -> WebRTC to every viewer.
// The webcam image never leaves this page; only numbers are sent.
import * as THREE from 'three';
import { FaceLandmarker, PoseLandmarker, HandLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import { AvatarStage, autoExpression, ExprBaseline } from './shared/avatar.js';
import {
  ARKIT, PEER_PREFIX, HOTKEY_EXPRESSIONS, MODEL_CHUNK, DEFAULT_POS, DEFAULT_VIEW, AVATAR_ASPECT, effectiveZone,
  VISEMES, AUTO_EXPR, POSES, DEFAULT_STYLE, DEFAULT_FX, normalizeStyle, IS_DEV, DEV_CODE,
  HEARTBEAT_MS, HEARTBEAT_TIMEOUT_MS, MOTION_MAX_BUFFERED, peerOptions,
} from './shared/protocol.js';
import { buildArmPayload, ArmTracker } from './shared/arms.js';
import { OneEuroArray } from './shared/filters.js';
import { PROP_ATTACH, DRAW_MODES, normalizeProp } from './shared/props.js';
import { SpringGrabber } from './shared/grab.js';
import { Room, rowLayout, rowPos, ownView, roomView, SLOT_STEP, MAX_MODELS } from './shared/room.js';

const $ = (id) => document.getElementById(id);
const MODEL_URLS = {
  face: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  pose: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task',
  hand: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
};
const SEND_INTERVAL_MS = 33; // ~30 Hz
// Co-host mode (multi-model rooms): this page joins someone else's room with its own avatar instead of
// hosting one. Started from the start screen's "Join with my avatar".
const PAGE = new URLSearchParams(location.search);
const GUEST_CODE = (PAGE.get('join') || '').toUpperCase();
const GUEST = !!GUEST_CODE;
const GUEST_NAME = (PAGE.get('name') || '').slice(0, 24);
// Hosting a room with co-hosts (start screen: "With co-hosts"). A normal broadcast takes no co-hosts.
// "OBS only": only the camera output, nothing goes to viewers; co-hosts can still join (then a code is needed).
const OBS_ONLY = !GUEST && PAGE.has('obs');
const ROOM_MODE = !GUEST && (PAGE.has('room') || OBS_ONLY);
const ROOM_START = Number(PAGE.get('room') || PAGE.get('obs')) || 0; // dev: how many avatars to start with
if (GUEST) document.body.classList.add('guest');
let room = null;  // the other avatars in the room, drawn beside yours in the preview (set up below)
let myId = GUEST ? null : 'h'; // which avatar is yours in the room ('h' = the host)
// room state (declared early: settings applied at start-up already broadcast through it)
const members = new Map(); // co-hosts by peer id: { id:'c1'…, name, model, motion, modelId, modelBuf, style, props, perm, lastHeard, incoming }
let memberSeq = 0;
let order = ['h'];
let host = null; // a co-host's connection to the host: { peer, model, motion, lastHeard }
let guestRetry = null, guestStopped = false, guestViewers = [];

// ---------------- settings ----------------
const settings = loadSettings();
function loadSettings() {
  const defaults = { v: 2, mirror: true, swapLR: true, hideCam: false, autoExpr: true, arms: false, linkEyes: false, smoothing: 0.5, mouthGain: 1.6, blinkGain: 1.5, bodyX: 1, bodyY: 1, bodyZ: 0.5, mouthMax: 1, blinkMax: 1, armSmoothing: 0.6, viewerGrab: false, viewerPat: true, viewerSlap: false, voiceMouth: false, voiceGain: 1, micId: '', roomModels: 1, freePlace: false, exprCal: {}, exprTune: {}, maxViewers: 0, camId: '', style: DEFAULT_STYLE, models: {}, lightPresets: {} };
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
  $('sensFor').textContent = `Saved for “${name}”${prof ? '' : ' (copied from your current settings)'}.`;
  saveSettings();
}
const applyToggles = () => {
  document.body.classList.toggle('camHidden', settings.hideCam);
  $('armsHint').hidden = !settings.arms;
  $('armSmoothRow').hidden = !settings.arms;
  if (settings.arms) initBodyTrackers();
};
// which spring chains wiggle on a slap (per model; default: the ones near the bottom)
function renderSlapBones() {
  const box = $('slapBones');
  const chains = stage.vrm ? stage.fx.chainList() : [];
  const pick = style.sb && style.sb.id === modelId ? new Set(style.sb.roots) : null;
  $('slapAuto').checked = !pick;
  if (!chains.length) { box.innerHTML = `<div class="muted hint">${stage.vrm ? 'This avatar has no spring bones.' : 'Load an avatar first.'}</div>`; return; }
  const seen = new Map();
  box.innerHTML = chains.map((c) => {
    const n = (seen.get(c.name) || 0) + 1; seen.set(c.name, n);
    const esc = c.name.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
    return n > 1 ? '' : `<label class="toggle"><span>${esc} <span class="muted">(${c.joints})</span></span><input type="checkbox" data-root="${esc}" ${pick?.has(c.name) ? 'checked' : ''} ${pick ? '' : 'disabled'}></label>`;
  }).join('');
}
function setSlapRoots(roots) { // null = auto
  if (!modelId) return;
  settings.slapRoots = settings.slapRoots || {};
  if (roots) settings.slapRoots[modelId] = roots; else delete settings.slapRoots[modelId];
  updateStyle({ sb: roots ? { id: modelId, roots } : null });
}
$('slapAuto').onchange = () => {
  // switching Auto off starts from what Auto was picking, so nothing changes until you untick something
  if ($('slapAuto').checked) setSlapRoots(null);
  else { stage.fx.slap(); stage.fx.slapAt = -1e9; setSlapRoots([...new Set((stage.fx.slapChains || []).map((c) => c[0].bone.name || 'chain'))]); }
  renderSlapBones();
};
$('slapBones').addEventListener('change', (e) => {
  const cb = e.target.closest('[data-root]');
  if (!cb || !modelId) return;
  const roots = new Set(style.sb?.id === modelId ? style.sb.roots : []);
  if (cb.checked) roots.add(cb.dataset.root); else roots.delete(cb.dataset.root);
  setSlapRoots([...roots]);
});
queueMicrotask(renderSlapBones); // once the preview exists
$('slapTest').onclick = () => { stage.fx.slap(); toOutput({ t: 'fx', k: 'slap' }); };

const permMsg = () => ({ t: 'perm', grab: !!settings.viewerGrab, pat: !!settings.viewerPat, slap: !!settings.viewerSlap });
for (const k of ['mirror', 'swapLR', 'hideCam', 'autoExpr', 'arms', 'linkEyes', 'viewerGrab', 'viewerPat', 'viewerSlap']) {
  $(k).checked = settings[k];
  $(k).onchange = () => {
    settings[k] = $(k).checked; saveSettings(); applyToggles();
    if (k === 'arms' && !paused) openCamera(); // switch camera resolution (720p for hands)
    if (k === 'viewerGrab') setViewerGrab(settings.viewerGrab);
    if (k === 'viewerPat' || k === 'viewerSlap') broadcastControl(permMsg());
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
  // after any panel opens / closes, make the sidebar re-measure how far it can scroll (some Windows
  // setups kept the old, shorter range after closing everything and opening it again)
  const aside = document.querySelector('aside');
  aside.addEventListener('toggle', () => requestAnimationFrame(() => {
    const top = aside.scrollTop;
    aside.style.overflowY = 'hidden'; void aside.offsetHeight; aside.style.overflowY = '';
    aside.scrollTop = top;
  }), true);
  document.querySelectorAll('details.sec[data-sec]').forEach((d) => {
    if (open[d.dataset.sec] !== undefined) d.open = open[d.dataset.sec];
    d.addEventListener('toggle', () => { open[d.dataset.sec] = d.open; try { localStorage.setItem('vt-sections', JSON.stringify(open)); } catch {} });
  });
}

// ---------------- avatar preview + view controls (viewers see the same framing) ----------------
const stage = new AvatarStage($('stage'), { maxFps: 60 }); // no need to draw the preview at 144 Hz on fast monitors
let view = stage.setView(loadJSON('vt-view', DEFAULT_VIEW));
window.vtStage = stage; // handy from the dev tools (and for tests)
function loadJSON(k, d) { try { return { ...d, ...JSON.parse(localStorage.getItem(k) || '{}') }; } catch { return { ...d }; } }

let viewSendTimer = null;
// In a room, framing (bust / full body) and roll are the host's; zoom, move and turn only move your own avatar.
let hostView = null; // co-host: the host's whole view (its framing + roll, and how its own avatar is shown)
function updateView(patch, fromHost = false) {
  if (GUEST) {
    if (fromHost) { hostView = { ...patch }; patch = roomView(patch); }
    else { patch = { ...patch }; delete patch.fr; delete patch.roll; }
  }
  view = stage.setView({ ...view, ...patch });
  if (room) { room.setView(GUEST ? hostView || view : view); layoutNeighbors(); }
  if (fromHost) { $('frBtn').textContent = 'Framing: ' + (view.fr === 'full' ? 'Full body' : 'Bust'); return; }
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
let hostLight = null; // co-host: the host's lighting
let styleSendTimer = null;
function updateStyle(patch) {
  style = stage.setStyle({ vg: { ...style.vg, ...patch.vg }, vm: { ...style.vm, ...patch.vm }, ag: { ...style.ag, ...patch.ag }, light: { ...style.light, ...patch.light }, fx: { ...style.fx, ...patch.fx }, pose: patch.pose ?? style.pose, sb: 'sb' in patch ? patch.sb : style.sb });
  if (GUEST && hostLight) stage.setStyle({ ...style, light: hostLight }); // the room's lighting is the host's
  if (!GUEST && room) room.setHostLight(style.light); // …so the co-hosts beside you get yours
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
  `<div class="slider dual"><span>${l} <output id="agOut_${k}"></output></span><input type="range" id="ag_${k}" min="0" max="3" step="0.05" title="Sensitivity"><span class="meter" title="Read from your face now (the line is where it starts to show)"><i id="agBar_${k}"></i><b></b></span></div>` +
  `<div class="calRow"><button class="mini" id="cal_${k}" title="Make this face as you'd normally do it, then click: that becomes your full ${l.toLowerCase()}">Calibrate</button><button class="mini" id="calReset_${k}">Reset</button><span class="muted" id="calText_${k}"></span></div>`).join('');
for (const [k] of AUTO_EXPR) $('ag_' + k).oninput = (e) => updateStyle({ ag: { [k]: +e.target.value } });
$('autoReset').onclick = () => updateStyle({ ag: DEFAULT_STYLE.ag });
// calibration: you make the face, it records how strongly your face reads it, which then counts as "full"
let autoRaw = null, calibrating = null; // calibrating = { k, vals, until }
function showCal() {
  for (const [k] of AUTO_EXPR) {
    const on = settings.exprCal[k] > 0, busy = calibrating?.k === k;
    $('calReset_' + k).hidden = !on || busy;
    $('cal_' + k).disabled = !!calibrating && !busy;
    if (!busy) { $('cal_' + k).textContent = on ? 'Recalibrate' : 'Calibrate'; $('calText_' + k).textContent = on ? 'calibrated' : ''; }
  }
}
for (const [k, label] of AUTO_EXPR) {
  $('cal_' + k).onclick = () => {
    if (calibrating) return;
    calibrating = { k, vals: [], until: performance.now() + 2500 };
    $('cal_' + k).textContent = 'Hold it…';
    $('calText_' + k).textContent = 'make your ' + label.toLowerCase() + ' face';
    showCal();
    const tick = setInterval(() => {
      if (performance.now() < calibrating.until) return;
      clearInterval(tick);
      const v = calibrating.vals.sort((a, b) => a - b), ok = v.length >= 5 ? v[Math.floor(v.length * 0.75)] : 0;
      calibrating = null;
      if (ok > 0.05) { settings.exprCal[k] = +ok.toFixed(4); saveSettings(); showCal(); }
      else { showCal(); $('calText_' + k).textContent = v.length < 5 ? 'no face seen, try again' : "couldn't see it, try a stronger face"; }
    }, 100);
  };
  $('calReset_' + k).onclick = () => { delete settings.exprCal[k]; saveSettings(); showCal(); };
}
showCal();
// ---- mouth from the microphone (optional) ----
const voice = { an: null, ctx: null, stream: null, td: null, fd: null, level: 0, tone: 0.5, at: 0 };
const VOICE_IDX = { funnel: ARKIT.indexOf('mouthFunnel'), sl: ARKIT.indexOf('mouthStretchLeft'), sr: ARKIT.indexOf('mouthStretchRight') };
async function startVoice() {
  stopVoice();
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: settings.micId ? { exact: settings.micId } : undefined, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const ctx = new AudioContext(), an = ctx.createAnalyser();
    an.fftSize = 1024; an.smoothingTimeConstant = 0.2;
    ctx.createMediaStreamSource(stream).connect(an);
    Object.assign(voice, { stream, ctx, an, td: new Float32Array(an.fftSize), fd: new Float32Array(an.frequencyBinCount), level: 0, at: performance.now() });
    listMics();
  } catch (err) {
    settings.voiceMouth = false; $('voiceMouth').checked = false; $('voiceRow').hidden = true; saveSettings();
    alert('Could not open the microphone: ' + err.message);
  }
}
function stopVoice() {
  voice.stream?.getTracks().forEach((tr) => tr.stop());
  voice.ctx?.close().catch(() => {});
  Object.assign(voice, { an: null, ctx: null, stream: null, level: 0 });
  $('voiceMeter').style.width = '0';
}
/** How loud you're talking (0..1) and how bright it sounds, read from the microphone right now. */
function readVoice() {
  const now = performance.now(), dt = Math.min(0.2, (now - voice.at) / 1000); voice.at = now;
  voice.an.getFloatTimeDomainData(voice.td);
  let sum = 0; for (const x of voice.td) sum += x * x;
  const db = 10 * Math.log10(sum / voice.td.length + 1e-12);
  const target = Math.min(1, Math.max(0, (db + 52) / 28) * settings.voiceGain);
  voice.level += (target - voice.level) * (1 - Math.exp(-dt * (target > voice.level ? 30 : 12))); // opens fast, closes a bit slower
  // brightness (spectral centroid, 150 Hz..4 kHz): dark sounds round the lips, bright ones stretch them
  voice.an.getFloatFrequencyData(voice.fd);
  const hz = voice.ctx.sampleRate / voice.an.fftSize;
  let wsum = 0, msum = 0;
  for (let i = Math.floor(150 / hz); i < Math.min(voice.fd.length, Math.ceil(4000 / hz)); i++) { const m = 10 ** (voice.fd[i] / 20); wsum += m * i * hz; msum += m; }
  const tone = msum > 0 ? Math.min(1, Math.max(0, (wsum / msum - 600) / 1400)) : 0.5;
  voice.tone += (tone - voice.tone) * (1 - Math.exp(-dt * 10));
  $('voiceMeter').style.width = Math.round(voice.level * 100) + '%';
}
function applyVoice(b) {
  readVoice();
  const L = voice.level;
  if (L < 0.02) return;
  b[JAW_IDX] = Math.max(b[JAW_IDX], L * 0.75);
  b[VOICE_IDX.funnel] = Math.max(b[VOICE_IDX.funnel], L * 0.45 * (1 - voice.tone));
  const st = L * 0.4 * voice.tone;
  b[VOICE_IDX.sl] = Math.max(b[VOICE_IDX.sl], st); b[VOICE_IDX.sr] = Math.max(b[VOICE_IDX.sr], st);
}
async function listMics() {
  const devs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  $('micSel').innerHTML = devs.map((d, i) => `<option value="${d.deviceId}">${(d.label || 'Microphone ' + (i + 1)).replace(/</g, '&lt;')}</option>`).join('');
  const cur = voice.stream?.getAudioTracks()[0]?.getSettings().deviceId;
  $('micSel').value = settings.micId && devs.some((d) => d.deviceId === settings.micId) ? settings.micId : (cur || '');
}
$('voiceMouth').checked = settings.voiceMouth;
$('voiceRow').hidden = !settings.voiceMouth;
$('voiceGain').value = settings.voiceGain;
$('voiceMouth').onchange = () => {
  settings.voiceMouth = $('voiceMouth').checked; saveSettings();
  $('voiceRow').hidden = !settings.voiceMouth;
  if (settings.voiceMouth) startVoice(); else stopVoice();
};
$('voiceGain').oninput = () => { settings.voiceGain = +$('voiceGain').value; saveSettings(); };
$('micSel').onchange = () => { settings.micId = $('micSel').value; saveSettings(); startVoice(); };
// the meter keeps moving even while no face is tracked, so you can set it up
setInterval(() => { if (voice.an && performance.now() - voice.at > 120) readVoice(); }, 100);
if (settings.voiceMouth) startVoice();

// ---- Performance panel ----
const perfStart = new Map(); // part → memory the first time it was seen
async function showPerf() {
  if (!document.querySelector('[data-sec=perf]').open || !window.vt.appMetrics) return;
  const list = await window.vt.appMetrics().catch(() => null);
  if (!list) return;
  const by = new Map();
  for (const p of list) { const o = by.get(p.name) || { mb: 0, cpu: 0 }; o.mb += p.mb; o.cpu += p.cpu; by.set(p.name, o); }
  const now = performance.now();
  const rows = [...by].sort((a, b) => b[1].mb - a[1].mb).map(([name, o]) => {
    if (!perfStart.has(name)) perfStart.set(name, { mb: o.mb, at: now });
    const s = perfStart.get(name), grew = o.mb - s.mb, mins = (now - s.at) / 60000;
    const trend = mins >= 1 && Math.abs(grew) >= 20 ? ` <span style="color:${grew > 0 ? 'var(--warn)' : 'inherit'}">${grew > 0 ? '+' : ''}${grew} MB in ${Math.round(mins)} min</span>` : '';
    return `<div class="row" style="justify-content:space-between;gap:8px"><span>${name}</span><span>${o.mb} MB · ${o.cpu.toFixed(1)}% CPU${trend}</span></div>`;
  });
  const total = [...by.values()].reduce((a, o) => a + o.mb, 0);
  $('perfRows').innerHTML = rows.join('') + `<div class="row" style="justify-content:space-between;margin-top:4px"><b>Total</b><b>${total} MB</b></div>`;
}
setInterval(showPerf, 4000);
document.querySelector('[data-sec=perf]').addEventListener('toggle', showPerf);

let autoScores = null; // what the auto expressions read from your face (set per tracked frame)
const exprBase = new ExprBaseline(); // your relaxed face, learned as you go
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
const FX_INPUTS = { fxBy: 'by', fxBz: 'bz', fxBs: 'bs', fxHy: 'hy', fxHz: 'hz', fxHs: 'hs', fxNy: 'ny', fxNz: 'nz', fxNs: 'ns' };
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
// reset buttons: Position / Size / Rotation / All
function resetButtons(container, onPick) {
  container.addEventListener('click', (e) => { const b = e.target.closest('[data-reset]'); if (b) onPick(b.dataset.reset); });
}
resetButtons(document.querySelector('#viewTools .btns'), (what) => {
  const D = DEFAULT_VIEW;
  if (what === 'pos') updateView({ px: D.px, py: D.py });
  else if (what === 'size') updateView({ zoom: D.zoom });
  else if (what === 'rot') updateView({ yaw: D.yaw, el: D.el });
  else updateView({ ...D, fr: view.fr });
  showRoll();
});


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
    const roots = (settings.slapRoots || {})[id];
    updateStyle({ sb: Array.isArray(roots) ? { id, roots } : null });
    renderSlapBones();
    $('empty').hidden = true;
    $('modelName').textContent = name;
    $('modelName').classList.remove('muted');
    $('syncBadge').hidden = !info.perfectSync;
    buildExpressionButtons(info.expressions);
    storeLastModel(buf, name);
    for (const v of viewers.values()) if (v.model?.open) offerModel(v);
    for (const m of members.values()) sendToMember(m, { t: 'model-use', id });
    ownToOutput({ t: 'model', id, buf: buf.slice(0) });
    uploadModel();
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
    if (!viewers.size) setNet('ok', OBS_ONLY ? obsNetText() : 'Online, waiting for viewers');
  });
  p.on('connection', (conn) => {
    if (conn.metadata?.role === 'member') { acceptMember(conn); return; } // someone joining with their own avatar
    if (OBS_ONLY) { // no viewers in this mode
      conn.on('open', () => { if (conn.label === 'model') { try { conn.send({ t: 'bye', reason: 'obs-only' }); } catch {} } setTimeout(() => conn.close(), 500); });
      return;
    }
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
if (GUEST) showCode(GUEST_CODE);
else if (!OBS_ONLY) startPeer(DEV_CODE || undefined); // dev: the code `npm run dev` gave both windows (OBS only: see syncObsPeer)
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
  if (fromId === 'mirror') { if (outputOpen) { try { outCh.postMessage(msg); } catch {} } } // the mirror did it itself
  else toOutput(msg);
  for (const [id, v] of viewers) if (id !== fromId && v.model?.open) { try { v.model.send(msg); } catch {} }
  for (const m of members.values()) sendToMember(m, msg); // co-hosts see it on the host's avatar too
}
function setViewerGrab(on) {
  broadcastControl(permMsg());
  if (!on) for (const v of viewers.values()) {
    if (!stage.grabs.has('v' + v.n)) continue;
    stage.setGrab('v' + v.n, -1, null);
    broadcastControl({ t: 'grab', k: 'v' + v.n, j: -1, p: null });
  }
}

// ---- camera output window (for OBS / a virtual camera): mirrors what viewers get, locally ----
const outCh = new BroadcastChannel('vt-output');
let outputOpen = false;
// …and the mirror (your avatar on your own screen, placed like on the viewer you picked) gets the same
const mirCh = new BroadcastChannel('vt-mirror');
let mirrorOpen = false;
const toOutput = (msg) => {
  if (outputOpen) { try { outCh.postMessage(msg); } catch {} }
  if (mirrorOpen) { try { mirCh.postMessage(msg); } catch {} }
};
const localPageHandler = (ch, onHello) => async ({ data: d }) => {
  if (d?.t === 'hello') {
    postLocalState(ch);
    onHello();
  }
  if (d?.t === 'need-model' && typeof d.m === 'string') { postMemberState(ch, d.m); return; } // a page that missed someone's avatar
  if (d?.t === 'need-prop') { const blob = await getAnyPropImage(String(d.hash)); if (blob) ch.postMessage({ t: 'prop-img', hash: d.hash, blob }); }
};
/** Everything a local page (camera output, mirror) needs: my avatar, and everyone else's in a room. */
function postLocalState(ch) {
  const post = (msg) => { try { ch.postMessage(msg); } catch {} };
  const own = (msg) => post(GUEST ? wrapM(myId || 'me', msg) : msg);
  if (room && room.order.length > 1) post({ t: 'members', order: [...room.order], names: room.names, free: room.free });
  post({ t: 'view', ...(GUEST ? hostView || view : view) }); // the host's (its avatar is the page's main one)
  if (GUEST) own({ t: 'mview', ...ownView(view) });
  if (modelBuf) own({ t: 'model', id: modelId, buf: modelBuf.slice(0) });
  own({ t: 'style', ...style });
  own({ t: 'props', list: publicProps() });
  if (GUEST) own(permMsg());
  for (const id of room?.order || []) if (id !== (myId || 'h')) postMemberState(ch, id);
}
/** Another avatar of the room (look, props, switches, model) to a local page. */
function postMemberState(ch, id) {
  const post = (msg) => { try { ch.postMessage(id === 'h' ? msg : wrapM(id, msg)); } catch {} };
  if (GUEST) { // what I have of them is in my preview
    const slot = room.slot(id);
    if (!slot) return;
    post({ t: 'style', ...slot.style });
    if (id !== 'h') post({ t: 'mview', ...slot.ownView });
    post({ t: 'props', list: slot.props });
    post({ t: 'perm', ...slot.perm });
    const buf = roomModelBufs.get(slot.stage.modelId);
    if (buf) post({ t: 'model', id: slot.stage.modelId, buf: buf.slice(0) });
    return;
  }
  const m = memberById(id);
  if (!m) return;
  if (m.style) post({ t: 'style', ...m.style });
  if (m.view) post({ t: 'mview', ...m.view });
  post({ t: 'props', list: m.props || [] });
  post({ t: 'perm', ...(m.perm || {}) });
  if (m.modelBuf) post({ t: 'model', id: m.modelId, buf: m.modelBuf.slice(0) });
}
outCh.onmessage = localPageHandler(outCh, () => showOutputState(true));
const mirrorHandler = localPageHandler(mirCh, () => { mirrorOpen = true; mirCh.postMessage(permMsg()); mirrorPos(); showMirrorState(true); });
// you can pat, boop, slap and pull hair on your mirror, like a viewer (same permission switches)
const mirrorAsViewer = { n: 'm', pos: { ...DEFAULT_POS } };
mirCh.onmessage = (ev) => {
  const d = ev.data;
  if (d && (d.t === 'fx' || d.t === 'grab')) { onViewerMessage('mirror', mirrorAsViewer, d); return; }
  mirrorHandler(ev);
};
let lastMirrorPos = '';
// only for a viewer in Full screen mode: if they leave it (or leave), yours goes away too
const mirrorTarget = () => { const v = viewers.get(selectedViewer); return v && v.state?.mode === 'screen' && (v.motion?.open || v.model?.open) ? v : null; };
let displayCount = 1;
let mirrorGoneTimer = null;
function syncMirror() {
  const ok = !!mirrorTarget();
  // a short reconnect isn't "leaving": give it a few seconds before closing yours
  if (ok) { clearTimeout(mirrorGoneTimer); mirrorGoneTimer = null; }
  else if (mirrorOpen && !mirrorGoneTimer) mirrorGoneTimer = setTimeout(() => { mirrorGoneTimer = null; if (!mirrorTarget() && mirrorOpen) { window.vt.closeMirror(); showMirrorState(false); syncMirror(); } }, 6000);
  const show = ok || (mirrorOpen && !!mirrorGoneTimer);
  $('mirrorBtn').hidden = !show;
  $('mirrorDisplay').hidden = !show || displayCount < 2;
  mirrorPos();
}
function mirrorPos() {
  if (!mirrorOpen) return;
  const v = mirrorTarget();
  if (!v) return;
  const p = { ...v.pos, zone: v.state?.zone };
  const msg = { t: 'pos', x: p.x, y: p.y, s: p.s, tb: !!p.tb, zone: p.zone || null };
  const idle = v.rx?.s === 'hidden'; // their avatar faded out (no tracking for 30 s): so does yours
  const mpos = room?.free ? v.mpos || {} : {};
  const key = JSON.stringify(msg) + idle + JSON.stringify(mpos);
  if (key === lastMirrorPos) return;
  lastMirrorPos = key;
  try {
    mirCh.postMessage(msg); mirCh.postMessage({ t: 'idle', on: idle });
    for (const [id, p] of Object.entries(mpos)) mirCh.postMessage(wrapM(id, { t: 'pos', ...p }));
  } catch {}
}
function showMirrorState(open) {
  mirrorOpen = open;
  if (!open) lastMirrorPos = '';
  $('mirrorBtn').textContent = open ? 'Hide from my screen' : 'Show on my screen';
  $('mirrorBtn').classList.toggle('on', open);
}
$('mirrorBtn').onclick = () => {
  if (mirrorOpen) { window.vt.closeMirror(); showMirrorState(false); return; }
  if (!mirrorTarget()) return;
  window.vt.openMirror({ displayId: Number($('mirrorDisplay').value) || 0 });
};
window.vt.onMirrorClosed(() => showMirrorState(false));
window.vt.getConfig().then((cfg) => {
  const list = cfg.displays || [];
  $('mirrorDisplay').innerHTML = list.map((d) => `<option value="${d.id}">${d.label.replace(/</g, '&lt;')}</option>`).join('');
  displayCount = list.length;
  syncMirror();
});
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
  if (GUEST) { guestSend(msg); return; } // a co-host's own changes go to the host, who passes them on
  toOutput(msg);
  for (const v of viewers.values()) if (v.model?.open) { try { v.model.send(msg); } catch {} }
  for (const mem of members.values()) sendToMember(mem, msg); // co-hosts see the host's avatar too
}

// =====================================================================================================
// Multi-model rooms (see shared/room.js). The host lets co-hosts in (up to settings.roomModels avatars
// in total), relays everything between everyone, and keeps the line-up (`order`, left to right).
// =====================================================================================================
function memberById(id) { return [...members.values()].find((m) => m.id === id) || null; }
function hostName() { return modelName || 'Host'; }
function wrapM(m, d) { return { t: 'mm', m, d }; }
function roomViewers() { return [...viewers.values()].filter((v) => v.state?.rooms && v.model?.open); }
function sendToMember(mem, msg) { if (mem.model?.open) { try { mem.model.send(msg); } catch {} } }

function membersMsg() {
  const names = { h: hostName() };
  for (const m of members.values()) names[m.id] = m.name || 'Co-host';
  return { t: 'members', order: [...order], names, free: !!settings.freePlace };
}
/** Tell everyone who's in the room and in which order. */
function announceMembers() {
  if (GUEST) return;
  const msg = membersMsg();
  for (const v of roomViewers()) { try { v.model.send(msg); } catch {} }
  for (const m of members.values()) sendToMember(m, { ...msg, you: m.id });
  toOutput(msg);
  room.setMembers(msg);
  layoutNeighbors(); renderMembersUI(); renderPlacement();
  if (OBS_ONLY && peer?.open) setNet('ok', obsNetText());
}
/** A co-host's message, passed on to everyone else (viewers that understand rooms, other co-hosts, local pages, my preview). */
function relayMember(mem, d, exceptViewer = null) {
  const msg = wrapM(mem.id, d);
  for (const [id, v] of viewers) if (id !== exceptViewer && v.state?.rooms && v.model?.open) { try { v.model.send(msg); } catch {} }
  for (const m of members.values()) if (m !== mem) sendToMember(m, msg);
  if (exceptViewer === 'mirror') { if (outputOpen) { try { outCh.postMessage(msg); } catch {} } } // the mirror did it itself
  else toOutput(msg);
  room.handle(mem.id, d);
}
/** Everything a newcomer (viewer or co-host) needs to show the co-hosts. */
function memberStateMsgs(skipId = null) {
  const out = [];
  for (const m of members.values()) {
    if (m.id === skipId) continue;
    if (m.style) out.push(wrapM(m.id, { t: 'style', ...m.style }));
    if (m.view) out.push(wrapM(m.id, { t: 'mview', ...m.view }));
    out.push(wrapM(m.id, { t: 'props', list: m.props || [] }));
    out.push(wrapM(m.id, { t: 'perm', ...(m.perm || {}) }));
    if (m.modelId) out.push(wrapM(m.id, { t: 'model-use', id: m.modelId }));
  }
  return out;
}
async function sendMemberModel(conn, mem) {
  if (!mem?.modelBuf || !conn?.open) return;
  const id = mem.modelId;
  await sendChunked(conn, 'model', { id }, mem.modelBuf, () => mem.modelId === id, (msg) => wrapM(mem.id, msg));
}

// prop images of co-hosts: fetched from their owner the first time someone needs one
const memberImgs = new Map(), memberImgWaiters = new Map();
async function getAnyPropImage(hash) {
  const own = await getPropImage(hash);
  if (own) return own;
  if (memberImgs.has(hash)) return memberImgs.get(hash);
  const ask = (send) => new Promise((res) => {
    memberImgWaiters.set(hash, [...(memberImgWaiters.get(hash) || []), res]);
    if (memberImgWaiters.get(hash).length === 1) send();
    setTimeout(() => res(null), 60000);
  });
  if (GUEST) return ask(() => sendToHost({ t: 'need-prop', hash })); // the host has everyone's (or fetches them)
  const owner = [...members.values()].find((m) => (m.props || []).some((p) => p.img === hash));
  return owner ? ask(() => sendToMember(owner, { t: 'need-prop', hash })) : null;
}
const toArrayBuffer = (data) => (data instanceof ArrayBuffer ? data : ArrayBuffer.isView(data) ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null);
const incomingMemberImgs = new Map();
function receivePropChunk(d) {
  if (d.t === 'prop-begin') { incomingMemberImgs.set(d.hash, { mime: String(d.mime || ''), parts: new Array(d.chunks), got: 0 }); return; }
  const inc = incomingMemberImgs.get(d.hash);
  if (!inc) return;
  if (d.t === 'prop-chunk') { if (!inc.parts[d.i]) { inc.parts[d.i] = toArrayBuffer(d.data); inc.got++; } return; }
  incomingMemberImgs.delete(d.hash);
  if (inc.parts.some((x) => !x) || !/^image\/(png|jpeg|gif|webp)$/.test(inc.mime)) return;
  const blob = new Blob(inc.parts, { type: inc.mime });
  memberImgs.set(d.hash, blob);
  for (const r of memberImgWaiters.get(d.hash) || []) r(blob);
  memberImgWaiters.delete(d.hash);
}

// ---- host: co-hosts connecting ----
function acceptMember(conn) {
  const pid = conn.peer;
  const reject = (reason) => conn.on('open', () => {
    if (conn.label === 'model') { try { conn.send({ t: 'bye', reason, max: maxModels() }); } catch {} }
    setTimeout(() => conn.close(), 500);
  });
  if (!members.has(pid) && (maxModels() <= 1 || members.size + 1 >= maxModels())) { reject(maxModels() <= 1 ? 'no-cohosts' : 'models-full'); return; }
  let mem = members.get(pid);
  if (!mem) { mem = { id: 'c' + (++memberSeq), pid, name: String(conn.metadata?.name || '').slice(0, 24), perm: {}, props: [], lastHeard: performance.now() }; members.set(pid, mem); }
  if (conn.label === 'model') {
    mem.model = conn;
    conn.on('data', (d) => onMemberMessage(mem, d));
    conn.on('open', () => {
      if (!order.includes(mem.id)) order.push(mem.id);
      // the co-host gets the host's avatar and the others, like a viewer would
      sendToMember(mem, { ...membersMsg(), you: mem.id });
      sendToMember(mem, { t: 'view', ...view });
      sendToMember(mem, { t: 'style', ...style });
      sendToMember(mem, { t: 'props', list: publicProps() });
      sendToMember(mem, permMsg());
      if (modelBuf) sendToMember(mem, { t: 'model-use', id: modelId });
      for (const msg of memberStateMsgs(mem.id)) sendToMember(mem, msg);
      sendViewersToMembers(true);
      announceMembers();
    });
  } else {
    mem.motion = conn;
    conn.on('data', (d) => onMemberMotion(mem, d));
  }
  const gone = () => {
    if (mem.model === conn) mem.model = null;
    if (mem.motion === conn) mem.motion = null;
    if (!mem.model && !mem.motion) dropMember(pid);
  };
  conn.on('close', gone);
  conn.on('error', () => conn.close());
}
function dropMember(pid) {
  const mem = members.get(pid);
  if (!mem) return;
  members.delete(pid);
  order = order.filter((id) => id !== mem.id);
  try { mem.model?.close(); mem.motion?.close(); } catch {}
  announceMembers();
}
async function kickMember(mem, reason = 'kicked') {
  sendToMember(mem, { t: 'bye', reason });
  await new Promise((r) => setTimeout(r, 150));
  dropMember(mem.pid);
}
function moveInOrder(id, dir) {
  const i = order.indexOf(id), j = i + Math.sign(dir);
  if (i < 0 || j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  announceMembers();
}

function onMemberMessage(mem, d) {
  mem.lastHeard = performance.now();
  if (!d || typeof d !== 'object') return;
  switch (d.t) {
    case 'hb': return;
    case 'bye': dropMember(mem.pid); return;
    case 'member': mem.name = String(d.name || '').slice(0, 24); announceMembers(); return;
    case 'model-begin': mem.incoming = { id: String(d.id), size: d.size, parts: new Array(d.chunks), got: 0 }; return;
    case 'model-chunk': if (mem.incoming && d.id === mem.incoming.id && !mem.incoming.parts[d.i]) { mem.incoming.parts[d.i] = toArrayBuffer(d.data); mem.incoming.got++; } return;
    case 'model-end': {
      const inc = mem.incoming; mem.incoming = null;
      if (!inc || inc.parts.some((x) => !x)) { sendToMember(mem, { t: 'need-model' }); return; }
      const buf = new Uint8Array(inc.size); let off = 0;
      for (const p of inc.parts) { buf.set(new Uint8Array(p), off); off += p.byteLength; }
      mem.modelBuf = buf.buffer; mem.modelId = inc.id;
      room.handle(mem.id, { t: 'model', id: inc.id, buf: buf.buffer.slice(0) });
      toOutput(wrapM(mem.id, { t: 'model', id: inc.id, buf: buf.buffer.slice(0) }));
      const use = wrapM(mem.id, { t: 'model-use', id: inc.id });
      for (const v of roomViewers()) { try { v.model.send(use); } catch {} }
      for (const m of members.values()) if (m !== mem) sendToMember(m, use);
      renderMembersUI();
      return;
    }
    case 'mstyle': { const { t, ...st } = d; mem.style = st; relayMember(mem, { t: 'style', ...st }); return; }
    case 'mview': mem.view = ownView(d); relayMember(mem, { t: 'mview', ...mem.view }); return;
    case 'mprops': mem.props = Array.isArray(d.list) ? d.list.slice(0, 64) : []; relayMember(mem, { t: 'props', list: mem.props }); return;
    case 'mperm': mem.perm = { grab: !!d.grab, pat: !!d.pat, slap: !!d.slap }; relayMember(mem, { t: 'perm', ...mem.perm }); return;
    case 'grab': { // pulling their own hair in their preview
      const p = Array.isArray(d.p) && d.p.length === 3 && d.p.every(Number.isFinite) ? d.p : null;
      relayMember(mem, { t: 'grab', k: 'o', j: Number.isInteger(d.j) ? d.j : -1, p });
      return;
    }
    case 'fx': if (['pat', 'boop', 'slap'].includes(d.k)) relayMember(mem, { t: 'fx', k: d.k, r: d.r, d: d.d }); return;
    case 'move': moveInOrder(mem.id, d.dir); return;
    case 'mpos': { // free placement on a full-screen viewer
      if (!settings.freePlace) return;
      const v = viewers.get(String(d.key));
      if (!v) return;
      v.mpos = v.mpos || {};
      v.mpos[mem.id] = { x: +d.x, y: +d.y, s: +d.s, tb: !!d.tb };
      if (v.model?.open && v.state?.rooms) { try { v.model.send(wrapM(mem.id, { t: 'pos', ...v.mpos[mem.id] })); } catch {} }
      if (mirrorTarget() === v) { lastMirrorPos = ''; mirrorPos(); }
      sendViewersToMembers(); renderPlacement();
      return;
    }
    case 'need-model':
      if (d.m && d.m !== 'h') { const o = memberById(d.m); if (o) for (const msg of memberStateMsgs().filter((x) => x.m === o.id && x.d.t !== 'model-use')) sendToMember(mem, msg); }
      mem.sending = (mem.sending || 0) + 1;
      (d.m && d.m !== 'h' ? sendMemberModel(mem.model, memberById(d.m)) : mem.model?.open ? sendModel(mem.model) : Promise.resolve())
        .finally(() => { mem.sending--; });
      return;
    case 'need-prop': if (mem.model?.open) sendPropImage(mem.model, String(d.hash)); return;
    case 'prop-begin': case 'prop-chunk': case 'prop-end': receivePropChunk(d); return;
  }
}
function onMemberMotion(mem, d) {
  mem.lastHeard = performance.now();
  if (!d || d.t !== 'm') return;
  const frame = { ...d, m: mem.id };
  room.motion(mem.id, frame);
  toOutput(frame);
  for (const v of viewers.values()) {
    if (!v.motion?.open || !v.state?.rooms) continue;
    if ((v.motion.dataChannel?.bufferedAmount ?? 0) > MOTION_MAX_BUFFERED) continue;
    try { v.motion.send(frame); } catch {}
  }
  for (const m of members.values()) if (m !== mem && m.motion?.open) { try { m.motion.send(frame); } catch {} }
}
// co-hosts are pinged too, and dropped when silent
setInterval(() => {
  if (GUEST) return;
  const now = performance.now();
  for (const [pid, m] of members) {
    sendToMember(m, { t: 'hb' });
    // a big model on its way can hold up the pings behind it: more patience meanwhile
    if (now - m.lastHeard > HEARTBEAT_TIMEOUT_MS * (m.incoming || m.sending ? 3 : 1)) dropMember(pid);
  }
}, HEARTBEAT_MS);

/** Co-hosts placing themselves need the full-screen viewers' screens: send them a summary. */
let viewersToMembersTimer = null;
function sendViewersToMembers(now = false) {
  if (GUEST || !members.size) return;
  const go = () => {
    viewersToMembersTimer = null;
    const list = [...viewers.entries()].filter(([, v]) => v.state?.rooms).map(([key, v]) => ({ key, n: v.n, name: viewerLabel(v), state: v.state, pos: v.pos, mpos: v.mpos || {} }));
    for (const m of members.values()) sendToMember(m, { t: 'viewers', list });
  };
  if (now) { clearTimeout(viewersToMembersTimer); go(); }
  else if (!viewersToMembersTimer) viewersToMembersTimer = setTimeout(go, 300);
}

// ---- the other avatars beside yours in the preview ----
// the others' models are kept (latest one each) so a camera output opened later can get them
const roomModelBufs = new Map();
room = window.vtRoom = new Room({
  main: stage,
  container: $('neighbors'), stageOptions: () => ({ maxFps: 30, maxPixelRatio: 1 }), // beside you in the preview: cheaper
  propLoader: getAnyPropImage, skip: [myId || '?'],
  send: (msg) => { if (GUEST) sendToHost(msg); },
  cache: {
    get: (id) => roomModelBufs.get(id) || null,
    put: (id, buf) => {
      roomModelBufs.set(id, buf);
      const used = new Set([...room.slots.values()].map((s) => s.stage.modelId).concat(id));
      for (const k of [...roomModelBufs.keys()]) if (!used.has(k)) roomModelBufs.delete(k);
    },
  },
  onLoaded: (slot) => { if (GUEST && slot.stage.modelId && roomModelBufs.has(slot.stage.modelId)) postSlotModel(slot); },
});
/** A guest's camera output gets the others' avatars from here (the host's own come from the host's own buffers). */
function postSlotModel(slot) {
  const buf = roomModelBufs.get(slot.stage.modelId);
  if (!buf || !outputOpen) return;
  const msg = { t: 'model', id: slot.stage.modelId, buf: buf.slice(0) };
  try { outCh.postMessage(slot.id === 'h' ? msg : wrapM(slot.id, msg)); } catch {}
}
room.setView(view);
room.setMembers({ order: ['h'] });
room.startDepth({ main: $('stage'), base: -10 });
if (!GUEST) room.setHostLight(style.light); // the room's lighting is yours // bigger avatars further back
function layoutNeighbors() {
  if (!room) return;
  if (settings.hideOthers) for (const s of room.slots.values()) s.stage.suspended = true; // newcomers too
  const me = myId || 'h';
  const W = stage.canvas.clientWidth, H = stage.canvas.clientHeight;
  if (room.order.length <= 1 || !W || !H) return;
  const L = rowLayout(room.order, W, H, me, view.roll);
  for (const [id, s] of room.slots) if (L[id]) s.stage.setViewport(L[id]);
}
new ResizeObserver(layoutNeighbors).observe($('stageWrap'));

// ---- room settings + the co-host list (host) / your place in the row (everyone) ----
function renderMembersUI() {
  const n = room.order.length;
  $('rowPlace').hidden = n <= 1;
  const i = room.order.indexOf(myId || 'h');
  $('moveLeft').disabled = i <= 0;
  $('moveRight').disabled = i < 0 || i >= n - 1;
  $('rowPlaceText').textContent = n > 1 ? `You're ${i + 1} of ${n} from the left` : '';
  if (GUEST) return;
  const box = $('cohosts');
  box.hidden = !members.size;
  box.innerHTML = members.size ? '<h4>Co-hosts</h4>' : '';
  for (const m of members.values()) {
    const row = document.createElement('div');
    row.className = 'vrow';
    const label = document.createElement('span');
    label.className = 'vlabel';
    label.textContent = (m.name || 'Co-host') + (m.modelId ? '' : ' (no avatar yet)');
    const kick = document.createElement('button');
    kick.textContent = '✕'; kick.title = 'Remove this co-host from the room';
    kick.onclick = () => kickMember(m);
    row.append(label, kick);
    box.appendChild(row);
  }
}
$('moveLeft').onclick = () => (GUEST ? sendToHost({ t: 'move', dir: -1 }) : moveInOrder('h', -1));
$('moveRight').onclick = () => (GUEST ? sendToHost({ t: 'move', dir: 1 }) : moveInOrder('h', 1));
// how many avatars this room takes, the host's included (1 = a normal broadcast: no co-hosts)
function maxModels() {
  if (OBS_ONLY) return Math.max(1, Math.min(MAX_MODELS, settings.obsModels || 1)); // 1 = just me, offline
  return ROOM_MODE ? Math.max(2, Math.min(MAX_MODELS, settings.roomModels || 2)) : 1;
}
if (OBS_ONLY && ROOM_START >= 1) { settings.obsModels = Math.min(MAX_MODELS, ROOM_START); saveSettings(); }
else if (ROOM_START >= 2) { settings.roomModels = Math.min(MAX_MODELS, ROOM_START); saveSettings(); }
document.body.classList.toggle('roomMode', ROOM_MODE);
document.body.classList.toggle('obsOnly', OBS_ONLY);
if (OBS_ONLY) {
  $('roomModels').insertAdjacentHTML('afterbegin', '<option value="1">Just me</option>');
  $('roomSecTitle').textContent = 'OBS only';
  $('viewersSecTitle').textContent = 'Co-hosts';
  $('stop').textContent = 'Stop';
}
$('roomModels').value = String(maxModels());
$('roomModels').onchange = () => {
  const n = Math.max(OBS_ONLY ? 1 : 2, Math.min(MAX_MODELS, Number($('roomModels').value) || 2));
  if (OBS_ONLY) settings.obsModels = n; else settings.roomModels = n;
  saveSettings();
  // fewer spots than co-hosts: the last ones to join leave
  const extra = [...members.values()].slice(Math.max(0, maxModels() - 1));
  for (const m of extra) kickMember(m, 'models-full');
  syncObsPeer();
};
function obsNetText() { return members.size ? 'Online, co-hosts in the room' : 'Online, waiting for co-hosts'; }
/** OBS only: only online (with a room code) while co-hosts are allowed; otherwise nothing leaves this computer. */
function syncObsPeer() {
  if (!OBS_ONLY) return;
  const want = maxModels() >= 2;
  document.body.classList.toggle('offline', !want);
  if (want && !peer) { stopping = false; sigFailures = 0; idTakenTries = 0; setNet('warn', 'Connecting to the connection server…'); startPeer(DEV_CODE || undefined); }
  else if (!want) {
    if (peer) {
      for (const m of [...members.values()]) kickMember(m, 'no-cohosts');
      const p = peer; peer = null; // first, so its own events are ignored
      setTimeout(() => { try { p.destroy(); } catch {} }, 300);
    }
    setNet('ok', 'Offline: nothing leaves this computer');
  }
}
// hide the others in my preview (only here: nobody else is affected)
function applyHideOthers() {
  const on = !!settings.hideOthers;
  $('neighbors').hidden = on;
  for (const s of room.slots.values()) s.stage.suspended = on; // not drawn at all meanwhile
}
$('hideOthers').checked = !!settings.hideOthers;
$('hideOthers').onchange = () => { settings.hideOthers = $('hideOthers').checked; saveSettings(); applyHideOthers(); };
$('freePlace').checked = !!settings.freePlace;
$('freePlace').onchange = () => { settings.freePlace = $('freePlace').checked; saveSettings(); announceMembers(); };

// =====================================================================================================
// Co-host side: join the host's room, send it my avatar / movements / settings, show the others.
// =====================================================================================================
function sendToHost(msg) { if (host?.model?.open) { try { host.model.send(msg); } catch {} } }
function ownToOutput(msg) { toOutput(GUEST ? wrapM(myId || 'me', msg) : msg); }
function guestSend(msg) {
  ownToOutput(msg);
  switch (msg.t) {
    case 'style': { const { t, ...st } = msg; sendToHost({ t: 'mstyle', ...st }); return; }
    case 'view': { const v = { t: 'mview', ...ownView(msg) }; ownToOutput(v); sendToHost(v); return; } // only my own avatar's
    case 'props': sendToHost({ t: 'mprops', list: msg.list }); return;
    case 'perm': sendToHost({ t: 'mperm', grab: msg.grab, pat: msg.pat, slap: msg.slap }); return;
    case 'grab': sendToHost({ t: 'grab', j: msg.j, p: msg.p }); return;
    case 'fx': sendToHost({ t: 'fx', k: msg.k, r: msg.r, d: msg.d }); return;
    case 'bye': sendToHost({ t: 'bye' }); return;
  }
}
function joinHost() {
  if (!GUEST || guestStopped) return;
  clearTimeout(guestRetry);
  const old = host;
  try { old?.peer?.destroy(); } catch {}
  const p = new window.Peer(peerOptions());
  const h = host = { peer: p };
  setNet('warn', `Joining room ${GUEST_CODE}…`);
  const retry = (text, ms = 4000) => {
    if (h !== host || guestStopped) return;
    if (text) setNet('bad', text);
    clearTimeout(guestRetry);
    guestRetry = setTimeout(joinHost, ms);
  };
  p.on('open', () => {
    if (h !== host) return;
    const meta = { role: 'member', name: GUEST_NAME || modelName || '' };
    const m = h.model = p.connect(PEER_PREFIX + GUEST_CODE, { label: 'model', reliable: true, serialization: 'binary', metadata: meta });
    const mo = h.motion = p.connect(PEER_PREFIX + GUEST_CODE, { label: 'motion', reliable: false, serialization: 'json', metadata: meta });
    m.on('open', () => {
      if (h !== host) return;
      h.lastHeard = performance.now();
      setNet('ok', `In room ${GUEST_CODE} with your avatar`);
      sendToHost({ t: 'member', name: meta.name });
      uploadModel();
      broadcastControl({ t: 'style', ...style });
      broadcastControl({ t: 'view', ...view });
      broadcastControl({ t: 'props', list: publicProps() });
      broadcastControl(permMsg());
    });
    m.on('data', (d) => { if (h === host) onHostMessage(d); });
    mo.on('data', (d) => {
      if (h !== host || !d || d.t !== 'm') return;
      h.lastHeard = performance.now();
      if (d.m === myId) return;
      room.motion(d.m || 'h', d);
      toOutput(d);
    });
    for (const c of [m, mo]) { c.on('close', () => retry('Lost the room. Rejoining…')); c.on('error', () => retry('Lost the room. Rejoining…')); }
  });
  p.on('error', (err) => {
    if (h !== host) return;
    if (err.type === 'peer-unavailable') retry(`Room ${GUEST_CODE} isn't online. Retrying…`, 5000);
    else retry('Connection problem (' + err.type + '). Retrying…');
  });
}
async function uploadModel() {
  if (!GUEST || !modelBuf || !host?.model?.open) return;
  const id = modelId, h = host;
  h.sending = true;
  try { await sendChunked(h.model, 'model', { id }, modelBuf, () => id === modelId); } finally { h.sending = false; }
}
// the host's messages: its own avatar unwrapped, the other co-hosts wrapped
async function onHostMessage(d) {
  if (!d || typeof d !== 'object') return;
  host.lastHeard = performance.now();
  switch (d.t) {
    case 'hb': return;
    case 'bye':
      if (d.reason === 'kicked') { guestStopped = true; setNet('bad', 'The host removed you from the room.'); }
      else if (d.reason === 'models-full') { setNet('bad', 'The room is full. Retrying…'); clearTimeout(guestRetry); guestRetry = setTimeout(joinHost, 15000); }
      else if (d.reason === 'no-cohosts') { guestStopped = true; setNet('bad', 'This room doesn\'t take co-hosts (the host has it set to one avatar).'); }
      else { setNet('warn', 'The host ended the room. Waiting…'); clearTimeout(guestRetry); guestRetry = setTimeout(joinHost, 5000); }
      room.setMembers({ order: [] });
      layoutNeighbors(); renderMembersUI();
      return;
    case 'members':
      const newId = d.you && d.you !== myId;
      if (d.you) { myId = d.you; room.skip = new Set([myId]); }
      room.setMembers(d);
      if (newId && outputOpen) postLocalState(outCh); // my avatar now has its place in the room
      else toOutput(d);
      layoutNeighbors(); renderMembersUI(); renderPlacement();
      return;
    case 'mm':
      if (d.m === myId) { // someone touching MY avatar (a viewer's pat, boop, slap, pull)
        const x = d.d || {};
        if (x.t === 'fx') { if (x.k === 'pat') stage.fx.patting(+x.r); else if (x.k === 'boop') stage.fx.boop(); else if (x.k === 'slap') stage.fx.slap(x.d); }
        else if (x.t === 'grab' && typeof x.k === 'string') stage.setGrab('r' + x.k, Number.isInteger(x.j) ? x.j : -1, Array.isArray(x.p) ? x.p : null, true);
        ownToOutput(x);
        return;
      }
      await room.handle(d.m, d.d);
      toOutput(d);
      return;
    case 'view': updateView(d, true); toOutput(d); return;
    case 'style':
      hostLight = normalizeStyle(d).light;
      stage.setStyle({ ...style, light: hostLight });
      room.setHostLight(hostLight);
      room.handle('h', d);
      toOutput(d);
      return;
    case 'viewers': guestViewers = Array.isArray(d.list) ? d.list : []; syncGuestViewers(); return;
    case 'need-model': uploadModel(); return;
    case 'need-prop': sendPropImage(host.model, String(d.hash)); return;
    case 'prop-begin': case 'prop-chunk': case 'prop-end': receivePropChunk(d); return;
    case 'pos': return; // positions on viewers' screens are between the host and them
    default: // the host's own avatar: model, props, perm, fx, grab…
      await room.handle('h', d);
      if (!/^model-/.test(d.t)) toOutput(d);
  }
}
setInterval(() => {
  if (!GUEST || !host?.model?.open) return;
  sendToHost({ t: 'hb' });
  const busy = host.sending || [...room.slots.values()].some((s) => s.incoming);
  if (performance.now() - (host.lastHeard || 0) > HEARTBEAT_TIMEOUT_MS * (busy ? 3 : 1)) { try { host.model.close(); } catch {} }
}, HEARTBEAT_MS);
/** Co-host placing their own avatar: the host's viewer list, as local stand-ins for the placement view. */
function syncGuestViewers() {
  if (!GUEST) return;
  const keep = new Set();
  for (const g of guestViewers) {
    keep.add(g.key);
    let v = viewers.get(g.key);
    if (!v) { v = { n: g.n, pos: { ...DEFAULT_POS }, guest: true }; viewers.set(g.key, v); }
    v.state = { ...g.state, name: g.name };
    if (!v.dragging) { v.pos = g.pos || v.pos; v.mpos = g.mpos || {}; }
    v.remoteOpen = true;
  }
  for (const k of [...viewers.keys()]) if (!keep.has(k)) viewers.delete(k);
  updateViewers();
}
if (GUEST) { $('stop').textContent = 'Leave room'; joinHost(); }
if (OBS_ONLY) { syncObsPeer(); setTimeout(() => { if (!outputOpen) $('outputBtn').click(); }, 800); } // the camera output is the point
applyHideOthers();
layoutNeighbors(); renderMembersUI();


async function sayBye(reason) {
  stopping = true;
  broadcastControl({ t: 'bye', reason });
  await new Promise((r) => setTimeout(r, 150)); // let it flush
  for (const id of [...viewers.keys()]) dropViewer(id);
  for (const pid of [...members.keys()]) { const m = members.get(pid); try { m.model?.close(); m.motion?.close(); } catch {} members.delete(pid); }
  if (GUEST) { guestStopped = true; clearTimeout(guestRetry); try { host?.peer?.destroy(); } catch {} }
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
  if (v.guest) return ['ok', 'Watching the room', ''];
  const rx = v.rx;
  if (!v.motion?.open || !v.model?.open) return ['warn', 'Connecting…', 'The connection is still being set up'];
  if (!rx) return [modelBuf ? 'warn' : 'muted', modelBuf ? 'Connected' : 'Waiting for your avatar', 'This viewer runs an older version and doesn\'t report what it sees'];
  if (rx.s === 'loading') return ['warn', `Loading your avatar… ${Math.round((rx.p || 0) * 100)}%`, 'Your model is being sent / loaded on their side'];
  if (rx.s === 'error') return ['bad', 'Avatar failed to load', 'Their app couldn\'t open your model'];
  if (rx.s === 'hidden') return ['muted', 'Avatar hidden (you\'re not tracking)', 'Hidden on full screen after 30 s without tracking'];
  if (rx.s === 'ready') return ['ok', '● Sees you', 'Your avatar is on their screen'];
  return ['muted', modelBuf ? 'Waiting for your avatar' : 'Waiting for you to load an avatar', ''];
}

const MODE_LABEL = { floating: 'floating widget', window: 'window', screen: 'full screen' };
const viewerLabel = (v) => v.state?.name || `Viewer ${v.n}`;

$('maxViewers').value = String(settings.maxViewers || 0);
$('maxViewers').onchange = () => { settings.maxViewers = Number($('maxViewers').value) || 0; saveSettings(); updateViewers(); };

const isLive = (v) => v.motion?.open || v.model?.open || v.remoteOpen; // remoteOpen: a co-host's copy of the host's viewer list
function updateViewers() {
  const live = [...viewers.entries()].filter(([, v]) => isLive(v));
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
  if (peer?.open) setNet('ok', OBS_ONLY ? obsNetText() : live.length ? 'Online, streaming' : 'Online, waiting for viewers');
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
  if (d.m && (d.t === 'fx' || d.t === 'grab' || d.t === 'need-model')) { onViewerToMember(id, v, d); return; }
  if (d.t === 'fx') { // a viewer's headpat / boop / slap
    const now = performance.now();
    if (d.k === 'slap') {
      if (!settings.viewerSlap || now - (v.lastSlap || 0) < 300) return;
      v.lastSlap = now;
      const dir = Array.isArray(d.d) && d.d.length === 3 && d.d.every((x) => Number.isFinite(+x)) ? d.d.map((x) => Math.max(-1, Math.min(1, +x))) : null;
      stage.fx.slap(dir);
      relayGrab(id, { t: 'fx', k: 'slap', d: dir });
      return;
    }
    if (!settings.viewerPat || (d.k !== 'pat' && d.k !== 'boop')) return;
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
  if (d.t === 'rx') { v.rx = { s: String(d.s), p: Math.max(0, Math.min(1, +d.p || 0)) }; updateViewers(); mirrorPos(); return; }
  if (d.t === 'need-model') { if (v.model?.open) sendModel(v.model); return; }
  if (d.t === 'need-prop') { if (v.model?.open) sendPropImage(v.model, String(d.hash)); return; }
  if (d.t !== 'viewer') return;
  const first = !v.hello;
  v.hello = true;
  v.state = {
    name: String(d.name || '').slice(0, 24), mode: d.mode, aspect: Number(d.aspect) || 16 / 9,
    zone: d.zone || { x: 0, y: 0, w: 1, h: 1 }, work: d.work || { x: 0, y: 0, w: 1, h: 1 }, sharing: !!d.sharing, have: d.have || null, rooms: !!d.rooms,
  };
  if (d.pos && !v.dragging) v.pos = { ...DEFAULT_POS, ...d.pos };
  if (!v.pos.tb) { toFullArea(v); sendPos(v, true); }
  if (first) {
    v.model.send({ t: 'props', list: publicProps() });
    v.model.send({ t: 'view', ...view });
    v.model.send({ t: 'style', ...style });
    v.model.send(permMsg());
    offerModel(v);
    if (d.rooms && order.length > 1) { // the co-hosts' avatars too
      v.model.send(membersMsg());
      for (const msg of memberStateMsgs()) v.model.send(msg);
      for (const [mid, p] of Object.entries(v.mpos || {})) v.model.send(wrapM(mid, { t: 'pos', ...p }));
    }
  }
  updateViewers();
  renderPlacement();
  sendViewersToMembers();
}
/** A viewer touching a co-host's avatar: each owner's own permission switches apply. */
function onViewerToMember(id, v, d) {
  const mem = memberById(String(d.m));
  if (!mem) return;
  if (d.t === 'need-model') {
    if (!v.model?.open) return;
    try { // its look and switches too (a viewer asks when it couldn't add that avatar in time)
      if (mem.style) v.model.send(wrapM(mem.id, { t: 'style', ...mem.style }));
      if (mem.view) v.model.send(wrapM(mem.id, { t: 'mview', ...mem.view }));
      v.model.send(wrapM(mem.id, { t: 'props', list: mem.props || [] }));
      v.model.send(wrapM(mem.id, { t: 'perm', ...(mem.perm || {}) }));
    } catch {}
    sendMemberModel(v.model, mem);
    return;
  }
  const perm = mem.perm || {};
  const now = performance.now();
  v.memberFx = v.memberFx || {};
  const last = v.memberFx[mem.id] = v.memberFx[mem.id] || {};
  if (d.t === 'grab') {
    if (!perm.grab) return;
    const p = Array.isArray(d.p) && d.p.length === 3 && d.p.every(Number.isFinite) ? d.p : null;
    relayMemberFromViewer(mem, { t: 'grab', k: 'v' + v.n, j: Number.isInteger(d.j) ? d.j : -1, p }, id);
    return;
  }
  if (d.k === 'slap') {
    if (!perm.slap || now - (last.slap || 0) < 300) return;
    last.slap = now;
    const dir = Array.isArray(d.d) && d.d.length === 3 && d.d.every((x) => Number.isFinite(+x)) ? d.d.map((x) => Math.max(-1, Math.min(1, +x))) : null;
    relayMemberFromViewer(mem, { t: 'fx', k: 'slap', d: dir }, id);
    return;
  }
  if (!perm.pat || (d.k !== 'pat' && d.k !== 'boop')) return;
  if (d.k === 'boop') { if (now - (last.boop || 0) < 250) return; last.boop = now; }
  relayMemberFromViewer(mem, { t: 'fx', k: d.k, r: Number.isFinite(+d.r) ? +d.r : undefined }, id);
}
// the toucher's own app already shows it, but the others (and the owner) need it; the mirror has no
// network connection, so it gets it like everyone else
function relayMemberFromViewer(mem, d, fromId) {
  sendToMember(mem, wrapM(mem.id, d)); // the owner (their onHostMessage applies it to their own avatar)
  relayMember(mem, d, fromId);
}

// send a big binary in chunks with back-pressure: kind-begin / kind-chunk / kind-end
async function sendChunked(conn, kind, meta, buf, stillWanted = () => true, wrap = (m) => m) {
  const chunks = Math.ceil(buf.byteLength / MODEL_CHUNK);
  conn.send(wrap({ t: kind + '-begin', ...meta, size: buf.byteLength, chunks }));
  for (let i = 0; i < chunks; i++) {
    if (!conn.open || !stillWanted()) return false;
    while (conn.dataChannel && conn.dataChannel.bufferedAmount > 4 * 1024 * 1024) await new Promise((r) => setTimeout(r, 30));
    conn.send(wrap({ t: kind + '-chunk', ...meta, i, data: buf.slice(i * MODEL_CHUNK, (i + 1) * MODEL_CHUNK) }));
    if (i % 16 === 15) await new Promise((r) => setTimeout(r, 0));
  }
  conn.send(wrap({ t: kind + '-end', ...meta }));
  return true;
}

async function sendPropImage(conn, hash) {
  const blob = await getAnyPropImage(hash);
  if (!blob || !conn?.open) return;
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
  const live = [...viewers.entries()].filter(([, v]) => isLive(v));
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
  syncMirror();
  if ($('placeView').hidden) return;
  const v = viewers.get(selectedViewer);
  const msg = $('placeMsg');
  const show = (text) => { msg.hidden = false; msg.innerHTML = text; $('screenArea').hidden = true; $('placeBar').hidden = !v; };
  if (!v) return show('Nobody is watching yet. Viewers in <b>Full screen</b> mode show up here.');
  if (!v.state) return show('Waiting for this viewer’s screen info…');
  if (v.state.mode !== 'screen') {
    return show(`<b>${viewerLabel(v).replace(/</g, '&lt;')}</b> uses the ${MODE_LABEL[v.state.mode] || v.state.mode}, so there's nothing to place.<br>They can switch to <b>Full screen</b> from their tray icon.`);
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
    : 'Screen preview is off (they can turn it on from their tray icon).<br>This is an outline of their monitor.';

  const zp = zoneRectPx();
  const me = myId || 'h';
  const place = (el, pos) => {
    const p = clampPos(pos, zp);
    const boxH = p.s * zp.h, boxW = boxH * AVATAR_ASPECT;
    Object.assign(el.style, { left: p.x * zp.w - boxW / 2 + 'px', top: p.y * zp.h - boxH + 'px', width: boxW + 'px', height: boxH + 'px' });
  };
  place($('avBox'), roomPos(v, me));
  $('avName').textContent = modelName || 'Avatar';
  $('avBox').classList.toggle('locked', GUEST && !room.free);
  $('avBox').title = GUEST && !room.free ? 'You stand in the row next to the host' : '';
  $('avHandle').hidden = GUEST && !room.free;
  // the other avatars of the room
  const others = room.order.length > 1 ? room.order.filter((id) => id !== me) : [];
  for (const [id, el] of memberBoxes) if (!others.includes(id)) { el.remove(); memberBoxes.delete(id); }
  for (const id of others) {
    let el = memberBoxes.get(id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'mbox';
      el.innerHTML = '<span class="name"></span><svg viewBox="0 0 60 100"><circle cx="30" cy="18" r="13" fill="#fff"/><path d="M8 100 V58 q0-20 22-20 q22 0 22 20 V100z" fill="#fff"/></svg>';
      $('zoneBox').insertBefore(el, $('avBox'));
      memberBoxes.set(id, el);
    }
    el.querySelector('.name').textContent = room.names[id] || (id === 'h' ? 'Host' : 'Co-host');
    place(el, roomPos(v, id));
  }
  renderScreenProps();
}
const memberBoxes = new Map(); // id → ghost box of another avatar of the room in the placement view

/** Where an avatar of the room stands on a full-screen viewer: its own place (free placement), or next to the host in the row. */
function roomPos(v, id) {
  if (id !== 'h' && room.free && v.mpos?.[id]) return v.mpos[id];
  const zp = zoneRectPx();
  return rowPos(room.order, id, v.pos, zp.w / zp.h, view.roll); // v.pos: the middle of the row
}
/** A co-host placing their own avatar on a full-screen viewer (when the host allows it; the host can't move them then). */
function setMemberPos(v, id, patch) {
  v.mpos = v.mpos || {};
  const p = v.mpos[id] = clampPos({ ...roomPos(v, id), ...patch, tb: true }, zoneRectPx());
  renderPlacement();
  sendToHost({ t: 'mpos', key: selectedViewer, x: p.x, y: p.y, s: p.s, tb: true });
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
  if (GUEST) { if (room.free) setMemberPos(v, myId, patch); return; } // a co-host moves only their own avatar
  const zp = zoneRectPx();
  v.pos = clampPos({ ...v.pos, ...patch }, zp);
  const n = room.order.length, i = room.order.indexOf('h');
  if (n > 1 && i >= 0) { // keep the row's middle where the whole row fits (no dead zone when dragging back)
    const ratio = zp.w / zp.h;
    const r = (view.roll || 0) * Math.PI / 180;
    v.pos.x = rowPos(room.order, 'h', v.pos, ratio, view.roll).x - (i - (n - 1) / 2) * SLOT_STEP * v.pos.s / ratio * Math.cos(r);
  }
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
  if (GUEST && !room.free) return;
  // the host moves the whole row (v.pos is its middle), a co-host only their own avatar
  drag = { v, resize: e.target.id === 'avHandle', x: e.clientX, y: e.clientY, start: { ...(GUEST ? roomPos(v, myId) : v.pos) } };
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
const endDrag = () => { if (!drag) return; drag.v.dragging = false; if (!GUEST) sendPos(drag.v, true); drag = null; $('avBox').classList.remove('dragging', 'snapped'); };
$('avBox').addEventListener('pointerup', endDrag);
$('avBox').addEventListener('pointercancel', endDrag);
$('screenArea').addEventListener('wheel', (e) => {
  const v = viewers.get(selectedViewer);
  if (!v) return;
  e.preventDefault();
  updatePos(v, { s: roomPos(v, myId || 'h').s * (e.deltaY < 0 ? 1.06 : 1 / 1.06) });
}, { passive: false });
$('placeAdd').onclick = () => $('placeFile').click();
$('placeFile').onchange = async () => { for (const f of $('placeFile').files) await addPropFile(f, { onScreen: true }); $('placeFile').value = ''; };
resetButtons($('resetPosBtns'), (what) => {
  const v = viewers.get(selectedViewer);
  if (!v) return;
  if (what === 'size') updatePos(v, { s: DEFAULT_POS.s }); // feet stay where they are
  else if (what === 'pos') updatePos(v, { x: DEFAULT_POS.x, tb: true, y: taskbarSnapY(v) ?? 1 });
  else updatePos(v, { ...DEFAULT_POS, tb: true, y: taskbarSnapY(v) ?? 1 });
});

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
    // clicking the prop's bar (anywhere but its buttons) opens its settings, clicking again closes them
    const top = row.querySelector('.top');
    top.style.cursor = 'pointer';
    top.onclick = (e) => { if (!e.target.closest('button')) selectProp(selectedProp === d.id ? null : d.id); };
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
  if (voice.an) applyVoice(b);
  // per-expression tuning: e.g. a closed-eye "joy" face shouldn't blink, a pout shouldn't open the mouth
  // Auto expressions use their expression's tuning too, as strongly as the expression shows. They're
  // read here, before the tuning, so e.g. tuning the smile away for "happy" doesn't switch happy off.
  const auto = autoExpression(b, style.ag, exprBase.update(b, Math.min(0.2, (t - (exprBase.t ?? t)) || 0.033)), settings.exprCal);
  autoRaw = auto.raw;
  if (calibrating && performance.now() < calibrating.until) calibrating.vals.push(auto.raw[calibrating.k] || 0);
  exprBase.t = t;
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
    if (GUEST) { // a co-host: to the host, who passes it on
      toOutput({ ...frame, m: myId || 'me' });
      const mo = host?.motion;
      if (mo?.open && (mo.dataChannel?.bufferedAmount ?? 0) <= MOTION_MAX_BUFFERED) { try { mo.send(frame); } catch {} }
      return;
    }
    toOutput(frame);
    for (const v of viewers.values()) {
      if (!v.motion?.open) continue;
      // a backed-up channel means the network can't keep up: drop this frame rather than queue it
      if ((v.motion.dataChannel?.bufferedAmount ?? 0) > MOTION_MAX_BUFFERED) { v.skipped = (v.skipped || 0) + 1; continue; }
      try { v.motion.send(frame); } catch {}
    }
    for (const m of members.values()) {
      if (!m.motion?.open || (m.motion.dataChannel?.bufferedAmount ?? 0) > MOTION_MAX_BUFFERED) continue;
      try { m.motion.send(frame); } catch {}
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
