/**
 * Palettes built from the pigments actually ground for ebru — earth and mineral
 * colours, not screen primaries. `paper` is the ahar-sized sheet the bath is
 * lifted onto; it is never pure white.
 *
 * Names are the traditional Turkish pigment names where one exists.
 */

export const PALETTES = {
  klasik: {
    label: 'Klasik',
    paper: '#F2EADA',
    colors: [
      '#22406B', // çivit mavisi — indigo
      '#A93B2A', // toprak kırmızısı
      '#D9A02B', // aspur sarısı
      '#F0E7D6', // üstübeç — lead white
      '#2C2A26', // is siyahı — lampblack
    ],
  },

  lacivert: {
    label: 'Lacivert Gece',
    paper: '#EDE6D6',
    colors: [
      '#16294A',
      '#28477A',
      '#4A6FA5',
      '#C9A227', // altın
      '#EFE8DA',
    ],
  },

  gulbahar: {
    label: 'Gülbahar',
    paper: '#F6EFE6',
    colors: [
      '#B8465C',
      '#D98A96',
      '#E8B4B0',
      '#7A5C6E',
      '#F4E6DC',
    ],
  },

  toprak: {
    label: 'Toprak',
    paper: '#F0E6D2',
    colors: [
      '#7A4A25',
      '#A9682F',
      '#C99A42',
      '#5C4033',
      '#E6D5B8',
    ],
  },

  hazan: {
    label: 'Hazan',
    paper: '#F4EBD9',
    colors: [
      '#8C2F1B',
      '#C25A26',
      '#E0A030',
      '#6B4226',
      '#EFE0C4',
    ],
  },

  firuze: {
    label: 'Firuze',
    paper: '#F1EEE2',
    colors: [
      '#0F5C63',
      '#2A8C8C',
      '#69B5AE',
      '#C4A344',
      '#EDE7D6',
    ],
  },

  sultan: {
    label: 'Sultan',
    paper: '#F3E9D6',
    colors: [
      '#7E1416', // sultan kırmızısı
      '#B02A24',
      '#C9A227', // altın
      '#1E1B18',
      '#F0E4CC',
    ],
  },

  zeytin: {
    label: 'Zeytin',
    paper: '#F1ECDA',
    colors: [
      '#3E5236',
      '#5E7A4A',
      '#8FA36A',
      '#A8862F',
      '#ECE4CE',
    ],
  },
};

export const PALETTE_NAMES = Object.keys(PALETTES);

/** @param {string} name */
export function getPalette(name) {
  const p = PALETTES[name];
  if (!p) {
    throw new Error(`Unknown palette "${name}". Available: ${PALETTE_NAMES.join(', ')}`);
  }
  return p;
}
