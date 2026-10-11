// Spectrum chart: inline SVG with gap-aware lines and a hover readout.

import { esc } from './format.js';

const W = 340;
const H = 200;
const M = { top: 12, right: 12, bottom: 30, left: 40 };
const PW = W - M.left - M.right;
const PH = H - M.top - M.bottom;

/**
 * @param {HTMLElement} root
 * @param {{ series: Array<{ id, label, wl: number[], values: (number|null)[], color, dash?, width? }>,
 *           normalize: boolean, units?: 'sr^-1'|'normalized', shapeFrom?: number }} spec
 * units: of the values, Rrs (sr^-1) or curves scaled to unit length. shapeFrom: bands below
 * this wavelength are shaded, as the shape comparison leaves them out.
 */
export function renderChart(root, { series, normalize, units = 'sr^-1', shapeFrom = null }) {
  const prepared = series.map((s) => {
    const peak = Math.max(...s.values.filter((v) => v != null));
    const scale = normalize && peak > 0 ? 1 / peak : 1;
    return { ...s, ys: s.values.map((v) => (v == null ? null : v * scale)) };
  });

  const allWl = prepared.flatMap((s) => s.wl);
  const x0 = Math.floor(Math.min(...allWl) / 50) * 50;
  const x1 = Math.ceil(Math.max(...allWl) / 50) * 50;
  // Normalized lines all peak at 1, so that axis stops just above 1. Curves can dip
  // below zero (over-corrected blue bands), so the axis then starts below zero too.
  const values = prepared.flatMap((s) => s.ys.filter((v) => v != null));
  const yMax = normalize ? 1.1 : niceMax(Math.max(...values) * 1.05);
  const low = Math.min(0, ...values);
  const yMin = low < 0 ? -niceMax(-low * 1.05) : 0;
  const sx = (w) => M.left + ((w - x0) / (x1 - x0)) * PW;
  const sy = (v) => M.top + PH - ((v - yMin) / (yMax - yMin)) * PH;

  const rrs = units !== 'normalized';
  const yScale = normalize || !rrs ? 1 : 1000;
  const top = normalize ? 1 : yMax;
  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((f) => yMin + f * (top - yMin));
  const yLabel = normalize ? 'Relative to own peak' : rrs ? 'Rrs (10⁻³ sr⁻¹)' : 'Curve scaled to unit length';
  const xTicks = [];
  for (let w = x0; w <= x1; w += 50) xTicks.push(w);

  // Shade spectral gaps in the first (measured) series, e.g. PACE's 590–610 nm.
  const gaps = findGaps(prepared[0].wl);
  const unused = shapeFrom != null && shapeFrom > x0 ? [x0, Math.min(shapeFrom, x1)] : null;

  const lines = prepared
    .map(
      (s) =>
        `<path d="${pathFor(s.wl, s.ys, sx, sy)}" fill="none" style="stroke:${s.color}" stroke-width="${s.width ?? 1.6}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} stroke-linejoin="round" stroke-linecap="round"/>`,
    )
    .join('');

  root.innerHTML = `
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Reflectance spectra: ${esc(prepared.map((s) => s.label).join(', '))}">
      ${unused ? `<rect class="chart-gap chart-unused" x="${sx(unused[0])}" y="${M.top}" width="${sx(unused[1]) - sx(unused[0])}" height="${PH}"><title>Not used by the shape comparison</title></rect><text class="chart-gap-label" x="${(sx(unused[0]) + sx(unused[1])) / 2}" y="${M.top + 9}">not in shape</text>` : ''}
      ${gaps.map(([a, b]) => `<rect class="chart-gap" x="${sx(a)}" y="${M.top}" width="${sx(b) - sx(a)}" height="${PH}"/><text class="chart-gap-label" x="${(sx(a) + sx(b)) / 2}" y="${M.top + 9}">gap</text>`).join('')}
      ${yTicks.map((v) => `<line class="chart-grid ${Math.abs(v) < 1e-12 && yMin < 0 ? 'chart-zero' : ''}" x1="${M.left}" x2="${M.left + PW}" y1="${sy(v)}" y2="${sy(v)}"/><text class="chart-tick" x="${M.left - 6}" y="${sy(v) + 3}" text-anchor="end">${(v * yScale).toFixed(normalize || !rrs ? 2 : yMax * yScale < 10 ? 1 : 0)}</text>`).join('')}
      ${yMin < 0 && !yTicks.some((v) => Math.abs(v) < 1e-12) ? `<line class="chart-grid chart-zero" x1="${M.left}" x2="${M.left + PW}" y1="${sy(0)}" y2="${sy(0)}"/>` : ''}
      ${xTicks.map((w) => `<text class="chart-tick" x="${sx(w)}" y="${M.top + PH + 14}" text-anchor="middle">${w}</text>`).join('')}
      <text class="chart-axis" x="${M.left + PW / 2}" y="${H - 3}" text-anchor="middle">Wavelength (nm)</text>
      <text class="chart-axis" transform="translate(10 ${M.top + PH / 2}) rotate(-90)" text-anchor="middle">${yLabel}</text>
      ${lines}
      <line class="chart-cursor" x1="0" x2="0" y1="${M.top}" y2="${M.top + PH}" visibility="hidden"/>
      <rect class="chart-hit" x="${M.left}" y="${M.top}" width="${PW}" height="${PH}" fill="transparent"/>
    </svg>
    <div class="chart-readout mono" aria-live="off">Hover the chart to read values.</div>`;

  const svg = root.querySelector('svg');
  const cursor = root.querySelector('.chart-cursor');
  const readout = root.querySelector('.chart-readout');
  const hit = root.querySelector('.chart-hit');
  const base = prepared[0];

  const show = (clientX) => {
    const box = svg.getBoundingClientRect();
    const xSvg = ((clientX - box.left) / box.width) * W;
    const wl = x0 + ((xSvg - M.left) / PW) * (x1 - x0);
    let best = 0;
    for (let i = 1; i < base.wl.length; i++) if (Math.abs(base.wl[i] - wl) < Math.abs(base.wl[best] - wl)) best = i;
    const at = base.wl[best];
    cursor.setAttribute('x1', sx(at));
    cursor.setAttribute('x2', sx(at));
    cursor.setAttribute('visibility', 'visible');
    const parts = prepared.map((s) => {
      const v = valueAt(s.wl, s.ys, at);
      const text = v == null ? 'n/a' : normalize ? v.toFixed(2) : v.toFixed(rrs ? 4 : 3);
      return `<span><i style="background:${s.color}"></i>${esc(s.label)} ${text}</span>`;
    });
    readout.innerHTML = `<strong>${at.toFixed(0)} nm</strong>${parts.join('')}`;
  };
  hit.addEventListener('pointermove', (e) => show(e.clientX));
  hit.addEventListener('pointerdown', (e) => show(e.clientX));
  hit.addEventListener('pointerleave', () => cursor.setAttribute('visibility', 'hidden'));
}

function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const n = v / p;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p;
}

function medianStep(wl) {
  const d = wl.slice(1).map((w, i) => w - wl[i]).sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)] ?? 1;
}

function findGaps(wl) {
  const step = medianStep(wl);
  const gaps = [];
  for (let i = 1; i < wl.length; i++) if (wl[i] - wl[i - 1] > step * 2.5) gaps.push([wl[i - 1], wl[i]]);
  return gaps;
}

/** SVG path that breaks at nulls and at gaps much wider than the usual band step. */
function pathFor(wl, ys, sx, sy) {
  const step = medianStep(wl);
  let d = '';
  let pen = false;
  for (let i = 0; i < wl.length; i++) {
    if (ys[i] == null) {
      pen = false;
      continue;
    }
    const gap = i > 0 && wl[i] - wl[i - 1] > step * 2.5;
    d += `${pen && !gap ? 'L' : 'M'}${sx(wl[i]).toFixed(1)},${sy(ys[i]).toFixed(1)}`;
    pen = true;
  }
  return d;
}

function valueAt(wl, ys, at) {
  for (let i = 0; i < wl.length; i++) {
    if (wl[i] === at) return ys[i];
    if (wl[i] > at) {
      if (i === 0 || ys[i] == null || ys[i - 1] == null || wl[i] - wl[i - 1] > 20) return null;
      const f = (at - wl[i - 1]) / (wl[i] - wl[i - 1]);
      return ys[i - 1] + (ys[i] - ys[i - 1]) * f;
    }
  }
  return null;
}
