// Shared constants for the sender <-> receiver protocol.

// Dev builds (npm run dev, pages opened with ?dev=1) use their own rooms: a dev broadcaster and a
// released viewer (or the other way round) can never find each other.
const PAGE_Q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
export const IS_DEV = PAGE_Q.has('dev');
export const DEV_CODE = (PAGE_Q.get('devcode') || '').toUpperCase();
export const PEER_PREFIX = IS_DEV ? 'vtoverlay-dev-room-' : 'vtoverlay-room-';

// ARKit-style blendshape names, in the fixed order they are sent over the wire.
// (MediaPipe FaceLandmarker outputs exactly these, plus "_neutral".)
export const ARKIT = [
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'cheekPuff', 'cheekSquintLeft', 'cheekSquintRight',
  'eyeBlinkLeft', 'eyeBlinkRight', 'eyeLookDownLeft', 'eyeLookDownRight',
  'eyeLookInLeft', 'eyeLookInRight', 'eyeLookOutLeft', 'eyeLookOutRight',
  'eyeLookUpLeft', 'eyeLookUpRight', 'eyeSquintLeft', 'eyeSquintRight',
  'eyeWideLeft', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawOpen', 'jawRight',
  'mouthClose', 'mouthDimpleLeft', 'mouthDimpleRight', 'mouthFrownLeft', 'mouthFrownRight',
  'mouthFunnel', 'mouthLeft', 'mouthLowerDownLeft', 'mouthLowerDownRight',
  'mouthPressLeft', 'mouthPressRight', 'mouthPucker', 'mouthRight',
  'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthStretchLeft', 'mouthStretchRight',
  'mouthUpperUpLeft', 'mouthUpperUpRight', 'noseSneerLeft', 'noseSneerRight',
];
export const ARKIT_INDEX = Object.fromEntries(ARKIT.map((n, i) => [n, i]));

// Expressions the sender can trigger with hotkeys 1-5 (VRM presets).
export const HOTKEY_EXPRESSIONS = ['happy', 'angry', 'sad', 'surprised', 'relaxed'];

// Size of each chunk when sending the .vrm file to viewers.
export const MODEL_CHUNK = 64 * 1024;

// Default placement of the avatar in full-screen mode:
//   x = horizontal centre, y = bottom edge (both 0..1 inside the zone),
//   s = avatar height as a fraction of the zone height
export const DEFAULT_POS = { x: 0.85, y: 1, s: 0.5 };

// How the avatar is shot (set by the broadcaster, same for every viewer):
//   fr = 'bust' | 'full', zoom, px/py = pan in "visible heights", yaw = model turn (rad), el = camera elevation (rad),
//   roll = picture rotation (degrees, + = counter-clockwise; 180 = upside down)
export const DEFAULT_VIEW = { fr: 'bust', zoom: 1, px: 0, py: 0, yaw: 0, el: 0, roll: 0 };

// How the avatar looks (set by the broadcaster, same for every viewer):
//   vg    = sensitivity of each mouth shape (VRM visemes: aa = A, ee = E, ih = I, oh = O, ou = U)
//   vm    = hard limit of each mouth shape (0..1, applied after the sensitivity)
//   light = key light colour / intensity / direction it comes FROM (x: -1 left … +1 right of the screen,
//           y: -1 below … +1 above, z: -1 behind … +1 in front / from the camera) and the ambient (fill) light
export const VISEMES = [['aa', 'A'], ['ee', 'E'], ['ih', 'I'], ['oh', 'O'], ['ou', 'U']];
export const AUTO_EXPR = [['happy', 'Happy'], ['sad', 'Sad'], ['angry', 'Angry'], ['surprised', 'Surprised']];
export const DEFAULT_STYLE = {
  vg: { aa: 1, ee: 1, ih: 1, oh: 1, ou: 1 },
  vm: { aa: 1, ee: 1, ih: 1, oh: 1, ou: 1 }, // hard limit: each mouth shape never goes past this
  ag: { happy: 1, sad: 1, angry: 1, surprised: 1 }, // auto expression sensitivity
  light: { color: '#ffffff', i: 0.9, x: 0.32, y: 0.72, z: 0.62, amb: 0.45, ambColor: '#ffffff' },
  pose: 'stand', // body pose, one of POSES
};
/** Body poses the broadcaster can pick (legs, hips, a bit of spine; head, face and arms stay tracked). */
export const POSES = [['stand', 'Standing'], ['relaxed', 'Relaxed (weight on one leg)'], ['walk', 'Walking'], ['sit', 'Sitting (chair)'], ['floor', 'Sitting on the floor'], ['kneel', 'Kneeling'], ['seiza', 'Sitting back on the knees']];
/** Clean up a style received from the network / storage (anything missing → default). */
export function normalizeStyle(st = {}) {
  const num = (v, d, lo, hi) => (Number.isFinite(+v) && v !== null && v !== '' ? Math.max(lo, Math.min(hi, +v)) : d);
  const col = (v, d) => (/^#[0-9a-f]{6}$/i.test(String(v)) ? String(v).toLowerCase() : d);
  const D = DEFAULT_STYLE, vg = st.vg || {};
  let l = st.light || {};
  if (l.x === undefined && (l.az !== undefined || l.el !== undefined)) { // older versions: angles in degrees
    const az = num(l.az, 27, -180, 180) * Math.PI / 180, el = num(l.el, 46, -89, 89) * Math.PI / 180;
    l = { ...l, x: Math.sin(az) * Math.cos(el), y: Math.sin(el), z: Math.cos(az) * Math.cos(el) };
  }
  return {
    vg: Object.fromEntries(VISEMES.map(([k]) => [k, num(vg[k], D.vg[k], 0, 3)])),
    vm: Object.fromEntries(VISEMES.map(([k]) => [k, num((st.vm || {})[k], D.vm[k], 0, 1)])),
    ag: Object.fromEntries(AUTO_EXPR.map(([k]) => [k, num((st.ag || {})[k], D.ag[k], 0, 3)])),
    light: {
      color: col(l.color, D.light.color), i: num(l.i, D.light.i, 0, 3),
      x: num(l.x, D.light.x, -1, 1), y: num(l.y, D.light.y, -1, 1), z: num(l.z, D.light.z, -1, 1),
      amb: num(l.amb, D.light.amb, 0, 2), ambColor: col(l.ambColor, D.light.ambColor),
    },
    fx: normalizeFx(st.fx),
    pose: POSES.some(([k]) => k === st.pose) ? st.pose : D.pose,
  };
}

// Headpat / boop areas (fine-tuning by the broadcaster, in metres / multipliers, relative to what's
// detected automatically from the model's head and eyes): hy = head area up/down, hs = head area size,
// ny / nz = nose up/down and forward/back, ns = nose area size.
export const DEFAULT_FX = { hy: 0, hz: 0, hs: 1, ny: 0, nz: 0, ns: 1 };
export function normalizeFx(fx = {}) {
  const num = (v, d, lo, hi) => (Number.isFinite(+v) && v !== null && v !== '' ? Math.max(lo, Math.min(hi, +v)) : d);
  const D = DEFAULT_FX; fx = fx || {};
  return { hy: num(fx.hy, D.hy, -0.3, 0.3), hz: num(fx.hz, D.hz, -0.3, 0.3), hs: num(fx.hs, D.hs, 0.3, 3), ny: num(fx.ny, D.ny, -0.15, 0.15), nz: num(fx.nz, D.nz, -0.15, 0.15), ns: num(fx.ns, D.ns, 0.3, 3) };
}

// Full screen viewers hide the avatar after this long without live tracking (paused, face lost, disconnected).
export const IDLE_HIDE_MS = 30000;

export const HEARTBEAT_MS = 2000;       // both sides ping this often on the model channel
export const HEARTBEAT_TIMEOUT_MS = 10000; // …and consider the other side gone after this much silence
export const MOTION_MAX_BUFFERED = 32 * 1024; // skip motion frames while the channel is backed up
export const AVATAR_ASPECT = 0.62; // width / height of the avatar box

/*
Privacy: the webcam image never leaves the broadcaster's computer. Only the numbers
below (head rotation, head offset, 52 face-shape weights, expression name and, if arm
 tracking is on, arm/finger directions) are sent.

Messages
  motion channel (unreliable, json, ~30 Hz):
    { t:'m', q:[x,y,z,w], p:[x,y,z], b:[52 numbers 0..1], x:'happy'|null, f:boolean (face found), h:true (held: out of view, last pose),
      ae:boolean (auto expressions), a:{l,r}|null (arm/hand directions, see arms.js) }
       q = head rotation (avatar space), p = head offset in metres from calibrated centre
  model channel (reliable, binary):
    { t:'model-use', id }                the viewer already has this model cached, load it from there
    { t:'model-begin', id, size, chunks }   (id = SHA-256 of the file, first 16 hex chars; the file name is never sent)
    { t:'model-chunk', id, i, data:ArrayBuffer }
    { t:'model-end', id }

  control (model channel):
    viewer -> broadcaster  { t:'viewer', name, mode:'floating'|'window'|'screen', aspect, zone:{x,y,w,h}, pos, sharing, have }
                           (zone is 0..1 of the viewer's monitor; aspect = monitor width / height; have = cached model id)
                           { t:'need-model' }   cache miss after 'model-use'
    broadcaster -> viewer  { t:'view', fr, zoom, px, py, yaw, el }
                           { t:'style', vg:{aa,ee,ih,oh,ou}, light:{color,i,az,el,amb,ambColor} }   (see normalizeStyle)
                           { t:'pos', x, y, s, tb }   (only used in 'screen' mode; tb = may cover the taskbar)
                           { t:'perm', grab:boolean, pat:boolean }   may viewers pull hair / clothes? headpat & boop?
                           { t:'fx', k:'pat'|'boop', r }   someone's headpat (sent ~every 150 ms while rubbing; r = pats/s) / boop
                           { t:'grab', k, j, p }        someone's pull (k = 'b' broadcaster | 'v<n>' viewer; j = spring joint index,
                                                         p = avatar-local target [x,y,z], j:-1 / p:null = let go)
    viewer -> broadcaster  { t:'grab', j, p }           this viewer's pull (ignored unless allowed; relayed to the others)
                           { t:'fx', k }                this viewer's headpat / boop (ignored unless allowed; relayed)
                           { t:'rx', s:'waiting'|'loading'|'ready'|'hidden'|'error', p }   what the viewer sees (p = loading progress)
    both ways              { t:'hb' } heartbeat · { t:'bye', reason:'ended'|'kicked'|'left'|'full', max? } clean disconnect / room full

  props (model channel):
    broadcaster -> viewer  { t:'props', list:[{ id, img, attach, pos, rot, rx, ry, size, face, flip, visible, w, fp, fr, layer }] }
                           full list on every change (see shared/props.js)
    viewer -> broadcaster  { t:'need-prop', hash }   image not cached yet
    broadcaster -> viewer  { t:'prop-begin', hash, mime, size, chunks } · { t:'prop-chunk', hash, i, data } · { t:'prop-end', hash }
    (file names of props are never sent)

  screen preview (optional, viewer opts in): the viewer places a PeerJS media call to the
  broadcaster carrying a low-frame-rate capture of the monitor the avatar is on.
*/

/** The zone the avatar may use in full screen mode, minus the taskbar (`work` = usable part of the monitor). */
export function effectiveZone(zone, work = { x: 0, y: 0, w: 1, h: 1 }) {
  const x = Math.max(zone.x, work.x), y = Math.max(zone.y, work.y);
  const r = Math.min(zone.x + zone.w, work.x + work.w), b = Math.min(zone.y + zone.h, work.y + work.h);
  return r - x > 0.02 && b - y > 0.02 ? { x, y, w: r - x, h: b - y } : { ...work };
}

// PeerJS's `reliable: false` only makes a data channel *unordered*, it still retransmits lost
// packets forever, so on a lossy connection old motion frames pile up (growing lag) and block the
// heartbeats. Motion frames are worthless once a newer one exists, so make that channel truly
// unreliable: no retransmits, unordered. (Patched once per page, before any connection is made.)
if (typeof RTCPeerConnection !== 'undefined' && !RTCPeerConnection.prototype.__vtPatched) {
  const orig = RTCPeerConnection.prototype.createDataChannel;
  RTCPeerConnection.prototype.createDataChannel = function (label, opts = {}) {
    if (label === 'motion') opts = { ...opts, ordered: false, maxRetransmits: 0 };
    return orig.call(this, label, opts);
  };
  RTCPeerConnection.prototype.__vtPatched = true;
}

// PeerJS options. By default the free public PeerJS signalling server is used; to use your own
// (npx peer --port 9000), set localStorage 'vt-peer-server' to {"host":"…","port":9000,"path":"/","secure":false}.
export function peerOptions() {
  let custom = null;
  try { custom = JSON.parse(PAGE_Q.get('peer') || localStorage.getItem('vt-peer-server') || 'null'); } catch {}
  return {
    ...(custom || {}),
    config: { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }] },
  };
}
