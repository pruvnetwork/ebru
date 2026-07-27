/**
 * SVG -> PNG.
 *
 * The vector form is the master; PNG is a delivery format. Rasterising happens
 * through resvg (Rust), not a browser, so it runs in a plain server process
 * with no headless Chrome to babysit.
 */

import { Resvg } from '@resvg/resvg-js';

/**
 * @param {string} svg
 * @param {object} [opts]
 * @param {number} [opts.width] output width in pixels; height follows the aspect ratio
 * @returns {Buffer} PNG bytes
 */
export function toPng(svg, { width = 1200 } = {}) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    background: 'transparent',
  });
  return resvg.render().asPng();
}
