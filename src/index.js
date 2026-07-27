/**
 * ebru — deterministic Turkish paper marbling.
 *
 *   render('any string')  ->  { svg, meta }
 *
 * The seed fixes everything: pattern, palette, every drop and every comb
 * stroke. Same seed, same artwork, on any machine, forever.
 */

import { Rng } from './rng.js';
import { Marble } from './marble.js';
import { PALETTES, PALETTE_NAMES, getPalette } from './palettes.js';
import { PATTERNS, PATTERN_NAMES, FINISHES } from './patterns.js';
import { toSvg } from './svg.js';
import { analyse, chooseGesture, paint, locate } from './reading.js';

export { Rng, Marble, PALETTES, PALETTE_NAMES, PATTERNS, PATTERN_NAMES, toSvg };
export { analyse, chooseGesture } from './reading.js';

/**
 * @param {string} seed
 * @param {object} [opts]
 * @param {number} [opts.width]
 * @param {number} [opts.height]
 * @param {string} [opts.pattern]    force a pattern; otherwise chosen from seed
 * @param {string} [opts.palette]    force a palette; otherwise chosen from seed
 * @param {number} [opts.resolution] points per drop — quality/size dial
 * @param {boolean} [opts.grain]
 * @returns {{ svg: string, meta: object }}
 */
export function render(seed, opts = {}) {
  const {
    width = 1000,
    height = 1000,
    resolution = 512,
    grain = true,
  } = opts;

  const rng = new Rng(seed);

  // Draw the choices before the pattern runs so that forcing one of them does
  // not shift the rest of the sequence.
  const pickedPattern = rng.pick(PATTERN_NAMES);
  const pickedPalette = rng.pick(PALETTE_NAMES);

  const patternName = opts.pattern ?? pickedPattern;
  const paletteName = opts.palette ?? pickedPalette;

  const pattern = PATTERNS[patternName];
  if (!pattern) {
    throw new Error(`Unknown pattern "${patternName}". Available: ${PATTERN_NAMES.join(', ')}`);
  }
  const palette = getPalette(paletteName);

  const marble = new Marble({ width, height, resolution, maxEdge: opts.maxEdge });
  // Watching the bath is opt-in and read-only: with no hook this is the same
  // render it always was, and with one the artwork is unchanged — only now
  // somebody saw it being made. The palette is handed over too, so a frame can
  // be written on the same paper the finished sheet uses.
  if (opts.onFrame) {
    marble.onFrame = (m) => opts.onFrame(m, { palette, pattern, patternName, paletteName });
  }

  const started = process.hrtime.bigint();
  pattern.fn(marble, rng, palette);
  marble.settle();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  const title = `${pattern.label} · ${palette.label}`;
  const description = `${pattern.gloss} Seed: ${seed}`;

  const svg = toSvg(marble, {
    paper: palette.paper,
    tolerance: Math.min(width, height) / 9000,
    grain,
    title,
    description,
  });

  return {
    svg,
    meta: {
      mode: 'seed',
      seed: String(seed),
      hash: rng.hash,
      pattern: patternName,
      patternLabel: pattern.label,
      palette: paletteName,
      paletteLabel: palette.label,
      paper: palette.paper,
      colors: palette.colors,
      width,
      height,
      drops: marble.drops.length,
      points: marble.pointCount,
      bytes: svg.length,
      renderMs: Math.round(elapsedMs * 100) / 100,
    },
  };
}

/**
 * Render a wallet rather than a string.
 *
 * The drops are the transactions, in the order they happened; the finish is
 * chosen from the shape of the behaviour rather than from a dice roll. What
 * comes back carries a legend, because the point of this mode is that the
 * picture can be read: every drop can be pointed at and named.
 *
 * The reading must be pinned to a block. An unpinned reading would mean the
 * same address produced a different artwork tomorrow, which would break the one
 * promise the engine makes.
 *
 * @param {import('./reading.js').Reading} reading
 * @param {object} [opts] same shape as render(), plus optional pattern/palette override
 */
export function renderReading(reading, opts = {}) {
  const {
    width = 1000,
    height = 1000,
    resolution = 512,
    grain = true,
  } = opts;

  if (!reading || typeof reading.address !== 'string') {
    throw new Error('renderReading needs a reading with an address');
  }

  const stamp = `${reading.address}@${reading.block ?? 'tip'}`;
  const rng = new Rng(stamp);

  const stats = analyse(reading);
  const gesture = chooseGesture(stats);

  const patternName = opts.pattern ?? gesture.pattern;
  const paletteName = opts.palette ?? rng.pick(PALETTE_NAMES);
  const pattern = PATTERNS[patternName];
  if (!pattern) {
    throw new Error(`Unknown pattern "${patternName}". Available: ${PATTERN_NAMES.join(', ')}`);
  }
  const palette = getPalette(paletteName);

  const marble = new Marble({ width, height, resolution, maxEdge: opts.maxEdge });

  const started = process.hrtime.bigint();
  const laid = paint(marble, reading, stats, palette);
  // A separate stream, so adding a transaction changes the drops without also
  // rerolling every comb stroke.
  FINISHES[patternName](marble, new Rng(`${stamp}#finish`), palette);
  marble.settle();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  const legend = locate(marble, laid);

  // Which pigment ended up standing for which token — the first thing anyone
  // wants to know when they look at their own sheet.
  const key = [];
  const seen = new Set();
  for (const entry of legend) {
    if (seen.has(entry.token)) continue;
    seen.add(entry.token);
    key.push({ token: entry.token, color: entry.color });
  }

  const short = `${reading.address.slice(0, 6)}…${reading.address.slice(-4)}`;
  const title = `${short} · ${pattern.label}`;
  const description = `${gesture.reason} ${stats.n} movements read at block ${reading.block ?? 'tip'}.`;

  const svg = toSvg(marble, {
    paper: palette.paper,
    tolerance: Math.min(width, height) / 9000,
    grain,
    title,
    description,
  });

  return {
    svg,
    legend,
    meta: {
      mode: 'reading',
      address: reading.address,
      chain: reading.chain ?? null,
      block: reading.block ?? null,
      hash: rng.hash,
      pattern: patternName,
      patternLabel: pattern.label,
      reason: gesture.reason,
      palette: paletteName,
      paletteLabel: palette.label,
      paper: palette.paper,
      key,
      events: stats.n,
      spanDays: stats.span ? Math.round(stats.span / 86400) : 0,
      burstiness: Math.round(stats.burstiness * 100) / 100,
      concentration: Math.round(stats.concentration * 100) / 100,
      width,
      height,
      drops: marble.drops.length,
      points: marble.pointCount,
      bytes: svg.length,
      renderMs: Math.round(elapsedMs * 100) / 100,
    },
  };
}
