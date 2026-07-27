#!/usr/bin/env node
/**
 * ebru CLI
 *
 *   node bin/ebru.js "seed phrase"                  -> out/<seed>.svg
 *   node bin/ebru.js "seed" --pattern sal --palette firuze
 *   node bin/ebru.js --sheet out/sheet.html         -> contact sheet of all patterns
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { render, PATTERN_NAMES, PALETTE_NAMES, PATTERNS, PALETTES } from '../src/index.js';

const argv = process.argv.slice(2);

/** Split argv once into flags and bare positionals, so nothing is double-read. */
const flags = new Map();
const positionals = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags.set(a.slice(2), next);
      i++;
    } else {
      flags.set(a.slice(2), true);
    }
  } else {
    positionals.push(a);
  }
}

function flag(name, fallback) {
  return flags.has(name) ? flags.get(name) : fallback;
}

function write(path, content) {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return abs;
}

if (flag('help', false) || argv.includes('-h')) {
  console.log(`ebru — deterministic Turkish paper marbling

  ebru "<seed>" [--pattern <name>] [--palette <name>] [--size <px>]
                [--resolution <n>] [--out <file.svg>] [--no-grain]
  ebru --sheet <file.html>   render every pattern x palette pairing

  patterns: ${PATTERN_NAMES.join(', ')}
  palettes: ${PALETTE_NAMES.join(', ')}`);
  process.exit(0);
}

const sheet = flag('sheet', false);

if (sheet) {
  const size = Number(flag('size', 460));
  const cells = [];
  let totalMs = 0;

  for (const pattern of PATTERN_NAMES) {
    for (const palette of PALETTE_NAMES) {
      const seed = `${pattern}-${palette}`;
      const { svg, meta } = render(seed, {
        width: size,
        height: size,
        pattern,
        palette,
        resolution: Number(flag('resolution', 420)),
      });
      totalMs += meta.renderMs;
      cells.push(
        `<figure><div class="art">${svg}</div>` +
        `<figcaption><b>${PATTERNS[pattern].label}</b> · ${PALETTES[palette].label}` +
        `<span>${meta.drops} drops · ${(meta.bytes / 1024).toFixed(0)} KB · ${meta.renderMs} ms</span>` +
        `</figcaption></figure>`,
      );
    }
  }

  const html = `<!doctype html><meta charset="utf-8"><title>ebru — contact sheet</title>
<style>
  body{background:#14120f;color:#e8ddc8;font:14px/1.5 ui-sans-serif,system-ui,sans-serif;margin:0;padding:32px}
  h1{font-weight:600;letter-spacing:-.02em;margin:0 0 4px}
  p.sub{opacity:.55;margin:0 0 28px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(${size}px,1fr));gap:24px}
  figure{margin:0}
  .art svg{width:100%;height:auto;display:block;border-radius:3px}
  figcaption{padding-top:8px;font-size:13px}
  figcaption span{display:block;opacity:.45;font-size:11px;font-variant-numeric:tabular-nums}
</style>
<h1>ebru</h1>
<p class="sub">${cells.length} sheets · ${PATTERN_NAMES.length} patterns × ${PALETTE_NAMES.length} palettes · ${totalMs.toFixed(0)} ms total</p>
<div class="grid">${cells.join('')}</div>`;

  const abs = write(typeof sheet === 'string' ? sheet : 'out/sheet.html', html);
  console.log(`${cells.length} sheets → ${abs}  (${totalMs.toFixed(0)} ms total, ${(totalMs / cells.length).toFixed(1)} ms avg)`);
  process.exit(0);
}

const seed = positionals[0] ?? 'ebru';
const size = Number(flag('size', 1000));

const { svg, meta } = render(seed, {
  width: size,
  height: size,
  pattern: flag('pattern', undefined),
  palette: flag('palette', undefined),
  resolution: Number(flag('resolution', 420)),
  grain: !flags.has('no-grain'),
});

const out = write(flag('out', `out/${String(seed).replace(/[^\w.-]+/g, '_').slice(0, 60)}.svg`), svg);
console.log(JSON.stringify(meta, null, 2));
console.log(`\n→ ${out}`);
