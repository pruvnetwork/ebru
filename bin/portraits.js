#!/usr/bin/env node
/**
 * Synthetic wallets, one per behaviour the reader is supposed to distinguish.
 *
 * These are fixtures, not real chain data — they exist to check that the
 * gesture actually follows the behaviour instead of a dice roll, and that five
 * different histories produce five visibly different sheets. Everything is
 * generated from a seeded RNG so the fixtures themselves are reproducible.
 *
 *   node bin/portraits.js
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { Rng, renderReading } from '../src/index.js';
import { toPng } from '../src/raster.js';

const DAY = 86400;
const T0 = 1735689600; // 2025-01-01T00:00:00Z, fixed so fixtures never drift

/** @returns {import('../src/reading.js').Reading} */
function wallet(name, address, build) {
  const rng = new Rng(`fixture:${name}`);
  const events = [];
  build(rng, (ts, value, token, counterparty) => {
    events.push({
      hash: `0x${new Rng(`${name}:${events.length}`).hash}`,
      ts: Math.round(ts),
      value,
      token,
      counterparty,
    });
  });
  return { address, chain: 'xlayer', block: 12_345_678, events };
}

const TOKENS = ['OKB', 'USDT', 'xETH', 'xBTC'];

const WALLETS = [
  // Eight large moves over a year, nothing else.
  wallet('whale', '0xW4A1E0000000000000000000000000000000fade', (rng, add) => {
    for (let i = 0; i < 8; i++) {
      add(T0 + i * 44 * DAY + rng.float(0, 3 * DAY), rng.float(40_000, 900_000), rng.pick(TOKENS), `0xdesk${i}`);
    }
  }),

  // A market maker: metronomic, hundreds of similar-sized fills.
  wallet('bot', '0xB07B07000000000000000000000000000000beef', (rng, add) => {
    for (let i = 0; i < 260; i++) {
      add(T0 + i * 1.2 * DAY + rng.float(-1800, 1800), rng.float(900, 1400), rng.pick(TOKENS.slice(0, 2)), `0xpool${rng.int(0, 2)}`);
    }
  }),

  // Quiet for weeks, then forty trades in three days, repeatedly.
  wallet('degen', '0xDE6E0000000000000000000000000000000cafe0', (rng, add) => {
    let t = T0;
    for (let burst = 0; burst < 6; burst++) {
      t += rng.float(24, 46) * DAY;
      const n = rng.int(28, 46);
      for (let i = 0; i < n; i++) {
        add(t + rng.float(0, 3 * DAY), rng.float(80, 9_000), rng.pick(TOKENS), `0xdex${rng.int(0, 5)}`);
      }
    }
  }),

  // Almost everything routed through a single protocol, at human intervals.
  wallet('loyal', '0x10YA100000000000000000000000000000000abc', (rng, add) => {
    let t = T0;
    for (let i = 0; i < 90; i++) {
      t += rng.float(0.5, 9) * DAY;
      const solo = rng.bool(0.84);
      add(t, rng.float(200, 6_000), solo ? 'USDT' : rng.pick(TOKENS), solo ? '0xlend' : `0xother${rng.int(0, 3)}`);
    }
  }),

  // Airdrop farming: hundreds of dust transfers and one real position.
  wallet('dust', '0xD05700000000000000000000000000000000dead', (rng, add) => {
    for (let i = 0; i < 300; i++) {
      add(T0 + i * 0.9 * DAY + rng.float(0, DAY), rng.float(0.2, 6), rng.pick(TOKENS), `0xfarm${rng.int(0, 9)}`);
    }
    add(T0 + 150 * DAY, 120_000, 'xETH', '0xtreasury');
  }),
];

mkdirSync('out/portraits', { recursive: true });

console.log('behaviour → gesture\n');
for (const w of WALLETS) {
  const { svg, legend, meta } = renderReading(w, { width: 900, height: 900, grain: false });
  const name = w.address.slice(2, 8).toLowerCase();
  writeFileSync(`out/portraits/${name}.png`, toPng(svg, { width: 620 }));

  const first = legend[0];
  const biggest = legend.reduce((a, b) => (b.value > a.value ? b : a));

  console.log(
    `${meta.address.slice(0, 10)}…  ${String(meta.events).padStart(4)} tx  ` +
    `burst ${String(meta.burstiness).padStart(5)}  conc ${String(meta.concentration).padStart(4)}  ` +
    `→ ${meta.patternLabel.padEnd(14)} ${meta.renderMs}ms`,
  );
  console.log(`    ${meta.reason}`);
  console.log(
    `    key: ${meta.key.map((k) => `${k.token}=${k.color}`).join('  ')}\n` +
    `    first tx still holds ${(first.share * 100).toFixed(2)}% of the sheet; ` +
    `largest (${Math.round(biggest.value).toLocaleString('en-US')} ${biggest.token}) at ${biggest.x},${biggest.y}\n`,
  );
}
console.log('→ out/portraits/');
