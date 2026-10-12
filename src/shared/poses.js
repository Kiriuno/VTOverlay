// Body poses (standing, sitting, walking…): procedural leg / hips / spine angles that the head, face
// and arm tracking sit on top of. A pose is a flat set of numbers so poses can be cross-faded by
// simply blending them. Units: radians, and metres for the hips offset. Directions are the model's
// own ("forward" = where it faces, "left" = its left), converted to bone rotations in avatar.js.
//
//   hx, hy, hz   hips offset (to the left, up, forward); bob = extra up/down that the framing ignores
//   hp, hr       hips pitch (top forward) and roll (left side down)
//   sp, sr       spine lean forward / to the left
//   per leg (l… / r…):  F thigh forward, O thigh outward, T knee turned outward, K knee bend, A toes down
//   per arm (la / ra):  F arm swung forward (on top of the relaxed arm pose)
// Hands resting somewhere (on the hip, the thighs…) are placed by IK, see poseArms.

/** Leg measurements of a model (normalized bones), used to keep feet / knees / bottom on the floor. */
export function measureLegs(hb, hipsRest) {
  const up = hb('leftUpperLeg'), low = hb('leftLowerLeg'), foot = hb('leftFoot');
  if (!up || !low || !foot || !hipsRest) return null;
  const L1 = low.position.length(), L2 = foot.position.length();
  const legTop = hipsRest.y + up.position.y; // hip joints' height when standing
  const footH = Math.max(0.02, legTop - L1 - L2); // ankle height
  return { L1, L2, legTop, footH, k: legTop / 0.85 }; // k: size compared to an average adult's legs
}

export function poseValues(name, t, m) {
  const k = m.k;
  switch (name) {
    case 'relaxed': return {
      hx: -0.03 * k, hy: -0.008 * k, hr: 0.07, sr: -0.08,
      lF: 0.16, lO: 0.07, lT: 0.15, lK: 0.32, lA: 0.12, rO: -0.03,
    };
    case 'walk': {
      const ph = t * Math.PI * 2 * 0.85, sn = Math.sin(ph), cs = Math.cos(ph);
      return {
        bob: -0.018 * k * sn * sn, sp: 0.05, sr: 0.025 * sn, hr: -0.04 * sn,
        lF: 0.36 * sn, rF: -0.36 * sn,
        lK: 0.08 + 0.75 * Math.max(0, cs) ** 1.5, rK: 0.08 + 0.75 * Math.max(0, -cs) ** 1.5,
        lA: 0.2 * Math.max(0, cs) - 0.12 * Math.max(0, sn), rA: 0.2 * Math.max(0, -cs) - 0.12 * Math.max(0, -sn),
        laF: -0.32 * sn, raF: 0.32 * sn,
      };
    }
    case 'sit': {
      const F = 1.5, K = 1.5;
      return {
        hy: -(m.L1 * (1 - Math.cos(F)) + m.L2 * (1 - Math.cos(F - K))), sp: 0.06,
        lF: F, rF: F, lK: K, rK: K, lO: 0.07, rO: 0.07,
      };
    }
    case 'kneel': return {
      hy: -(m.L2 + 0.35 * m.footH), sp: 0.03,
      lF: 0.04, rF: 0.04, lK: 1.57, rK: 1.57, lA: 1.0, rA: 1.0, lO: 0.06, rO: 0.06,
    };
    case 'seiza': { // kneeling, sitting back between the heels: knees close, feet out to the sides so
      // they never go through the thighs (even with thick legs or big shoes)
      const F = 1.2, K = 2.55; // with the knee turned in by 0.95 the shins lie flat, pointing back and out
      return {
        hy: -(m.legTop - 0.06 * k - m.L1 * Math.cos(F)), sp: 0.05,
        lF: F, rF: F, lK: K, rK: K, lT: -0.95, rT: -0.95, lA: 1.3, rA: 1.3, lO: 0.04, rO: 0.04,
      };
    }
    case 'floor': return {
      hy: -(m.legTop - 0.11 * k), hz: -0.04 * k, hp: -0.12, sp: 0.16,
      lF: 1.35, rF: 1.35, lO: 0.5, rO: 0.5, lT: 1.3, rT: 1.3, lK: 2.3, rK: 2.3, lA: 0.2, rA: 0.2,
    };
    default: return {};
  }
}

/** Where a pose puts each hand while the camera doesn't see it: 'hip', 'thigh', 'knee' or null (arm left as is). */
export function poseArms(name) {
  switch (name) {
    case 'relaxed': return { l: 'hip', r: null };
    case 'sit': return { l: 'thigh', r: 'thigh' };
    case 'seiza': return { l: 'thigh', r: 'thigh' };
    case 'floor': return { l: 'knee', r: 'knee' };
    default: return { l: null, r: null };
  }
}

export const POSE_KEYS = ['hx', 'hy', 'bob', 'hz', 'hp', 'hr', 'sp', 'sr', 'lF', 'lO', 'lT', 'lK', 'lA', 'rF', 'rO', 'rT', 'rK', 'rA', 'laF', 'raF'];
