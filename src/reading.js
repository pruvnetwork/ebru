/**
 * A wallet, read as a bath.
 *
 * The mapping here is structural rather than decorative. Ebru records gestures
 * in the order they were made: the first paint thrown ends up squeezed into
 * thin veins by everything that follows, and the last thing thrown sits on top,
 * whole and obvious. An address's history has exactly that shape. So each
 * transaction becomes a drop, oldest first, and the picture that falls out is a
 * reading of the account rather than a decoration hung next to it.
 *
 *   drop order   <- transaction order (oldest = deepest)
 *   drop size    <- value moved, log scaled
 *   drop colour  <- token or counterparty
 *   comb pass    <- a dormant stretch; the bath settles and is drawn through
 *   vortex       <- a burst of activity
 *   pattern      <- the shape of the behaviour, not a dice roll
 *
 * Nothing in this file touches the network. It consumes a `Reading`, which some
 * other layer is responsible for fetching and pinning to a block height — that
 * pinning is what keeps a given address reproducible forever.
 *
 * @typedef {object} Event
 * @property {string} hash
 * @property {number} ts          unix seconds
 * @property {number} value       in whatever unit the caller normalised to
 * @property {string} [token]     symbol; groups events onto a pigment
 * @property {string} [counterparty]
 *
 * @typedef {object} Reading
 * @property {string} address
 * @property {string} [chain]
 * @property {number} [block]     the height this reading was taken at
 * @property {Event[]} events     oldest first
 */

import { Rng } from './rng.js';
import { layGround } from './patterns.js';

/** Coefficient of variation — the standard "how uneven is this" measure. */
function dispersion(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (mean === 0) return 0;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function median(values) {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Reduce a history to the handful of numbers that decide how it should be
 * painted.
 * @param {Reading} reading
 */
export function analyse(reading) {
  const events = (reading.events ?? []).slice().sort((a, b) => a.ts - b.ts);
  const n = events.length;

  const gaps = [];
  for (let i = 1; i < n; i++) gaps.push(Math.max(1, events[i].ts - events[i - 1].ts));

  const values = events.map((e) => Math.max(0, e.value ?? 0));

  // How concentrated is the activity on one counterparty? A wallet that talks
  // almost entirely to one contract wants a flower with a clear centre.
  const byParty = new Map();
  for (const e of events) {
    const k = e.counterparty ?? e.token ?? 'unknown';
    byParty.set(k, (byParty.get(k) ?? 0) + 1);
  }
  const topParty = [...byParty.entries()].sort((a, b) => b[1] - a[1])[0];
  const concentration = n ? (topParty?.[1] ?? 0) / n : 0;

  // Distinct tokens, most-used first — these become the pigments, so the order
  // matters: the dominant token gets the ground colour.
  const byToken = new Map();
  for (const e of events) {
    const k = e.token ?? 'native';
    byToken.set(k, (byToken.get(k) ?? 0) + 1);
  }
  const tokens = [...byToken.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);

  const span = n > 1 ? events[n - 1].ts - events[0].ts : 0;

  return {
    events,
    n,
    span,
    tokens,
    concentration,
    topParty: topParty?.[0] ?? null,
    burstiness: dispersion(gaps),
    medianValue: median(values),
    maxValue: values.length ? Math.max(...values) : 0,
    /** Longest dormant stretch as a fraction of the whole history. */
    longestGap: gaps.length && span ? Math.max(...gaps) / span : 0,
  };
}

/**
 * Pick the gesture that honestly describes this behaviour, and say why.
 * The reason is part of the product: an unexplained picture is decoration.
 */
export function chooseGesture(stats) {
  const { n, burstiness, concentration, longestGap } = stats;

  if (n === 0) {
    return { pattern: 'battal', reason: 'An untouched account — paint thrown on a still bath.' };
  }
  if (n < 10) {
    return { pattern: 'battal', reason: `Only ${n} movements: the paint is left to find its own cells.` };
  }
  // Ordered by how distinctive the signal is, not by convenience. Several of
  // these can be true at once — a market maker is both concentrated on one pool
  // and metronomic — and the portrait should show whichever fact is the more
  // striking one to a person looking at the account.
  if (n > 180 && stats.medianValue > 0 && stats.maxValue / stats.medianValue > 40) {
    return { pattern: 'kumlu', reason: `${n} movements, nearly all of them dust — a sanded ground.` };
  }
  if (burstiness > 1.6) {
    return { pattern: 'bulbul', reason: 'Activity arrives in bursts; the bath is turned into nests.' };
  }
  // A near-perfect metronome is a machine, and that outranks whatever it is
  // trading against.
  if (burstiness < 0.25) {
    return { pattern: 'tarakli', reason: 'Machine rhythm — the fine comb drawn straight through.' };
  }
  if (concentration > 0.6) {
    return {
      pattern: 'hatip',
      reason: `${Math.round(concentration * 100)}% of activity runs through one counterparty — a flower with a clear centre.`,
    };
  }
  if (burstiness < 0.7) {
    return { pattern: 'tarakli', reason: 'A steady rhythm — the fine comb drawn straight through.' };
  }
  if (longestGap > 0.4) {
    return { pattern: 'gelgit', reason: 'One long dormancy splits the history; the comb is drawn across it.' };
  }
  return { pattern: 'sal', reason: 'Varied but continuous activity, folded into a shawl.' };
}

/** Polygon centroid and area, so each drop can be pointed at afterwards. */
function centroid(xs, ys) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < xs.length; i++) {
    const j = i + 1 === xs.length ? 0 : i + 1;
    const cross = xs[i] * ys[j] - xs[j] * ys[i];
    a += cross;
    cx += (xs[i] + xs[j]) * cross;
    cy += (ys[i] + ys[j]) * cross;
  }
  a *= 0.5;
  if (Math.abs(a) < 1e-9) return { x: xs[0], y: ys[0], area: 0 };
  return { x: cx / (6 * a), y: cy / (6 * a), area: Math.abs(a) };
}

/**
 * Lay the history onto the bath.
 *
 * @param {import('./marble.js').Marble} marble
 * @param {Reading} reading
 * @param {object} stats      from analyse()
 * @param {object} palette
 * @returns {object[]} one legend entry per transaction, in transaction order
 */
export function paint(marble, reading, stats, palette) {
  const rng = new Rng(`${reading.address}@${reading.block ?? 'tip'}`);
  const scale = Math.min(marble.w, marble.h);
  const { events, tokens } = stats;

  // The palette is split in two. The quieter tail of it becomes the bath the
  // account is read onto; the saturated head is reserved for the tokens, so a
  // transaction always reads as a mark *on* the sheet rather than part of it.
  const signal = palette.colors.slice(0, 3);
  const ground = palette.colors.slice(3);

  // Always lay a ground. A sparse account on a bare bath looks like a failed
  // render rather than a quiet history — and the ground is what the drops push
  // aside, which is where the cell structure comes from at all.
  // Less of it when there are many transactions, since those cover the sheet
  // themselves.
  const groundCoverage = Math.max(0.8, Math.min(2.2, 2.2 - events.length * 0.006));
  layGround(marble, rng, ground.length ? ground : palette.colors, {
    rounds: ground.length || 2,
    coverage: groundCoverage,
    rMin: 0.03,
    rMax: 0.07,
    taper: 0.74,
  });
  const groundDrops = marble.drops.length;

  // Pigment per token, most-used token first.
  const pigment = new Map();
  tokens.forEach((t, i) => pigment.set(t, signal[i % signal.length]));

  // Value -> radius. Log scaled, because balances span many orders of magnitude
  // and a linear map would make one whale transfer swallow the sheet.
  const values = events.map((e) => (Number.isFinite(e.value) && e.value > 0 ? e.value : 0));
  const maxV = Math.max(...values, 1);
  const radiusFor = (v) => {
    // Clamp before the log. A negative amount — a badly normalised outgoing
    // transfer, say — would otherwise make log1p return NaN, and a NaN radius
    // takes the whole bath down with it.
    const safe = Number.isFinite(v) && v > 0 ? v : 0;
    const t = Math.log1p(safe) / Math.log1p(maxV);
    return (0.022 + 0.055 * t) * scale;
  };

  const legend = [];
  const gapThreshold = stats.span ? stats.span / Math.max(6, events.length / 4) : Infinity;

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
      const color = pigment.get(e.token ?? 'native') ?? signal[0];

    // Position is drawn from the transaction hash, so the same transaction
    // always lands in the same place regardless of what surrounds it.
    const spot = new Rng(e.hash ?? `${reading.address}:${i}`);
    const x = spot.float(-0.04, 1.04) * marble.w;
    const y = spot.float(-0.04, 1.04) * marble.h;
    const r = radiusFor(e.value ?? 0);

    marble.drop(x, y, r, color);
    legend.push({
      index: i,
      hash: e.hash,
      ts: e.ts,
      token: e.token ?? 'native',
      value: e.value ?? 0,
      counterparty: e.counterparty ?? null,
      color,
      dropId: marble.drops[marble.drops.length - 1].id,
    });

    // A dormant stretch: the bath is left to settle, then drawn through.
    const gap = i > 0 ? e.ts - events[i - 1].ts : 0;
    if (gap > gapThreshold) {
      const angle = spot.float(0, Math.PI * 2);
      marble.comb({
        x: marble.w / 2,
        y: marble.h / 2,
        ux: Math.cos(angle),
        uy: Math.sin(angle),
        count: spot.int(6, 12),
        spacing: scale * spot.float(0.06, 0.11),
        mag: scale * spot.float(0.04, 0.09),
        alpha: spot.float(0.22, 0.34),
        lambda: scale * spot.float(0.022, 0.04),
      });
    }
  }

  // Bursts become nests. Found by scanning for windows far denser than average.
  if (stats.burstiness > 1.2 && events.length > 20) {
    const windows = [];
    const w = Math.max(4, Math.round(events.length / 12));
    for (let i = 0; i + w < events.length; i += w) {
      const dt = events[i + w].ts - events[i].ts;
      windows.push({ i, rate: dt > 0 ? w / dt : Infinity });
    }
    windows.sort((a, b) => b.rate - a.rate);
    for (const win of windows.slice(0, rng.int(2, 4))) {
      const anchor = legend[win.i];
      const spot = new Rng(anchor.hash ?? `burst:${win.i}`);
      marble.vortex({
        x: spot.float(0.15, 0.85) * marble.w,
        y: spot.float(0.15, 0.85) * marble.h,
        strength: spot.float(2.4, 4.6) * (spot.bool() ? 1 : -1),
        falloff: scale * spot.float(0.1, 0.18),
      });
    }
  }

  return legend;
}

/**
 * Attach final positions to the legend, so a caller can annotate the image or
 * answer "which part of this is my first transaction".
 */
export function locate(marble, legend) {
  // By id, not by position: culling has already reshuffled the array.
  const byId = new Map(marble.drops.map((d) => [d.id, d]));
  return legend.map((entry) => {
    const drop = byId.get(entry.dropId);
    // A drop with no surviving points was pushed clean off the sheet — the
    // transaction is real but nothing of it is left to point at.
    if (!drop) return { ...entry, visible: false, x: null, y: null, share: 0 };
    const c = centroid(drop.xs, drop.ys);
    return {
      ...entry,
      visible: true,
      x: Math.round(c.x * 10) / 10,
      y: Math.round(c.y * 10) / 10,
      /** Share of the sheet this transaction still occupies, 0-1. */
      share: Math.round((c.area / (marble.w * marble.h)) * 10000) / 10000,
    };
  });
}
