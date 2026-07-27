#!/usr/bin/env node
/**
 * The marketplace avatar.
 *
 * A full sheet turns to mush at listing-icon size, so this composes a single
 * large hatip rosette dead centre instead — the one ebru form with a silhouette
 * strong enough to survive being shrunk to a hundred pixels. It is still made
 * only of drops and stylus strokes; nothing is drawn directly.
 *
 *   node bin/avatar.js
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { Marble, Rng, PALETTES, toSvg } from '../src/index.js';
import { toPng } from '../src/raster.js';

const SIZE = 1024;
/** Sizes the listing actually renders at, used to sanity-check legibility. */
const PREVIEWS = [512, 128, 64];

function avatar(paletteName, seed) {
  const palette = PALETTES[paletteName];
  const rng = new Rng(seed);
  const m = new Marble({ width: SIZE, height: SIZE });
  const scale = SIZE;
  const cx = SIZE / 2;
  const cy = SIZE / 2;

  // Ground: the two quietest colours, enough to cover, so the rosette has
  // something to bite into.
  const ground = palette.colors.slice(3);
  const meanR = 0.055 * scale;
  const count = Math.round((1.7 * SIZE * SIZE) / (Math.PI * meanR * meanR));
  for (let round = 0; round < ground.length; round++) {
    const shrink = Math.pow(0.74, round);
    for (let i = 0; i < count; i++) {
      m.drop(
        rng.float(-0.06, 1.06) * SIZE,
        rng.float(-0.06, 1.06) * SIZE,
        rng.float(0.035, 0.075) * shrink * scale,
        ground[round],
      );
    }
  }

  // The rosette, larger relative to the sheet than it would ever be in a real
  // hatip — an icon has to read as one shape, not as a field with a flower in it.
  // Sized so the marbled ground still shows at the corners. Filling the frame
  // reads as a generic star; leaving the bath visible is what says "ebru".
  const outer = 0.26 * scale;
  const rings = 5;
  const ringColors = [palette.colors[0], palette.colors[3], palette.colors[1], palette.colors[4], palette.colors[2]];
  for (let i = 0; i < rings; i++) {
    m.drop(cx, cy, outer * (1 - i / rings), ringColors[i % ringColors.length]);
  }

  const petals = 12;
  const startAngle = -Math.PI / 2;
  for (let i = 0; i < petals; i++) {
    const a = startAngle + (i / petals) * Math.PI * 2;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const outward = i % 2 === 0;
    const [r1, r2] = outward ? [outer * 0.1, outer * 1.9] : [outer * 1.9, outer * 0.1];
    m.stylus({
      x1: cx + ca * r1,
      y1: cy + sa * r1,
      x2: cx + ca * r2,
      y2: cy + sa * r2,
      mag: outer * 0.6,
      lambda: outer * 0.2,
    });
  }

  m.settle();
  return {
    svg: toSvg(m, {
      paper: palette.paper,
      tolerance: SIZE / 9000,
      grain: false,
      title: `Ebru — ${palette.label}`,
    }),
    drops: m.drops.length,
  };
}

mkdirSync('out/avatar', { recursive: true });

const candidates = [
  ['sultan', 'avatar-sultan'],
  ['klasik', 'avatar-klasik'],
  ['lacivert', 'avatar-lacivert'],
  ['firuze', 'avatar-firuze'],
];

const cells = [];
for (const [paletteName, seed] of candidates) {
  const { svg, drops } = avatar(paletteName, seed);
  writeFileSync(`out/avatar/${paletteName}.svg`, svg);
  const shots = {};
  for (const px of PREVIEWS) {
    const png = toPng(svg, { width: px });
    writeFileSync(`out/avatar/${paletteName}-${px}.png`, png);
    shots[px] = `data:image/png;base64,${png.toString('base64')}`;
  }
  console.log(`${paletteName.padEnd(10)} ${String(drops).padStart(5)} drops  ${(svg.length / 1024).toFixed(0)}KB svg`);

  cells.push(
    `<figure><figcaption>${PALETTES[paletteName].label}</figcaption><div class="row">` +
      PREVIEWS.map((px) => `<span><img src="${shots[px]}" width="${px}" height="${px}" alt=""><em>${px}px</em></span>`).join('') +
      `</div></figure>`,
  );
}

writeFileSync(
  'out/avatar/index.html',
  `<title>ebru — avatar candidates</title>
<style>
 body{background:#14110C;color:#E8E0CF;font:14px/1.5 system-ui,sans-serif;margin:0;padding:40px}
 h1{font:400 30px/1 'Iowan Old Style',Palatino,Georgia,serif;margin:0 0 28px}
 figure{margin:0 0 34px}
 figcaption{font:400 18px 'Iowan Old Style',Palatino,Georgia,serif;margin-bottom:10px}
 .row{display:flex;gap:26px;align-items:flex-end}
 .row span{display:flex;flex-direction:column;gap:6px;align-items:center}
 img{border-radius:3px;display:block}
 em{font-style:normal;font-size:11px;opacity:.45}
</style>
<h1>Avatar candidates — legibility at listing sizes</h1>
${cells.join('\n')}`,
);

console.log('\n→ out/avatar/  (open index.html to compare at 512 / 128 / 64 px)');
