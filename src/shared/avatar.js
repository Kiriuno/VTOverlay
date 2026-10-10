// AvatarStage: loads a VRM and drives it from motion frames.
// Used by both the sender (local preview) and the receiver (desktop overlay).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { ARKIT, ARKIT_INDEX, DEFAULT_VIEW, DEFAULT_STYLE, normalizeStyle } from './protocol.js';
import { FINGER_SEGMENTS } from './arms.js';
import { PropLayer } from './props.js';

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
  constructor(canvas, { maxPixelRatio = 2, maxFps = 0 } = {}) {
    this.minFrameMs = maxFps ? 1000 / maxFps - 1 : 0; // cap rendering (see-through windows are costly on Windows)
    this.lastRenderAt = 0;
    this.canvas = canvas;
    this.viewport = null; // optional "virtual box" (see setViewport)
    this.renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, maxPixelRatio));
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

    this.lookTarget = new THREE.Object3D();
    this.props = new PropLayer(this);
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas);
    this.renderer.setAnimationLoop(() => this._tick());
  }

  _resize() {
    const w = this.canvas.clientWidth || 1, h = this.canvas.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this._applyProjection();
    this._frameCamera();
  }

  /**
   * Frame the avatar as if the canvas were only the box {x, y, w, h} (CSS px, relative to the canvas),
   * but keep drawing outside it — so arms, hair or a zoomed-in shot are never cut at the box edge.
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
    const n = { fr: src.fr, zoom: src.zoom, px: src.px, py: src.py, yaw: src.yaw, el: src.el };
    n.fr = n.fr === 'full' ? 'full' : 'bust';
    n.zoom = Math.max(0.3, Math.min(5, +n.zoom || 1));
    n.px = Math.max(-2, Math.min(2, +n.px || 0));
    n.py = Math.max(-2, Math.min(2, +n.py || 0));
    n.yaw = Math.max(-Math.PI, Math.min(Math.PI, +n.yaw || 0));
    n.el = Math.max(-0.6, Math.min(0.6, +n.el || 0));
    this.view = n;
    this._frameCamera();
    return n;
  }

  /** Lighting and per-mouth-shape sensitivity. Returns the cleaned-up style. */
  setStyle(st) {
    const n = normalizeStyle(st);
    this.style = n;
    const L = n.light, rad = THREE.MathUtils.degToRad;
    this.keyLight.color.set(L.color);
    this.keyLight.intensity = Math.PI * L.i;
    // direction: az 0 = from the camera, + = from the right of the screen; el + = from above
    const az = rad(L.az), el = rad(L.el);
    this.keyLight.position.set(Math.sin(az) * Math.cos(el) * 3, 1 + Math.sin(el) * 3, Math.cos(az) * Math.cos(el) * 3);
    this.ambLight.color.set(L.ambColor);
    this.ambLight.intensity = Math.PI * L.amb;
    return n;
  }

  /** Height of the visible area in world units — used to convert mouse drags to pans. */
  visibleHeight() { return this._span / this.view.zoom; }

  _frameCamera() {
    let headY = 1.4, height = 1.6;
    if (this.vrm) {
      const head = this.vrm.humanoid.getNormalizedBoneNode('head');
      if (head) { const v = new THREE.Vector3(); head.getWorldPosition(v); headY = v.y; height = headY + 0.12; }
    }
    const { fr, zoom, px, py, el } = this.view;
    const fov = THREE.MathUtils.degToRad(this.camera.fov);
    const span = fr === 'full' ? height * 1.08 : 0.64;
    this._span = span;
    const centerY = fr === 'full' ? height / 2 : headY - 0.07;
    const visible = span / zoom;
    const target = new THREE.Vector3(-px * visible, centerY - py * visible, 0);
    const dist = (span / 2) / Math.tan(fov / 2) / zoom;
    this.camera.position.set(target.x, target.y + Math.sin(el) * dist, Math.cos(el) * dist);
    this.camera.lookAt(target);
  }

  async loadVRM(arrayBuffer, modelId = null) {
    const gltf = await this.loader.parseAsync(arrayBuffer, '');
    const vrm = gltf.userData.vrm;
    if (!vrm) throw new Error('This file is not a VRM model.');
    VRMUtils.removeUnnecessaryVertices(gltf.scene);
    VRMUtils.combineSkeletons(gltf.scene);
    VRMUtils.rotateVRM0(vrm); // VRM 0.x faces -Z; make everything face the camera (+Z)
    vrm.scene.traverse((o) => { o.frustumCulled = false; });

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

    vrm.update(0);
    this.props.captureRest(vrm);
    this._frameCamera();
    return { perfectSync: this.perfectSync, expressions: this.expressions, name: vrm.meta?.name ?? vrm.meta?.title ?? 'Avatar' };
  }

  clearVRM() {
    if (!this.vrm) return;
    this.props.detachFromModel(); // props live on bones; keep them out of the dispose
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
    this.target.ae = frame.ae !== false;
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
    this.renderer.render(this.scene, this.camera);
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
    // the whole body follows the head (up/down, left/right, toward/away — scaled by the broadcaster's
    // sensitivity sliders), with a slight lean so it doesn't look like a sliding cut-out; plus breathing
    const hips = hb('hips');
    if (hips && this.hipsRest) hips.position.set(this.hipsRest.x + s * cur.p.x, this.hipsRest.y + cur.p.y, this.hipsRest.z + s * cur.p.z);
    const breathe = Math.sin(t * 1.6) * 0.012;
    if (spine) spine.rotation.set(s * (-cur.p.z * 0.3 + breathe), 0, s * (-cur.p.x * 0.35));
    if (chest) chest.rotation.set(s * breathe * 0.6, new THREE.Euler().setFromQuaternion(cur.q).y * 0.15, 0);
    // relaxed idle arms (the arm tracker blends from this pose)
    const sway = Math.sin(t * 0.9) * 0.03;
    const set = (n, x, y, z) => { const b = hb(n); if (b) b.rotation.set(x, y, z); };
    set('leftUpperArm', 0, 0, s * (-1.22 + sway));
    set('rightUpperArm', 0, 0, s * (1.22 - sway));
    set('leftLowerArm', 0, -0.25, 0); // rotation about Y is the same in both frames
    set('rightLowerArm', 0, 0.25, 0);
    set('leftHand', 0, 0, -0.1 * s);
    set('rightHand', 0, 0, 0.1 * s);
    for (const side of ['left', 'right']) for (const [bone] of FINGER_SEGMENTS) hb(side + bone)?.quaternion.identity();
    this._applyArms(dt, live);

    // ----- eyes -----
    const gazeRight = (B('eyeLookInLeft') + B('eyeLookOutRight') - B('eyeLookOutLeft') - B('eyeLookInRight')) / 2;
    const gazeUp = (B('eyeLookUpLeft') + B('eyeLookUpRight') - B('eyeLookDownLeft') - B('eyeLookDownRight')) / 2;
    // model faces +Z, its right side is -X
    this.lookTarget.position.set(s * -gazeRight * 0.55, gazeUp * 0.35, s * 1);

    // ----- face -----
    const em = vrm.expressionManager;
    if (em) {
      const idleBlink = live ? 0 : this._idleBlink(t);
      const smile = (B('mouthSmileLeft') + B('mouthSmileRight')) / 2;
      const vg = this.style.vg;
      if (this.perfectSync) {
        // per-vowel sensitivity, mapped onto the ARKit shapes that mostly form each vowel
        for (let i = 0; i < ARKIT.length; i++) if (this.syncMap[i]) em.setValue(this.syncMap[i], clamp01(cur.b[i] * (SYNC_VOWEL[i] ? vg[SYNC_VOWEL[i]] : 1)));
        if (!live) { em.setValue(this.syncMap[ARKIT_INDEX.eyeBlinkLeft] ?? 'blinkLeft', idleBlink); em.setValue(this.syncMap[ARKIT_INDEX.eyeBlinkRight] ?? 'blinkRight', idleBlink); }
      } else {
        const jaw = B('jawOpen'), pucker = B('mouthPucker'), funnel = B('mouthFunnel');
        const stretch = (B('mouthStretchLeft') + B('mouthStretchRight')) / 2;
        em.setValue('blinkLeft', Math.max(B('eyeBlinkLeft'), idleBlink));
        em.setValue('blinkRight', Math.max(B('eyeBlinkRight'), idleBlink));
        em.setValue('aa', clamp01(jaw * (1 - pucker * 0.8) * (1 - funnel * 0.6) * vg.aa));
        em.setValue('oh', clamp01(funnel * 1.2 * Math.min(1, jaw * 3) * vg.oh));
        em.setValue('ou', clamp01(pucker * 1.1 * vg.ou));
        em.setValue('ee', clamp01((stretch * 1.5 + smile * jaw * 1.2) * vg.ee));
        em.setValue('ih', clamp01(jaw * 0.6 * smile * vg.ih));
      }
      // Auto expressions: read the emotion off the face-shape weights (no extra model needed)
      const browUp = B('browInnerUp');
      const browDown = (B('browDownLeft') + B('browDownRight')) / 2;
      const frown = (B('mouthFrownLeft') + B('mouthFrownRight')) / 2;
      const wide = (B('eyeWideLeft') + B('eyeWideRight')) / 2;
      const auto = live && tgt.ae ? {
        happy: clamp01((smile - 0.3) * 1.6),
        angry: clamp01((browDown - 0.35) * 1.8) * (1 - clamp01(smile * 2)),
        sad: clamp01((frown - 0.2) * 1.5 + (browUp - 0.5) * 0.5) * (1 - clamp01(smile * 2)),
        surprised: clamp01((browUp - 0.45) * 1.3 + (wide - 0.3) + (B('jawOpen') - 0.4) * 0.5),
        relaxed: 0,
      } : {};
      // perfect-sync models already show smiles etc. through their blendshapes, so keep auto subtle there
      const autoGain = this.perfectSync ? 0.35 : 0.75;
      // hotkey expressions fade in/out and override the auto ones
      for (const name of this.expressions) {
        const want = live && tgt.x === name ? 1 : (tgt.x ? 0 : (auto[name] ?? 0) * autoGain);
        cur.xw[name] = (cur.xw[name] ?? 0) + (want - (cur.xw[name] ?? 0)) * (1 - Math.exp(-dt * 10));
        em.setValue(name, cur.xw[name]);
      }
    }

    vrm.update(dt);
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
    const k = 1 - Math.exp(-dt * 14);
    const s = this.axis;
    const root = this.vrm.humanoid.normalizedHumanBonesRoot;
    this.vrm.scene.updateMatrixWorld(true);
    const rootInv = root.getWorldQuaternion(new THREE.Quaternion()).invert();
    const toH = (arr, o = 0) => new THREE.Vector3(s * arr[o], arr[o + 1], s * arr[o + 2]); // avatar → rig space

    for (const side of ['l', 'r']) {
      const rig = this.armRig[side], st = this.cur.arms[side];
      const t = live ? this.target.arms?.[side] : null;
      // smooth weights and directions
      st.w += ((t ? t.w : 0) - st.w) * k;
      st.hw += ((t && t.h ? t.hw * t.w : 0) - st.hw) * k;
      if (t) {
        lerpDir(st.u, toH(t.u), k, st.init); lerpDir(st.f, toH(t.f), k, st.init);
        if (t.h) {
          lerpDir(st.hf, toH(t.h, 0), k, st.hinit); lerpDir(st.hs, toH(t.h, 3), k, st.hinit);
          for (let i = 0; i < 15; i++) lerpDir(st.g[i], toH(t.g, i * 3), k, st.hinit);
          st.hinit = true;
        }
        st.init = true;
      }
      if (!rig || st.w < 0.01 || !st.init) continue;

      const parentRel = (node) => rootInv.clone().multiply(node.parent.getWorldQuaternion(new THREE.Quaternion()));
      const aim = (node, rest, dirH, w) => {
        const local = dirH.clone().applyQuaternion(parentRel(node).invert()).normalize();
        const q = new THREE.Quaternion().setFromUnitVectors(rest, local);
        node.quaternion.slerp(q, w);
        node.updateMatrixWorld(true);
      };
      aim(rig.upper, rig.upperRest, st.u, st.w);
      aim(rig.lower, rig.lowerRest, st.f, st.w);

      if (rig.handF && st.hw > 0.01 && st.hinit) {
        const world = basisQuat(st.hf, st.hs).multiply(basisQuat(rig.handF, rig.handS).invert());
        const q = parentRel(rig.hand).invert().multiply(world);
        rig.hand.quaternion.slerp(q, st.hw);
        rig.hand.updateMatrixWorld(true);
        for (const f of rig.fingers) aim(f.node, f.rest, st.g[f.i], st.hw);
      }
    }
  }

  _idleBlink(t) {
    // blink roughly every 4 s when no live data is arriving
    const phase = t % 4.2;
    return phase < 0.12 ? Math.sin((phase / 0.12) * Math.PI) : 0;
  }
}

function newArmState() {
  return {
    w: 0, hw: 0, init: false, hinit: false,
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
