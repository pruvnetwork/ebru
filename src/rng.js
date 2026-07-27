/**
 * Deterministic seeded RNG.
 *
 * The whole point of the engine is that a seed is a contract: the same seed must
 * produce a byte-identical artwork on any machine, forever. So no Math.random(),
 * no Date, no floating-point-order surprises.
 */

/** xmur3: string -> 32-bit seed integer. */
function xmur3(str) {
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return () => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/** mulberry32: 32-bit state -> uniform floats in [0,1). */
function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  /** @param {string} seed any string — a phrase, a wallet address, a tx hash */
  constructor(seed) {
    this.seed = String(seed);
    const h = xmur3(this.seed);
    this.hash = h().toString(16).padStart(8, '0') + h().toString(16).padStart(8, '0');
    this.next = mulberry32(xmur3(this.seed)());
  }

  /** float in [min, max) */
  float(min = 0, max = 1) {
    return min + this.next() * (max - min);
  }

  /** integer in [min, max] */
  int(min, max) {
    return Math.floor(this.float(min, max + 1));
  }

  bool(p = 0.5) {
    return this.next() < p;
  }

  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Fisher-Yates, returns a new array. */
  shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  /** Normal-ish value via sum of uniforms — cheap, deterministic, good enough. */
  gauss(mean = 0, sd = 1) {
    const u = this.next() + this.next() + this.next() + this.next() +
              this.next() + this.next() + this.next() + this.next();
    return mean + ((u - 4) / 1.1547) * sd;
  }
}
