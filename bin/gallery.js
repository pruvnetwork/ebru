#!/usr/bin/env node
/**
 * Builds the gallery page: renders every pattern and every palette, embeds them
 * as data URIs, and writes a self-contained HTML file.
 *
 *   node bin/gallery.js out/gallery.html
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { render, PATTERN_NAMES, PALETTE_NAMES, PATTERNS, PALETTES } from '../src/index.js';
import { toPng } from '../src/raster.js';

const OUT = process.argv[2] ?? 'out/gallery.html';
const PLATE_PX = 520;
const SWATCH_PX = 200;

/** What each pattern is laid over — the patterns genuinely build on each other. */
const BUILDS_ON = {
  gelgit: 'battal',
  sal: 'gelgit',
  bulbul: 'sal',
  tarakli: 'gelgit',
};

const dataUri = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

console.log('rendering plates…');
const plates = PATTERN_NAMES.map((name) => {
  const { svg, meta } = render(`ebru-${name}`, {
    width: 1000,
    height: 1000,
    pattern: name,
    grain: false,
  });
  const png = toPng(svg, { width: PLATE_PX });
  console.log(`  ${name.padEnd(9)} ${String(meta.renderMs).padStart(8)}ms  ${(png.length / 1024).toFixed(0)}KB`);
  return { name, meta, uri: dataUri(png), ...PATTERNS[name] };
});

console.log('rendering palette swatches…');
const swatches = PALETTE_NAMES.map((name) => {
  const { svg } = render(`palette-${name}`, {
    width: 700,
    height: 700,
    pattern: 'sal',
    palette: name,
    grain: false,
  });
  return { name, uri: dataUri(toPng(svg, { width: SWATCH_PX })), ...PALETTES[name] };
});

const totalMs = plates.reduce((a, p) => a + p.meta.renderMs, 0);

const plateHtml = plates
  .map(
    (p) => `
      <article class="plate">
        <div class="label">
          <h2>${esc(p.label)}</h2>
          <p class="gloss">${esc(p.gloss)}</p>
          ${BUILDS_ON[p.name] ? `<p class="over">laid over <span>${esc(PATTERNS[BUILDS_ON[p.name]].label)}</span></p>` : ''}
          <dl>
            <dt>seed</dt><dd>ebru-${esc(p.name)}</dd>
            <dt>palette</dt><dd>${esc(p.meta.paletteLabel)}</dd>
            <dt>drops</dt><dd>${p.meta.drops.toLocaleString('en-US')}</dd>
            <dt>points</dt><dd>${p.meta.points.toLocaleString('en-US')}</dd>
            <dt>render</dt><dd>${p.meta.renderMs} ms</dd>
          </dl>
        </div>
        <figure>
          <img src="${p.uri}" width="${PLATE_PX}" height="${PLATE_PX}" alt="${esc(p.label)} pattern, ${esc(p.meta.paletteLabel)} palette" loading="lazy">
        </figure>
      </article>`,
  )
  .join('');

const swatchHtml = swatches
  .map(
    (s) => `
        <figure class="swatch">
          <img src="${s.uri}" width="${SWATCH_PX}" height="${SWATCH_PX}" alt="${esc(s.label)} palette" loading="lazy">
          <figcaption>
            <span class="nm">${esc(s.label)}</span>
            <span class="chips">${s.colors.map((c) => `<i style="background:${esc(c)}"></i>`).join('')}</span>
          </figcaption>
        </figure>`,
  )
  .join('');

const html = `<title>ebru — deterministic Turkish marbling</title>
<style>
  :root{
    --ink:#14110C; --wall:#1E1A14; --line:#2E2820;
    --chalk:#E8E0CF; --dim:#9A907C;
    --gold:#C9A227; --indigo:#7C9BC9;
    --serif:'Iowan Old Style','Palatino Linotype',Palatino,'Book Antiqua',Georgia,serif;
    --sans:system-ui,-apple-system,'Segoe UI',sans-serif;
    --mono:ui-monospace,'SF Mono',SFMono-Regular,Menlo,monospace;
  }
  @media (prefers-color-scheme:light){
    :root{ --ink:#EFE9DB; --wall:#E5DECC; --line:#D2C8AF; --chalk:#1A1712; --dim:#6B6252; --gold:#8A6D12; --indigo:#2F4E7C; }
  }
  :root[data-theme="dark"]{ --ink:#14110C; --wall:#1E1A14; --line:#2E2820; --chalk:#E8E0CF; --dim:#9A907C; --gold:#C9A227; --indigo:#7C9BC9; }
  :root[data-theme="light"]{ --ink:#EFE9DB; --wall:#E5DECC; --line:#D2C8AF; --chalk:#1A1712; --dim:#6B6252; --gold:#8A6D12; --indigo:#2F4E7C; }

  body{background:var(--ink);color:var(--chalk);font-family:var(--sans);line-height:1.6;margin:0}
  .wrap{max-width:1180px;margin:0 auto;padding:clamp(28px,6vw,88px) clamp(20px,5vw,56px) 120px}
  img{max-width:100%;height:auto;display:block}

  header{border-bottom:1px solid var(--line);padding-bottom:clamp(32px,5vw,56px)}
  h1{font-family:var(--serif);font-weight:400;font-size:clamp(52px,11vw,116px);line-height:.9;letter-spacing:-.02em;margin:0}
  .thesis{font-family:var(--serif);font-size:clamp(19px,2.3vw,27px);line-height:1.45;max-width:30ch;color:var(--chalk);margin:24px 0 0;text-wrap:balance}
  .thesis em{color:var(--gold);font-style:normal}

  .maths{display:flex;flex-wrap:wrap;gap:14px 44px;margin-top:40px;font-family:var(--mono);font-size:13px;color:var(--dim)}
  .maths div{display:flex;gap:14px;align-items:baseline}
  .maths b{color:var(--gold);font-weight:400;font-family:var(--sans);font-size:11px;letter-spacing:.13em;text-transform:uppercase;min-width:52px}
  .maths code{color:var(--chalk);white-space:nowrap}
  .scroller{overflow-x:auto}

  .note{color:var(--dim);font-size:14px;max-width:62ch;margin:36px 0 0}
  .note b{color:var(--chalk);font-weight:600}

  .plates{display:flex;flex-direction:column;gap:clamp(56px,8vw,104px);margin-top:clamp(56px,8vw,104px)}
  .plate{display:grid;grid-template-columns:minmax(190px,1fr) minmax(0,2.1fr);gap:clamp(24px,4vw,52px);align-items:start}
  .label h2{font-family:var(--serif);font-weight:400;font-size:clamp(28px,3.4vw,40px);line-height:1.05;margin:0 0 12px;text-wrap:balance}
  .gloss{margin:0;color:var(--chalk);font-size:15px;max-width:34ch}
  .over{margin:12px 0 0;font-size:12px;letter-spacing:.1em;text-transform:uppercase;color:var(--dim)}
  .over span{color:var(--indigo)}
  dl{display:grid;grid-template-columns:auto 1fr;gap:5px 18px;margin:26px 0 0;font-family:var(--mono);font-size:12px;font-variant-numeric:tabular-nums}
  dt{color:var(--dim)}
  dd{margin:0;color:var(--chalk)}
  figure{margin:0}
  .plate img{width:100%;border-radius:2px;box-shadow:0 2px 40px rgba(0,0,0,.35)}

  h3{font-family:var(--serif);font-weight:400;font-size:clamp(26px,3vw,34px);margin:0 0 6px}
  .section{margin-top:clamp(72px,10vw,132px);border-top:1px solid var(--line);padding-top:clamp(32px,5vw,52px)}
  .sub{color:var(--dim);font-size:15px;max-width:56ch;margin:0 0 34px}
  .swatches{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:26px}
  .swatch img{width:100%;border-radius:2px}
  .swatch figcaption{display:flex;flex-direction:column;gap:8px;padding-top:10px}
  .nm{font-family:var(--serif);font-size:17px}
  .chips{display:flex;gap:3px}
  .chips i{width:16px;height:16px;border-radius:1px;display:block}

  @media (max-width:720px){
    .plate{grid-template-columns:1fr}
  }
  @media (prefers-reduced-motion:reduce){ *{animation:none!important;transition:none!important} }
</style>

<div class="wrap">
  <header>
    <h1>ebru</h1>
    <p class="thesis">A seed goes in, a marbled sheet comes out. No model weights, no sampler, no temperature — <em>the seed is a contract</em>.</p>

    <div class="maths scroller">
      <div><b>drop</b><code>p′ = C + (p − C)·√(1 + r² / |p − C|²)</code></div>
      <div><b>tine</b><code>p′ = p + u·M·α^(d / λ)</code></div>
    </div>

    <p class="note">Both maps preserve area, so a drop stays a single closed curve however many times it is deformed — which is why the output is real vector geometry rather than pixels. Every sheet below is the same seven gestures a marbler performs at the bath, in order. <b>${plates.length} plates rendered in ${(totalMs / 1000).toFixed(1)} s on one core</b>, no GPU.</p>
  </header>

  <main class="plates">${plateHtml}
  </main>

  <section class="section">
    <h3>Pigments</h3>
    <p class="sub">Ground from the colours actually used at the bath — earth and mineral, not screen primaries. The paper is never pure white. One şal, eight palettes.</p>
    <div class="swatches">${swatchHtml}
    </div>
  </section>
</div>`;

const abs = resolve(OUT);
mkdirSync(dirname(abs), { recursive: true });
writeFileSync(abs, html);
console.log(`\n→ ${abs}  (${(html.length / 1024 / 1024).toFixed(2)} MB)`);
