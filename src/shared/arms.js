// Arm + hand tracking → compact direction payload (pure math, no three.js).
//
// Everything is expressed in "avatar space": the avatar faces +Z (toward the viewer),
// +X is the avatar's LEFT, +Y is up. The receiver turns these directions into bone
// rotations for its own copy of the rig (see AvatarStage._applyArms).

// MediaPipe Pose landmark indices (anatomical left/right of the person)
const POSE = { l: { shoulder: 11, elbow: 13, wrist: 15 }, r: { shoulder: 12, elbow: 14, wrist: 16 } };

// VRM finger bones and the hand landmarks that span each one
export const FINGER_SEGMENTS = [
  ['ThumbMetacarpal', 1, 2], ['ThumbProximal', 2, 3], ['ThumbDistal', 3, 4],
  ['IndexProximal', 5, 6], ['IndexIntermediate', 6, 7], ['IndexDistal', 7, 8],
  ['MiddleProximal', 9, 10], ['MiddleIntermediate', 10, 11], ['MiddleDistal', 11, 12],
  ['RingProximal', 13, 14], ['RingIntermediate', 14, 15], ['RingDistal', 15, 16],
  ['LittleProximal', 17, 18], ['LittleIntermediate', 18, 19], ['LittleDistal', 19, 20],
];

const Z_SCALE = 0.6; // monocular depth is noisy — damp it
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const r3 = (v) => Math.round(v * 1000) / 1000;

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function norm(v) { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [r3(v[0] / l), r3(v[1] / l), r3(v[2] / l)]; }

/**
 * @param pose   PoseLandmarker result (or null)
 * @param hands  HandLandmarker result (or null)
 * @param mirror true = avatar moves like your reflection
 * @returns {{l: object|null, r: object|null} | null}
 */
export function buildArmPayload(pose, hands, mirror) {
  const p2d = pose?.landmarks?.[0], p3d = pose?.worldLandmarks?.[0];
  if (!p2d || !p3d) return null;

  // MediaPipe world coords: x → image right (= person's left), y down, z away from camera.
  const toAv = (pt) => [mirror ? -pt.x : pt.x, -pt.y, -pt.z * Z_SCALE];

  // Match detected hands to the pose's wrists (handedness labels are unreliable on raw webcam frames).
  const handFor = { l: null, r: null };
  const hl = hands?.landmarks || [], hw = hands?.worldLandmarks || [];
  for (let i = 0; i < hl.length; i++) {
    const wrist = hl[i][0];
    let best = null, bestD = 0.18;
    for (const side of ['l', 'r']) {
      const pw = p2d[POSE[side].wrist];
      const d = Math.hypot(pw.x - wrist.x, pw.y - wrist.y);
      if (d < bestD && !handFor[side]) { best = side; bestD = d; }
    }
    if (best) handFor[best] = hw[i] || null;
  }

  const out = {};
  for (const avSide of ['l', 'r']) {
    // in mirror mode the avatar's left arm copies your right arm
    const side = mirror ? (avSide === 'l' ? 'r' : 'l') : avSide;
    const idx = POSE[side];
    const vis = Math.min(p2d[idx.elbow].visibility ?? 1, p2d[idx.wrist].visibility ?? 1);
    const w = clamp01((vis - 0.55) / 0.25);
    if (w <= 0) { out[avSide] = null; continue; }
    const sh = toAv(p3d[idx.shoulder]), el = toAv(p3d[idx.elbow]), wr = toAv(p3d[idx.wrist]);
    const arm = { w: r3(w), u: norm(sub(el, sh)), f: norm(sub(wr, el)), hw: 0 };

    const h = handFor[side];
    if (h) {
      const P = h.map(toAv);
      arm.hw = 1;
      arm.h = [...norm(sub(P[9], P[0])), ...norm(sub(P[5], P[17]))]; // forward (to middle knuckle), across (pinky → index)
      arm.g = [];
      for (const [, a, b] of FINGER_SEGMENTS) arm.g.push(...norm(sub(P[b], P[a])));
    }
    out[avSide] = arm;
  }
  return out;
}
