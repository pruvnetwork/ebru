/**
 * The marbling bath.
 *
 * This is not an image filter and not a diffusion model — it is the actual
 * fluid math of ebru. Paint floats on a thickened (kitre) bath; every new drop
 * pushes the earlier paint outward, and every comb stroke drags it along.
 * Both operations are closed-form area-preserving maps, so a drop stays a
 * single closed curve no matter how many times it is deformed. That is why the
 * output can be exact vector geometry rather than pixels.
 *
 * Each drop is stored as a closed polygon. Operations transform every point of
 * every existing drop, in creation order — later drops sit on top, exactly as
 * paint does on the bath.
 *
 * Drop map (Jaffer):   p' = C + (p - C) * sqrt(1 + r^2 / |p - C|^2)
 * Tine map (Jaffer):   p' = p + u * M * alpha^(d / lambda)
 *   where d is the perpendicular distance from p to the comb line and u is the
 *   unit direction the comb is dragged in.
 *
 * Resampling is what makes this look like paint rather than origami. Every
 * operation stretches some parts of a curve and bunches up others; if the point
 * set is left alone, a drop that started as a smooth circle degenerates into a
 * visible polygon. So after each gesture every curve is walked and new points
 * are inserted wherever the spacing has opened past `maxEdge`. Because that
 * happens after every single gesture, the inserted points are always placed
 * while the curve is still locally straight, and they then follow the remaining
 * deformations exactly like original points.
 */

export class Marble {
  /**
   * @param {object} opts
   * @param {number} opts.width   bath width in user units
   * @param {number} opts.height  bath height
   * @param {number} [opts.resolution] starting points per drop
   * @param {number} [opts.maxEdge]    resample when an edge exceeds this length
   * @param {number} [opts.budget]     soft cap on total points
   */
  constructor({ width, height, resolution = 512, maxEdge, budget = 900000, epsilon }) {
    this.w = width;
    this.h = height;
    this.resolution = resolution;
    // Point spacing, in canvas units. Deliberately independent of the size the
    // artwork is finally delivered at: keeping it fixed means a seed produces
    // the same geometry whether it is asked for at 300px or 2000px, and only
    // the rasterisation differs. Tying it to output size would be faster for
    // small requests but would make "same seed, same artwork" quietly untrue
    // across sizes.
    this.maxEdge = maxEdge ?? Math.min(width, height) / 170;
    // Half the coordinate precision the SVG is written at — displacements
    // smaller than this cannot survive the output rounding anyway.
    this.epsilon = epsilon ?? Math.min(width, height) / 14000;
    this.budget = budget;
    this.points = 0;
    // Drops carry a stable id because culling reindexes the array, and callers
    // that recorded "my transaction is drop 12" must not silently start
    // pointing at someone else's paint.
    this.nextId = 0;
    /** @type {{id: number, xs: number[], ys: number[], color: string}[]} */
    this.drops = [];
  }

  /**
   * Insert points wherever a curve has been stretched thin. Skipped once the
   * point budget is exhausted, so a pathological seed degrades in sharpness
   * instead of hanging.
   */
  _resample() {
    if (this.points >= this.budget) return;

    const maxEdge = this.maxEdge;
    const maxEdge2 = maxEdge * maxEdge;
    let total = 0;

    for (const d of this.drops) {
      const { xs, ys } = d;
      const n = xs.length;

      // Scan first, rebuild only if something actually stretched. Most gestures
      // leave most of the bath almost untouched, and rebuilding every curve
      // every time costs far more in allocation than the marbling maths does.
      let needs = false;
      for (let i = 0; i < n; i++) {
        const j = i + 1 === n ? 0 : i + 1;
        const dx = xs[j] - xs[i];
        const dy = ys[j] - ys[i];
        if (dx * dx + dy * dy > maxEdge2) {
          needs = true;
          break;
        }
      }
      if (!needs) {
        total += n;
        continue;
      }

      const nx = [];
      const ny = [];

      for (let i = 0; i < n; i++) {
        const j = i + 1 === n ? 0 : i + 1;
        nx.push(xs[i]);
        ny.push(ys[i]);

        const dx = xs[j] - xs[i];
        const dy = ys[j] - ys[i];
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > maxEdge) {
          // Cap the insertion per edge: a single gesture should never be able
          // to blow up one curve by orders of magnitude.
          const k = Math.min(Math.ceil(len / maxEdge) - 1, 12);
          for (let s = 1; s <= k; s++) {
            const t = s / (k + 1);
            nx.push(xs[i] + dx * t);
            ny.push(ys[i] + dy * t);
          }
        }
      }

      d.xs = nx;
      d.ys = ny;
      total += nx.length;
    }

    this.points = total;
  }

  /** Discard whatever has drifted far outside the bath — it can never come back. */
  _cull() {
    const mx = this.w * 1.6;
    const my = this.h * 1.6;
    const lo = -this.w * 0.6;
    const lo2 = -this.h * 0.6;

    this.drops = this.drops.filter((d) => {
      const { xs, ys } = d;
      for (let i = 0; i < xs.length; i++) {
        if (xs[i] > lo && xs[i] < mx && ys[i] > lo2 && ys[i] < my) return true;
      }
      return false;
    });
  }

  /**
   * Drop a circle of paint. Displaces all paint already on the bath outward.
   */
  drop(cx, cy, r, color) {
    // Guard at the door. A non-finite radius or centre would propagate NaN
    // through every point on the bath and only surface much later as an
    // unrenderable path, so anything unusable is dropped here instead.
    if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(cx) || !Number.isFinite(cy)) {
      return this;
    }

    const r2 = r * r;

    // Far from the drop the displacement tends to r^2 / 2d, which for the small
    // drops that make up the later rounds falls below the precision the artwork
    // is written out at long before it leaves the sheet. Points past that
    // distance are left alone: the error is bounded by `epsilon` user units and
    // it buys back most of the cost of the dense late rounds.
    const cutoff = r2 / (2 * this.epsilon);
    const cutoff2 = cutoff * cutoff;

    for (const d of this.drops) {
      const { xs, ys } = d;
      for (let i = 0; i < xs.length; i++) {
        const px = xs[i] - cx;
        const py = ys[i] - cy;
        const m2 = px * px + py * py;
        if (m2 > cutoff2) continue;
        if (m2 < 1e-12) {
          // Dead centre: the map is singular there. Push it straight out along
          // the new drop's rim so the polygon stays well-formed.
          xs[i] = cx + r;
          ys[i] = cy;
          continue;
        }
        const f = Math.sqrt(1 + r2 / m2);
        xs[i] = cx + px * f;
        ys[i] = cy + py * f;
      }
    }

    // Size the starting polygon to the drop. A 4px speck and a drop that spans
    // a third of the sheet need very different point counts, and giving every
    // drop the same number is how the point budget gets wasted on specks.
    const n = Math.max(24, Math.min(this.resolution, Math.ceil((2 * Math.PI * r) / this.maxEdge)));
    const xs = new Array(n);
    const ys = new Array(n);
    const step = (Math.PI * 2) / n;
    for (let i = 0; i < n; i++) {
      const t = i * step;
      xs[i] = cx + r * Math.cos(t);
      ys[i] = cy + r * Math.sin(t);
    }
    this.drops.push({ id: this.nextId++, xs, ys, color });
    this.points += n;

    this._resample();
    return this;
  }

  /**
   * A single tine (one tooth of the comb, or a single stylus stroke) dragged
   * along direction (ux, uy) through the point (x, y).
   */
  tine({ x, y, ux, uy, mag, alpha = 0.28, lambda = 26 }) {
    const nx = -uy;
    const ny = ux;
    const k = Math.log(alpha) / lambda;

    for (const d of this.drops) {
      const { xs, ys } = d;
      for (let i = 0; i < xs.length; i++) {
        const dist = Math.abs((xs[i] - x) * nx + (ys[i] - y) * ny);
        const s = mag * Math.exp(k * dist);
        xs[i] += ux * s;
        ys[i] += uy * s;
      }
    }
    this._resample();
    return this;
  }

  /**
   * A tine whose line is a sine wave rather than straight. This is what turns a
   * plain gelgit into a şal (shawl) — the comb is rocked side to side as it is
   * drawn across the bath.
   */
  waveTine({ x, y, ux, uy, mag, alpha = 0.28, lambda = 26, amp = 18, freq = 0.02, phase = 0 }) {
    const nx = -uy;
    const ny = ux;
    const k = Math.log(alpha) / lambda;

    for (const d of this.drops) {
      const { xs, ys } = d;
      for (let i = 0; i < xs.length; i++) {
        const rx = xs[i] - x;
        const ry = ys[i] - y;
        const along = rx * ux + ry * uy;
        const across = rx * nx + ry * ny;
        const dist = Math.abs(across - amp * Math.sin(freq * along + phase));
        const s = mag * Math.exp(k * dist);
        xs[i] += ux * s;
        ys[i] += uy * s;
      }
    }
    this._resample();
    return this;
  }

  /**
   * A comb: many parallel tines at a fixed spacing, all dragged together.
   */
  comb({ x, y, ux, uy, count, spacing, mag, alpha = 0.28, lambda = 26, alternate = false }) {
    const nx = -uy;
    const ny = ux;
    for (let i = 0; i < count; i++) {
      const off = (i - (count - 1) / 2) * spacing;
      const dir = alternate && i % 2 === 1 ? -1 : 1;
      this.tine({
        x: x + nx * off,
        y: y + ny * off,
        ux,
        uy,
        mag: mag * dir,
        alpha,
        lambda,
      });
    }
    return this;
  }

  /** Wavy comb — the şal / bülbül yuvası workhorse. */
  waveComb({ x, y, ux, uy, count, spacing, mag, alpha = 0.28, lambda = 26, amp = 18, freq = 0.02, phase = 0, alternate = false }) {
    const nx = -uy;
    const ny = ux;
    for (let i = 0; i < count; i++) {
      const off = (i - (count - 1) / 2) * spacing;
      const dir = alternate && i % 2 === 1 ? -1 : 1;
      this.waveTine({
        x: x + nx * off,
        y: y + ny * off,
        ux,
        uy,
        mag: mag * dir,
        alpha,
        lambda,
        amp,
        freq,
        phase,
      });
    }
    return this;
  }

  /**
   * Swirl the bath around a point — the stylus turn that opens a
   * bülbül yuvası (nightingale's nest).
   */
  vortex({ x, y, strength, falloff }) {
    for (const d of this.drops) {
      const { xs, ys } = d;
      for (let i = 0; i < xs.length; i++) {
        const px = xs[i] - x;
        const py = ys[i] - y;
        const dist = Math.sqrt(px * px + py * py);
        const a = strength * Math.exp(-dist / falloff);
        const c = Math.cos(a);
        const s = Math.sin(a);
        xs[i] = x + px * c - py * s;
        ys[i] = y + px * s + py * c;
      }
    }
    this._resample();
    return this;
  }

  /**
   * A stylus stroke drawn from (x1,y1) to (x2,y2).
   *
   * This is the gesture that opens a hatip flower. It differs from `pull` in the
   * way that matters: the paint is dragged along the *path* the needle travels,
   * with the pull falling off by distance to that path rather than to a single
   * point. A point-centred pull just domes the paint up; a stroke draws a petal.
   *
   * @param {object} o
   * @param {number} o.mag    how far paint sitting on the path is carried
   * @param {number} o.lambda how quickly the pull dies out sideways
   */
  stylus({ x1, y1, x2, y2, mag, lambda }) {
    const vx = x2 - x1;
    const vy = y2 - y1;
    const len2 = vx * vx + vy * vy;
    if (len2 < 1e-12) return this;
    const len = Math.sqrt(len2);
    const ux = vx / len;
    const uy = vy / len;
    const k = -1 / lambda;

    for (const d of this.drops) {
      const { xs, ys } = d;
      for (let i = 0; i < xs.length; i++) {
        const px = xs[i];
        const py = ys[i];
        // Distance to the segment, not the infinite line — the needle is lifted
        // at both ends of the stroke.
        let t = ((px - x1) * vx + (py - y1) * vy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = x1 + vx * t;
        const qy = y1 + vy * t;
        const ddx = px - qx;
        const ddy = py - qy;
        const dist = Math.sqrt(ddx * ddx + ddy * ddy);
        const s = mag * Math.exp(k * dist);
        xs[i] += ux * s;
        ys[i] += uy * s;
      }
    }
    this._resample();
    return this;
  }

  /**
   * A short stylus pull toward or away from a point. Kept for the softer,
   * rounder displacement it gives; `stylus` is the one that draws petals.
   */
  pull({ x, y, ux, uy, mag, radius }) {
    const k = -3 / radius;
    for (const d of this.drops) {
      const { xs, ys } = d;
      for (let i = 0; i < xs.length; i++) {
        const px = xs[i] - x;
        const py = ys[i] - y;
        const dist = Math.sqrt(px * px + py * py);
        const s = mag * Math.exp(k * dist);
        xs[i] += ux * s;
        ys[i] += uy * s;
      }
    }
    this._resample();
    return this;
  }

  /** Call once when the bath is finished, before rendering. */
  settle() {
    this._cull();
    let total = 0;
    for (const d of this.drops) total += d.xs.length;
    this.points = total;
    return this;
  }

  get pointCount() {
    return this.points;
  }
}
