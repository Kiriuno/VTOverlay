// Multi-model rooms. A host can let up to 4 more people (co-hosts) join with their own avatar; all the
// avatars stand in one row, and everyone (viewers, co-hosts, the camera output…) sees all of them.
//
// The host relays everything: a co-host's messages reach the others wrapped as { t:'mm', m, d } (m = the
// co-host's id, d = the same message a solo broadcaster would send: model-*, style, props, perm, fx,
// grab, pos), and their motion frames carry `m`. The host's own messages are unchanged, so a room
// with just the host looks exactly like before.
//
// Room keeps one RoomSlot (own canvas + AvatarStage) per other avatar; where the canvases go is up to
// the page using it (a row in a window, boxes on a monitor, beside you in your preview).
import { AvatarStage } from './avatar.js';
import { SpringGrabber } from './grab.js';
import { FxInput } from './fx.js';
import { AVATAR_ASPECT } from './protocol.js';

/** Distance between neighbours in the row, in avatar-box heights (a bit less than a box: they stand close). */
export const SLOT_STEP = AVATAR_ASPECT * 0.85;
export const MAX_MODELS = 5;

// The view is split: framing (bust / full body) and roll are the room's (the host's), the rest
// (zoom, move, turn, tilt) belongs to each avatar's owner and only moves their own avatar.
const OWN_DEFAULT = { zoom: 1, px: 0, py: 0, yaw: 0, el: 0 };
export const ownView = (v = {}) => {
  const o = {};
  for (const k of Object.keys(OWN_DEFAULT)) o[k] = Number.isFinite(+v[k]) ? +v[k] : OWN_DEFAULT[k];
  return o;
};
export const roomView = (v = {}) => ({ fr: v.fr, roll: v.roll });

const toBuffer = (data) => {
  if (data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return null;
};

export class RoomSlot {
  constructor(room, id) {
    this.room = room; this.id = id;
    this.name = ''; this.style = {}; this.perm = {}; this.ownView = ownView(); this.pos = null; this.shown = null; this.props = [];
    this.lastLive = performance.now(); this.incoming = null; this.idle = false;
    this.el = document.createElement('div');
    this.el.className = 'member';
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'memberCanvas';
    this.el.appendChild(this.canvas);
    room.container.appendChild(this.el);
    this.stage = new AvatarStage(this.canvas, room.stageOptions());
    if (room.propLoader) this.stage.props.setLoader(room.propLoader);
    this.stage.onModel = () => room.syncFrame();
    if (id === 'h') this.ownView = ownView(room.view);
    this.applyView();
    this.applyStyle();
    if (room.interactive) {
      const send = (msg) => room.send({ ...msg, m: id });
      this.grabber = new SpringGrabber(this.stage, this.canvas, {
        send: (j, p) => send({ t: 'grab', j, p }),
        canGrab: () => !!this.perm.grab && room.canInteract(this),
      });
      let lastBoop = 0, lastSlap = 0;
      this.fxIn = new FxInput(this.stage.fx, this.canvas, {
        onPat: (r) => send({ t: 'fx', k: 'pat', r }),
        onBoop: () => { lastBoop = performance.now(); send({ t: 'fx', k: 'boop' }); },
        onSlap: (d) => { lastSlap = performance.now(); send({ t: 'fx', k: 'slap', d }); },
        enabled: () => !!this.perm.pat && room.canInteract(this) && performance.now() - lastBoop > 250,
        canSlap: () => !!this.perm.slap && room.canInteract(this) && performance.now() - lastSlap > 300,
      });
    }
  }

  get hasModel() { return !!this.stage.vrm; }

  /** Framing and roll are the room's, zoom / move / turn the owner's own. */
  applyView() { this.stage.setView({ ...roomView(this.room.view), ...this.ownView }); }

  /** Lighting is the host's; mouth sensitivity, pose, interaction areas… are the owner's own. */
  applyStyle() {
    const light = this.room.hostLight || this.style.light;
    this.stage.setStyle({ ...this.style, ...(light ? { light } : {}) });
  }

  async load(buf, id) {
    try {
      await this.stage.loadVRM(buf, id);
      this.room.onLoaded?.(this);
      return true;
    } catch (err) { console.warn('member model failed', this.id, err); return false; }
  }

  async handle(d) {
    if (!d || typeof d !== 'object') return;
    switch (d.t) {
      case 'model': if (d.buf && this.stage.modelId !== d.id) await this.load(d.buf, d.id); return; // local pages
      case 'model-use': {
        if (this.stage.modelId === d.id) return;
        const buf = await this.room.cache?.get(d.id);
        if (buf) { await this.load(buf, d.id); return; }
        this.room.send({ t: 'need-model', m: this.id });
        return;
      }
      case 'model-begin':
        this.incoming = { id: d.id, size: d.size, chunks: d.chunks, parts: new Array(d.chunks), got: 0 };
        return;
      case 'model-chunk': {
        const inc = this.incoming;
        if (!inc || d.id !== inc.id) return;
        if (!inc.parts[d.i]) { inc.parts[d.i] = toBuffer(d.data); inc.got++; }
        return;
      }
      case 'model-end': {
        const inc = this.incoming;
        if (!inc || d.id !== inc.id) return;
        this.incoming = null;
        if (inc.parts.some((p) => !p)) { this.room.send({ t: 'need-model', m: this.id }); return; }
        const buf = new Uint8Array(inc.size); let off = 0;
        for (const p of inc.parts) { buf.set(new Uint8Array(p), off); off += p.byteLength; }
        if (await this.load(buf.buffer.slice(0), inc.id)) this.room.cache?.put(inc.id, buf.buffer);
        return;
      }
      case 'style': this.style = d; this.applyStyle(); return;
      case 'mview': this.ownView = ownView(d); this.applyView(); this.room.onView?.(this); return;
      case 'props':
        if (Array.isArray(d.list)) { this.props = d.list.slice(0, 64); this.stage.props.sync(this.props); this.room.onProps?.(this); }
        return;
      case 'perm':
        this.perm = { grab: !!d.grab, pat: !!d.pat, slap: !!d.slap };
        if (!this.perm.grab) { this.grabber?.end(); this.stage.clearGrabs(); }
        return;
      case 'fx':
        if (d.k === 'pat') this.stage.fx.patting(+d.r);
        else if (d.k === 'boop') this.stage.fx.boop();
        else if (d.k === 'slap') this.stage.fx.slap(d.d);
        return;
      case 'grab':
        if (typeof d.k === 'string') this.stage.setGrab('r' + d.k, Number.isInteger(d.j) ? d.j : -1, Array.isArray(d.p) ? d.p.slice(0, 3).map(Number) : null, true);
        return;
      case 'pos':
        this.pos = { x: +d.x, y: +d.y, s: +d.s, tb: !!d.tb };
        this.room.onPos?.(this);
        return;
    }
  }

  motion(frame) {
    this.stage.setMotion(frame);
    if (frame.f && !frame.h) this.lastLive = performance.now();
  }

  dispose() {
    this.grabber?.end();
    this.stage.dispose();
    this.el.remove();
  }
}

export class Room {
  /**
   * @param o.container    element the slots' elements go in
   * @param o.stageOptions () => AvatarStage options (frame rate, resolution…)
   * @param o.propLoader   (hash) => Promise<Blob>, shared with the main avatar
   * @param o.cache        { get(id) → ArrayBuffer|null, put(id, buf) } for models (optional)
   * @param o.send         (msg) => void, toward the host (need-model, fx, grab…)
   * @param o.interactive  give every slot its own hair-pulling / headpat / boop / slap input
   * @param o.canInteract  (slot) => boolean
   */
  constructor(o) {
    Object.assign(this, { send: () => {}, canInteract: () => false, interactive: false, stageOptions: () => ({}) }, o);
    this.slots = new Map();
    this.order = [];       // every avatar in the room, left to right: 'h' = the host, 'c1'… = co-hosts
    this.names = {};
    this.free = false;     // co-hosts may place their own avatar on full-screen viewers
    this.view = {};
    this.hostLight = null;
    this.skip = new Set(o.skip || []); // ids that aren't drawn by this room (e.g. the page's own avatar)
    // the page's own big avatar (the host's on viewers, yours in your preview): framed with the others
    if (this.main) { const prev = this.main.onModel; this.main.onModel = () => { prev?.(); this.syncFrame(); }; }
  }

  /**
   * Who stands in front: each avatar is its own picture, so they're layered (CSS z-index). The bigger one
   * on screen (model height × its zoom × its box) is further back, the smaller in front; the same size
   * shares a layer. o.main = the element holding the page's own big avatar, o.base = the lowest z-index.
   */
  startDepth({ main, base = 0 }) {
    this.depthMain = main; this.depthBase = base;
    clearInterval(this._depthTimer);
    this._depthTimer = setInterval(() => this.applyDepth(), 300);
    this.applyDepth();
  }

  applyDepth() {
    if (this.order.length <= 1 && this._depthAlone) return; // alone: nothing to sort (already reset)
    this._depthAlone = this.order.length <= 1;
    const items = [];
    if (this.main && this.depthMain) items.push({ el: this.depthMain, st: this.main });
    for (const s of this.slots.values()) items.push({ el: s.el, st: s.stage });
    const size = (st) => (st.vrm ? st.headRestY || 1.4 : 0) * (st.view.zoom || 1) * (st.viewport?.h || st.canvas.clientHeight || 1);
    const sizes = items.map((it) => size(it.st));
    const levels = [...sizes].sort((a, b) => b - a).filter((v, i, a) => i === 0 || v < a[i - 1] * 0.995); // biggest first
    items.forEach((it, i) => {
      const layer = this.order.length > 1 ? levels.findIndex((v) => sizes[i] >= v * 0.995) : 0; // 0 = the back
      const z = String(this.depthBase + Math.max(0, layer));
      if (it.el.style.zIndex !== z) it.el.style.zIndex = z;
    });
  }

  /** Everyone on the same floor: one shared head height (the tallest avatar's) while there's more than one. */
  syncFrame() {
    const stages = [...(this.main ? [this.main] : []), ...[...this.slots.values()].map((s) => s.stage)];
    let ref = null;
    if (this.order.length > 1) for (const st of stages) if (st.vrm && st.headRestY != null) ref = Math.max(ref ?? -Infinity, st.headRestY);
    for (const st of stages) st.setGroupHead(ref);
  }

  /** The room's line-up changed. Slots are created / removed to match (except skipped ids). */
  setMembers({ order = [], names = {}, free = false } = {}) {
    this.order = order.filter((id) => typeof id === 'string').slice(0, MAX_MODELS);
    this.names = names || {};
    this.free = !!free;
    for (const [id, s] of this.slots) if (!this.order.includes(id) || this.skip.has(id)) { s.dispose(); this.slots.delete(id); }
    for (const id of this.order) {
      if (this.skip.has(id)) continue;
      let s = this.slots.get(id);
      if (!s) {
        try { s = new RoomSlot(this, id); } catch (err) { // e.g. no WebGL context available right now
          console.warn('could not add avatar', id, err);
          (this._failed = this._failed || new Set()).add(id);
          clearTimeout(this._retry);
          this._retry = setTimeout(() => this.setMembers({ order: this.order, names: this.names, free: this.free }), 2000);
          continue;
        }
        this.slots.set(id, s);
        if (this._failed?.delete(id)) this.send({ t: 'need-model', m: id }); // its model went by while it couldn't be added
      }
      s.name = this.names[id] || '';
    }
    this.syncFrame();
    this.onChange?.();
  }

  slot(id) { return this.slots.get(id) || null; }
  index(id) { return this.order.indexOf(id); }
  get count() { return Math.max(1, this.order.length); }

  /** A wrapped co-host message ({ t:'mm', m, d }). Messages for an avatar this room doesn't draw are ignored. */
  handle(m, d) { return this.slots.get(m)?.handle(d); }
  motion(m, frame) { this.slots.get(m)?.motion(frame); }

  /** The host's view: framing + roll for everyone, and the rest for the host's own avatar (if drawn here). */
  setView(v) {
    this.view = { ...v };
    for (const s of this.slots.values()) { if (s.id === 'h') s.ownView = ownView(v); s.applyView(); }
  }
  setHostLight(light) { this.hostLight = light || null; for (const s of this.slots.values()) s.applyStyle(); }
  setQuality(q) { for (const s of this.slots.values()) s.stage.setQuality(q); }

  /** Input targets (for pages that route mouse events): [{ slot, grabber, fxIn }]. */
  targets() { return [...this.slots.values()].filter((s) => s.grabber).map((s) => ({ slot: s, grabber: s.grabber, fxIn: s.fxIn })); }

  dispose() { clearInterval(this._depthTimer); for (const s of this.slots.values()) s.dispose(); this.slots.clear(); }
}

/**
 * Where each avatar's box goes in a W×H area, everyone in one row. Returns { [id]: { x, y, w, h } } in
 * px. center: 'group' = the row is centred (viewers, camera output), or an id = that avatar is centred
 * (your own preview: you in the middle, the others beside you).
 */
export function rowLayout(order, W, H, center = 'group', roll = 0) {
  const n = Math.max(1, order.length);
  // roll turns the whole row around its middle (a column at 90°), like one picture
  const r = (roll || 0) * Math.PI / 180, c = Math.abs(Math.cos(r)), sn = Math.abs(Math.sin(r));
  const run = (n - 1) * SLOT_STEP; // in box heights
  const groupW = c * AVATAR_ASPECT + sn + c * run, groupH = sn * AVATAR_ASPECT + c + sn * run;
  const boxH = center === 'group' ? Math.min(H, W / groupW, H / Math.max(1, groupH)) : H;
  const boxW = boxH * AVATAR_ASPECT;
  const mid = center === 'group' ? (n - 1) / 2 : Math.max(0, order.indexOf(center));
  const out = {};
  order.forEach((id, i) => {
    const off = (i - mid) * SLOT_STEP * boxH; // along the row; + roll = counter-clockwise on screen
    const cx = W / 2 + off * Math.cos(r), cy = H / 2 - off * Math.sin(r);
    out[id] = { x: cx - boxW / 2, y: cy - boxH / 2, w: boxW, h: boxH };
  });
  return out;
}

/**
 * Full screen: where an avatar stands, from the room's placement `pos` (x = the middle of the whole row,
 * y = the feet, s = an avatar's height, all in fractions of the zone). ratio = zone width / height.
 * The row is kept inside the zone as a whole, so the avatars at the ends never get squashed together.
 */
export function rowPos(order, id, pos, ratio, roll = 0) {
  const n = order.length, i = order.indexOf(id);
  if (n <= 1 || i < 0) return pos;
  const r = (roll || 0) * Math.PI / 180, c = Math.cos(r), sn = Math.sin(r);
  const step = SLOT_STEP * pos.s / ratio; // one step along the row, in zone widths
  const half = Math.min(0.5, (pos.s * AVATAR_ASPECT / ratio + (n - 1) * step * Math.abs(c)) / 2);
  const mid = Math.max(half, Math.min(1 - half, pos.x));
  const off = (i - (n - 1) / 2) * step; // zone widths; the row turns with the roll, around its middle
  return { ...pos, x: mid + off * c, y: pos.y - off * sn * ratio };
}
