// Headpats and boops.
//
//  • Headpat: rub the mouse quickly back and forth over the top of the head. The head squishes in
//    rhythm under a big cartoon hand (the "headpat" meme). Only the model's head is squished (its bone
//    is scaled), props are never squished.
//  • Boop: click the nose. A little nose scrunch and a few tiny stars flying off.
//  • Slap (only if the broadcaster allows it): a quick swipe of the mouse across the bottom (not a
//    click, so the springs there can still be grabbed). The spring bones there (skirt, tail, long
//    hair…) wiggle for a moment, whole chains at once, and the legs wobble a tiny bit, feet planted.
//
// The areas come from the model's head and eye bones; the broadcaster can nudge them (style.fx).
// AvatarFx draws the effects; FxInput turns mouse movement into "pat" / "boop" events.
import * as THREE from 'three';

const UP = new THREE.Vector3(0, 1, 0);
// Pat speed (pats per second). The classic headpat gif pats ~2.6 times a second; rubbing faster or
// slower speeds it up / slows it down, but never below half or above four times that.
export const PAT_RATE = 2.6, PAT_MIN = PAT_RATE / 2, PAT_MAX = PAT_RATE * 2.5;
// Optional: the real headpat gif. Put it at assets/headpat.gif (it isn't shipped with the code);
// without it a drawn hand is used.
const HEADPAT_GIF = '/assets/headpat.gif';

export class AvatarFx {
  constructor(stage) {
    this.stage = stage;
    this.pat = { level: 0, until: 0, phase: 0, rate: PAT_RATE, want: PAT_RATE };
    this.boopAt = -1e9; this.slapAt = -1e9;
    this.stars = [];
    this.group = new THREE.Group();
    this.group.renderOrder = 900;
    stage.scene.add(this.group);
    this.hand = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: handTexture(), transparent: true, depthTest: false, depthWrite: false, toneMapped: false, opacity: 0,
    }));
    this.hand.renderOrder = 1000;
    this.hand.layers.set(3);
    this.hand.visible = false;
    this.group.add(this.hand);
    this.gif = null; // { frames: [canvas], tex, ctx, canvas } once assets/headpat.gif is loaded
    loadGif(HEADPAT_GIF).then((frames) => {
      if (!frames?.length) return;
      const canvas = document.createElement('canvas');
      canvas.width = frames[0].width; canvas.height = frames[0].height;
      const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace;
      this.gif = { frames, canvas, ctx: canvas.getContext('2d'), tex, shown: -1 };
      this.hand.material.map = tex; this.hand.material.needsUpdate = true;
    });
    this.starTex = starTexture();
    this.showAreas = false;
    this.areaMarks = null;
  }

  /** Called after a model loads: find the head / nose areas in head-bone space. */
  captureRest(vrm) {
    this.vrm = vrm;
    this.head = vrm?.humanoid.getRawBoneNode('head') || null;
    this.rest = null;
    if (!this.head) return;
    vrm.scene.updateMatrixWorld(true);
    const H = this.head.getWorldPosition(new THREE.Vector3());
    const le = vrm.humanoid.getRawBoneNode('leftEye'), re = vrm.humanoid.getRawBoneNode('rightEye');
    let eyes;
    if (le && re) eyes = le.getWorldPosition(new THREE.Vector3()).add(re.getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
    else eyes = H.clone().add(new THREE.Vector3(0, 0.07, 0.04)); // typical head proportions
    const eyeUp = Math.max(0.03, eyes.y - H.y);
    // at load the model faces +Z (avatar space == world here)
    this.rest = {
      headQ: this.head.getWorldQuaternion(new THREE.Quaternion()),
      H,
      patC: new THREE.Vector3(H.x, eyes.y + eyeUp * 1.6, H.z - 0.01), // top of the head
      patR: eyeUp * 1.35,
      noseC: eyes.clone().add(new THREE.Vector3(0, -eyeUp * 0.62, eyeUp * 0.6)), // below and in front of the eyes
      noseR: eyeUp * 0.38,
    };
    // the bottom: behind the hip joints, following the hips bone
    this.hips = vrm.humanoid.getRawBoneNode('hips') || null;
    const lL = vrm.humanoid.getRawBoneNode('leftUpperLeg'), rL = vrm.humanoid.getRawBoneNode('rightUpperLeg');
    if (this.hips && lL && rL) {
      const lp = lL.getWorldPosition(new THREE.Vector3()), rp = rL.getWorldPosition(new THREE.Vector3());
      const w = Math.max(0.08, lp.distanceTo(rp)); // hip width
      const mid = lp.add(rp).multiplyScalar(0.5);
      this.rest.hipsQ = this.hips.getWorldQuaternion(new THREE.Quaternion());
      this.rest.HP = this.hips.getWorldPosition(new THREE.Vector3());
      this.rest.buttC = new THREE.Vector3(mid.x, mid.y - w * 0.4, mid.z - w * 0.45);
      this.rest.buttR = w * 0.8;
    }
    this.pat.level = 0;
  }

  /** Current areas in world space: { pat: {c, r}, nose: {c, r} }, following the head. */
  areas() {
    if (!this.rest || !this.head) return null;
    const fx = this.stage.style?.fx || {};
    const r = this.rest;
    const toWorld = (pRest) => {
      // rest (avatar space) → head-local at rest → current world
      const local = pRest.clone().sub(r.H).applyQuaternion(r.headQ.clone().invert());
      const s = this.head.scale; // undo our own squish so the areas don't wobble
      local.set(local.x / (s.x || 1), local.y / (s.y || 1), local.z / (s.z || 1));
      return this.head.localToWorld(local);
    };
    const patRest = r.patC.clone().add(new THREE.Vector3(0, fx.hy || 0, fx.hz || 0));
    const noseRest = r.noseC.clone().add(new THREE.Vector3(0, fx.ny || 0, fx.nz || 0));
    const out = {
      pat: { c: toWorld(patRest), r: r.patR * (fx.hs || 1) },
      nose: { c: toWorld(noseRest), r: r.noseR * (fx.ns || 1) },
    };
    if (r.buttC && this.hips) {
      // forward/back is negative = further back (the area sits behind the hips)
      const rest = r.buttC.clone().add(new THREE.Vector3(0, fx.by || 0, -(fx.bz || 0)));
      const local = rest.sub(r.HP).applyQuaternion(r.hipsQ.clone().invert());
      const c = this.hips.localToWorld(local);
      const center = this.hips.getWorldPosition(new THREE.Vector3());
      out.butt = { c, r: r.buttR * (fx.bs || 1), back: c.clone().sub(center).setY(0).normalize() };
    }
    return out;
  }

  /** 'nose' | 'head' | 'butt' | null for a canvas point (CSS px). The bottom only counts when withButt
   *  and only while it's turned at least sideways to the camera (not through the front of the hips). */
  hit(x, y, headScale = 1, withButt = false) {
    const a = this.areas();
    if (!a) return null;
    const cam = this.stage.camera, w = this.stage.canvas.clientWidth, h = this.stage.canvas.clientHeight;
    cam.updateMatrixWorld(); // the view may have changed since the last frame was drawn
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
    const inside = (area) => {
      const c = area.c.clone().project(cam), e = area.c.clone().addScaledVector(right, area.r).project(cam);
      if (c.z > 1) return false;
      const cx = (c.x + 1) / 2 * w, cy = (1 - c.y) / 2 * h, rpx = Math.hypot((e.x - c.x) / 2 * w, (e.y - c.y) / 2 * h);
      return Math.hypot(x - cx, y - cy) <= rpx * scale;
    };
    let scale = 1;
    if (inside(a.nose)) return 'nose';
    if (withButt && a.butt) {
      const toCam = cam.position.clone().sub(a.butt.c).setY(0).normalize();
      if (a.butt.back.dot(toCam) > -0.25 && inside(a.butt)) return 'butt';
    }
    scale = headScale;
    if (inside(a.pat)) return 'head';
    return null;
  }

  /** Keep the headpat going (call repeatedly while someone is rubbing); rate = pats per second. */
  patting(rate = null) {
    this.pat.until = performance.now() + 900;
    if (Number.isFinite(rate)) this.pat.want = Math.max(PAT_MIN, Math.min(PAT_MAX, rate));
  }

  boop() {
    this.boopAt = performance.now();
    if (this.stage.suspended || this.stars.length > 40) return; // hidden / plenty already: no new stars
    const a = this.areas();
    if (!a) return;
    // a few tiny stars burst out of the nose, each its own way, then drift down and slowly fade
    const cam = this.stage.camera;
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion), up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
    const origin = a.nose.c.clone().addScaledVector(cam.position.clone().sub(a.nose.c).normalize(), 0.02);
    const n = 7, turn = Math.random() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const ang = turn + (i / n) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
      const dir = right.clone().multiplyScalar(Math.cos(ang)).addScaledVector(up, Math.sin(ang));
      this._spawnStar(origin, dir, a, i);
    }
  }

  /** A direction on screen (px, y down) as a unit direction in the avatar's own space, [x, y, z]. */
  screenToAvatarDir(dx, dy) {
    const cam = this.stage.camera;
    const w = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion).multiplyScalar(dx)
      .add(new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion).multiplyScalar(-dy));
    if (w.lengthSq() < 1e-8 || !this.vrm) return null;
    w.applyQuaternion(this.vrm.scene.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize();
    return w.toArray().map((v) => +v.toFixed(3));
  }

  /** @param dir optional [x, y, z] in avatar space: the way the slapping hand went (the wiggle follows it) */
  slap(dir = null) {
    this.slapAt = performance.now();
    this.slapChains = [];
    this.slapDir = Array.isArray(dir) && dir.length === 3 && dir.every(Number.isFinite) ? new THREE.Vector3(...dir) : null;
    const a = this.areas();
    if (!a?.butt) return;
    // every spring chain (skirt panel, tail, lock of hair…) that starts or passes near the bottom
    const st = this.stage, reach = a.butt.r * 1.6, p = new THREE.Vector3();
    const pick = st.style?.sb;
    if (pick && pick.id === st.modelId) { // the broadcaster picked the chains for this model
      const roots = new Set(pick.roots);
      this.slapChains = this._chains().filter((c) => roots.has(chainName(c)));
      this.slapR = a.butt.r;
      return;
    }
    for (const chain of this._chains()) {
      // near the bottom, or hanging straight off the hips (tails, skirts)
      const onHips = chain[0].bone.parent === this.hips || chain[0].bone.parent?.parent === this.hips;
      const near = onHips || chain.some((j) => j.bone.getWorldPosition(p).distanceTo(a.butt.c) < reach || st._jointTailWorld(j, p).distanceTo(a.butt.c) < reach);
      if (near) this.slapChains.push(chain);
    }
    this.slapR = a.butt.r;
  }

  /** The spring chains of the model: [{ name, joints }] (name = its root bone's name). */
  chainList() { return this._chains().map((c) => ({ name: chainName(c), joints: c.length })); }

  /** Spring joints grouped into chains (root first), worked out once per model. */
  _chains() {
    const st = this.stage;
    if (this._chainsFor === st.springJoints) return this._chainList;
    const byRoot = new Map();
    for (const j of st.springJoints || []) {
      const path = [j];
      let p = st.jointByBone.get(j.bone.parent);
      while (p && path.length < 64) { path.unshift(p); p = st.jointByBone.get(p.bone.parent); }
      const root = path[0];
      if (!byRoot.has(root) || byRoot.get(root).length < path.length) byRoot.set(root, path);
    }
    this._chainsFor = st.springJoints;
    this._chainList = [...byRoot.values()];
    return this._chainList;
  }

  /** While a slap is going: drive the hit chains side to side (forced, decaying), call before vrm.update(). */
  _wiggleSprings(dt) {
    const t = (performance.now() - this.slapAt) / 1000;
    if (!this.slapChains?.length || !(dt > 0)) return;
    if (t > 1.4) { this.slapChains = null; return; }
    const hips = this.hips;
    if (!hips) return;
    const q = hips.getWorldQuaternion(new THREE.Quaternion());
    let side = new THREE.Vector3(1, 0, 0).applyQuaternion(q), fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(q);
    if (this.slapDir && this.vrm && this.slapDir.lengthSq() > 1e-6) {
      // swung the way the hand went: knocked that way first, then swinging back and forth along it
      side = this.slapDir.clone().applyQuaternion(this.vrm.scene.getWorldQuaternion(new THREE.Quaternion())).normalize();
      fwd.set(0, 0, 0);
    }
    const r = this.slapR || 0.12;
    // where the tails should be pushed to, now and a frame ago; the difference is moved this frame. The
    // tails are moved directly (not given a speed), so it shows even on stiff, heavily damped springs.
    const D = (tt) => side.clone().multiplyScalar(Math.sin(tt * Math.PI * 2 * 3.6) * Math.exp(-2.4 * tt))
      .addScaledVector(fwd, 0.6 * (1 - Math.exp(-25 * tt)) * Math.exp(-5 * tt));
    const step = D(t).sub(D(Math.max(0, t - dt)));
    const tail = new THREE.Vector3(), moved = new THREE.Vector3();
    for (const chain of this.slapChains) {
      chain.forEach((j, i) => {
        const k = Math.min(1.6, 0.45 + i * 0.3) * r; // the further down the chain, the bigger the swing
        const m = j._getMatrixWorldToCenter();
        this.stage._jointTailWorld(j, tail);
        moved.copy(tail).addScaledVector(step, k).applyMatrix4(m);
        const delta = moved.sub(j._currentTail);
        j._currentTail.add(delta); j._prevTail.add(delta);
      });
    }
  }

  _spawnStar(origin, dir, a, i) {
    // stars are recycled (one shared shape, a small pool of meshes): nothing new is made per boop
    let m = this.starPool?.pop();
    if (!m) {
      this.starGeo = this.starGeo || new THREE.PlaneGeometry(1, 1);
      m = new THREE.Mesh(this.starGeo, new THREE.MeshBasicMaterial({ map: this.starTex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
      m.renderOrder = 1001;
      m.layers.set(3);
    }
    m.material.color.setHSL([0.13, 0.14, 0.11, 0.92, 0.55][i % 5], 1, 0.6);
    m.material.opacity = 1;
    m.rotation.set(0, 0, 0);
    m.position.copy(origin);
    const size = a.nose.r * (0.35 + Math.random() * 0.2); // tiny
    m.scale.set(size, size, 1);
    this.group.add(m);
    const speed = a.pat.r * (1.6 + Math.random() * 0.8);
    this.stars.push({ m, v: dir.multiplyScalar(speed), g: a.pat.r * 2.2, drag: 1.6, t: 0, life: 1.3 + Math.random() * 0.5, spin: (Math.random() - 0.5) * 6 });
  }

  /** Bone effects, call before vrm.update(). */
  applyBones(dt) {
    if (!this.head) return;
    const now = performance.now(), p = this.pat;
    const want = now < p.until ? 1 : 0;
    p.level += (want - p.level) * (1 - Math.exp(-dt * (want ? 10 : 5)));
    if (p.level < 0.002) p.level = 0;
    p.rate += (p.want - p.rate) * (1 - Math.exp(-dt * 4)); // ease speed changes
    if (p.level > 0) p.phase = (p.phase + dt * p.rate) % 1; // 0 → 1 = one pat
    else p.phase = 0;
    // squish follows the pat: hand comes down in the middle of each cycle (like the gif)
    const press = p.level * Math.pow(Math.sin(p.phase * Math.PI), 1.5); // 0 = hand up, 1 = hand down
    let sy = 1 - 0.22 * press, sxz = 1 + 0.12 * press;
    // boop: a quick scrunch that settles
    const bt = (now - this.boopAt) / 1000;
    if (bt < 0.45) { const k = Math.sin(bt / 0.45 * Math.PI) * Math.exp(-bt * 3); sy *= 1 - 0.1 * k; sxz *= 1 + 0.06 * k; }
    this.head.scale.set(sxz, sy, sxz);
    this.press = press;
    // slap: the springs there wiggle, and the hips give a small jiggle (the upper body is held steady)
    this._wiggleSprings(dt);
    // …and the legs wobble a tiny bit, knees swaying while the feet stay planted: the thigh turns by w,
    // the shin back by twice that (thigh ≈ shin length), the foot by w again to stay flat
    const st = (now - this.slapAt) / 1000;
    if (st < 0.8 && this.vrm) {
      const hb = (n) => this.vrm.humanoid.getNormalizedBoneNode(n);
      const w = 0.018 * Math.sin(st * 26) * Math.exp(-st * 5.5), Z = new THREE.Vector3(0, 0, 1);
      for (const side of ['left', 'right']) {
        hb(side + 'UpperLeg')?.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(Z, w));
        hb(side + 'LowerLeg')?.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(Z, -2 * w));
        hb(side + 'Foot')?.quaternion.multiply(new THREE.Quaternion().setFromAxisAngle(Z, w));
      }
    }
  }

  /** Hand, stars and area outlines, call every frame after the model is posed. */
  update(dt, camera) {
    const a = (this.pat.level > 0 || this.stars.length || this.showAreas) ? this.areas() : null;
    // the big hand: comes down on the head in rhythm, always facing the viewer
    const L = this.pat.level;
    this.hand.visible = L > 0.01 && !!a;
    if (this.hand.visible) {
      // the hand comes from above the avatar's head as seen on screen, even when the picture is rolled
      // (sideways, upside down): "up" is the avatar's up, flattened onto the screen
      const camQ = camera.quaternion;
      const camUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camQ), camRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camQ);
      const ax = UP.dot(camRight), ay = UP.dot(camUp);
      const roll = Math.hypot(ax, ay) > 0.2 ? Math.atan2(-ax, ay) : 0; // how far the avatar's up is turned on screen
      const handQ = camQ.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), roll));
      const r = a.pat.r, up = new THREE.Vector3(0, 1, 0).applyQuaternion(handQ);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(handQ);
      const toCam = camera.position.clone().sub(a.pat.c).normalize();
      if (this.gif) {
        // the gif animates the hand itself: show the frame for this point of the pat
        const g = this.gif, f = Math.min(g.frames.length - 1, Math.floor(this.pat.phase * g.frames.length));
        if (f !== g.shown) { g.ctx.clearRect(0, 0, g.canvas.width, g.canvas.height); g.ctx.drawImage(g.frames[f], 0, 0); g.tex.needsUpdate = true; g.shown = f; }
        this.hand.position.copy(a.pat.c).addScaledVector(up, r * (0.55 + 0.5 * (1 - L))).addScaledVector(toCam, r * 0.6);
        this.hand.quaternion.copy(handQ);
        const s = r * 3.4;
        this.hand.scale.set(s, s, 1);
      } else {
        const lift = r * (1.0 - 0.45 * (this.press || 0)) + r * 0.6 * (1 - L);
        this.hand.position.copy(a.pat.c).addScaledVector(up, lift).addScaledVector(right, Math.sin(this.pat.phase * Math.PI * 2 * 0.5) * r * 0.12).addScaledVector(toCam, r * 0.6);
        this.hand.quaternion.copy(handQ);
        this.hand.rotateZ(-0.15 + Math.sin(this.pat.phase * Math.PI * 2) * 0.05);
        const s = r * 2.4;
        this.hand.scale.set(s, s, 1);
      }
      this.hand.material.opacity = Math.min(1, L * 1.6);
    }
    // boop stars fly out, slow down, drift down (gravity, screen-down) and slowly fade
    const down = new THREE.Vector3(0, -1, 0).applyQuaternion(camera.quaternion);
    for (let i = this.stars.length - 1; i >= 0; i--) {
      const st = this.stars[i];
      st.t += dt;
      st.v.multiplyScalar(Math.exp(-st.drag * dt)).addScaledVector(down, st.g * dt);
      st.m.position.addScaledVector(st.v, dt);
      st.m.quaternion.copy(camera.quaternion);
      st.m.rotateZ(st.t * st.spin);
      const k = st.t / st.life;
      st.m.material.opacity = k < 0.35 ? 1 : Math.max(0, 1 - (k - 0.35) / 0.65) ** 1.5; // hold, then fade out slowly
      if (st.t >= st.life) { this.group.remove(st.m); (this.starPool = this.starPool || []).push(st.m); this.stars.splice(i, 1); }
    }
    this._drawAreas(a, camera);
  }

  // dashed circles showing the areas (broadcaster's preview, while adjusting them)
  _drawAreas(a, camera) {
    if (!this.showAreas || !a) { if (this.areaMarks) this.areaMarks.visible = false; return; }
    if (!this.areaMarks) {
      const ring = (color) => {
        const pts = []; for (let i = 0; i <= 48; i++) { const t = i / 48 * Math.PI * 2; pts.push(new THREE.Vector3(Math.cos(t), Math.sin(t), 0)); }
        const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color, dashSize: 0.12, gapSize: 0.08, depthTest: false }));
        l.computeLineDistances(); l.renderOrder = 1002; l.layers.set(3); return l;
      };
      this.areaMarks = new THREE.Group();
      this.areaMarks.add(ring(0xb48cff), ring(0xffcf70), ring(0xff7aa8));
      this.group.add(this.areaMarks);
    }
    this.areaMarks.visible = true;
    const [pat, nose, butt] = this.areaMarks.children;
    for (const [m, ar] of [[pat, a.pat], [nose, a.nose], [butt, a.butt]]) {
      m.visible = !!ar;
      if (ar) { m.position.copy(ar.c); m.quaternion.copy(camera.quaternion); m.scale.setScalar(ar.r); }
    }
  }
}

/**
 * Mouse → pat / boop.
 *  • A headpat starts after ~0.4 s of rubbing back and forth over the head (so just passing over it
 *    does nothing). Once it's going, the area is more forgiving: overshooting the head a bit, or
 *    leaving it for a moment, doesn't stop it.
 *  • Rubbing speed sets the pat speed (PAT_MIN … PAT_MAX).
 *  • Boop = a click (mouse down) on the nose.
 */
const START_AFTER_MS = 400, FORGIVE_MS = 600, OVERSHOOT = 1.8, FLIP_MIN_PX = 10;
// a pat needs some speed: strokes slower than this (back-and-forths per second) don't start one, and a
// pause this long between direction changes starts the count over (slowly moving across the head)
const START_RATE = 4, MAX_FLIP_GAP_MS = 175;
// a slap: the mouse crossing the bottom at least this fast (px/s) for at least this far (px)
const SLAP_SPEED = 1400, SLAP_PX = 40;
export class FxInput {
  constructor(fx, canvas, { onPat = () => {}, onBoop = () => {}, onSlap = () => {}, enabled = () => true, canSlap = () => false } = {}) {
    this.fx = fx; this.canvas = canvas; this.onPat = onPat; this.onBoop = onBoop; this.onSlap = onSlap; this.enabled = enabled; this.canSlap = canSlap;
    this._reset();
    this.lastPatSent = 0;
  }
  _reset() { this.last = null; this.dir = 0; this.travel = 0; this.flips = []; this.rubSince = 0; this.offSince = 0; this.patting = false; }
  _local(e) { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  /** 'nose' | 'head' | null under the mouse (the bottom isn't clickable: it's swiped, see _swipe). */
  over(e) { return this.enabled() ? this.fx.hit(...this._local(e)) : null; }

  move(e) {
    // the browser hands over one move event per frame; the in-between positions are in
    // getCoalescedEvents(), so use them all and quick rubbing is caught even at a low frame rate
    const list = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    if (this.canSlap()) for (const ev of list) this._swipe(ev); else this.swipe = null;
    if (!this.enabled()) { if (this.last) this._reset(); return; }
    for (const ev of list) this._move(ev);
  }

  /** A fast swipe across the bottom = slap (at least SLAP_PX travelled inside it at SLAP_SPEED or more). */
  _swipe(e) {
    const now = e.timeStamp || performance.now(), [x, y] = this._local(e);
    if (this.fx.hit(x, y, 1, true) !== 'butt') { this.swipe = null; return; }
    const s = this.swipe;
    if (!s || now - s.t > 80) { this.swipe = { x, y, t: now, dist: 0, vx: 0, vy: 0 }; return; }
    const d = Math.hypot(x - s.x, y - s.y), dt = Math.max(1, now - s.t);
    if (d / dt * 1000 >= SLAP_SPEED) { s.dist += d; s.vx += x - s.x; s.vy += y - s.y; } // the fast part of the stroke…
    else { s.dist = 0; s.vx = 0; s.vy = 0; } // too slow: start counting again
    s.x = x; s.y = y; s.t = now;
    if (s.dist >= SLAP_PX) {
      this.swipe = null;
      const dir = this.fx.screenToAvatarDir(s.vx, s.vy); // …is the way the hand went
      this.fx.slap(dir); this.onSlap(dir);
    }
  }

  _move(e) {
    // each position's own time (a frame's worth of positions arrive together)
    const now = e.timeStamp || performance.now(), [x, y] = this._local(e);
    // while a pat is going (or building up), a bigger area counts, to allow for overshooting
    const onHead = this.fx.hit(x, y, this.rubSince ? OVERSHOOT : 1) === 'head';
    if (!onHead) {
      if (!this.offSince) this.offSince = now;
      if (now - this.offSince > FORGIVE_MS) this._reset(); // really gone
      else this.last = { x, y };
      return;
    }
    this.offSince = 0;
    if (this.last) {
      const dx = x - this.last.x, dy = y - this.last.y;
      const v = Math.abs(dx) >= Math.abs(dy) ? dx : dy; // follow the main rubbing axis
      const sign = Math.sign(v);
      if (sign && sign !== this.dir) {
        if (this.travel > FLIP_MIN_PX) {
          const prev = this.flips[this.flips.length - 1];
          if (!this.patting && prev && now - prev > MAX_FLIP_GAP_MS) { this.flips = []; this.rubSince = now; } // too slow: start over
          this.flips.push(now);
          if (!this.rubSince) this.rubSince = now;
        }
        this.dir = sign; this.travel = 0;
      }
      this.travel += Math.abs(v);
    }
    this.last = { x, y };
    this.flips = this.flips.filter((t) => now - t < 1000);
    if (this.flips.length < 2) { if (!this.patting && !this.flips.length) this.rubSince = 0; return; }
    if (!this.patting && now - this.rubSince < START_AFTER_MS) return; // not long enough yet
    // how fast you rub: two direction changes = one back-and-forth
    const span = Math.max(0.15, (this.flips[this.flips.length - 1] - this.flips[0]) / 1000);
    const rubRate = ((this.flips.length - 1) / 2) / span;
    if (!this.patting && rubRate < START_RATE) return; // too slow to count as a headpat
    this.patting = true;
    if (now - this.lastPatSent > 150) {
      this.lastPatSent = now;
      const rate = Math.max(PAT_MIN, Math.min(PAT_MAX, rubRate)); // …which sets how fast it pats
      this.fx.patting(rate);
      this.onPat(+rate.toFixed(2));
    }
  }

  /** Mouse down: boops if it's on the nose. Returns true if it booped. */
  down(e) {
    if (this.over(e) !== 'nose') return false;
    this.fx.boop();
    this.onBoop();
    return true;
  }
}

const chainName = (chain) => chain[0].bone.name || 'chain';

// ---- drawn textures ----
function handTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d');
  g.translate(128, 128);
  g.lineJoin = 'round'; g.lineCap = 'round';
  const skin = '#ffd9b8', line = '#4a2f2a';
  // an open hand seen from above, fingers pointing down (it pats downward)
  const shape = () => {
    g.beginPath();
    g.ellipse(0, -38, 70, 62, 0, 0, Math.PI * 2); // palm
    const fingers = [[-48, 30, 15, 46, 0.18], [-17, 40, 16, 54, 0.05], [15, 40, 16, 52, -0.05], [45, 28, 14, 44, -0.18]];
    for (const [fx, fy, rw, rh, rot] of fingers) { g.moveTo(fx + rw, fy); g.ellipse(fx, fy, rw, rh, rot, 0, Math.PI * 2); }
    g.moveTo(-60, -60); g.ellipse(-78, -18, 18, 42, 0.9, 0, Math.PI * 2); // thumb
  };
  g.fillStyle = line; g.save(); g.scale(1.06, 1.06); shape(); g.fill(); g.restore(); // outline
  g.fillStyle = skin; shape(); g.fill();
  g.strokeStyle = '#e8b896'; g.lineWidth = 4;
  for (const x of [-32, 0, 31]) { g.beginPath(); g.moveTo(x, 4); g.lineTo(x * 1.05, 26); g.stroke(); } // knuckle creases
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

function starTexture() {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  g.translate(32, 33); g.beginPath();
  for (let i = 0; i < 10; i++) { const r = i % 2 ? 11 : 28, a = i * Math.PI / 5 - Math.PI / 2; g.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
  g.closePath(); g.fillStyle = '#fff'; g.fill();
  g.lineWidth = 3.5; g.strokeStyle = 'rgba(70, 35, 10, 0.85)'; g.lineJoin = 'round'; g.stroke(); // outline: readable on any background
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

// Decode an animated gif into frames (null if the file isn't there).
async function loadGif(url) {
  try {
    const res = await fetch(url);
    if (!res.ok || !('ImageDecoder' in window)) return null;
    const dec = new ImageDecoder({ data: await res.arrayBuffer(), type: 'image/gif' });
    await dec.tracks.ready; await dec.completed;
    const n = dec.tracks.selectedTrack?.frameCount || 0, frames = [];
    for (let i = 0; i < n; i++) {
      const { image } = await dec.decode({ frameIndex: i });
      const c = document.createElement('canvas'); c.width = image.displayWidth; c.height = image.displayHeight;
      c.getContext('2d').drawImage(image, 0, 0); image.close(); frames.push(c);
    }
    dec.close();
    return frames;
  } catch { return null; }
}
