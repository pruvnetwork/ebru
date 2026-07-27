#!/usr/bin/env node
/**
 * The bath, filmed.
 *
 *   node bin/frames.js "OKX.AI" --pattern bulbul --out out/film
 *
 * Every other renderer in this category produces a picture in one move, so
 * there is nothing between a prompt and a result to look at. Here the sheet is
 * built by a sequence of gestures — paint lands, spreads what is already there,
 * the comb drags it — and each of those intermediate states is a real thing the
 * engine passes through. This writes them out as frames and hands them to
 * ffmpeg.
 *
 * The final frame is byte-identical to what `render()` returns for the same
 * seed: the frame hook only reads the bath. That matters — a demo that showed a
 * prettier build-up than the artwork it claims to explain would be a lie told
 * with real data.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { Marble } from '../src/marble.js';
import { render, PATTERN_NAMES, PALETTE_NAMES } from '../src/index.js';
import { toPng } from '../src/raster.js';

const argv = process.argv.slice(2);
const seed = argv.find((a) => !a.startsWith('--')) ?? 'OKX.AI';
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : argv[i + 1];
};

const pattern = flag('pattern');
const palette = flag('palette');
const outDir = flag('out', 'out/film');
const size = Number(flag('size', 720));
const fps = Number(flag('fps', 30));
// How many gestures a clip should last. Sampling is what turns ~1,200 gestures
// into a watchable length; taking every one would run 40 seconds on its own.
const seconds = Number(flag('seconds', 12));
// The final sheet is the payload, not the process — hold on it.
const holdSeconds = Number(flag('hold', 2));

if (pattern && !PATTERN_NAMES.includes(pattern)) {
  console.error(`Unknown pattern "${pattern}". One of: ${PATTERN_NAMES.join(' ')}`);
  process.exit(1);
}
if (palette && !PALETTE_NAMES.includes(palette)) {
  console.error(`Unknown palette "${palette}". One of: ${PALETTE_NAMES.join(' ')}`);
  process.exit(1);
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// Pass 1 — how many gestures is this seed going to make?
//
// The count is not knowable ahead of time (it falls out of the seed), and the
// sampling interval depends on it, so the bath is built once to count and once
// to film. Building it twice is cheap next to rasterising, and the second run
// is identical to the first because the RNG is seeded.
let total = 0;
{
  const step = Marble.prototype._step;
  Marble.prototype._step = function counted() { total++; return step.call(this); };
  try {
    render(seed, { width: 1000, height: 1000, pattern, palette });
  } finally {
    Marble.prototype._step = step;
  }
}

const wanted = Math.max(1, Math.round(fps * seconds));
const every = Math.max(1, Math.floor(total / wanted));
console.log(`${total} gestures → filming every ${every}, ~${Math.round(total / every / fps)}s at ${fps}fps`);

// Pass 2 — film it.
//
// `toSvg` is imported through the same path the artwork uses rather than
// reimplemented here, so a frame is the sheet as it would have been delivered
// had the marbler stopped at that gesture.
const { toSvg } = await import('../src/svg.js');

let seen = 0;
let written = 0;
const started = Date.now();

const hook = (m, { palette: pal, pattern: pat }) => {
  seen++;
  if (seen % every !== 0) return;
  const svg = toSvg(m, {
    paper: pal.paper,
    tolerance: 1000 / 9000,
    grain: true,
    title: `${pat.label} · ${pal.label}`,
    description: `Frame ${written} of ${seed}`,
  });
  writeFileSync(join(outDir, `f${String(written).padStart(5, '0')}.png`), toPng(svg, { width: size }));
  written++;
  if (written % 30 === 0) process.stdout.write(`  ${written} frames\r`);
};

// The palette and title come from the finished render so the frames carry the
// same paper and label the artwork does.
const finished = render(seed, { width: 1000, height: 1000, pattern, palette, onFrame: hook });

writeFileSync(join(outDir, 'final.svg'), finished.svg);
writeFileSync(join(outDir, 'final.png'), toPng(finished.svg, { width: size }));

// Hold the finished sheet by repeating its frame — simpler and more exact than
// asking ffmpeg to ease out of a sequence.
for (let i = 0; i < Math.round(fps * holdSeconds); i++) {
  writeFileSync(join(outDir, `f${String(written++).padStart(5, '0')}.png`), toPng(finished.svg, { width: size }));
}

console.log(`\n${written} frames in ${((Date.now() - started) / 1000).toFixed(1)}s → ${outDir}`);

// ffmpeg is optional: the frames are the deliverable, the mp4 is a convenience.
const mp4 = join(outDir, 'bath.mp4');
try {
  execFileSync('ffmpeg', [
    '-y', '-framerate', String(fps),
    '-i', join(outDir, 'f%05d.png'),
    // yuv420p and even dimensions, or half the world's players refuse it.
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '17',
    mp4,
  ], { stdio: 'pipe' });
  console.log(`${mp4}`);
} catch (err) {
  console.log(`frames written; ffmpeg failed (${err.message.split('\n')[0]}) — encode them yourself`);
}
