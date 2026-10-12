// Props: 2D images placed in the scene or attached to a body part (moving with it).
//
// A prop definition (what is stored and sent to viewers):
//   { id, img (image hash), attach ('scene' | 'screen' | VRM bone name), pos:[x,y,z], rot (radians, around Z = roll),
//     rx, ry (radians, around X / Y), size (height in metres), face (always face the camera), flip, visible,
//     w (follow strength 0..1, attached props), fp / fr (follow the bone's position / rotation),
//     draw ('front' = always in front of the avatar, 'back' = always behind it, 'depth' = by its real
//     distance, so it can sit e.g. between an arm and the body) }
// Among props drawn the same way, the list order decides: earlier in the list = in front.
//
// 'screen' props aren't part of the 3D picture at all: full-screen viewers show them as a plain image
// layer over their whole monitor (pos = [x, y] centre as fractions of the monitor, size = fraction of
// its height; draw 'back' = behind the avatar, otherwise in front). They always face the viewer.
// Everything else ignores them.
//
// Attached props live in "avatar space" (metres, avatar facing the viewer, +Y up, as the model stands
// at rest). Each frame the bone's movement since rest is applied to them, fully (w = 1), not at all
// (w = 0, the prop stays where that body part is at rest) or partly, and only the parts that are
// switched on (position and/or rotation). They are NOT children of the bone, so squashing or
// scaling the model (e.g. a headpat) never squashes the props.
import * as THREE from 'three';

export const PROP_ATTACH = [
  ['scene', 'Scene (stays put)'], ['screen', "Viewer's screen (full screen)"], ['head', 'Head'], ['neck', 'Neck'], ['upperChest', 'Upper chest'],
  ['chest', 'Chest'], ['spine', 'Spine'], ['hips', 'Hips'],
  ['leftHand', 'Left hand'], ['rightHand', 'Right hand'], ['leftLowerArm', 'Left forearm'], ['rightLowerArm', 'Right forearm'],
  ['leftUpperArm', 'Left upper arm'], ['rightUpperArm', 'Right upper arm'], ['leftFoot', 'Left foot'], ['rightFoot', 'Right foot'],
];
export const DRAW_MODES = [['front', 'In front of the avatar'], ['back', 'Behind the avatar'], ['depth', 'By distance (can go between arm and body)']];
const DRAW_LAYER = { back: 1, depth: 0, front: 2 }; // render pass, see AvatarStage._render

const MAX_TEX = 2048;
const PLANE = new THREE.PlaneGeometry(1, 1);
const IDENT = new THREE.Quaternion();
const tq = new THREE.Quaternion(), tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), te = new THREE.Euler();

/** Fill in defaults for older / partial definitions. */
export function normalizeProp(d) {
  const n = (v, def) => (Number.isFinite(+v) && v !== null && v !== '' ? +v : def);
  return {
    ...d,
    pos: Array.isArray(d.pos) && d.pos.length === 3 ? d.pos.map((v) => n(v, 0)) : [0, 0, 0],
    rot: n(d.rot, 0), rx: n(d.rx, 0), ry: n(d.ry, 0),
    size: Math.max(0.01, n(d.size, 0.3)),
    w: Math.max(0, Math.min(1, n(d.w, 1))),
    fp: d.fp !== false, fr: d.fr !== false,
    // older versions had a layer number (and always drew by distance)
    draw: ['front', 'back', 'depth'].includes(d.draw) ? d.draw : (Number(d.layer) < 0 ? 'back' : 'depth'),
  };
}

export class PropLayer {
  /** @param stage AvatarStage */
  constructor(stage) {
    this.stage = stage;
    this.items = new Map();
    this.loader = null;
    this.selectedId = null;
    this.boneRest = {};
    // avatar space: follows the model's placement (e.g. the broadcaster's yaw turn), not its pose
    this.avatarSpace = new THREE.Group();
    this.avatarSpace.matrixAutoUpdate = false;
    stage.scene.add(this.avatarSpace);
    this.loadMatrixInv = new THREE.Matrix4();
  }

  setLoader(fn) { this.loader = fn; for (const it of this.items.values()) if (!it.loaded && !it.loading) this._load(it); }

  /** Remember each bone's rest transform (called by the stage right after a model loads). */
  captureRest(vrm) {
    this.boneRest = {};
    this.vrm = vrm || null;
    if (vrm) {
      vrm.scene.updateMatrixWorld(true);
      this.loadMatrixInv.copy(vrm.scene.matrixWorld).invert();
      for (const [name] of PROP_ATTACH) {
        if (name === 'scene') continue;
        const node = vrm.humanoid.getRawBoneNode(name);
        if (!node) continue;
        // at load time world space == avatar space (the scene hasn't been turned yet)
        this.boneRest[name] = { node, p0: node.getWorldPosition(new THREE.Vector3()), q0: node.getWorldQuaternion(new THREE.Quaternion()) };
      }
    }
    this._syncAvatarSpace();
    for (const it of this.items.values()) this._apply(it);
  }

  /** Called before the model is disposed. */
  detachFromModel() {
    this.boneRest = {};
    this.vrm = null;
    for (const it of this.items.values()) if (it.def.attach !== 'scene') { it.mesh.visible = false; if (it.outline) it.outline.visible = false; }
  }

  _syncAvatarSpace() {
    const a = this.avatarSpace;
    if (this.vrm) { this.vrm.scene.updateMatrixWorld(true); a.matrix.multiplyMatrices(this.vrm.scene.matrixWorld, this.loadMatrixInv); }
    else a.matrix.identity();
    a.matrixWorldNeedsUpdate = true;
    a.updateMatrixWorld(true);
  }

  /** Replace the full list of props (adds, updates and removes as needed). */
  sync(defs) {
    const seen = new Set();
    defs.forEach((raw, order) => {
      const d = normalizeProp(raw);
      seen.add(d.id);
      let it = this.items.get(d.id);
      if (it && it.def.img !== d.img) { this._remove(it); it = null; }
      if (!it) it = this._create(d);
      it.def = d;
      it.order = order;
      this._apply(it);
    });
    for (const [id, it] of this.items) if (!seen.has(id)) this._remove(it);
  }

  _create(d) {
    const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, toneMapped: false });
    const mesh = new THREE.Mesh(PLANE, mat);
    mesh.frustumCulled = false;
    mesh.visible = false;
    const it = { def: d, mesh, aspect: 1, loaded: false, loading: false, dead: false, order: 0 };
    mesh.userData.propId = d.id;
    this.items.set(d.id, it);
    this._load(it);
    return it;
  }

  _remove(it) {
    it.dead = true;
    clearTimeout(it.timer);
    try { it.decoder?.close(); } catch {}
    it.mesh.parent?.remove(it.mesh);
    it.mesh.material.map?.dispose();
    it.mesh.material.dispose();
    this.items.delete(it.def.id);
  }

  async _load(it) {
    if (!this.loader) return;
    it.loading = true;
    let blob = null;
    try { blob = await this.loader(it.def.img); } catch {}
    it.loading = false;
    if (!blob || it.dead) return;
    const type = blob.type || '';
    try {
      if (/gif|webp|png/.test(type) && 'ImageDecoder' in window && await this._loadAnimated(it, blob, type)) return;
      const bmp = await createImageBitmap(blob);
      if (it.dead) return bmp.close();
      const { canvas, ctx } = makeCanvas(bmp.width, bmp.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
      this._setTexture(it, canvas);
    } catch (err) { console.warn('prop image failed', err); }
  }

  // Animated GIF / WebP / APNG: decode one frame at a time and loop with each frame's own duration.
  async _loadAnimated(it, blob, type) {
    const decoder = new ImageDecoder({ data: await blob.arrayBuffer(), type });
    await decoder.tracks.ready; // 'completed' alone can resolve before the track list exists
    await decoder.completed;
    const track = decoder.tracks.selectedTrack;
    if (!track || track.frameCount <= 1) { decoder.close(); return false; }
    it.decoder = decoder;
    const first = (await decoder.decode({ frameIndex: 0 })).image;
    const { canvas, ctx } = makeCanvas(first.displayWidth, first.displayHeight);
    first.close();
    this._setTexture(it, canvas);
    let i = 0;
    const step = async () => {
      if (it.dead) return;
      try {
        const { image } = await decoder.decode({ frameIndex: i });
        if (it.dead) { image.close(); return; }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
        const ms = image.duration ? image.duration / 1000 : 100;
        image.close();
        it.mesh.material.map.needsUpdate = true;
        i = (i + 1) % track.frameCount;
        it.timer = setTimeout(step, Math.max(16, ms));
      } catch { /* decoder closed */ }
    };
    step();
    return true;
  }

  _setTexture(it, canvas) {
    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    it.mesh.material.map = tex;
    it.mesh.material.needsUpdate = true;
    it.aspect = canvas.width / canvas.height;
    it.loaded = true;
    this._apply(it);
  }

  /**
   * The frame an attached prop hangs from, in avatar space: position P and rotation R, so the prop
   * sits at P + R·pos, turned by R. Blends the bone's rest and current transform by the follow
   * strength. The position / rotation locks are applied in _place, on top of this same frame.
   */
  _frame(d, out = { P: new THREE.Vector3(), R: new THREE.Quaternion() }) {
    const rest = this.boneRest[d.attach];
    if (!rest) return null;
    const node = rest.node;
    const P1 = node.getWorldPosition(tv);
    this.avatarSpace.worldToLocal(P1);
    const spaceQ = this.avatarSpace.getWorldQuaternion(tq).invert();
    const Q1 = node.getWorldQuaternion(new THREE.Quaternion()).premultiply(spaceQ);
    const dq = Q1.multiply(rest.q0.clone().invert()); // bone's rotation since rest
    out.P.copy(rest.p0).lerp(P1, d.w);
    out.R.copy(IDENT).slerp(dq, d.w);
    return out;
  }

  _apply(it) {
    const d = it.def, mesh = it.mesh;
    const scene = d.attach === 'scene';
    const parent = scene ? this.stage.scene : this.boneRest[d.attach] ? this.avatarSpace : null;
    if (!parent) { mesh.parent?.remove(mesh); mesh.visible = false; if (it.outline) it.outline.visible = false; return; }
    if (mesh.parent !== parent) parent.add(mesh);
    this._place(it);
    const h = d.size;
    mesh.scale.set(h * it.aspect * (d.flip ? -1 : 1), h, 1);
    mesh.visible = !!d.visible && it.loaded;
    const layer = DRAW_LAYER[d.draw];
    mesh.layers.set(layer);
    if (it.outline) { it.outline.visible = mesh.visible; it.outline.layers.set(layer); }
    if (mesh.material.depthTest !== (d.draw === 'depth')) { mesh.material.depthTest = d.draw === 'depth'; mesh.material.needsUpdate = true; }
  }

  _ownRot(d) { return new THREE.Quaternion().setFromEuler(te.set(d.rx, d.ry, d.rot, 'YXZ')); }

  _place(it) {
    const d = it.def, mesh = it.mesh;
    const pos = tv2.fromArray(d.pos);
    if (d.attach === 'scene') {
      mesh.position.copy(pos);
      mesh.quaternion.copy(this._ownRot(d));
      return;
    }
    const f = this._frame(d, it.frame || (it.frame = { P: new THREE.Vector3(), R: new THREE.Quaternion() }));
    if (!f) return;
    // Position follow off: it stays where it would be with the avatar at rest. Rotation follow off: it
    // keeps its own angle. Each lock leaves the other half exactly as it is without locks.
    if (d.fp) mesh.position.copy(pos).applyQuaternion(f.R).add(f.P);
    else mesh.position.copy(pos).add(this.boneRest[d.attach].p0);
    if (d.fr) mesh.quaternion.copy(f.R).multiply(this._ownRot(d));
    else mesh.quaternion.copy(this._ownRot(d));
  }

  /** Per-frame: follow the bones, billboards turn toward the camera, then set the drawing order. */
  update(camera) {
    if (!this.items.size) return;
    this._syncAvatarSpace(); // also brings the bones' world matrices up to date
    const list = [];
    for (const it of this.items.values()) {
      if (!it.mesh.parent || !it.mesh.visible) continue;
      if (it.def.attach !== 'scene') this._place(it);
      if (it.def.face) {
        it.mesh.parent.getWorldQuaternion(tq).invert();
        it.mesh.quaternion.copy(tq).multiply(camera.quaternion).multiply(this._ownRot(it.def));
      }
      it.mesh.updateMatrixWorld(true);
      list.push(it);
    }
    // in front / behind: the list order (earlier = drawn later = in front). By distance: three.js sorts
    // those by their real distance, so they share one order value.
    const n = this.items.size;
    for (const it of list) it.mesh.renderOrder = it.def.draw === 'depth' ? 10 : 10 + (n - it.order);
  }

  // ---------- editing helpers (broadcaster preview) ----------
  setSelected(id) {
    for (const it of this.items.values()) {
      if (it.def.id === id && !it.outline) {
        const box = new THREE.LineSegments(new THREE.EdgesGeometry(PLANE), new THREE.LineBasicMaterial({ color: 0xb48cff, depthTest: false }));
        box.renderOrder = 999;
        it.mesh.add(box);
        it.outline = box;
      } else if (it.def.id !== id && it.outline) {
        it.mesh.remove(it.outline);
        it.outline.geometry.dispose();
        it.outline = null;
      }
      if (it.outline) it.outline.visible = it.mesh.visible;
    }
    this.selectedId = id;
  }

  /** @param filter optional (def) => boolean, e.g. to skip locked props */
  pick(raycaster, filter = null) {
    raycaster.layers.enableAll(); // props live in several render passes
    const meshes = [...this.items.values()].filter((it) => it.mesh.visible && it.mesh.parent && (!filter || filter(it.def))).map((it) => it.mesh);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    return hit ? { id: hit.object.userData.propId, point: hit.point } : null;
  }

  worldPosition(id) {
    const it = this.items.get(id);
    return it?.mesh.parent ? it.mesh.getWorldPosition(new THREE.Vector3()) : null;
  }

  /** The stored pos that puts prop `id` (with definition `d`, default its own) at world position `world`. */
  posForWorld(id, world, d = null) {
    const it = this.items.get(id);
    if (!it) return null;
    d = normalizeProp(d || it.def);
    if (d.attach === 'scene') return world.toArray();
    if (d.attach === 'screen') return null;
    this._syncAvatarSpace();
    const f = this._frame(d);
    if (!f) return null;
    if (!d.fp) return this.avatarSpace.worldToLocal(world.clone()).sub(this.boneRest[d.attach].p0).toArray();
    const local = this.avatarSpace.worldToLocal(world.clone()).sub(f.P);
    return local.applyQuaternion(f.R.clone().invert()).toArray();
  }

  /** When a prop's attach / follow settings change, the pos that keeps it where it is on screen. */
  posKeepingPlace(id, patch) {
    const it = this.items.get(id);
    const world = this.worldPosition(id);
    if (!it || !world) return null;
    return this.posForWorld(id, world, { ...it.def, ...patch });
  }
}

function makeCanvas(w, h) {
  const k = Math.min(1, MAX_TEX / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  return { canvas, ctx: canvas.getContext('2d') };
}
