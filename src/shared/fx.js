// Headpats and boops.
//
//  • Headpat: rub the mouse quickly back and forth over the top of the head. The head squishes in
//    rhythm under a big cartoon hand (the "headpat" meme). Only the model's head is squished (its bone
//    is scaled), props are never squished.
//  • Boop: click the nose. A little nose scrunch and a few tiny stars flying off.
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
    this.boopAt = -1e9;
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
    const patRest = r.patC.clone().add(new THREE.Vector3(0, fx.hy || 0, 0));
    const noseRest = r.noseC.clone().add(new THREE.Vector3(0, fx.ny || 0, fx.nz || 0));
    return {
      pat: { c: toWorld(patRest), r: r.patR * (fx.hs || 1) },
      nose: { c: toWorld(noseRest), r: r.noseR * (fx.ns || 1) },
    };
  }

  /** 'nose' | 'head' | null for a canvas point (CSS px). */
  hit(x, y, headScale = 1) {
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

  _spawnStar(origin, dir, a, i) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({
      map: this.starTex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
      color: new THREE.Color().setHSL([0.13, 0.14, 0.11, 0.92, 0.55][i % 5], 1, 0.6),
    }));
    m.renderOrder = 1001;
    m.layers.set(3);
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
  }

  /** Hand, stars and area outlines, call every frame after the model is posed. */
  update(dt, camera) {
    const a = (this.pat.level > 0 || this.stars.length || this.showAreas) ? this.areas() : null;
    // the big hand: comes down on the head in rhythm, always facing the viewer
    const L = this.pat.level;
    this.hand.visible = L > 0.01 && !!a;
    if (this.hand.visible) {
      const r = a.pat.r, up = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
      const toCam = camera.position.clone().sub(a.pat.c).normalize();
      if (this.gif) {
        // the gif animates the hand itself: show the frame for this point of the pat
        const g = this.gif, f = Math.min(g.frames.length - 1, Math.floor(this.pat.phase * g.frames.length));
        if (f !== g.shown) { g.ctx.clearRect(0, 0, g.canvas.width, g.canvas.height); g.ctx.drawImage(g.frames[f], 0, 0); g.tex.needsUpdate = true; g.shown = f; }
        this.hand.position.copy(a.pat.c).addScaledVector(up, r * (0.55 + 0.5 * (1 - L))).addScaledVector(toCam, r * 0.6);
        this.hand.quaternion.copy(camera.quaternion);
        const s = r * 3.4;
        this.hand.scale.set(s, s, 1);
      } else {
        const lift = r * (1.0 - 0.45 * (this.press || 0)) + r * 0.6 * (1 - L);
        this.hand.position.copy(a.pat.c).addScaledVector(up, lift).addScaledVector(right, Math.sin(this.pat.phase * Math.PI * 2 * 0.5) * r * 0.12).addScaledVector(toCam, r * 0.6);
        this.hand.quaternion.copy(camera.quaternion);
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
      if (st.t >= st.life) { this.group.remove(st.m); st.m.geometry.dispose(); st.m.material.dispose(); this.stars.splice(i, 1); }
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
      this.areaMarks.add(ring(0xb48cff), ring(0xffcf70));
      this.group.add(this.areaMarks);
    }
    this.areaMarks.visible = true;
    const [pat, nose] = this.areaMarks.children;
    for (const [m, ar] of [[pat, a.pat], [nose, a.nose]]) { m.position.copy(ar.c); m.quaternion.copy(camera.quaternion); m.scale.setScalar(ar.r); }
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
export class FxInput {
  constructor(fx, canvas, { onPat = () => {}, onBoop = () => {}, enabled = () => true } = {}) {
    this.fx = fx; this.canvas = canvas; this.onPat = onPat; this.onBoop = onBoop; this.enabled = enabled;
    this._reset();
    this.lastPatSent = 0;
  }
  _reset() { this.last = null; this.dir = 0; this.travel = 0; this.flips = []; this.rubSince = 0; this.offSince = 0; this.patting = false; }
  _local(e) { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }
  /** 'nose' | 'head' | null under the mouse. */
  over(e) { return this.enabled() ? this.fx.hit(...this._local(e)) : null; }

  move(e) {
    if (!this.enabled()) { if (this.last) this._reset(); return; }
    // the browser hands over one move event per frame; the in-between positions are in
    // getCoalescedEvents(), so use them all and quick rubbing is caught even at a low frame rate
    const list = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    for (const ev of list) this._move(ev);
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
    if (!this.enabled() || this.over(e) !== 'nose') return false;
    this.fx.boop();
    this.onBoop();
    return true;
  }
}

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
