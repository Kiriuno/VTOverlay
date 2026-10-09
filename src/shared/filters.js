// One-Euro filter (Casiez et al. 2012): heavy smoothing when you hold still (kills jitter),
// light smoothing when you move fast (keeps latency low). The standard choice for face trackers.

const alpha = (cutoff, dt) => 1 / (1 + 1 / (2 * Math.PI * cutoff * dt));

export class OneEuro {
  constructor(minCutoff = 1, beta = 0.5, dCutoff = 1) {
    this.set(minCutoff, beta, dCutoff);
    this.x = null; this.dx = 0; this.t = null;
  }
  set(minCutoff, beta, dCutoff = 1) { this.minCutoff = minCutoff; this.beta = beta; this.dCutoff = dCutoff; }
  reset() { this.x = null; this.dx = 0; this.t = null; }
  filter(value, tSeconds) {
    if (this.x === null) { this.x = value; this.t = tSeconds; return value; }
    const dt = Math.max(1e-3, Math.min(0.2, tSeconds - this.t)); // tolerate dropped frames
    this.t = tSeconds;
    const rawDx = (value - this.x) / dt;
    this.dx += alpha(this.dCutoff, dt) * (rawDx - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }
}

/** A bank of One-Euro filters for a fixed-length array of numbers. */
export class OneEuroArray {
  constructor(n, minCutoff, beta) { this.f = Array.from({ length: n }, () => new OneEuro(minCutoff, beta)); }
  set(minCutoff, beta) { for (const f of this.f) f.set(minCutoff, beta); }
  setOne(i, minCutoff, beta) { this.f[i].set(minCutoff, beta); }
  reset() { for (const f of this.f) f.reset(); }
  filter(arr, t) { return arr.map((v, i) => this.f[i].filter(v, t)); }
}
