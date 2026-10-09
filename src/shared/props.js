// Props: 2D images placed in the scene or attached to a body part (moving with it).
//
// A prop definition (what is stored and sent to viewers):
//   { id, img (image hash), attach ('scene' | VRM bone name), pos:[x,y,z], rot (radians, roll),
//     size (height in metres), face (always face the camera), flip, visible }
// For attached props, pos is the offset from the bone measured in "avatar space at rest"
// (metres, avatar facing the viewer, +X = avatar's left, +Y up), so it doesn't depend on how
// a particular rig orients its bones.
import * as THREE from 'three';

export const PROP_ATTACH = [
  ['scene', 'Scene (stays put)'], ['head', 'Head'], ['neck', 'Neck'], ['upperChest', 'Upper chest'],
  ['chest', 'Chest'], ['spine', 'Spine'], ['hips', 'Hips'],
  ['leftHand', 'Left hand'], ['rightHand', 'Right hand'], ['leftLowerArm', 'Left forearm'], ['rightLowerArm', 'Right forearm'],
  ['leftUpperArm', 'Left upper arm'], ['rightUpperArm', 'Right upper arm'], ['leftFoot', 'Left foot'], ['rightFoot', 'Right foot'],
];
const MAX_TEX = 2048;
const PLANE = new THREE.PlaneGeometry(1, 1);
const Z = new THREE.Vector3(0, 0, 1);
const tq = new THREE.Quaternion(), tq2 = new THREE.Quaternion();

export class PropLayer {
  /** @param stage AvatarStage  @param loader async (hash) => Blob | null */
  constructor(stage) {
    this.stage = stage;
    this.items = new Map();
    this.loader = null;
    this.selectedId = null;
    this.boneRest = {};
  }

  setLoader(fn) { this.loader = fn; for (const it of this.items.values()) if (!it.loaded && !it.loading) this._load(it); }

  /** Remember each bone's rest orientation (called by the stage right after a model loads). */
  captureRest(vrm) {
    this.boneRest = {};
    if (!vrm) return;
    vrm.scene.updateMatrixWorld(true);
    for (const [name] of PROP_ATTACH) {
      if (name === 'scene') continue;
      const node = vrm.humanoid.getRawBoneNode(name);
      if (!node) continue;
      const s = new THREE.Vector3(); node.getWorldScale(s);
      this.boneRest[name] = { node, q: node.getWorldQuaternion(new THREE.Quaternion()), s: s.x || 1 };
    }
    for (const it of this.items.values()) this._apply(it);
  }

  /** Called before the model is disposed: take attached props off its bones so they survive. */
  detachFromModel() {
    for (const it of this.items.values()) if (it.def.attach !== 'scene') { it.mesh.parent?.remove(it.mesh); it.mesh.visible = false; }
    this.boneRest = {};
  }

  /** Replace the full list of props (adds, updates and removes as needed). */
  sync(defs) {
    const seen = new Set();
    defs.forEach((d, order) => {
      seen.add(d.id);
      let it = this.items.get(d.id);
      if (it && it.def.img !== d.img) { this._remove(it); it = null; }
      if (!it) it = this._create(d);
      it.def = { ...d };
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

  _parentFor(d) {
    if (d.attach === 'scene') return this.stage.scene;
    return this.boneRest[d.attach]?.node ?? null;
  }

  _apply(it) {
    const d = it.def, mesh = it.mesh;
    const parent = this._parentFor(d);
    if (!parent) { mesh.parent?.remove(mesh); mesh.visible = false; return; }
    if (mesh.parent !== parent) parent.add(mesh);
    const roll = new THREE.Quaternion().setFromAxisAngle(Z, d.rot || 0);
    const pos = new THREE.Vector3().fromArray(d.pos || [0, 0, 0]);
    let s = 1;
    if (d.attach === 'scene') {
      mesh.position.copy(pos);
      mesh.quaternion.copy(roll);
    } else {
      const rest = this.boneRest[d.attach];
      s = rest.s;
      const inv = rest.q.clone().invert();
      mesh.position.copy(pos.applyQuaternion(inv).divideScalar(s));
      mesh.quaternion.copy(inv).multiply(roll);
    }
    const h = Math.max(0.01, d.size || 0.3);
    mesh.scale.set((h * it.aspect * (d.flip ? -1 : 1)) / s, h / s, 1);
    mesh.renderOrder = 10 + it.order;
    mesh.visible = !!d.visible && it.loaded;
    if (it.outline) it.outline.visible = mesh.visible;
  }

  /** Per-frame: billboards turn toward the camera. */
  update(camera) {
    for (const it of this.items.values()) {
      if (!it.def.face || !it.mesh.parent || !it.mesh.visible) continue;
      it.mesh.parent.getWorldQuaternion(tq).invert();
      tq2.setFromAxisAngle(Z, it.def.rot || 0);
      it.mesh.quaternion.copy(tq).multiply(camera.quaternion).multiply(tq2);
    }
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

  pick(raycaster) {
    const meshes = [...this.items.values()].filter((it) => it.mesh.visible && it.mesh.parent).map((it) => it.mesh);
    const hit = raycaster.intersectObjects(meshes, false)[0];
    return hit ? { id: hit.object.userData.propId, point: hit.point } : null;
  }

  worldPosition(id) {
    const it = this.items.get(id);
    return it?.mesh.parent ? it.mesh.getWorldPosition(new THREE.Vector3()) : null;
  }

  /** Convert a world position into the stored pos of prop `id` (doesn't modify the prop). */
  posForWorld(id, world) {
    const it = this.items.get(id);
    if (!it?.mesh.parent) return null;
    const d = it.def;
    if (d.attach === 'scene') return world.toArray();
    const rest = this.boneRest[d.attach];
    const local = it.mesh.parent.worldToLocal(world.clone());
    return local.multiplyScalar(rest.s).applyQuaternion(rest.q).toArray();
  }

  /** A sensible starting pos when a prop is (re)attached somewhere: keep it where it currently is. */
  posKeepingPlace(id, newAttach) {
    const it = this.items.get(id);
    const world = this.worldPosition(id);
    if (!it || !world) return null;
    if (newAttach === 'scene') return world.toArray();
    const rest = this.boneRest[newAttach];
    if (!rest) return null;
    const local = rest.node.worldToLocal(world.clone());
    return local.multiplyScalar(rest.s).applyQuaternion(rest.q).toArray();
  }
}

function makeCanvas(w, h) {
  const k = Math.min(1, MAX_TEX / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * k));
  canvas.height = Math.max(1, Math.round(h * k));
  return { canvas, ctx: canvas.getContext('2d') };
}
