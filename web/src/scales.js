// Colors for the class and chlorophyll layers.

// Class colors (the agreed hues: grey no data, blue non-bloom water, yellow weak bloom,
// light orange unclassified dense bloom, red C. polykrikoides-like, dark orange
// Noctiluca-like, green diatom-like). The shades were picked so every pair stays apart
// under deutan, protan and tritan simulation (CIEDE2000 ≥ 10). Land stays transparent;
// shallow water is drawn as a hatch (its color is the stripe color). Always shown with a word too.
export const CLASS_COLORS = {
  land: null,
  shallow: '#80878e',
  no_data: '#6b6963',
  clear: '#5598e7',
  weak_unclassified: '#f2cf63',
  dense_unclassified: '#e79556',
  cp_like: '#b52622',
  noctiluca_like: '#cb6507',
  diatom_like: '#1e7441',
};

// Risk tiers take the color of the class that defines them, so the map and the
// interface share one palette (main.js turns these into CSS variables).
export const TIER_CLASS = {
  high: 'cp_like',
  watch: 'dense_unclassified',
  monitor: 'weak_unclassified',
  low: 'diatom_like',
  none: null,
  not_assessed: null,
};

// Risk tiers: an icon for each, so the tier never relies on color.
export const TIER_ICONS = {
  high: 'tierHigh',
  watch: 'tierWatch',
  monitor: 'eye',
  low: 'tierLow',
  none: 'dash',
  not_assessed: 'notAssessed',
};

/** "#rrggbb" → [r, g, b]. */
export function hexToRgb(hex) {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// Hatch stripes (RGBA) over shallow water: neutral on the class layer, light over
// the chlorophyll colors.
export const HATCH = {
  classes: [128, 135, 142, 225],
  chl: [255, 255, 255, 150],
};

// Chlorophyll: a log scale from 0 to 20 mg m^-3 (20 and above in the top color),
// as agreed with the data team: dark blue (very clear) through light blue, green
// and yellow to red (dense bloom), like NASA's chlorophyll maps. A pure log scale
// can't reach 0, so positions use log(1 + value / CHL_KNEE): logarithmic above
// about 0.1, and exactly 0 at 0.
export const CHL_MIN = 0;
export const CHL_MAX = 20;
const CHL_KNEE = 0.1;
const CHL_STOPS = [
  [0, [8, 48, 107]], // dark blue: very clear water
  [0.3, [61, 143, 214]], // light blue: normal water
  [1, [58, 166, 85]], // green: productive water
  [3, [245, 211, 61]], // yellow: weak-bloom zone
  [10, [215, 48, 31]], // red: dense bloom
  [20, [122, 10, 18]], // dark red: 20 and above
];

/** Position 0–1 of a chlorophyll value on the scale. */
export function chlPosition(v) {
  const t = Math.log10(1 + Math.max(0, v) / CHL_KNEE) / Math.log10(1 + CHL_MAX / CHL_KNEE);
  return Math.min(1, Math.max(0, t));
}

const STOP_POS = CHL_STOPS.map(([v]) => chlPosition(v));

/** [r, g, b] for a position 0–1 on the chlorophyll scale. */
export function chlRamp(t) {
  const x = Math.min(1, Math.max(0, t));
  let i = 0;
  while (i < STOP_POS.length - 2 && x > STOP_POS[i + 1]) i++;
  const f = (x - STOP_POS[i]) / (STOP_POS[i + 1] - STOP_POS[i]);
  const [a, b] = [CHL_STOPS[i][1], CHL_STOPS[i + 1][1]];
  return a.map((c, k) => Math.round(c + (b[k] - c) * Math.min(1, Math.max(0, f))));
}

export const chlColor = (v) => chlRamp(chlPosition(v));

/** CSS gradient of the chlorophyll scale, for the legend. */
export function chlGradientCss() {
  const stops = CHL_STOPS.map(([, c], i) => `rgb(${c.join(' ')}) ${(STOP_POS[i] * 100).toFixed(1)}%`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

// Fluorescence line height (nFLH): a linear scale from 0 to NFLH_TOP (the top color
// above that; negative readings sit at the bottom). The colors step sharply at the
// manifest's threshold (rule.nflh_dense_min), so raised fluorescence stands out:
// muted navy and slate below it, magenta through orange to pale yellow above it.
// NFLH_TOP is a display range, not a threshold.
export const NFLH_MIN = 0;
const NFLH_TOP = 0.8;

/** Top of the nFLH scale: 0.8, or twice the threshold if that is higher. */
export const nflhMax = (threshold) => Math.max(NFLH_TOP, 2 * (threshold ?? 0));

/** Position 0–1 of an nFLH value on the scale. */
export function nflhPosition(v, threshold) {
  return Math.min(1, Math.max(0, (v - NFLH_MIN) / (nflhMax(threshold) - NFLH_MIN)));
}

/** [position, [r, g, b]] stops; two stops share the threshold's position for the sharp step. */
function nflhStops(threshold) {
  const t = nflhPosition(threshold, threshold);
  const t2 = nflhPosition(2 * threshold, threshold);
  return [
    [0, [20, 40, 79]], // dark navy: no glow
    [t, [90, 115, 151]], // muted slate, just under the threshold
    [t, [194, 58, 125]], // magenta: raised from here
    [Math.max(t2, t + 0.01), [240, 123, 60]], // orange at twice the threshold
    [1, [255, 224, 138]], // pale yellow at the top
  ];
}

/** [r, g, b] for an nFLH value. */
export function nflhColor(v, threshold) {
  const x = nflhPosition(v, threshold);
  const stops = nflhStops(threshold);
  if (v >= threshold) {
    // Above the step: from the magenta stop onwards.
    for (let i = 2; i < stops.length - 1; i++) {
      const [a, ca] = stops[i];
      const [b, cb] = stops[i + 1];
      if (x <= b || i === stops.length - 2) {
        const f = b > a ? Math.min(1, Math.max(0, (x - a) / (b - a))) : 1;
        return ca.map((c, k) => Math.round(c + (cb[k] - c) * f));
      }
    }
  }
  const [a, ca] = stops[0];
  const [b, cb] = stops[1];
  const f = b > a ? Math.min(1, Math.max(0, (x - a) / (b - a))) : 0;
  return ca.map((c, k) => Math.round(c + (cb[k] - c) * f));
}

/** CSS gradient of the nFLH scale, for the legend. */
export function nflhGradientCss(threshold) {
  const stops = nflhStops(threshold).map(([p, c]) => `rgb(${c.join(' ')}) ${(p * 100).toFixed(1)}%`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}
