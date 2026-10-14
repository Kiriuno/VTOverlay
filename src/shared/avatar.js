// AvatarStage: loads a VRM and drives it from motion frames.
// Used by both the sender (local preview) and the receiver (desktop overlay).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { ARKIT, ARKIT_INDEX, DEFAULT_VIEW, DEFAULT_STYLE, normalizeStyle } from './protocol.js';
import { FINGER_SEGMENTS } from './arms.js';
import { PropLayer } from './props.js';
import { AvatarFx } from './fx.js';
import { measureLegs, poseValues, poseArms, POSE_KEYS } from './poses.js';

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const SIDES = { l: 'left', r: 'right' };

// Expressions driven by tracking (never offered as buttons)
const TRACKED = new Set(['aa', 'ih', 'ou', 'ee', 'oh', 'blink', 'blinkLeft', 'blinkRight', 'lookUp', 'lookDown', 'lookLeft', 'lookRight', 'neutral']);
// perfect-sync models: which vowel's sensitivity scales which ARKit shape
const SYNC_VOWEL = ARKIT.map((n) => ({
  jawOpen: 'aa', mouthStretchLeft: 'ee', mouthStretchRight: 'ee',
  mouthUpperUpLeft: 'ih', mouthUpperUpRight: 'ih', mouthLowerDownLeft: 'ih', mouthLowerDownRight: 'ih',
  mouthFunnel: 'oh', mouthPucker: 'ou',
})[n] || null);
const PRESET_ORDER = ['happy', 'angry', 'sad', 'relaxed', 'surprised'];

export class AvatarStage {
  constructor(canvas, { maxPixelRatio = 2, maxFps = 0, maxTexture = 0 } = {}) {
    this.maxTexture = maxTexture; // >0: shrink the model's textures to at most this size (memory)
    this.minFrameMs = maxFps ? 1000 / maxFps - 1 : 0; // cap rendering (see-through windows are costly on Windows)
    this.lastRenderAt = 0;
    this.canvas = canvas;
    this.viewport = null; // optional "virtual box" (see setViewport)
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: false });
    this.maxPixelRatio = Math.min(window.devicePixelRatio, maxPixelRatio);
    this.pixelBudget = 0; // >0: lower the resolution of big canvases so they never cost more than this many pixels
    this.renderer.setPixelRatio(this.maxPixelRatio);
    this.expressions = [];
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.05, 50);
    // How the avatar is shot. Owned by the broadcaster, mirrored on every viewer.
    this.view = { ...DEFAULT_VIEW };

    // lighting + mouth-shape sensitivity: also owned by the broadcaster (see setStyle)
    this.keyLight = new THREE.DirectionalLight(0xffffff, Math.PI * 0.9);
    this.keyLight.target.position.set(0, 1, 0);
    this.ambLight = new THREE.AmbientLight(0xffffff, Math.PI * 0.45);
    this.scene.add(this.keyLight, this.keyLight.target, this.ambLight);
    this.keyLight.layers.enableAll(); this.ambLight.layers.enableAll(); // lights count in every render pass
    this.setStyle(DEFAULT_STYLE);
    this.suspended = false; // true = don't render at all (hidden viewer)

    this.loader = new GLTFLoader();
    this.loader.register((parser) => new VRMLoaderPlugin(parser));

    this.vrm = null;
    this.modelId = null;
    this.timer = new THREE.Timer();
    this.lastFrameAt = 0;

    // target (latest network frame) and current (smoothed) state
    this.target = { q: new THREE.Quaternion(), p: new THREE.Vector3(), b: new Float32Array(ARKIT.length), x: null, face: false, ae: true, arms: null };
    this.cur = { q: new THREE.Quaternion(), p: new THREE.Vector3(), b: new Float32Array(ARKIT.length), xw: {}, arms: { l: newArmState(), r: newArmState() } };

    this.poseW = { stand: 1 }; // body pose cross-fade weights
    this.poseDrop = 0; this._framedDrop = 0; // how far the pose lowers the hips (bust framing follows it)
    this.groupHead = null; // in a room with several avatars: one shared head height for everyone, so all feet are on the same floor
    this.lookTarget = new THREE.Object3D();
    this.springJoints = []; this.jointByBone = new Map();
    this.grabs = new Map(); // key → { j, p (avatar-local target), at, remote }
    this.props = new PropLayer(this);
    this.fx = new AvatarFx(this); // headpats & boops
    this._resize();
    this._ro = new ResizeObserver(() => this._resize());
    this._ro.observe(canvas);
    this.renderer.setAnimationLoop(() => this._tick());
  }

  /** Free everything (the model, the GPU context). The stage can't be used afterwards. */
  dispose() {
    this.renderer.setAnimationLoop(null);
    this._ro?.disconnect();
    try { this.clearVRM(); } catch {}
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  _resize() {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    // Setting a canvas's size wipes it, even to the same size, and the ResizeObserver runs right
    // before the screen is painted, so an unneeded resize flashes a blank frame. Only resize when the
    // size really changed, and then draw straight away.
    if (w === this._w && h === this._h) { this._applyProjection(); return; }
    this._w = w; this._h = h;
    if (this.pixelBudget) this.renderer.setPixelRatio(Math.min(this.maxPixelRatio, Math.sqrt(this.pixelBudget / (w * h))));
    this.renderer.setSize(w, h, false);
    this._applyProjection();
    this._frameCamera();
    this.renderNow();
  }

  /** Draw a frame right now (e.g. after the canvas was resized), outside the normal frame loop. */
  renderNow() {
    if (this.suspended) return;
    this.props.update(this.camera);
    this._render();
  }

  // Drawn in passes (three.js layers): 1 = props set to "behind the avatar", 0 = the avatar and props
  // placed "by distance", 2 = props "in front of the avatar", 3 = headpat / boop effects. So "behind" and
  // "in front" hold whatever the props' 3D positions are.
  _render() {
    const r = this.renderer, cam = this.camera;
    r.autoClear = false;
    r.clear();
    for (const layer of [1, 0, 2, 3]) { cam.layers.set(layer); r.render(this.scene, cam); }
    cam.layers.set(0);
  }

  /** Change the frame-rate cap (0 = none) and resolution cap at runtime. */
  setQuality({ maxFps = 0, maxPixelRatio = 2, maxTexture = this.maxTexture } = {}) {
    this.maxTexture = maxTexture; // used by the next model load
    this.minFrameMs = maxFps ? 1000 / maxFps - 1 : 0;
    this.maxPixelRatio = Math.min(window.devicePixelRatio, maxPixelRatio);
    this.renderer.setPixelRatio(this.maxPixelRatio);
    this._w = this._h = -1; // force the drawing buffer to the new resolution
    this._resize();
  }

  /** Call after changing the canvas's CSS size: resizes the drawing buffer and redraws in the same frame. */
  syncSize() { this._resize(); }

  /**
   * Frame the avatar as if the canvas were only the box {x, y, w, h} (CSS px, relative to the canvas),
   * but keep drawing outside it, so arms, hair or a zoomed-in shot are never cut at the box edge.
   * Pass null to use the whole canvas as the frame again.
   */
  setViewport(vp) {
    this.viewport = vp && vp.w > 0 && vp.h > 0 ? vp : null;
    this._applyProjection();
  }

  _applyProjection() {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1, vp = this.viewport;
    if (vp) {
      this.camera.aspect = vp.w / vp.h;
      this.camera.setViewOffset(vp.w, vp.h, -vp.x, -vp.y, w, h);
    } else {
      this.camera.clearViewOffset();
      this.camera.aspect = w / h;
    }
    this.camera.updateProjectionMatrix();
  }

  /** Update the camera/model view. Any subset of {fr, zoom, px, py, yaw, el}. */
  setView(v) {
    const src = { ...this.view, ...v };
    const n = { fr: src.fr, zoom: src.zoom, px: src.px, py: src.py, yaw: src.yaw, el: src.el, roll: src.roll };
    n.fr = n.fr === 'full' ? 'full' : 'bust';
    n.zoom = Math.max(0.3, Math.min(5, +n.zoom || 1));
    n.px = Math.max(-2, Math.min(2, +n.px || 0));
    n.py = Math.max(-2, Math.min(2, +n.py || 0));
    n.yaw = ((((+n.yaw || 0) + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) - Math.PI; // turns all the way round
    n.el = Math.max(-0.6, Math.min(0.6, +n.el || 0));
    n.roll = Math.max(-180, Math.min(180, +n.roll || 0)); // degrees, + = counter-clockwise on screen
    this.view = n;
    this._frameCamera();
    return n;
  }

  /** Lighting and per-mouth-shape sensitivity. Returns the cleaned-up style. */
  setStyle(st) {
    const n = normalizeStyle(st);
    this.style = n;
    const L = n.light;
    this.keyLight.color.set(L.color);
    this.keyLight.intensity = Math.PI * L.i;
    // the direction the light comes from (x right, y up, z toward the camera); all zero → straight ahead
    const dir = new THREE.Vector3(L.x, L.y, L.z);
    if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1);
    dir.normalize();
    this.keyLight.position.set(dir.x * 3, 1 + dir.y * 3, dir.z * 3);
    this.ambLight.color.set(L.ambColor);
    this.ambLight.intensity = Math.PI * L.amb;
    return n;
  }

  /** Room framing (see groupHead); null = frame your own avatar on its own. */
  setGroupHead(y) {
    const v = Number.isFinite(y) ? y : null;
    if (v === this.groupHead) return;
    this.groupHead = v;
    this._frameCamera();
  }

  /** Height of the visible area in world units, used to convert mouse drags to pans. */
  visibleHeight() { return this._span / this.view.zoom; }

  _frameCamera() {
    let headY = 1.4, height = 1.6;
    if (this.vrm && this.headRestY != null) { headY = this.headRestY; height = headY + 0.12; }
    const { fr, zoom, px, py, el } = this.view;
    // bust framing keeps the face in view when a pose (sitting…) lowers it; full body stays put, so
    // sitting down looks like sitting down. In a room everyone is framed from the same height and
    // nobody follows their pose: a kneeling avatar is lower than a standing one, a short one smaller.
    if (this.groupHead != null) { headY = this.groupHead; height = headY + 0.12; }
    else if (fr !== 'full') headY -= this.poseDrop;
    this._framedDrop = this.poseDrop;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const span = fr === 'full' ? height * 1.08 : 0.64;
    this._span = span;
    const centerY = fr === 'full' ? height / 2 : headY - 0.07;
    const visible = span / zoom;
    const target = new THREE.Vector3(-px * visible, centerY - py * visible, 0);
    const dist = (span / 2) / Math.tan(fov / 2) / zoom;
    this.camera.position.set(target.x, target.y + Math.sin(el) * dist, Math.cos(el) * dist);
    this.camera.lookAt(target);
    // roll: turning the camera clockwise turns the picture (the avatar) counter-clockwise
    if (this.view.roll) this.camera.rotateZ(-this.view.roll * Math.PI / 180);
  }

  async loadVRM(arrayBuffer, modelId = null) {
    const gltf = await this.loader.parseAsync(arrayBuffer, '');
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('This file is not a VRM model.');
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm); // VRM 0.x faces -Z; make everything face the camera (+Z)
    vrm.scene.traverse((o) => { o.frustumCulled = false; });
    if (this.maxTexture) shrinkTextures(vrm.scene, this.maxTexture);

    this.clearVRM();
    this.vrm = vrm;
    this.modelId = modelId;
    this.scene.add(vrm.scene);
    this.baseYaw = vrm.scene.rotation.y;
    // VRM 0.x rigs keep their original "facing -Z" local frame even after rotateVRM0,
    // so the X and Z axes are flipped relative to avatar space: s = -1 converts.
    // Detect it from the rig itself (the left forearm sits on +X in a +Z-facing frame).
    const lowerArm = vrm.humanoid.getNormalizedBoneNode('leftLowerArm');
    this.axis = lowerArm && Math.abs(lowerArm.position.x) > 1e-4
      ? Math.sign(lowerArm.position.x)
      : (vrm.meta?.metaVersion === '0' ? -1 : 1);
    this._prepareArmRig();
    this.hipsRest = vrm.humanoid.getNormalizedBoneNode('hips')?.position.clone() ?? null;
    this.legs = measureLegs((n) => vrm.humanoid.getNormalizedBoneNode(n), this.hipsRest);

    // Detect "perfect sync" models (expressions named after ARKit blendshapes).
    const names = Object.keys(vrm.expressionManager?.expressionMap ?? {});
    const lower = Object.fromEntries(names.map((n) => [n.toLowerCase(), n]));
    this.syncMap = ARKIT.map((n) => lower[n.toLowerCase()] ?? null);
    this.perfectSync = this.syncMap.filter(Boolean).length >= 20;
    // every other expression the model ships with (presets first, then the model's own extras)
    const arkitLower = new Set(ARKIT.map((n) => n.toLowerCase()));
    const extra = names.filter((n) => !TRACKED.has(n) && !arkitLower.has(n.toLowerCase()));
    this.expressions = [...PRESET_ORDER.filter((n) => extra.includes(n)), ...extra.filter((n) => !PRESET_ORDER.includes(n))];
    this.cur.xw = {};

    // Eye target lives in head space, so gaze follows the head.
    const head = vrm.humanoid.getNormalizedBoneNode('head');
    if (head && vrm.lookAt) { head.add(this.lookTarget); vrm.lookAt.target = this.lookTarget; }

    // spring bones (hair, skirt, ribbons…) that can be grabbed with the mouse
    this.springJoints = vrm.springBoneManager ? [...vrm.springBoneManager.joints] : [];
    this.jointByBone = new Map(this.springJoints.map((j) => [j.bone, j]));
    this.grabs.clear();

    vrm.update(0);
    const headNode = vrm.humanoid.getNormalizedBoneNode('head');
    this.headRestY = headNode ? headNode.getWorldPosition(new THREE.Vector3()).y : null;
    this.props.captureRest(vrm);
    this.fx.captureRest(vrm);
    this._frameCamera();
    this.onModel?.();
    return { perfectSync: this.perfectSync, expressions: this.expressions, name: vrm.meta?.name ?? vrm.meta?.title ?? 'Avatar' };
  }

  clearVRM() {
    if (!this.vrm) return;
    this.props.detachFromModel();
    this.fx.captureRest(null);
    this.scene.remove(this.vrm.scene);
    VRMUtils.deepDispose(this.vrm.scene);
    this.vrm = null;
    this.modelId = null;
  }

  /** Feed a motion frame (from the tracker or the network). */
  setMotion(frame) {
    if (frame.q) this.target.q.fromArray(frame.q);
    if (frame.p) this.target.p.fromArray(frame.p);
    if (frame.b) for (let i = 0; i < ARKIT.length; i++) this.target.b[i] = frame.b[i] ?? 0;
    this.target.x = frame.x ?? null;
    this.target.face = frame.f !== false;
    this.target.hold = !!frame.h; // broadcaster out of view: their last pose, held
    this.target.ae = frame.ae !== false;
    this.target.ax = frame.ax; // [auto expression, strength] | null; undefined from older broadcasters
    this.target.arms = frame.a ?? null;
    this.lastFrameAt = performance.now();
  }

  _tick() {
    if (this.suspended) return;
    if (this.minFrameMs) {
      const now = performance.now();
      if (now - this.lastRenderAt < this.minFrameMs) return;
      this.lastRenderAt = now;
    }
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const t = this.timer.getElapsed();
    if (this.vrm) this._animate(dt, t);
    this.props.update(this.camera);
    if (this.vrm) this.fx.update(dt, this.camera);
    this._render();
  }

  _animate(dt, t) {
    const vrm = this.vrm, cur = this.cur, tgt = this.target;
    const live = performance.now() - this.lastFrameAt < 1000 && tgt.face;
    vrm.scene.rotation.y = this.baseYaw + this.view.yaw;

    // ----- smoothing (frame-rate independent exponential) -----
    const kRot = 1 - Math.exp(-dt * 18), kFace = 1 - Math.exp(-dt * 24);
    const restQ = new THREE.Quaternion();
    cur.q.slerp(live ? tgt.q : restQ, live ? kRot : kRot * 0.15);
    cur.p.lerp(live ? tgt.p : new THREE.Vector3(), kRot);
    for (let i = 0; i < ARKIT.length; i++) cur.b[i] += ((live ? tgt.b[i] : 0) - cur.b[i]) * kFace;
    const B = (n) => cur.b[ARKIT_INDEX[n]];

    // ----- body / head bones -----
    const hb = (n) => vrm.humanoid.getNormalizedBoneNode(n);
    const ident = new THREE.Quaternion();
    const s = this.axis;
    const headQ = new THREE.Quaternion(s * cur.q.x, cur.q.y, s * cur.q.z, cur.q.w);
    const neck = hb('neck'), head = hb('head'), spine = hb('spine'), chest = hb('chest') || hb('upperChest');
    if (neck) neck.quaternion.copy(ident).slerp(headQ, 0.35);
    if (head) head.quaternion.copy(ident).slerp(headQ, neck ? 0.55 : 0.9);
    // the whole body follows the head (up/down, left/right, toward/away, scaled by the broadcaster's
    // sensitivity sliders), with a slight lean so it doesn't look like a sliding cut-out; plus breathing
    const P = this._pose(dt, t);
    const hips = hb('hips');
    if (hips && this.hipsRest) {
      hips.position.set(this.hipsRest.x + s * (cur.p.x + P.hx), this.hipsRest.y + cur.p.y + P.hy + P.bob, this.hipsRest.z + s * (cur.p.z + P.hz));
      hips.rotation.set(s * P.hp, 0, -s * P.hr);
    }
    const breathe = Math.sin(t * 1.6) * 0.012;
    if (spine) spine.rotation.set(s * (-cur.p.z * 0.3 + breathe + P.sp), 0, s * (-cur.p.x * 0.35) - s * P.sr);
    for (const [side, sg] of [['l', 1], ['r', -1]]) {
      const name = side === 'l' ? 'left' : 'right';
      // XZY: turn the thigh around itself first, then out to the side, then forward
      hb(name + 'UpperLeg')?.rotation.set(-s * P[side + 'F'], sg * P[side + 'T'], sg * s * P[side + 'O'], 'XZY');
      hb(name + 'LowerLeg')?.rotation.set(s * P[side + 'K'], 0, 0);
      hb(name + 'Foot')?.rotation.set(s * P[side + 'A'], 0, 0);
    }
    if (chest) chest.rotation.set(s * breathe * 0.6, new THREE.Euler().setFromQuaternion(cur.q).y * 0.15 + P.cy, 0);
    // relaxed idle arms (the arm tracker blends from this pose)
    const sway = Math.sin(t * 0.9) * 0.03;
    const set = (n, x, y, z) => { const b = hb(n); if (b) b.rotation.set(x, y, z); };
    set('leftUpperArm', -s * P.laF, 0, s * (-1.22 + sway));
    set('rightUpperArm', -s * P.raF, 0, s * (1.22 - sway));
    set('leftLowerArm', 0, -0.25 - P.laE, 0); // rotation about Y is the same in both frames
    set('rightLowerArm', 0, 0.25 + P.raE, 0);
    set('leftHand', 0, 0, -0.1 * s);
    set('rightHand', 0, 0, 0.1 * s);
    this._idleFingers(t);
    this._applyArms(dt, live);

    // ----- eyes -----
    const gazeRight = (B('eyeLookInLeft') + B('eyeLookOutRight') - B('eyeLookOutLeft') - B('eyeLookInRight')) / 2;
    const gazeUp = (B('eyeLookUpLeft') + B('eyeLookUpRight') - B('eyeLookDownLeft') - B('eyeLookDownRight')) / 2;
    // model faces +Z, its right side is -X
    this.lookTarget.position.set(s * -gazeRight * 0.55, gazeUp * 0.35, s * 1);

    // ----- face -----
    const em = vrm.expressionManager;
    if (em) {
      const idleBlink = live && !tgt.hold ? 0 : this._idleBlink(t);
      const smile = (B('mouthSmileLeft') + B('mouthSmileRight')) / 2;
      const vg = this.style.vg, vm = this.style.vm;
      if (this.perfectSync) {
        // per-vowel sensitivity, mapped onto the ARKit shapes that mostly form each vowel
        for (let i = 0; i < ARKIT.length; i++) if (this.syncMap[i]) em.setValue(this.syncMap[i], SYNC_VOWEL[i] ? Math.min(vm[SYNC_VOWEL[i]], clamp01(cur.b[i] * vg[SYNC_VOWEL[i]])) : cur.b[i]);
        if (!live || tgt.hold) { em.setValue(this.syncMap[ARKIT_INDEX.eyeBlinkLeft] ?? 'blinkLeft', idleBlink); em.setValue(this.syncMap[ARKIT_INDEX.eyeBlinkRight] ?? 'blinkRight', idleBlink); }
      } else {
        const jaw = B('jawOpen'), pucker = B('mouthPucker'), funnel = B('mouthFunnel');
        const stretch = (B('mouthStretchLeft') + B('mouthStretchRight')) / 2;
        em.setValue('blinkLeft', Math.max(B('eyeBlinkLeft'), idleBlink));
        em.setValue('blinkRight', Math.max(B('eyeBlinkRight'), idleBlink));
        const set = (k, v) => em.setValue(k, Math.min(vm[k], clamp01(v * vg[k]))); // sensitivity, then hard limit
        set('aa', jaw * (1 - pucker * 0.8) * (1 - funnel * 0.6));
        set('oh', funnel * 1.2 * Math.min(1, jaw * 3));
        set('ou', pucker * 1.1);
        set('ee', stretch * 1.5 + smile * jaw * 1.2);
        set('ih', jaw * 0.6 * smile);
      }
      // Auto expressions (see autoExpression below). A broadcaster on 0.8.1+ sends its own decision,
      // made before its per-expression mouth / blink tuning, so everyone shows the same one.
      let ax = tgt.ax;
      if (ax === undefined) { const a = autoExpression(cur.b, this.style.ag); this.autoScores = a.scores; ax = a.top; }
      const auto = live && tgt.ae && ax ? { [ax[0]]: ax[1], relaxed: 0 } : {};
      // perfect-sync models already show smiles etc. through their blendshapes, so keep auto subtle there
      const autoGain = this.perfectSync ? 0.35 : 0.75;
      // hotkey expressions fade in/out and override the auto ones
      for (const name of this.expressions) {
        const want = live && tgt.x === name ? 1 : (tgt.x ? 0 : (auto[name] ?? 0) * autoGain);
        cur.xw[name] = (cur.xw[name] ?? 0) + (want - (cur.xw[name] ?? 0)) * (1 - Math.exp(-dt * 10));
        em.setValue(name, cur.xw[name]);
      }
    }

    const restore = this._applyGrabs();
    this.fx.applyBones(dt);
    vrm.update(dt);
    if (restore) for (const [jt, st] of restore) Object.assign(jt.settings, st);
  }

  // ---------------- grabbing spring bones (hair, clothes…) ----------------
  // A grab pulls one spring joint's tail toward a point (in avatar-local space, so it means the same
  // thing on every computer); a few parent joints follow partly, so a lock of hair bends naturally.
  // Physics keeps running for everything else, and the hair swings back when released.
  _jointTailWorld(j, out = new THREE.Vector3()) {
    return out.copy(j._currentTail).applyMatrix4(j._getMatrixCenterToWorld());
  }

  /** Spring joint whose tail is nearest the canvas point (CSS px), within maxPx; -1 if none. */
  pickJoint(x, y, maxPx = 26) {
    if (!this.vrm || !this.springJoints.length) return -1;
    this.camera.updateMatrixWorld(); // the view may have changed since the last frame was drawn
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight, v = new THREE.Vector3();
    // Hair behind the head projects onto the face too: prefer joints in front of the head's centre
    // (as seen from the camera); ones behind only win when nothing in front is near the cursor.
    const head = this.vrm.humanoid.getNormalizedBoneNode('head');
    const viewDepth = (p) => -p.clone().applyMatrix4(this.camera.matrixWorldInverse).z;
    const headDepth = head ? viewDepth(head.getWorldPosition(new THREE.Vector3())) : Infinity;
    const r2 = maxPx * maxPx;
    let best = -1, bestScore = Infinity;
    this.springJoints.forEach((j, i) => {
      this._jointTailWorld(j, v);
      const behind = viewDepth(v) > headDepth + 0.02;
      v.project(this.camera);
      if (v.z > 1 || v.z < -1) return;
      const dx = (v.x + 1) / 2 * w - x, dy = (1 - v.y) / 2 * h - y, d = dx * dx + dy * dy;
      if (d > r2) return;
      const score = d + (behind ? r2 : 0);
      if (score < bestScore) { bestScore = score; best = i; }
    });
    return best;
  }

  /** Avatar-local point under canvas point (x, y) on the camera-facing plane through `world`. */
  canvasToAvatar(x, y, world) {
    const ndc = new THREE.Vector2(x / this.canvas.clientWidth * 2 - 1, -(y / this.canvas.clientHeight) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()), world);
    const hit = ray.ray.intersectPlane(plane, new THREE.Vector3());
    return hit ? this.vrm.scene.worldToLocal(hit) : null;
  }

  jointWorld(i) { const j = this.springJoints[i]; return j ? this._jointTailWorld(j) : null; }

  /** Start / move (p = [x,y,z] avatar-local) or release (p = null) a grab. */
  setGrab(key, j, p, remote = false) {
    if (p == null || !(j >= 0) || !this.springJoints[j]) { this.grabs.delete(key); return; }
    this.grabs.set(key, { j, p: new THREE.Vector3().fromArray(p), at: performance.now(), remote });
  }

  clearGrabs(filter = () => true) { for (const k of [...this.grabs.keys()]) if (filter(k)) this.grabs.delete(k); }

  _applyGrabs() {
    if (!this.grabs.size) return;
    const now = performance.now(), weights = [1, 0.6, 0.35, 0.15];
    const target = new THREE.Vector3(), head = new THREE.Vector3(), desired = new THREE.Vector3();
    const restore = new Map(); // joint → its own physics settings, put back right after this update
    this.vrm.scene.updateMatrixWorld(true);
    for (const [key, g] of this.grabs) {
      if (g.remote && now - g.at > 3000) { this.grabs.delete(key); continue; } // lost release message
      target.copy(g.p);
      this.vrm.scene.localToWorld(target);
      let jt = this.springJoints[g.j];
      for (let k = 0; k < weights.length && jt; k++) {
        head.setFromMatrixPosition(jt.bone.matrixWorld);
        const len = jt._worldSpaceBoneLength || this._jointTailWorld(jt, desired).distanceTo(head);
        desired.copy(target).sub(head).normalize().multiplyScalar(len).add(head).applyMatrix4(jt._getMatrixWorldToCenter());
        jt._currentTail.lerp(desired, weights[k]);
        jt._prevTail.lerp(desired, weights[k]);
        // stiffness (pull back to rest) and gravity would fight the hand: ease them off while held
        if (!restore.has(jt)) restore.set(jt, { stiffness: jt.settings.stiffness, gravityPower: jt.settings.gravityPower });
        const keep = 1 - weights[k];
        jt.settings.stiffness = restore.get(jt).stiffness * keep;
        jt.settings.gravityPower = restore.get(jt).gravityPower * keep;
        jt = this.jointByBone.get(jt.bone.parent);
      }
    }
    return restore.size ? restore : null;
  }

  // ---------------- arms & hands ----------------
  _prepareArmRig() {
    const hb = (n) => this.vrm.humanoid.getNormalizedBoneNode(n);
    const dirOf = (node, child) => (child ? child.position : node.position).clone().normalize();
    this.armRig = {};
    for (const [k, side] of Object.entries(SIDES)) {
      const upper = hb(side + 'UpperArm'), lower = hb(side + 'LowerArm'), hand = hb(side + 'Hand');
      if (!upper || !lower || !hand) continue;
      const rig = { upper, lower, hand, upperRest: dirOf(upper, lower), lowerRest: dirOf(lower, hand), fingers: [] };
      const midP = hb(side + 'MiddleProximal'), idxP = hb(side + 'IndexProximal'), litP = hb(side + 'LittleProximal');
      if (midP && idxP && litP) {
        rig.handF = midP.position.clone().normalize();
        rig.handS = idxP.position.clone().sub(litP.position).normalize();
      }
      FINGER_SEGMENTS.forEach(([bone], i) => {
        const node = hb(side + bone);
        if (!node) return;
        const next = FINGER_SEGMENTS[i + 1];
        const child = next && next[0].slice(0, 4) === bone.slice(0, 4) ? hb(side + next[0]) : null;
        rig.fingers.push({ i, node, rest: dirOf(node, child) });
      });
      this.armRig[k] = rig;
    }
  }

  _applyArms(dt, live) {
    if (!this.armRig) return;
    const k = 1 - Math.exp(-dt * 14), kGate = 1 - Math.exp(-dt * 6);
    const s = this.axis;
    const root = this.vrm.humanoid.normalizedHumanBonesRoot;
    this.vrm.scene.updateMatrixWorld(true);
    const rootInv = root.getWorldQuaternion(new THREE.Quaternion()).invert();
    const toH = (arr, o = 0) => new THREE.Vector3(s * arr[o], arr[o + 1], s * arr[o + 2]); // avatar → rig space
    const parentRel = (node) => rootInv.clone().multiply(node.parent.getWorldQuaternion(new THREE.Quaternion()));
    const aim = (node, rest, dirH, w) => {
      const local = dirH.clone().applyQuaternion(parentRel(node).invert()).normalize();
      const q = new THREE.Quaternion().setFromUnitVectors(rest, local);
      node.quaternion.slerp(q, w);
      node.updateMatrixWorld(true);
    };
    const aimHand = (rig, hf, hs, w) => {
      const world = basisQuat(hf, hs).multiply(basisQuat(rig.handF, rig.handS).invert());
      rig.hand.quaternion.slerp(parentRel(rig.hand).invert().multiply(world), w);
      rig.hand.updateMatrixWorld(true);
    };
    const placed = this._poseArmPlacement(rootInv);

    for (const side of ['l', 'r']) {
      const rig = this.armRig[side], st = this.cur.arms[side];
      const t = live ? this.target.arms?.[side] : null;
      // smooth weights and directions
      st.w += ((t ? t.w : 0) - st.w) * k;
      st.hw += ((t && t.h ? t.hw * t.w : 0) - st.hw) * k;
      // arms are only tracked while the camera sees the hand; otherwise they keep the pose's placement
      st.hg += ((t && t.h ? 1 : 0) - st.hg) * kGate;
      if (t) {
        lerpDir(st.u, toH(t.u), k, st.init); lerpDir(st.f, toH(t.f), k, st.init);
        if (t.h) {
          lerpDir(st.hf, toH(t.h, 0), k, st.hinit); lerpDir(st.hs, toH(t.h, 3), k, st.hinit);
          for (let i = 0; i < 15; i++) lerpDir(st.g[i], toH(t.g, i * 3), k, st.hinit);
          st.hinit = true;
        }
        st.init = true;
      }
      if (!rig) continue;
      const pl = placed[side];
      if (pl) {
        aim(rig.upper, rig.upperRest, pl.u, pl.w);
        aim(rig.lower, rig.lowerRest, pl.f, pl.w);
        if (rig.handF) aimHand(rig, pl.hf, pl.hs, pl.w);
      }
      const aw = st.w * st.hg;
      if (aw < 0.01 || !st.init) continue;
      aim(rig.upper, rig.upperRest, st.u, aw);
      aim(rig.lower, rig.lowerRest, st.f, aw);
      if (rig.handF && st.hw > 0.01 && st.hinit) {
        aimHand(rig, st.hf, st.hs, st.hw);
        for (const f of rig.fingers) aim(f.node, f.rest, st.g[f.i], st.hw);
      }
    }
  }

  /**
   * Where the current pose puts each hand (on the hip, on the thighs…), as arm / hand directions in rig
   * space plus a weight (how much of the current pose blend places that arm). Two-bone IK: the hand's
   * wrist goes to a point measured on the model's own legs, the elbow bends outward and back.
   */
  _poseArmPlacement(rootInv) {
    const out = { l: null, r: null };
    const W = this.poseW, hb = (n) => this.vrm.humanoid.getNormalizedBoneNode(n);
    let sum = 0;
    for (const n in W) sum += W[n];
    if (!sum || !this.legs) return out;
    const wp = (n) => new THREE.Vector3().setFromMatrixPosition(n.matrixWorld);
    const lHip = hb('leftUpperLeg'), rHip = hb('rightUpperLeg');
    if (!lHip || !rHip) return out;
    const up = new THREE.Vector3(0, 1, 0);
    const leftward = wp(lHip).sub(wp(rHip)).normalize();
    const fwd = new THREE.Vector3().crossVectors(leftward, up).normalize();
    const size = this.legs.k * this.vrm.scene.scale.y;
    for (const side of ['l', 'r']) {
      const rig = this.armRig[side];
      if (!rig) continue;
      const L = side === 'l' ? 'left' : 'right';
      const hip = hb(L + 'UpperLeg'), knee = hb(L + 'LowerLeg');
      if (!hip || !knee) continue;
      const S = wp(rig.upper), E0 = wp(rig.lower), H0 = wp(rig.hand);
      const a = S.distanceTo(E0), b = E0.distanceTo(H0);
      const HJ = wp(hip), K = wp(knee);
      const outward = side === 'l' ? leftward.clone() : leftward.clone().negate();
      const thighDir = K.clone().sub(HJ).normalize();
      const acc = { u: new THREE.Vector3(), f: new THREE.Vector3(), hf: new THREE.Vector3(), hs: new THREE.Vector3() };
      let w = 0;
      for (const n in W) {
        const kind = poseArms(n)[side];
        if (!kind) continue;
        let T, hf, hs, hint;
        if (kind === 'hip') {
          T = HJ.clone().addScaledVector(outward, 0.07 * size).addScaledVector(up, 0.1 * size).addScaledVector(fwd, -0.01 * size);
          hf = fwd.clone().addScaledVector(up, -0.8).normalize();
          hs = up.clone().addScaledVector(fwd, 0.3).normalize();
          hint = outward.clone().addScaledVector(fwd, -0.6);
        } else { // on the thigh ('thigh') or near the knee ('knee'), palm down, fingers toward the knee
          // the top of the thigh: up when it's level (sitting), the front when it's upright (kneeling)
          const top = up.clone().addScaledVector(fwd, 0.5);
          top.addScaledVector(thighDir, -top.dot(thighDir)).normalize();
          T = HJ.clone().lerp(K, kind === 'knee' ? 0.78 : 0.42).addScaledVector(top, 0.075 * size);
          hf = thighDir.clone().addScaledVector(top, -0.15).normalize();
          hs = outward.clone().negate();
          hint = outward.clone().addScaledVector(fwd, -0.5).addScaledVector(up, -0.3);
        }
        const toT = T.clone().sub(S);
        const d = Math.min(toT.length(), (a + b) * 0.999), dir = toT.normalize();
        const cosA = Math.max(-1, Math.min(1, (a * a + d * d - b * b) / (2 * a * d)));
        const perp = hint.clone().addScaledVector(dir, -hint.dot(dir)).normalize();
        const E = S.clone().addScaledVector(dir, a * cosA).addScaledVector(perp, a * Math.sqrt(1 - cosA * cosA));
        const H = S.clone().addScaledVector(dir, d);
        const ww = W[n] / sum;
        acc.u.addScaledVector(E.clone().sub(S).normalize(), ww);
        acc.f.addScaledVector(H.sub(E).normalize(), ww);
        acc.hf.addScaledVector(hf, ww); acc.hs.addScaledVector(hs, ww);
        w += ww;
      }
      if (w < 0.01) continue;
      for (const key in acc) acc[key].applyQuaternion(rootInv).normalize();
      out[side] = { ...acc, w };
    }
    return out;
  }

  /** The current body pose (cross-fading to the one picked in the style), as blended pose values. */
  _pose(dt, t) {
    const want = this.style.pose || 'stand', W = this.poseW;
    const k = 1 - Math.exp(-dt * 2.5); // about 1.5 s, gentle enough that hair doesn't fly up
    if (!(want in W)) W[want] = 0;
    for (const n of Object.keys(W)) {
      W[n] += ((n === want ? 1 : 0) - W[n]) * k;
      if (n !== want && W[n] < 0.002) delete W[n];
    }
    const out = Object.fromEntries(POSE_KEYS.map((key) => [key, 0]));
    if (!this.legs) return out;
    let sum = 0;
    for (const n in W) sum += W[n];
    for (const n in W) {
      const v = poseValues(n, t, this.legs), w = W[n] / (sum || 1);
      for (const key in v) out[key] += v[key] * w;
    }
    this.poseDrop = Math.max(0, -out.hy);
    if (this.groupHead == null && Math.abs(this.poseDrop - this._framedDrop) > 0.002) this._frameCamera();
    return out;
  }

  /**
   * Relaxed, slightly curled fingers (instead of the model's straight T-pose fingers) that move a
   * little. Flatter while a pose rests the hand somewhere. Hand tracking blends over this.
   */
  _idleFingers(t) {
    const hb = (n) => this.vrm.humanoid.getNormalizedBoneNode(n), s = this.axis;
    let rest = 0, sum = 0; // how much the hands rest on something (flatter fingers)
    for (const n in this.poseW) { sum += this.poseW[n]; const a = poseArms(n); rest += this.poseW[n] * ((a.l ? 0.5 : 0) + (a.r ? 0.5 : 0)); }
    rest = sum ? rest / sum : 0;
    const flat = 1 - 0.55 * rest;
    FINGER_SEGMENTS.forEach(([bone], i) => {
      const finger = Math.floor(i / 3), seg = i % 3; // 0 thumb, 1 index … 4 little; 0 proximal … 2 distal
      for (const [side, sg] of [['left', -1], ['right', 1]]) {
        const node = hb(side + bone);
        if (!node) continue;
        const wob = Math.sin(t * 0.7 + finger * 0.9 + (sg > 0 ? 1.7 : 0)) * 0.05;
        if (finger === 0) {
          // thumb: tucked a little toward the palm
          node.rotation.set(0, sg * -0.25 * (seg === 0 ? 1 : 0.5), sg * s * (0.1 + 0.15 * seg + wob * 0.5) * flat);
        } else {
          const curl = ([0.3, 0.42, 0.3][seg] + 0.06 * finger + wob) * flat;
          node.rotation.set(0, 0, sg * s * curl);
        }
      }
    });
  }

  _idleBlink(t) {
    // blink roughly every 4 s when no live data is arriving
    const phase = t % 4.2;
    return phase < 0.12 ? Math.sin((phase / 0.12) * Math.PI) : 0;
  }
}

/**
 * Auto expressions: read the emotion off the face-shape weights (no extra model needed). Each one
 * combines several cues (one cue alone, like raised brows, is too common in normal talking), scaled by
 * the broadcaster's sensitivity (ag); only the strongest shows, so they don't blur together.
 * @param b     ARKit blendshape weights
 * @param base  optional resting level of each weight (ExprBaseline): only movement above it counts, so
 *              a face that rests a bit smiley (or frowny) isn't read as happy (or angry) all the time
 * @param cal   optional calibration { emotion: raw value of your own face doing it }: then that face = full
 * @returns { scores: {happy, sad, angry, surprised}, top: [name, score] | null, raw }
 */
export function autoExpression(b, ag = {}, base = null, cal = null) {
  const B = base ? (n) => Math.max(0, (b[ARKIT_INDEX[n]] || 0) - base[ARKIT_INDEX[n]]) : (n) => b[ARKIT_INDEX[n]] || 0;
  const avg = (a, c) => (B(a) + B(c)) / 2, pos = (v) => Math.max(0, v);
  const smile = avg('mouthSmileLeft', 'mouthSmileRight');
  const browInner = B('browInnerUp'), browOuter = avg('browOuterUpLeft', 'browOuterUpRight');
  const browDown = avg('browDownLeft', 'browDownRight'), frown = avg('mouthFrownLeft', 'mouthFrownRight');
  const wide = avg('eyeWideLeft', 'eyeWideRight'), squint = avg('eyeSquintLeft', 'eyeSquintRight');
  const sneer = avg('noseSneerLeft', 'noseSneerRight'), press = avg('mouthPressLeft', 'mouthPressRight');
  const cheek = avg('cheekSquintLeft', 'cheekSquintRight');
  const notSmiling = 1 - clamp01(smile * 1.5);
  // Webcam face tracking reads smiles strongly but frowns, lowered brows and sneers only faintly, so
  // happy needs a clear smile while sad / angry react to smaller movements.
  const raw = {
    happy: pos(smile - 0.32) * 1.9 + pos(cheek - 0.1) * 0.25,
    sad: (pos(frown - 0.02) * 4 + pos(browInner - browOuter * 0.6 - 0.04) * 2.4 + pos(B('mouthShrugLower') - 0.1) * 0.9 + pos(press - 0.1) * 0.4) * notSmiling,
    angry: (pos(browDown - 0.05) * 3.2 + sneer * 2.2 + pos(squint - 0.15) * 0.9 + press * 0.6) * notSmiling,
    surprised: pos((browInner + browOuter) / 2 - 0.18) * 1.4 + pos(wide - 0.08) * 1.6 + pos(B('jawOpen') - 0.25) * 0.6,
  };
  const scores = {};
  let top = null;
  for (const k in raw) {
    // calibrated: your own "full" face = 1, and it starts showing from about a quarter of it
    const v = cal?.[k] > 0 ? Math.max(0, raw[k] / cal[k] - 0.15) / 0.85 : raw[k];
    scores[k] = clamp01(v * (ag[k] ?? 1));
    if (!top || scores[k] > scores[top]) top = k;
  }
  return { scores, top: top && scores[top] > 0.12 ? [top, scores[top]] : null, raw };
}

/**
 * The resting level of each expression cue, learned on the fly (no calibration step): it follows the
 * face down quickly and up only very slowly, so it settles on how your face looks when relaxed, while
 * a smile or a frown held for a while still counts.
 */
export class ExprBaseline {
  constructor() { this.v = new Float32Array(ARKIT.length).fill(-1); }
  update(b, dt) {
    const up = 1 - Math.exp(-dt / 120), down = 1 - Math.exp(-dt / 2.5);
    for (const i of BASE_CUES) {
      const x = b[i] || 0;
      if (this.v[i] < 0) { this.v[i] = Math.min(x, 0.3); continue; }
      this.v[i] += (x - this.v[i]) * (x > this.v[i] ? up : down);
    }
    return this.view();
  }
  /** Baseline per weight (0 where none is learned; jaw / eyes-closed etc. are never shifted). */
  view() { const out = new Float32Array(ARKIT.length); for (const i of BASE_CUES) out[i] = Math.max(0, this.v[i]) * 0.9; return out; }
}
const BASE_CUES = ['mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight',
  'browDownLeft', 'browDownRight', 'eyeWideLeft', 'eyeWideRight', 'eyeSquintLeft', 'eyeSquintRight', 'noseSneerLeft', 'noseSneerRight',
  'mouthPressLeft', 'mouthPressRight', 'cheekSquintLeft', 'cheekSquintRight', 'mouthShrugLower'].map((n) => ARKIT_INDEX[n]);

/**
 * Downscale every texture of a model that's bigger than `max` px (keeping its aspect). A 4096² texture
 * takes 64 MB of graphics memory (plus mipmaps); on a small desktop overlay 1024-2048 looks the same.
 */
function shrinkTextures(root, max) {
  const done = new Set();
  root.traverse((o) => {
    for (const m of [].concat(o.material || [])) {
      // plain materials keep textures as properties, MToon (VRM) ones in shader uniforms
      const found = [...Object.values(m), ...Object.values(m.uniforms || {}).map((u) => u?.value)];
      for (const tex of found) {
        if (!tex?.isTexture || done.has(tex)) continue;
        done.add(tex);
        const img = tex.image, w = img?.width, h = img?.height;
        if (!w || !h || Math.max(w, h) <= max) continue;
        const k = max / Math.max(w, h);
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        img.close?.(); // free the full-size bitmap
        tex.image = c;
        tex.needsUpdate = true;
      }
    }
  });
}

function newArmState() {
  return {
    w: 0, hw: 0, hg: 0, init: false, hinit: false,
    u: new THREE.Vector3(), f: new THREE.Vector3(), hf: new THREE.Vector3(), hs: new THREE.Vector3(),
    g: Array.from({ length: 15 }, () => new THREE.Vector3()),
  };
}

function lerpDir(cur, target, k, initialised) {
  if (!initialised) cur.copy(target); else cur.lerp(target, k);
  cur.normalize();
}

// rotation whose X axis = f, and whose Z axis is s made perpendicular to f
function basisQuat(f, s) {
  const x = f.clone().normalize();
  const y = new THREE.Vector3().crossVectors(s, x).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}
