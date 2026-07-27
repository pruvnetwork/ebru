/**
 * Vector output.
 *
 * Because every drop stays a single closed curve under the marbling maps, the
 * artwork is genuine geometry — it scales to any size with no resampling. The
 * only lossy step here is coordinate rounding, which we control.
 */

/**
 * Drop points that sit almost exactly on the line between their neighbours.
 * Deformation bunches points up in the calm parts of the bath and stretches
 * them thin in the turbulent parts, so this typically removes half the points
 * with no visible change.
 *
 * @param {Float64Array} xs
 * @param {Float64Array} ys
 * @param {number} tol maximum allowed deviation in user units
 */
function simplify(xs, ys, tol) {
  const n = xs.length;
  if (n < 8) return { xs: Array.from(xs), ys: Array.from(ys) };

  const outX = [];
  const outY = [];
  const tol2 = tol * tol;

  let ax = xs[0];
  let ay = ys[0];
  outX.push(ax);
  outY.push(ay);

  for (let i = 1; i < n - 1; i++) {
    const bx = xs[i];
    const by = ys[i];
    const cx = xs[i + 1];
    const cy = ys[i + 1];

    // Perpendicular distance from b to the segment a->c.
    const vx = cx - ax;
    const vy = cy - ay;
    const len2 = vx * vx + vy * vy;
    if (len2 < 1e-12) continue;
    const cross = (bx - ax) * vy - (by - ay) * vx;
    if ((cross * cross) / len2 > tol2) {
      outX.push(bx);
      outY.push(by);
      ax = bx;
      ay = by;
    }
  }

  outX.push(xs[n - 1]);
  outY.push(ys[n - 1]);
  return { xs: outX, ys: outY };
}

/**
 * Render the bath to an SVG document.
 *
 * @param {import('./marble.js').Marble} marble
 * @param {object} opts
 * @param {string} opts.paper       background colour
 * @param {number} [opts.precision] decimal places for coordinates
 * @param {number} [opts.tolerance] simplification tolerance in user units
 * @param {boolean} [opts.grain]    overlay a faint paper grain
 * @param {string} [opts.title]
 * @param {string} [opts.description]
 */
export function toSvg(marble, {
  paper,
  precision = 1,
  // Deliberately tight. Simplification is here only to drop points that are
  // genuinely redundant; anything looser starts shaving small drops down into
  // visible hexagons, which is the one artefact that instantly reads as "not
  // paint".
  tolerance = 0.06,
  grain = true,
  title = 'Ebru',
  description = '',
} = {}) {
  const p = Math.pow(10, precision);
  const round = (v) => {
    const r = Math.round(v * p) / p;
    return Object.is(r, -0) ? 0 : r;
  };

  const parts = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${marble.w} ${marble.h}" width="${marble.w}" height="${marble.h}" role="img" aria-label="${escapeAttr(title)}">`,
  );
  parts.push(`<title>${escapeText(title)}</title>`);
  if (description) parts.push(`<desc>${escapeText(description)}</desc>`);

  if (grain) {
    parts.push(
      '<defs><filter id="grain" x="0" y="0" width="100%" height="100%">' +
        '<feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="3" seed="7" result="n"/>' +
        '<feColorMatrix in="n" type="saturate" values="0"/>' +
        '</filter></defs>',
    );
  }

  parts.push(`<rect width="${marble.w}" height="${marble.h}" fill="${paper}"/>`);
  parts.push('<g shape-rendering="geometricPrecision">');

  for (const d of marble.drops) {
    const { xs, ys } = simplify(d.xs, d.ys, tolerance);
    if (xs.length < 3) continue;

    let path = '';
    for (let i = 0; i < xs.length; i++) {
      path += `${i === 0 ? 'M' : 'L'}${round(xs[i])} ${round(ys[i])}`;
    }
    path += 'Z';
    parts.push(`<path d="${path}" fill="${d.color}"/>`);
  }

  parts.push('</g>');

  if (grain) {
    parts.push(
      `<rect width="${marble.w}" height="${marble.h}" filter="url(#grain)" opacity="0.055" style="mix-blend-mode:multiply" pointer-events="none"/>`,
    );
  }

  parts.push('</svg>');
  return parts.join('');
}

function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;');
}
