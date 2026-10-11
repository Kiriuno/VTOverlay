// Mouse grabbing of the avatar's spring bones (hair, clothes, ribbons…), shared by the broadcaster's
// preview and the viewer overlay. The grab is applied locally right away and sent with `send(j, p)`
// (j = spring joint index, p = avatar-local target [x,y,z]; j = -1 / p = null = released) so everyone
// else sees the same pull.
export class SpringGrabber {
  /**
   * @param stage   AvatarStage
   * @param canvas  the stage's canvas
   * @param opts    { send(j, p), canGrab() → boolean }
   */
  constructor(stage, canvas, { send = () => {}, canGrab = () => true } = {}) {
    this.stage = stage; this.canvas = canvas; this.send = send; this.canGrab = canGrab;
    this.active = null; // { j, world }
    this.lastSent = 0; this.keepAlive = null;
  }

  get grabbing() { return !!this.active; }

  _local(e) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  /** Index of the grabbable joint under the mouse, or -1. */
  over(e) {
    if (!this.canGrab()) return -1;
    const [x, y] = this._local(e);
    const r = this.canvas.getBoundingClientRect();
    if (x < 0 || y < 0 || x > r.width || y > r.height) return -1;
    return this.stage.pickJoint(x, y);
  }

  /** Start a grab if there's something under the mouse. Returns true if it grabbed. */
  begin(e) {
    const j = this.over(e);
    if (j < 0) return false;
    this.active = { j, world: this.stage.jointWorld(j) };
    this.move(e, true);
    // the target only travels on mouse moves: resend now and then so others don't time the grab out
    clearInterval(this.keepAlive);
    this.keepAlive = setInterval(() => { if (this.active?.p) this._send(true); }, 1000);
    return true;
  }

  move(e, force = false) {
    if (!this.active) return;
    if (!this.canGrab()) { this.end(); return; }
    const [x, y] = this._local(e);
    const p = this.stage.canvasToAvatar(x, y, this.active.world);
    if (!p) return;
    this.active.p = p.toArray().map((v) => +v.toFixed(4));
    this.stage.setGrab('me', this.active.j, this.active.p);
    this._send(force);
  }

  _send(force) {
    const now = performance.now();
    if (!force && now - this.lastSent < 33) return; // ~30 updates a second is plenty
    this.lastSent = now;
    try { this.send(this.active.j, this.active.p); } catch {}
  }

  end() {
    clearInterval(this.keepAlive);
    if (!this.active) return;
    this.active = null;
    this.stage.setGrab('me', -1, null);
    try { this.send(-1, null); } catch {}
  }
}
