// Headless checks on the real data in data/ (the full suite, check.mjs, runs on the
// mock data, which has every class). Uses the installed Chrome.
//
//   npm run dev            (in another terminal: the real data, on port 5173)
//   npm run check:real     [-- --url http://127.0.0.1:5173/ --out check-output]
//
// Every date loads with zero console errors; the held-out test date opens on its own
// area; clicked pixels are explained consistently with grid.json and clusters.json
// (a named bloom, an unclassified dense bloom, a weak bloom whose fluorescence isn't
// raised, shallow water); the nFLH layer, site statuses across areas and swipe compare
// between the two areas work; the Gulf rule is gone; no sideways scroll on a phone.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc), []),
);
const BASE = args.url ?? 'http://127.0.0.1:5173/';
const OUT = path.resolve(args.out ?? 'check-output');
fs.mkdirSync(OUT, { recursive: true });

let failures = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const bad = (msg) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};
const check = (cond, msg, detail = '') => (cond ? ok(msg) : bad(detail ? `${msg}: ${detail}` : msg));

const loaded = (page) =>
  page.waitForFunction(() => window.__gbw?.view && window.__gbw.shown.size > 0 && [...window.__gbw.shown.values()].every((x) => x.loaded || x.error), null, { timeout: 60000 });
async function goDate(page, date) {
  await page.evaluate((d) => {
    location.hash = `#date=${d}`;
  }, date);
  await page.waitForFunction((d) => window.__gbw?.date === d, date, { timeout: 20000 });
  await loaded(page);
  await page.waitForTimeout(700);
}

/** A cell of one of `codes` whose neighbours share its code, matching `where` (a function body on s, grid, codes, i). */
const findCell = (page, codes, where = 'true') =>
  page.evaluate(
    ({ codes, where }) => {
      const s = window.__gbw;
      const test = new Function('s', 'grid', 'codes', 'i', `return (${where});`);
      for (const x of s.shown.values()) {
        if (!x.loaded) continue;
        const { grid, codes: c } = x.loaded;
        const W = grid.width;
        for (let i = W + 1; i < c.length - W - 1; i++) {
          if (!codes.includes(c[i]) || ![1, -1, W, -W].every((o) => c[i + o] === c[i]) || !test(s, grid, c, i)) continue;
          return { scene: x.scene.scene_id, index: i, code: c[i], lon: grid.bbox[0] + ((i % W) + 0.5) * grid.res_deg[0], lat: grid.bbox[3] - (Math.floor(i / W) + 0.5) * grid.res_deg[1] };
        }
      }
      return null;
    },
    { codes, where },
  );

/** Clicks a cell (centred and zoomed in first) and returns what its details show and store. */
async function clickCell(page, cell) {
  await page.evaluate(({ lon, lat }) => window.__gbw.view.map.jumpTo({ center: [lon, lat], zoom: 10 }), cell);
  await page.waitForTimeout(700);
  const at = await page.evaluate(({ lon, lat }) => {
    const m = window.__gbw.view.map;
    const b = m.getCanvas().getBoundingClientRect();
    const q = m.project([lon, lat]);
    return { x: b.left + q.x, y: b.top + q.y };
  }, cell);
  await page.mouse.click(at.x, at.y);
  await page.waitForSelector(`.pixel-card[data-code="${cell.code}"]`, { timeout: 10000 });
  return page.evaluate((index) => {
    const s = window.__gbw;
    const x = [...s.shown.values()].find((v) => v.loaded);
    const { grid } = x.loaded;
    const card = document.querySelector('.pixel-card');
    const cid = grid.cluster_id[index];
    return {
      steps: [...card.querySelectorAll('.step')].map((li) => li.className.replace('step ', '').replace('step-', '')),
      text: card.textContent.replace(/\s+/g, ' '),
      chl: grid.chlor_a[index],
      nflh: grid.nflh[index],
      cluster: cid != null ? s.clusters.get(cid) : null,
      group: cid != null ? s.references.get(s.clusters.get(cid).best_ref)?.group : null,
      rule: s.manifest.rule,
    };
  }, cell.index);
}

const browser = await chromium.launch({ channel: 'chrome' });
console.log('chrome (real data)');
const errors = [];
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(BASE);
await loaded(page);
const info = await page.evaluate(() => {
  const s = window.__gbw;
  return { dates: s.dates, date: s.date, real: s.scenes.every((x) => x.status === 'real'), regions: Object.keys(s.manifest.regions), mock: !document.getElementById('mock-banner')?.hidden };
});
check(info.real && !info.mock, 'every scene is real data and no Mock banner shows');
check(info.date === info.dates.at(-1), `opens on the latest date (${info.date})`);
check(info.regions.length === 2, `two areas (${info.regions.join(', ')})`);
await page.waitForFunction(() => window.__gbw.currents && window.__gbw.flow.isRunning(), null, { timeout: 15000 }).catch(() => {});
check(await page.isChecked('#currents') && (await page.evaluate(() => window.__gbw.flow.isRunning())), 'surface currents are on from the start');

// Every date loads.
const failed = [];
for (const d of info.dates) {
  await goDate(page, d);
  const e = await page.evaluate(() => [...window.__gbw.shown.values()].filter((x) => x.error).map((x) => x.scene.scene_id));
  failed.push(...e);
}
check(!failed.length, `all ${info.dates.length} dates load`, failed.join(', '));

// The held-out test date opens on its own area, with its links and true-negative check.
await goDate(page, '2026-03-14');
await goDate(page, '2025-03-24');
await page.waitForTimeout(800);
const test = await page.evaluate(() => {
  const s = window.__gbw;
  const x = [...s.shown.values()][0];
  const box = s.manifest.regions[x.scene.region].bbox;
  const b = s.view.map.getBounds();
  const el = document.querySelector('.test-check');
  return {
    region: x.scene.region,
    box,
    fits: b.getWest() <= box[0] + 0.01 && b.getEast() >= box[2] - 0.01 && b.getSouth() <= box[1] + 0.01 && b.getNorth() >= box[3] - 0.01,
    links: [...document.querySelectorAll('.scene-card .source-link')].map((a) => a.textContent.trim()),
    cp: +el?.dataset.cp,
    dense: +el?.dataset.dense,
    want: { cp: x.loaded.counts[6], dense: x.loaded.counts.slice(5).reduce((a, b) => a + b, 0) },
    verdict: el?.dataset.test,
  };
});
check(test.region === 'oman' && test.box.join() === '56,19,63,26.5' && test.fits, `the test date is in its own area [${test.box}] and the map fits it`);
const borders = async () =>
  page.evaluate(() => window.__gbw.view.map.getSource('frames').serialize().data.features.map((f) => f.geometry.coordinates.flat().join()));
const ringOf = ([w, s, e, n]) => [[w, n], [e, n], [e, s], [w, s], [w, n]].flat().join();
const testBorders = await borders();
await goDate(page, '2026-03-14');
const mainBorders = await borders();
const boxes = await page.evaluate(() => window.__gbw.manifest.regions);
check(testBorders.length === 1 && testBorders[0] === ringOf(boxes.oman.bbox) && mainBorders.length === 1 && mainBorders[0] === ringOf(boxes.gulf.bbox),
  'each date outlines only its own area: the test box on the test date, the main box on the others');
await goDate(page, '2025-03-24');
check(test.links.some((t) => /NASA/i.test(t)) && test.links.some((t) => /Copernicus/i.test(t)), `its sources link NASA and Copernicus (${test.links.join(' | ')})`);
check(test.cp === test.want.cp && test.dense === test.want.dense && test.verdict === (test.cp ? 'disagree' : 'agree'),
  `its true-negative check counts ${test.cp} C. polykrikoides-like of ${test.dense} dense-bloom pixels`);
await page.screenshot({ path: path.join(OUT, 'real-test-date.png') });

// Sites: inside the test area they get a status from its grid; elsewhere it's outside this date's area.
const sites = await page.evaluate(() => {
  const s = window.__gbw;
  const box = Object.values(s.manifest.regions).find((r) => r.bbox[0] === 56).bbox;
  const inBox = (site) => {
    const [lon, lat] = site.geometry.coordinates;
    return lon >= box[0] && lon <= box[2] && lat >= box[1] && lat <= box[3];
  };
  const inside = s.sites.filter(inBox).map((site) => s.siteStatuses.get(site.properties.site_id));
  const far = s.sites.filter((site) => site.geometry.coordinates[0] < 54).map((site) => s.siteStatuses.get(site.properties.site_id));
  return { inside: inside.length, insideFrom: inside.filter((st) => st.region === 'oman' && !st.reason).length, far: far.length, farOutside: far.filter((st) => st.reason === 'outside').length };
});
check(sites.inside > 0 && sites.insideFrom === sites.inside && sites.far > 0 && sites.farOutside === sites.far,
  `on the test date, the ${sites.inside} sites in its area get a status from its grid; the ${sites.far} far-west sites are outside its area`);

// A named bloom: all six checks pass, and the card shows the stored values and the margin's working.
const noct = await findCell(page, [7, 6, 8]);
if (noct) {
  const p = await clickCell(page, noct);
  const c = p.cluster;
  const math = `(${c.sam_deg[c.second_ref].toFixed(2)} − ${c.sam_deg[c.best_ref].toFixed(2)}) ÷ ${c.ref_gap_deg.toFixed(2)} = ${c.margin.toFixed(2)}`;
  const formula = Math.min(1, Math.max(0, (c.sam_deg[c.second_ref] - c.sam_deg[c.best_ref]) / c.ref_gap_deg));
  check(p.steps.length === 6 && p.steps.every((x) => x === 'pass'), `a class ${noct.code} pixel passes all six checks`, p.steps.join(','));
  check(p.text.includes(p.chl.toFixed(2)) && p.text.includes(p.nflh.toFixed(4)) && p.text.includes(math) && Math.abs(formula - c.margin) <= 0.011,
    `its details show the stored chlorophyll ${p.chl.toFixed(2)}, nFLH ${p.nflh.toFixed(4)} and the margin worked out from the angles and the reference gap (${math})`);
  check(!/Gulf rule/i.test(p.text), 'its details say nothing about the Gulf rule');
  await page.screenshot({ path: path.join(OUT, 'real-pixel.png') });
} else bad('no named-bloom pixel to click on the test date');

// A dense unclassified pixel fails the step its cluster calls for.
await goDate(page, '2026-02-14');
const dense = await findCell(page, [5]);
if (dense) {
  const p = await clickCell(page, dense);
  const c = p.cluster;
  const want = p.group === 'water' ? 3 : c.margin < p.rule.margin_min ? 4 : 5;
  check(p.steps.indexOf('fail') === want && p.steps.slice(0, want).every((x) => x === 'pass'),
    `a dense unclassified pixel fails check ${want + 1} (${p.group === 'water' ? 'closest reference is a water type' : c.margin < p.rule.margin_min ? 'margin too small' : 'the comparisons disagree'})`, p.steps.join(','));
} else bad('no dense unclassified pixel to click');

// A weak bloom with dense chlorophyll: the fluorescence check fails.
const weak = await findCell(page, [4], 'grid.chlor_a[i] >= s.manifest.rule.chl_dense_min');
if (weak) {
  const p = await clickCell(page, weak);
  check(p.steps.indexOf('fail') === 2 && p.nflh < p.rule.nflh_dense_min, `a weak bloom with chlorophyll ${p.chl.toFixed(2)} fails the fluorescence check (nFLH ${p.nflh.toFixed(4)})`, p.steps.join(','));
} else console.log('  skip  no weak pixel with dense chlorophyll on 2026-02-14');

// Shallow water: not assessed, without readings.
const shallow = await findCell(page, [1]);
if (shallow) {
  const p = await clickCell(page, shallow);
  check(/Shallow water, not assessed/.test(p.text) && !p.steps.length && /no readings are stored/.test(p.text), 'a shallow pixel reads "not assessed", with no checks and no stored readings');
} else bad('no shallow pixel to click');
await page.evaluate(() => document.querySelector('[data-action="close-pixel"]')?.click());

// Green Noctiluca-like patches get 48-hour drift tracks, and a patch pixel gives its drift.
await goDate(page, '2026-02-14');
await page.waitForFunction(() => window.__gbw.currents?.date === '2026-02-14', null, { timeout: 15000 });
const noctDrift = await page.evaluate(() => {
  const s = window.__gbw;
  const fs = s.view.map.getSource('drift').serialize().data.features;
  const x = [...s.shown.values()].find((v) => v.loaded);
  const p = x.loaded.patches?.find((q) => q.code === 7);
  const W = x.loaded.grid.width;
  const index = p ? [...p.cells].find((i) => [1, -1, W, -W].every((o) => p.cells.has(i + o))) : null;
  const { grid } = x.loaded;
  return {
    tracks: fs.filter((f) => f.properties.kind === 'track' && f.properties.species === 'noctiluca').length,
    h24: fs.some((f) => f.properties.kind === 'h24' && f.properties.species === 'noctiluca'),
    visible: s.view.map.getLayoutProperty('drift-track-noctiluca', 'visibility') === 'visible',
    cell: index == null ? null : { index, code: 7, lon: grid.bbox[0] + ((index % W) + 0.5) * grid.res_deg[0], lat: grid.bbox[3] - (Math.floor(index / W) + 0.5) * grid.res_deg[1] },
  };
});
check(noctDrift.tracks > 0 && noctDrift.h24 && noctDrift.visible, `on 14 Feb 2026, ${noctDrift.tracks} green Noctiluca-like patches get 48-hour drift tracks`, JSON.stringify(noctDrift));
if (noctDrift.cell) {
  await clickCell(page, noctDrift.cell);
  const note = (await page.locator('.current-note').innerText()).replace(/\s+/g, ' ');
  check(/km\/h toward the \w+/.test(note) && /green Noctiluca-like patch (drifts about \d+ km|reaches the coast)/.test(note) && /model estimate/i.test(note),
    'a Noctiluca-like patch pixel shows the current there and its patch drift, as a model estimate', note.slice(0, 200));
  await page.evaluate(() => document.querySelector('[data-action="close-pixel"]')?.click());
} else bad('no Noctiluca-like patch cell to click');

// The nFLH layer draws, and the readout shows the value.
await page.evaluate(() => window.__gbw.view.fitTo(Object.values(window.__gbw.manifest.regions)[0].bbox));
await page.click('button[data-layer="nflh"]');
await page.waitForTimeout(800);
const nflh = await page.evaluate(() => {
  const m = window.__gbw.view.map;
  return { layer: window.__gbw.layer, visible: m.getLayoutProperty('overlay-gulf', 'visibility') !== 'none', legend: !!document.querySelector('.nflh-legend') };
});
check(nflh.layer === 'nflh' && nflh.visible && nflh.legend, 'the nFLH layer draws with its scale');
await page.screenshot({ path: path.join(OUT, 'real-nflh.png') });
await page.click('button[data-layer="classes"]');

// Swipe compare across the two areas.
await page.evaluate(() => {
  location.hash = '#date=2026-03-14&compare=2025-03-24,classes';
});
await page.waitForFunction(() => window.__gbw?.compare?.open && [...window.__gbw.compare.shown.values()].every((x) => x.loaded), null, { timeout: 30000 });
await page.waitForTimeout(1200);
const cmp = await page.evaluate(() => {
  const s = window.__gbw;
  const b = s.cmp.view();
  return { a: [...s.shown.keys()].join(), b: [...s.compare.shown.keys()].join(), overlay: !!b?.map.getLayer('overlay-oman') && b.map.getLayoutProperty('overlay-oman', 'visibility') !== 'none' };
});
check(cmp.a === 'gulf' && cmp.b === 'oman' && cmp.overlay, `compare shows 14 Mar 2026 (A, ${cmp.a}) against the test date (B, ${cmp.b})`);
// B keeps its own area: its border and wash-out are the test box, A's the main box,
// and beyond the main box B's readings show and the readout gives them.
await page.evaluate(() => window.__gbw.view.fitTo(window.__gbw.manifest.regions.oman.bbox));
await page.waitForTimeout(900);
await page.evaluate(() => window.__gbw.cmp.setSplit(0.05));
await page.waitForTimeout(400);
const own = await page.evaluate(() => {
  const s = window.__gbw;
  const A = s.view.map;
  const B = s.cmp.view().map;
  const hole = (m) => m.getSource('outside').serialize().data.geometry.coordinates[1].flat().join();
  const frames = (m) => m.getSource('frames').serialize().data.features.map((f) => f.geometry.coordinates.flat().join());
  const ringOf = ([w, so, e, n]) => [[w, n], [e, n], [e, so], [w, so], [w, n]].flat().join();
  const gulf = s.manifest.regions.gulf.bbox;
  const { grid, codes } = [...s.compare.shown.values()][0].loaded;
  const box = A.getCanvas().getBoundingClientRect();
  const covers = [...document.querySelectorAll('.panel, .panel-tab, .panel-edge, .maplibregl-ctrl, .readout, .compare-handle')].filter((el) => el.getClientRects().length).map((el) => el.getBoundingClientRect());
  const covered = (x, y) => covers.some((r) => x > r.left - 8 && x < r.right + 8 && y > r.top - 8 && y < r.bottom + 8);
  const W = grid.width;
  let cell = null;
  for (let i = 2 * W; i < codes.length - 2 * W && !cell; i += 5) {
    const c = codes[i];
    if (c < 3 || ![1, 2, -1, -2, W, -W, 2 * W, -2 * W].every((o) => codes[i + o] === c)) continue;
    const lon = grid.bbox[0] + ((i % W) + 0.5) * grid.res_deg[0];
    const lat = grid.bbox[3] - (Math.floor(i / W) + 0.5) * grid.res_deg[1];
    if (lon < gulf[2] + 0.3 && lat > gulf[1] - 0.3) continue;
    const q = A.project([lon, lat]);
    const X = Math.round(box.left + q.x);
    const Y = Math.round(box.top + q.y);
    if (q.x < s.cmp.splitPx() + 20 || q.x > box.width - 10 || q.y < 10 || q.y > box.height - 10 || covered(X, Y)) continue;
    if (!document.elementFromPoint(X, Y)?.classList.contains('maplibregl-canvas')) continue;
    cell = { x: X, y: Y, label: s.manifest.classes.find((k) => k.code === c).label };
  }
  return { aHole: hole(A) === ringOf(gulf), bHole: hole(B) === ringOf(s.manifest.regions.oman.bbox), a: frames(A), b: frames(B), gulf: ringOf(gulf), oman: ringOf(s.manifest.regions.oman.bbox), cell };
});
check(own.aHole && own.bHole && own.a.join('|') === own.gulf && own.b.join('|') === own.oman, 'in compare, B outlines and keeps clear the test area, while A keeps the main area');
if (own.cell) {
  await page.mouse.move(own.cell.x, own.cell.y);
  await page.waitForTimeout(200);
  const ro = await page.evaluate(() => document.getElementById('readout').textContent.replace(/\s+/g, ' '));
  check(ro.includes(own.cell.label) && /B/.test(ro), `beyond the main area, hovering B gives the test date's reading (${own.cell.label})`, ro);
  await page.mouse.move(5, 450);
} else bad('found no test-date cell beyond the main area to hover');
await page.screenshot({ path: path.join(OUT, 'real-compare.png') });
await page.evaluate(() => document.querySelector('[data-cmp="close"]')?.click());

// No Gulf rule anywhere, the About page included.
await page.click('#about-btn');
await page.waitForTimeout(400);
const about = await page.evaluate(() => document.getElementById('about')?.textContent ?? '');
check(!/Gulf rule|Gulf discrimination/i.test(await page.evaluate(() => document.body.textContent)) && /What the data shows/.test(about) && !/Mock data/.test(about),
  'no Gulf rule anywhere; About shows what the data shows');
await page.screenshot({ path: path.join(OUT, 'real-about.png') });

// Dark theme, then a phone.
await page.emulateMedia({ colorScheme: 'dark' });
await page.keyboard.press('Escape');
await goDate(page, '2025-03-24');
await page.screenshot({ path: path.join(OUT, 'real-test-date-dark.png') });
await page.emulateMedia({ colorScheme: 'light' });

const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
phone.on('console', (m) => m.type() === 'error' && errors.push(`phone: ${m.text()}`));
phone.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
await phone.goto(`${BASE}#date=2025-03-24`);
await loaded(phone);
await phone.waitForTimeout(1000);
check(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no sideways scroll at phone width');
await phone.screenshot({ path: path.join(OUT, 'real-phone-test-date.png') });
await phone.close();

await page.waitForTimeout(500);
check(!errors.length, 'zero console errors', errors.slice(0, 5).join(' | '));
await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nAll real-data checks passed');
process.exit(failures ? 1 : 0);
