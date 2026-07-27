/**
 * The traditional ebru patterns, each expressed as the sequence of physical
 * gestures a marbler actually performs. Every pattern here is built only from
 * drops, combs and stylus turns — nothing is drawn directly.
 *
 * Each pattern splits into two halves: a *ground* (paint thrown onto the bath)
 * and a *finish* (the comb and stylus work that turns that ground into a named
 * pattern). They are kept separate because the ground is not always ours to
 * choose — when a wallet history supplies the drops, the finish still has to be
 * applied on top of them. See `FINISHES`.
 */

/**
 * Scatter paint across the bath: the base coat every other pattern starts from.
 *
 * A marbler throws one colour at a time, each from its own brush, and each
 * successive colour lands in smaller, more numerous drops than the last — the
 * first colour is the ground, the last is a fine speckle over everything. That
 * taper is what produces ebru's cell structure: broad fields of the early
 * colours, each ringed by thin walls of the later ones.
 */
function scatter(m, rng, colors, { rounds = 5, coverage = 2.2, rMin = 0.02, rMax = 0.05, taper = 0.72 } = {}) {
  const scale = Math.min(m.w, m.h);

  // Work in paint area rather than drop count, so a pattern asks for "twice the
  // sheet covered in the first colour" and gets that regardless of drop size.
  // Full coverage needs well over 1x: the bath keeps pushing paint off the edge.
  const meanArea = Math.PI * Math.pow(((rMin + rMax) / 2) * scale, 2);
  const baseCount = Math.round((coverage * m.w * m.h) / meanArea);

  for (let round = 0; round < rounds; round++) {
    const color = colors[round % colors.length];
    const shrink = Math.pow(taper, round);
    // Later colours come in slightly more drops but much smaller ones, so each
    // round lays down less paint than the one before and reads as an accent
    // over the ground rather than replacing it.
    const n = Math.round(baseCount * Math.pow(1 / taper, round * 0.35));

    for (let i = 0; i < n; i++) {
      // Kept close to the sheet: paint thrown far outside is pushed further out
      // by everything that follows and never contributes to the image.
      m.drop(
        rng.float(-0.06, 1.06) * m.w,
        rng.float(-0.06, 1.06) * m.h,
        rng.float(rMin, rMax) * shrink * scale,
        color,
      );
    }
  }
}

/**
 * The ground coat, for callers who supply their own drops afterwards.
 * A marbler never works on a bare bath; the ground is thrown first and
 * everything meaningful lands on top of it.
 */
export function layGround(m, rng, colors, opts) {
  scatter(m, rng, colors, opts);
}

/* ------------------------------------------------------------------ *
 * Finishes — the comb and stylus work, independent of how the paint
 * got onto the bath.
 * ------------------------------------------------------------------ */

/** The back-and-forth comb of a gelgit. */
export function combGelgit(m, rng) {
  const scale = Math.min(m.w, m.h);
  const vertical = rng.bool();
  const [ux, uy] = vertical ? [0, 1] : [1, 0];
  const passes = rng.int(2, 4);

  for (let p = 0; p < passes; p++) {
    const dir = p % 2 === 0 ? 1 : -1;
    m.comb({
      x: m.w / 2,
      y: m.h / 2,
      ux: ux * dir,
      uy: uy * dir,
      count: rng.int(10, 18),
      spacing: scale * rng.float(0.055, 0.095),
      mag: scale * rng.float(0.07, 0.13),
      alpha: rng.float(0.2, 0.34),
      lambda: scale * rng.float(0.022, 0.04),
    });
  }
}

/** The rocked comb that folds gelgit stripes into a şal. */
export function combSal(m, rng) {
  const scale = Math.min(m.w, m.h);
  const passes = rng.int(2, 3);

  for (let p = 0; p < passes; p++) {
    const angle = rng.float(0, Math.PI * 2);
    m.waveComb({
      x: m.w / 2,
      y: m.h / 2,
      ux: Math.cos(angle),
      uy: Math.sin(angle),
      count: rng.int(8, 14),
      spacing: scale * rng.float(0.07, 0.12),
      mag: scale * rng.float(0.05, 0.1),
      alpha: rng.float(0.22, 0.36),
      lambda: scale * rng.float(0.025, 0.045),
      amp: scale * rng.float(0.04, 0.09),
      freq: rng.float(0.008, 0.02) * (600 / scale),
      phase: rng.float(0, Math.PI * 2),
    });
  }
}

/** Stylus turns that open spiral nests. */
export function openNests(m, rng) {
  const scale = Math.min(m.w, m.h);
  const nests = rng.int(3, 6);

  for (let i = 0; i < nests; i++) {
    m.vortex({
      x: rng.float(0.15, 0.85) * m.w,
      y: rng.float(0.15, 0.85) * m.h,
      strength: rng.float(2.2, 5.0) * (rng.bool() ? 1 : -1),
      falloff: scale * rng.float(0.09, 0.17),
    });
  }
}

/** The dense fine-toothed comb of a taraklı. */
export function combFine(m, rng) {
  const scale = Math.min(m.w, m.h);
  const angle = rng.float(0, Math.PI * 2);

  m.comb({
    x: m.w / 2,
    y: m.h / 2,
    ux: Math.cos(angle),
    uy: Math.sin(angle),
    count: rng.int(24, 40),
    spacing: scale * rng.float(0.02, 0.038),
    mag: scale * rng.float(0.025, 0.05),
    alpha: rng.float(0.14, 0.26),
    lambda: scale * rng.float(0.01, 0.02),
    alternate: true,
  });
}

/** Concentric drops pulled open into hatip rosettes. */
export function drawFlowers(m, rng, palette) {
  const scale = Math.min(m.w, m.h);
  const flowers = rng.int(2, 4);

  for (let f = 0; f < flowers; f++) {
    const cx = rng.float(0.2, 0.8) * m.w;
    const cy = rng.float(0.2, 0.8) * m.h;
    const rings = rng.int(3, 5);
    const outer = scale * rng.float(0.09, 0.15);
    const ringColors = rng.shuffle(palette.colors);

    // Concentric drops, largest first — each new one sits inside the last.
    for (let i = 0; i < rings; i++) {
      const t = 1 - i / rings;
      m.drop(cx, cy, outer * t, ringColors[i % ringColors.length]);
    }

    // The rosette. The needle is drawn radially through the rings, alternating
    // outward and inward around the flower: the outward strokes pull the inner
    // colours out into petal tips, the inward ones pinch the ground back in
    // between them. Alternating direction is the whole trick — strokes all one
    // way just rotate the rings.
    const petals = rng.int(5, 8) * 2;
    const startAngle = rng.float(0, Math.PI * 2);
    const reach = outer * rng.float(1.7, 2.6);

    for (let i = 0; i < petals; i++) {
      const a = startAngle + (i / petals) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const outward = i % 2 === 0;

      const near = outer * 0.12;
      const far = reach;
      const [r1, r2] = outward ? [near, far] : [far, near];

      m.stylus({
        x1: cx + ca * r1,
        y1: cy + sa * r1,
        x2: cx + ca * r2,
        y2: cy + sa * r2,
        mag: outer * rng.float(0.5, 0.8),
        lambda: outer * rng.float(0.16, 0.26),
      });
    }
  }
}

/** The light single comb that settles a kumlu ground. */
export function combSoft(m, rng) {
  const scale = Math.min(m.w, m.h);
  m.comb({
    x: m.w / 2,
    y: m.h / 2,
    ux: 1,
    uy: 0,
    count: rng.int(6, 10),
    spacing: scale * rng.float(0.09, 0.14),
    mag: scale * rng.float(0.015, 0.035),
    alpha: 0.3,
    lambda: scale * 0.02,
  });
}

/* ------------------------------------------------------------------ *
 * Patterns — ground plus finish.
 * ------------------------------------------------------------------ */

/**
 * Battal — "the large one". The oldest pattern: paint dropped and left alone.
 * The cell structure comes entirely from drops crowding each other out.
 */
export function battal(m, rng, palette) {
  const colors = rng.shuffle(palette.colors);
  scatter(m, rng, colors, {
    rounds: rng.int(4, 5),
    coverage: rng.float(1.8, 2.4),
    rMin: 0.03,
    rMax: 0.075,
    taper: rng.float(0.66, 0.78),
  });
}

/**
 * Gelgit — "ebb and flow". Battal, then the comb drawn back and forth across
 * the bath in one axis.
 */
export function gelgit(m, rng, palette) {
  battal(m, rng, palette);
  combGelgit(m, rng);
}

/**
 * Şal — "shawl". The comb is rocked side to side while being drawn, folding the
 * gelgit stripes into the S-curves that give the pattern its name.
 */
export function sal(m, rng, palette) {
  gelgit(m, rng, palette);
  combSal(m, rng);
}

/**
 * Bülbül yuvası — "nightingale's nest". A şal ground, then the stylus turned in
 * a few places to open spiral nests.
 */
export function bulbulYuvasi(m, rng, palette) {
  sal(m, rng, palette);
  openNests(m, rng);
}

/**
 * Taraklı — "combed". A fine-toothed comb over a plain gelgit ground, giving
 * the dense feather structure used for book endpapers.
 */
export function tarakli(m, rng, palette) {
  gelgit(m, rng, palette);
  combFine(m, rng);
}

/**
 * Hatip — named for Hatip Mehmed Efendi, who invented it in the 18th century.
 * Concentric drops are laid on a battal ground and then pulled outward with the
 * stylus in a rosette of strokes, opening a flower.
 */
export function hatip(m, rng, palette) {
  const colors = rng.shuffle(palette.colors);
  scatter(m, rng, colors, {
    rounds: rng.int(3, 4),
    coverage: rng.float(1.6, 2.0),
    rMin: 0.03,
    rMax: 0.06,
  });
  drawFlowers(m, rng, palette);
}

/**
 * Kumlu — "sanded". Many tiny drops with almost no dispersal, producing the
 * fine granular ground prized for calligraphy panels.
 */
export function kumlu(m, rng, palette) {
  const colors = rng.shuffle(palette.colors);
  const scale = Math.min(m.w, m.h);

  scatter(m, rng, colors, { rounds: 2, coverage: 1.9, rMin: 0.05, rMax: 0.1 });

  const grains = rng.int(900, 1400);
  for (let i = 0; i < grains; i++) {
    m.drop(
      rng.float(-0.05, 1.05) * m.w,
      rng.float(-0.05, 1.05) * m.h,
      rng.float(0.0035, 0.009) * scale,
      colors[i % colors.length],
    );
  }

  combSoft(m, rng);
}

/**
 * The finish alone, for grounds we did not throw ourselves — a wallet history
 * supplies the drops, and this turns them into a named pattern.
 *
 * Kumlu deliberately omits its grains here: when hundreds of small transactions
 * lay the ground, those transactions *are* the sand.
 */
export const FINISHES = {
  battal: () => {},
  gelgit: (m, rng) => combGelgit(m, rng),
  sal: (m, rng) => {
    combGelgit(m, rng);
    combSal(m, rng);
  },
  bulbul: (m, rng) => {
    combGelgit(m, rng);
    combSal(m, rng);
    openNests(m, rng);
  },
  tarakli: (m, rng) => {
    combGelgit(m, rng);
    combFine(m, rng);
  },
  hatip: (m, rng, palette) => drawFlowers(m, rng, palette),
  kumlu: (m, rng) => combSoft(m, rng),
};

export const PATTERNS = {
  battal: { fn: battal, label: 'Battal', gloss: 'Paint dropped and left to find its own cells.' },
  gelgit: { fn: gelgit, label: 'Gelgit', gloss: 'The comb drawn back and forth across the bath.' },
  sal: { fn: sal, label: 'Şal', gloss: 'The comb rocked while drawn, folding stripes into S-curves.' },
  bulbul: { fn: bulbulYuvasi, label: 'Bülbül Yuvası', gloss: 'Şal ground opened into spiral nests with the stylus.' },
  tarakli: { fn: tarakli, label: 'Taraklı', gloss: 'A fine-toothed comb over gelgit, for book endpapers.' },
  hatip: { fn: hatip, label: 'Hatip', gloss: 'Concentric drops pulled open into a rosette.' },
  kumlu: { fn: kumlu, label: 'Kumlu', gloss: 'A fine granular ground, laid for calligraphy.' },
};

export const PATTERN_NAMES = Object.keys(PATTERNS);
