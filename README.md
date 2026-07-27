# ebru

Deterministic Turkish paper marbling. A seed goes in, a marbled sheet comes out.

```bash
node bin/ebru.js "merhaba dünya"
node bin/ebru.js "0xd8dA6BF2..." --pattern bulbul --palette lacivert --size 1600
node bin/ebru.js --sheet out/sheet.html          # every pattern x palette
```

## What this is

Not an image filter and not a diffusion model. This is the fluid math of ebru:
paint floats on a thickened bath, every new drop pushes the earlier paint
outward, and every comb stroke drags it along. Both are closed-form
area-preserving maps, so a drop stays a single closed curve however many times
it is deformed — which is why the output is real vector geometry rather than
pixels.

    drop   p' = C + (p - C) * sqrt(1 + r² / |p - C|²)
    tine   p' = p + u * M * α^(d / λ)

Two consequences fall out of that, and both are the point of the project:

- **The seed is a contract.** Same seed, same artwork, byte for byte, on any
  machine, forever. There is no model weight, no sampler, no temperature. The
  seed hash is in the output metadata.
- **It is fast and it costs nothing to run.** ~1–2 s for a 1000×1000 sheet on
  one core, no GPU, no API call to anyone.

## Patterns

Each is the sequence of gestures a marbler actually performs, in order.

| name      | Turkish        | gesture |
|-----------|----------------|---------|
| `battal`  | Battal         | paint dropped and left to find its own cells |
| `gelgit`  | Gelgit         | the comb drawn back and forth across the bath |
| `sal`     | Şal            | the comb rocked while drawn, folding stripes into S-curves |
| `bulbul`  | Bülbül Yuvası  | şal ground opened into spiral nests with the stylus |
| `tarakli` | Taraklı        | a fine-toothed comb over gelgit, for book endpapers |
| `hatip`   | Hatip          | concentric drops pulled open into a rosette |
| `kumlu`   | Kumlu          | a fine granular ground, laid for calligraphy |

## Palettes

`klasik` `lacivert` `gulbahar` `toprak` `hazan` `firuze` `sultan` `zeytin`

Built from the pigments actually ground for ebru — earth and mineral colours,
not screen primaries. The paper is never pure white.

## API

```js
import { render } from './src/index.js';
import { toPng } from './src/raster.js';

const { svg, meta } = render('any string', { width: 1200, height: 1200 });
const png = toPng(svg, { width: 1200 });
```

`meta` carries the seed, its hash, the chosen pattern and palette, drop and
point counts, byte size, and render time.

Omit `pattern` / `palette` and both are drawn from the seed.

## How it holds its shape

The one thing that separates this from origami-looking output is resampling.
Every gesture stretches some parts of a curve and bunches up others; left alone,
a drop that started as a smooth circle degenerates into a visible polygon. So
after *every* gesture each curve is walked and points are inserted wherever the
spacing has opened past `maxEdge`. Because that happens continuously, inserted
points are always placed while the curve is still locally straight, and they
then follow the remaining deformations exactly like original points.

Two things keep that affordable:

- Curves are scanned before they are rebuilt. Most gestures leave most of the
  bath almost untouched, and reallocating every curve every time costs far more
  than the marbling maths does. (This alone was 8.2 s → 3.7 s.)
- Far from a drop the displacement tends to `r²/2d`, which for the small drops of
  the later rounds falls below the output precision long before it leaves the
  sheet. Those points are skipped, with the error bounded by `epsilon`.

## Known limits

- SVG for the densest pattern (`bulbul`) reaches ~3 MB at 1000 px. Fine on disk,
  too big for an API response — deliver PNG, or raise `maxEdge` for a lighter
  vector file.
- `epsilon` makes the far field an approximation. Output is deterministic for a
  given version, but tuning `epsilon` or `maxEdge` changes results for a seed.

## Layout

    src/rng.js        seeded PRNG — xmur3 + mulberry32
    src/marble.js     the bath: drop, tine, comb, vortex, stylus, resampling
    src/patterns.js   the seven traditional patterns
    src/palettes.js   pigment palettes
    src/svg.js        vector output + point simplification
    src/raster.js     SVG -> PNG via resvg
    bin/ebru.js       CLI
