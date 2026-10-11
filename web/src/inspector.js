// Explains one pixel: why it got its class, step by step, from the stored
// values and the thresholds in manifest.rule (DATA_CONTRACT.md sections 6–7).
// Codes 0–2 (land, shallow, no data) are masks; codes 3–8 go through the checklist.

import { esc, richText, icon, fmtChl, fmtNflh, fmtDepth, fmtAngle, fmtMargin, fmtInt, prettyUnits } from './format.js';
import { CLASS_COLORS, TIER_ICONS } from './scales.js';
import { depthAt, seabedFlag } from './contract.js';
import { moreHtml, foldListHtml } from './more.js';

/**
 * Works out each check for a pixel.
 * @returns {{ code, steps, decidedBy, cluster, confidence, derivedCode, mask }}
 */
export function explainPixel({ manifest, grid, codes, index, clusters, references }) {
  const { rule } = manifest;
  const code = codes[index];
  const chl = grid.chlor_a[index];
  const nflh = grid.nflh?.[index] ?? null;
  const cid = grid.cluster_id[index];
  const cluster = clusters && cid != null ? clusters.get(cid) ?? null : null;
  const density = densityOf(rule, chl, nflh);

  if (code <= 2) return { code, mask: code, steps: [], cluster: null, confidence: null, derivedCode: code, density };

  const refGroup = (id) => references?.get(id)?.group ?? (id?.startsWith('water') || id === 'seabed' ? 'water' : 'bloom');
  const bestIsBloom = cluster ? refGroup(cluster.best_ref) === 'bloom' : null;
  // Not dense: a water-type match means non-bloom water, otherwise a weak bloom.
  const notDense = cluster
    ? bestIsBloom
      ? { code: 4, means: 'Not dense: a weak bloom, too thin to name a species.' }
      : { code: 3, means: 'Not dense, and the cluster looks most like a water type: non-bloom water.' }
    : { code: null, means: 'Not dense: non-bloom water or a weak bloom (cluster details unavailable).' };
  const nflhUnits = prettyUnits(rule.nflh_units ?? '');

  const steps = [
    {
      key: 'chl_weak',
      label: 'Chlorophyll reaches the bloom threshold',
      value: chl,
      shown: `${fmtChl(chl)} mg/m³`,
      test: `≥ ${fmtChl(rule.chl_weak_min)}`,
      pass: chl != null && chl >= rule.chl_weak_min,
      failMeans: 'Below the bloom threshold: non-bloom water.',
      failCode: 3,
    },
    {
      key: 'chl_dense',
      label: 'Chlorophyll is dense',
      shown: `${fmtChl(chl)} mg/m³`,
      test: `≥ ${fmtChl(rule.chl_dense_min)}`,
      pass: chl != null && chl >= rule.chl_dense_min,
      failMeans: notDense.means,
      failCode: notDense.code,
    },
    {
      key: 'nflh',
      label: 'Fluorescence (nflh) is raised too',
      shown: `${fmtNflh(nflh)}${nflh != null ? ` ${nflhUnits}` : ''}`,
      test: `≥ ${fmtNflh(rule.nflh_dense_min)}`,
      pass: nflh != null && nflh >= rule.nflh_dense_min,
      failMeans: nflh == null
        ? `No fluorescence reading, so the density can't be confirmed. ${notDense.means}`
        : `Living algae glow; mud and seabed don't. ${notDense.means}`,
      failCode: notDense.code,
    },
    {
      key: 'bloom_match',
      label: 'Closest reference is a bloom, not a water type',
      shown: cluster ? `${refLabel(references, cluster.best_ref)} (${fmtAngle(cluster.sam_deg[cluster.best_ref])}°)` : 'Cluster details unavailable',
      plain: true,
      test: 'a bloom reference',
      pass: bestIsBloom,
      failMeans: 'A dense bloom whose spectrum looks most like a water type: unclassified.',
      failCode: 5,
    },
    {
      key: 'margin',
      label: 'Best match is clearly ahead of the second-best',
      shown: cluster ? `margin ${fmtMargin(cluster.margin)}` : 'Cluster details unavailable',
      test: `≥ ${fmtMargin(rule.margin_min)}`,
      pass: cluster ? cluster.margin >= rule.margin_min : null,
      failMeans: 'Too close to call between two references: unclassified.',
      failCode: 5,
    },
    {
      key: 'comparisons',
      label: 'Shape and pigment-feature matches agree',
      shown: cluster?.best_ref_deriv
        ? `${refLabel(references, cluster.best_ref_deriv)} (${fmtAngle(cluster.sam_deriv_deg?.[cluster.best_ref_deriv])}°)`
        : 'Pigment-feature match unavailable',
      plain: true,
      test: 'the same reference as the shape match',
      pass: cluster?.best_ref_deriv ? cluster.best_ref_deriv === cluster.best_ref : null,
      failMeans: 'The shape and pigment-feature comparisons pick different references: unclassified.',
      failCode: 5,
    },
  ];

  // The first failing step decides the class; later steps aren't reached.
  let decidedBy = null;
  for (const s of steps) {
    if (decidedBy) s.state = 'skip';
    else if (s.pass === null) s.state = 'unknown';
    else if (s.pass) s.state = 'pass';
    else {
      s.state = 'fail';
      decidedBy = s;
    }
  }
  let derivedCode = decidedBy ? decidedBy.failCode : null;
  if (!decidedBy && cluster) {
    derivedCode = { cp_like: 6, noctiluca_like: 7, diatom_like: 8 }[cluster.label_key] ?? null;
  }
  // Without the cluster table, only the chlorophyll and fluorescence checks can be redone.
  if (!cluster && !decidedBy) derivedCode = null;

  let confidence = null;
  if (code >= 6 && cluster) {
    const bands = [...rule.confidence_bands].sort((a, b) => a.min - b.min);
    confidence = bands.filter((b) => cluster.margin >= b.min).pop() ?? null;
  }

  return { code, steps, decidedBy, cluster, confidence, derivedCode, mask: null, density };
}

/** 'dense' | 'weak' | 'none' | null (no reading), by the manifest's gates. */
function densityOf(rule, chl, nflh) {
  if (chl == null) return null;
  if (chl < rule.chl_weak_min) return 'none';
  return chl >= rule.chl_dense_min && nflh != null && nflh >= rule.nflh_dense_min ? 'dense' : 'weak';
}

const DENSITY = { dense: 'Dense', weak: 'Weak', none: 'No bloom' };

const TURBID_REF = 'water_turbid';

/** Non-bloom water best matching turbid water, with chlorophyll at or above the dense gate. */
export function isTurbid(rule, code, cluster, chl) {
  return code === 3 && cluster?.best_ref === TURBID_REF && chl != null && chl >= rule.chl_dense_min;
}

/**
 * Flags on top of the class (codes 3–8), worked out here rather than stored:
 * - shallow_zone: assessed water at least shallow_max_m and under shallow_flag_max_m deep
 * - turbid: non-bloom water best matching turbid water, with chlorophyll at or above the
 *   dense gate (the reading is likely inflated by sediment)
 * @returns {{ key: string, label: string, icon: string, caution: boolean, note: string }[]}
 */
export function pixelFlags({ manifest, grid, index, depth }, ex) {
  if (ex.code < 3) return [];
  const { rule } = manifest;
  const flags = [];
  const d = depthAt(depth, grid, index);
  if (seabedFlag(rule, d)) {
    const zone = `${rule.shallow_max_m}–${rule.shallow_flag_max_m} m`;
    flags.push({ key: 'shallow_zone', label: `Shallow ${zone}`, icon: 'warning', caution: true, note: `Shallow water (${zone}): the seabed may affect this result.` });
  }
  if (isTurbid(rule, ex.code, ex.cluster, grid.chlor_a[index])) {
    flags.push({ key: 'turbid', label: 'Turbid water', icon: 'warning', caution: true, note: 'Turbid water: the chlorophyll reading is likely inflated by sediment.' });
  }
  return flags;
}

/** The flags as labelled chips (an icon and a word each, never color alone). */
function flagChips(flags) {
  if (!flags.length) return '';
  return `
    <ul class="flag-chips" role="list" aria-label="Flags">
      ${flags.map((f) => `<li class="flag-chip ${f.caution ? 'is-caution' : 'is-ok'}" data-flag="${esc(f.key)}" title="${esc(f.note)}">${icon(f.icon)}<span>${esc(f.label)}</span></li>`).join('')}
    </ul>`;
}

export function refLabel(references, refId) {
  const label = references?.get(refId)?.label ?? refId;
  return label.replace(/\s*\(PLACEHOLDER\)\s*/i, '');
}

function maskReason(code, rule, chl, depth) {
  if (code === 0) return '<p class="mask-reason">Land. Not part of the analysis.</p>';
  if (code === 2) return '<p class="mask-reason">No data: cloud, sun glint or failed quality flags, or no chlorophyll value or cluster. This pixel was not tested.</p>';
  const lim = rule.shallow_max_m ?? '?';
  const deep = depth != null ? `${fmtDepth(depth)} deep, shallower than ${lim} m` : `shallower than ${lim} m`;
  const reading = chl != null
    ? `PACE reads ${fmtChl(chl)} mg/m³ of chlorophyll here: possibly a bloom, possibly light reflected by the seabed and stirred-up sediment raising the reading. So the pixel is not tested for a bloom and no species is named. The chlorophyll layer still shows the reading.`
    : 'In water this shallow, light reflected by the seabed and stirred-up sediment can raise the readings. So the pixel is not tested for a bloom, no species is named, and no readings are stored for it.';
  return moreHtml({
    key: 'shallow',
    className: 'mask-reason',
    head: `<p>Shallow water, not assessed: ${esc(deep)}.</p>`,
    body: `<p>${esc(reading)}</p>`,
    what: 'about shallow water',
  });
}

/** Assessed water between the shallow limit and the flag depth: the seabed may show. */
function seabedNote({ manifest, grid, index, depth }) {
  const { rule } = manifest;
  const d = depthAt(depth, grid, index);
  if (!seabedFlag(rule, d)) return '';
  const [lo, hi] = [esc(rule.shallow_max_m), esc(rule.shallow_flag_max_m)];
  return moreHtml({
    key: 'seabed',
    className: 'note note-seabed',
    icon: icon('warning'),
    head: `<strong>Shallow water (${lo}–${hi} m), here ${fmtDepth(d)} deep: the seabed may affect this result.</strong>`,
    body: `<p>Between ${lo} and ${hi} m, light reflected by sand or seagrass on the bottom can mix into the color.
      Gulf coastal water is often murky enough to hide it, but trust this result less than one from deeper water.</p>`,
    what: 'about the seabed',
  });
}

/** Non-bloom water that best matches turbid water, with a chlorophyll reading at bloom levels. */
function turbidNote(ctx, flags) {
  if (!flags.some((f) => f.key === 'turbid')) return '';
  const chl = ctx.grid.chlor_a[ctx.index];
  return moreHtml({
    key: 'turbid',
    className: 'note note-turbid',
    icon: icon('warning'),
    head: '<strong>Turbid water: the chlorophyll reading is likely inflated by sediment.</strong>',
    body: `<p>The cluster looks most like turbid water and fluorescence isn’t raised, so this is non-bloom water despite ${fmtChl(chl)} mg/m³.
      Mud raises the chlorophyll estimate but doesn’t glow.</p>`,
    what: 'about turbid water',
  });
}

/** The pixel's own values: chlorophyll, fluorescence, depth and density. */
function valuesHtml({ manifest, grid, index, depth }, ex) {
  const { rule } = manifest;
  const chl = grid.chlor_a[index];
  const nflh = grid.nflh?.[index] ?? null;
  const d = depthAt(depth, grid, index);
  const item = (label, value, unit = '') =>
    `<div><dt>${label}</dt><dd><span class="mono">${value}</span>${unit && value !== 'n/a' ? ` <span class="muted">${unit}</span>` : ''}</dd></div>`;
  return `
    <dl class="pixel-values">
      ${item('Chlorophyll', fmtChl(chl), 'mg/m³')}
      ${item('Fluorescence (nflh)', fmtNflh(nflh), esc(prettyUnits(rule.nflh_units ?? '')))}
      ${item('Depth', d == null ? 'n/a' : fmtDepth(d))}
      ${ex.code >= 3 && ex.density ? `<div><dt>Density</dt><dd>${DENSITY[ex.density]}</dd></div>` : ''}
    </dl>`;
}

const STATE = {
  pass: { word: 'Pass' },
  fail: { word: 'Fail' },
  skip: { word: 'Not reached' },
  unknown: { word: 'Unknown' },
};

/** HTML for the pixel card's content (main.js adds the foldable header). */
export function pixelCardHtml(ctx, ex) {
  const { manifest, grid, index, references, clustersError } = ctx;
  const { rule } = manifest;
  const cls = manifest.classes.find((k) => k.code === ex.code);
  const tier = manifest.risk_tiers.find((t) => t.key === cls.risk_tier);
  const color = CLASS_COLORS[cls.key];

  const head = `
    <h2 class="pixel-class">
      <span class="swatch swatch-lg ${!color ? 'swatch-none' : cls.key === 'shallow' ? 'swatch-hatch' : ''}" ${color ? `style="--swatch:${color}"` : ''}></span>
      <span>${richText(cls.label)}</span>
    </h2>
    <p class="pixel-tier tier-${esc(tier.key)}">${icon(TIER_ICONS[tier.key])}<span>Risk tier: <strong>${esc(tier.label)}</strong></span></p>`;

  if (ex.mask != null) {
    // Shallow water keeps its readings, when the pipeline stored them.
    const kept = ex.code === 1 && (grid.chlor_a[index] != null || grid.nflh?.[index] != null);
    const values = kept ? valuesHtml(ctx, ex) : '';
    return `${head}${ctx.compareHtml ?? ''}${values}${maskReason(ex.code, rule, grid.chlor_a[index], depthAt(ctx.depth, grid, index))}`;
  }

  const steps = ex.steps
    .map(
      (s, i) => `
      <li class="step step-${s.state}">
        <span class="step-mark mono">${i + 1}</span>
        <span class="step-body">
          <span class="step-label">${esc(s.label)}</span>
          <span class="step-values"><span class="${s.plain ? '' : 'mono'}">${s.plain ? richText(s.shown) : esc(s.shown)}</span> <span class="muted">needs</span> <span class="${s.plain ? '' : 'mono'}">${esc(s.test)}</span></span>
          ${s.state === 'fail' ? `<span class="step-outcome">${esc(s.failMeans)}</span>` : ''}
        </span>
        <span class="step-word">${STATE[s.state].word}</span>
      </li>`,
    )
    .join('');

  const result =
    !ex.decidedBy && ex.cluster
      ? `<p class="step-result"><span>All checks pass: named after the closest reference, <strong>${richText(refLabel(references, ex.cluster.best_ref))}</strong>.</span></p>`
      : '';
  const mismatch =
    ex.derivedCode != null && ex.derivedCode !== ex.code
      ? `<p class="note">${icon('warning')}<span>The stored class doesn't match what these checks give (code ${ex.derivedCode}). The data may be out of date; run the validator.</span></p>`
      : '';

  const confidence = ex.confidence
    ? moreHtml({
        key: 'confidence',
        className: 'confidence',
        head: `<p><span class="muted">Confidence</span> <strong>${esc(ex.confidence.label)}</strong> <span class="mono">(margin ${fmtMargin(ex.cluster.margin)})</span></p>`,
        lead: '<p class="muted small">A separation score, not a probability.</p>',
        body: '<p class="muted small">How clearly the best reference beat the runner-up, measured against how different those two references are from each other. A margin of 0.80 means clearly ahead, not an 80% chance: there’s no confirmed data to calibrate it into a probability.</p>',
        what: 'about the confidence',
      })
    : '';

  // The checks fold away behind their tally; the first failure decides the class.
  const count = (st) => ex.steps.filter((s) => s.state === st).length;
  const tally = [
    `<span class="tally ${count('pass') ? 'tally-pass' : 'tally-skip'}">${count('pass')} pass</span>`,
    `<span class="tally ${count('fail') ? 'tally-fail' : 'tally-skip'}">${count('fail')} fail</span>`,
    count('skip') ? `<span class="tally tally-skip">${count('skip')} not reached</span>` : '',
    count('unknown') ? `<span class="tally tally-skip">${count('unknown')} unknown</span>` : '',
  ].join(' ');
  const strip = ex.steps
    .map((s, i) => `<span class="pstep pstep-${s.state}" title="${i + 1}. ${esc(s.label)}: ${STATE[s.state].word}">${i + 1}</span>`)
    .join('');
  const checklist = foldListHtml({
    key: 'checklist',
    className: 'checklist',
    title: 'Class precedence checklist',
    summary: `<span class="pstrip" aria-hidden="true">${strip}</span><span class="tallies">${tally}</span>`,
    body: `<ol class="steps" role="list">${steps}</ol>${result}`,
    what: 'the class precedence checklist',
  });

  const flags = pixelFlags(ctx, ex);
  return `${head}
    ${ctx.compareHtml ?? ''}
    ${flagChips(flags)}
    ${valuesHtml(ctx, ex)}
    ${checklist}
    ${mismatch}${confidence}
    ${ex.cluster ? clusterHtml(ex.cluster, references, rule) : `<p class="note">${icon('warning')}<span>Cluster details unavailable${clustersError ? `: ${esc(clustersError.message)}` : ''}. Only the chlorophyll and fluorescence checks can be shown.</span></p>`}
    ${seabedNote(ctx)}
    ${turbidNote(ctx, flags)}
    ${ctx.currentHtml ?? ''}`;
}

function clusterHtml(c, references, rule) {
  const deriv = c.sam_deriv_deg ?? null;
  const rows = Object.entries(c.sam_deg)
    .sort((a, b) => a[1] - b[1])
    .map(([ref, deg]) => {
      const group = references?.get(ref)?.group ?? '';
      const mark = ref === c.best_ref ? '<span class="tag">best</span>' : ref === c.second_ref ? '<span class="tag tag-quiet">2nd</span>' : '';
      const d = deriv?.[ref];
      return `
        <li class="${ref === c.best_ref ? 'is-best' : ''}">
          <span class="angle-name">${richText(refLabel(references, ref))} ${mark}</span>
          <span class="angle-group muted">${esc(group)}</span>
          <span class="angle-bar" aria-hidden="true"><span style="width:${Math.min(100, (deg / 60) * 100).toFixed(1)}%"></span></span>
          <span class="angle-num mono">${fmtAngle(deg)}°</span>
          ${deriv ? `<span class="angle-num angle-deriv mono ${ref === c.best_ref_deriv ? 'is-best' : ''}" title="${ref === c.best_ref_deriv ? 'Best pigment-feature match' : 'Pigment-feature angle'}">${d == null ? 'n/a' : `${fmtAngle(d)}°`}</span>` : ''}
        </li>`;
    })
    .join('');
  const head = deriv
    ? `<li class="angles-head muted" aria-hidden="true"><span></span><span></span><span></span><span>shape</span><span>pigment</span></li>`
    : '';
  return `
    <div class="cluster">
      <p class="cluster-title">Cluster <span class="mono">#${c.cluster_id}</span>${c.parent_id != null ? ` <span class="muted">in group ${c.parent_id}</span>` : ''}: spectral angle to each reference${deriv ? ', by shape and by pigment features' : ''}</p>
      <ul class="angles ${deriv ? 'has-deriv' : ''}" role="list">${head}${rows}</ul>
      ${moreHtml({
        key: 'margin',
        className: 'cluster-math',
        head: '<p class="muted small">Smaller angle = more similar.</p>',
        body: `${marginMath(c, references, rule)}
          ${deriv ? `<p class="muted small">Pigment features compare the second derivative of the curves${rangeText(rule.deriv_range_nm)}, smoothed with a ${esc(rule.deriv_filter ?? 'Savitzky–Golay')} filter${rule.deriv_window ? ` (${esc(rule.deriv_window)} bands)` : ''}. It measures how sharply each curve bends, so broad backgrounds such as a sediment slope fade out and narrow pigment dips and bumps stand out. A species is named only when both comparisons pick the same reference.</p>` : ''}`,
        what: 'about the margin and the two comparisons',
      })}
    </div>`;
}

/** " over 500–700 nm" from a [low, high] range in the manifest, or nothing. */
function rangeText(range) {
  return Array.isArray(range) && range.length === 2 ? ` over ${esc(range[0])}–${esc(range[1])} nm` : '';
}

/** The margin worked out from the shown angles and the gap between the two references. */
function marginMath(c, references, rule) {
  const [best, second] = [c.sam_deg[c.best_ref], c.sam_deg[c.second_ref]];
  const fit = c.n_pixels ? ` ${fmtInt(c.n_pixels)} pixels in the fit.` : '';
  const shape = `Shape angles compare the curves${rangeText(rule.sam_range_nm)}.`;
  if (c.ref_gap_deg == null) {
    return `<p class="muted small">${shape} Margin <span class="mono">${fmtMargin(c.margin)}</span>.${fit}</p>`;
  }
  return `<p class="muted small">${shape} Margin = (2nd − best) ÷ the angle between those two references
    (${richText(refLabel(references, c.best_ref))} and ${richText(refLabel(references, c.second_ref))}) =
    <span class="mono">(${fmtAngle(second)} − ${fmtAngle(best)}) ÷ ${fmtAngle(c.ref_gap_deg)} = ${fmtMargin(c.margin)}</span>, kept between 0 and 1:
    how clearly the best reference beat the runner-up, measured against how different the two are.${fit}</p>`;
}
