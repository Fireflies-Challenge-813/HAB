// Headless checks for the dashboard. Uses the browsers already installed on
// this machine (no Playwright browser download needed).
//
//   npm run dev:mock       (in another terminal: the mock data, on port 5174)
//   npm run check          [-- --url http://127.0.0.1:5174/ --out check-output --browsers chrome,edge]
//   npm run check -- --prod --url <built site URL>   (skips the dev-only row test)
//
// For each browser: zero console errors, every date loads, the overlay rows
// sit at their true latitudes, rendered pixels match the grid's classes,
// clicked pixels are explained consistently with grid.json + clusters.json,
// markers stay pinned, land is drawn over the data, the timeline, layers,
// true color and sites work, and broken files produce friendly messages.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]?.startsWith('--') ? true : all[i + 1] ?? true]] : acc), []),
);
const BASE = args.url ?? 'http://127.0.0.1:5174/';
const OUT = path.resolve(args.out ?? 'check-output');
fs.mkdirSync(OUT, { recursive: true });

const BROWSERS = [
  { name: 'chrome', launch: { channel: 'chrome' } },
  { name: 'edge', launch: { channel: 'msedge' } },
  { name: 'avast', launch: { executablePath: 'C:/Program Files (x86)/AVAST Software/Browser/Application/AvastBrowser.exe' } },
];
const only = args.browsers ? args.browsers.split(',') : null; // e.g. --browsers chrome,edge

let failures = 0;
const ok = (msg) => console.log(`  ok    ${msg}`);
const bad = (msg) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};
const check = (cond, msg, detail = '') => (cond ? ok(msg) : bad(detail ? `${msg}: ${detail}` : msg));

async function waitForDate(page, date) {
  await page.waitForFunction(
    (d) => {
      const s = window.__gbw;
      return (
        s?.view && s.date === d && [...s.shown.values()].every((x) => x.loaded || x.error) &&
        !document.getElementById('map-status').classList.contains('is-loading')
      );
    },
    date,
    { timeout: 20000 },
  );
  await page.evaluate(
    () => new Promise((r) => (window.__gbw.view.map.loaded() ? r() : window.__gbw.view.map.once('idle', r))),
  );
}

async function goDate(page, date) {
  await page.evaluate((d) => (location.hash = `date=${d}`), date);
  await waitForDate(page, date);
}

function watchConsole(page, log) {
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') log.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => log.push(`pageerror: ${e.message}`));
}

/** Overlay rows: does each grid row's latitude land on that row in the image? */
/** Interior cells of a class: the whole (2r+1)² block shares the code. */
const findCellsFn = ({ codesWanted, r, max, depthIn = null }) => {
  const s = window.__gbw;
  const polys = (s.land?.features ?? []).flatMap((f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates));
  const boxes = polys.map((poly) => poly[0].reduce((b, [x, y]) => [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)], [180, 90, -180, -90]));
  const inRing = (ring, x, y) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const onLand = (x, y) =>
    polys.some((poly, k) => {
      const b = boxes[k];
      return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3] && poly.filter((ring) => inRing(ring, x, y)).length % 2 === 1;
    });
  const nearLand = (x, y, d) => [[0, 0], [d, 0], [-d, 0], [0, d], [0, -d], [d, d], [-d, -d], [d, -d], [-d, d]].some(([dx, dy]) => onLand(x + dx, y + dy));
  window.__onLand = onLand;
  const map = s.view.map;
  const box = map.getCanvas().getBoundingClientRect();
  const markers = s.sites.map((site) => map.project(site.geometry.coordinates));
  // Floating panels and map controls cover parts of the map; sample only the open map.
  const covers = [...document.querySelectorAll('.panel, .panel-tab, .panel-edge, .maplibregl-ctrl, .readout')]
    .filter((el) => el.getClientRects().length > 0)
    .map((el) => el.getBoundingClientRect());
  const covered = (x, y) => covers.some((r) => x > r.left - 6 && x < r.right + 6 && y > r.top - 6 && y < r.bottom + 6);
  const picks = Object.fromEntries(codesWanted.map((c) => [c, []]));
  for (const x of [...s.shown.values()].filter((v) => v.loaded)) {
    const { grid, codes } = x.loaded;
    const depth = (s.depth ?? []).find((d) => d.width === grid.width && d.height === grid.height && d.bbox.every((v, i) => Math.abs(v - grid.bbox[i]) < 1e-6));
    const step = Math.max(1, Math.floor(grid.height / 80));
    for (let row = r; row < grid.height - r; row += step) {
      for (let col = r; col < grid.width - r; col += step) {
        const code = codes[row * grid.width + col];
        if (!(code in picks) || picks[code].length >= max) continue;
        let same = true;
        for (let dr = -r; dr <= r && same; dr++)
          for (let dc = -r; dc <= r && same; dc++) same = codes[(row + dr) * grid.width + col + dc] === code;
        if (!same) continue;
        if (depthIn) {
          const d = depth?.depth_m[row * grid.width + col];
          if (d == null || d < depthIn[0] || d > depthIn[1]) continue;
        }
        const lon = grid.bbox[0] + (col + 0.5) * grid.res_deg[0];
        const lat = grid.bbox[3] - (row + 0.5) * grid.res_deg[1];
        const p = map.project([lon, lat]);
        if (p.x < 6 || p.y < 6 || p.x > box.width - 6 || p.y > box.height - 6 || covered(p.x + box.left, p.y + box.top)) continue;
        if (markers.some((m) => Math.hypot(m.x - p.x, m.y - p.y) < 26)) continue; // and site markers
        // and cells that touch the land cut out of the overlay (pipeline and basemap coasts differ slightly)
        if (code !== 0 && s.landOnTop && nearLand(lon, lat, grid.res_deg[0])) continue;
        picks[code].push({ code, scene: x.scene.scene_id, index: row * grid.width + col, lon, lat, x: Math.round(p.x + box.left), y: Math.round(p.y + box.top) });
      }
    }
  }
  return Object.values(picks).flat();
};

const idle = (page) => page.evaluate(() => new Promise((r) => (window.__gbw.view.map.loaded() ? setTimeout(r, 50) : window.__gbw.view.map.once('idle', r))));

/** Zooms to a box ([w, s, e, n]) so cells become several pixels wide. */
async function zoomToBox(page, box) {
  await page.evaluate((b) => window.__gbw.view.fitTo(b), box);
  await idle(page);
}

/** Zooms to this date's dense blooms (classes 5-8), else its blooms (4-8), else the whole grid. */
async function zoomToBlooms(page) {
  await page.waitForFunction(() => [...window.__gbw.shown.values()].some((v) => v.loaded), null, { timeout: 20000 });
  const box = await page.evaluate(() => {
    const x = [...window.__gbw.shown.values()].find((v) => v.loaded);
    const { grid, codes } = x.loaded;
    const around = (min) => {
      let b = [180, 90, -180, -90];
      for (let i = 0; i < codes.length; i++) {
        if (codes[i] < min) continue;
        const lon = grid.bbox[0] + ((i % grid.width) + 0.5) * grid.res_deg[0];
        const lat = grid.bbox[3] - (Math.floor(i / grid.width) + 0.5) * grid.res_deg[1];
        b = [Math.min(b[0], lon), Math.min(b[1], lat), Math.max(b[2], lon), Math.max(b[3], lat)];
      }
      return b;
    };
    let b = around(5);
    if (b[0] > b[2]) b = around(4);
    if (b[0] > b[2]) return grid.bbox;
    const cx = (b[0] + b[2]) / 2;
    const cy = (b[1] + b[3]) / 2;
    const half = Math.max(0.7, (b[2] - b[0]) / 2 + 0.2, (b[3] - b[1]) / 2 + 0.2);
    return [cx - half, cy - half * 0.75, cx + half, cy + half * 0.75];
  });
  await zoomToBox(page, box);
}

async function sampleScreen(page, points) {
  await page.addStyleTag({ content: '.readout,.maplibregl-control-container,.site-marker{visibility:hidden!important}' });
  const shot = (await page.screenshot()).toString('base64');
  const out = await page.evaluate(
    async ({ shot, points }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${shot}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      return points.map((s) => ({ ...s, rgb: [...ctx.getImageData(s.x, s.y, 1, 1).data.slice(0, 3)] }));
    },
    { shot, points },
  );
  await page.evaluate(() => document.querySelectorAll('style').forEach((s) => s.textContent.includes('.readout,.maplibregl-control-container') && s.remove()));
  return out;
}

/** Screenshot pixels at interior cells of a few classes vs. the class colors. */
async function checkRenderedPixels(page) {
  const samples = await page.evaluate(findCellsFn, { codesWanted: [0, 3, 6], r: 3, max: 20 });
  const colors = await sampleScreen(page, samples);
  const looksLike = {
    0: ([r, g, b]) => Math.max(r, g, b) - Math.min(r, g, b) < 30, // land: unpainted, near-gray
    3: ([r, , b]) => b > r + 50, // clear water: blue
    6: ([r, g, b]) => r > g + 70 && r > b + 70, // cp_like: red
  };
  const tally = {};
  for (const s of colors) {
    tally[s.code] ??= { n: 0, bad: [] };
    tally[s.code].n++;
    if (!looksLike[s.code](s.rgb)) tally[s.code].bad.push(`(${s.x},${s.y}) rgb(${s.rgb})`);
  }
  return tally;
}

/** Click one interior pixel per class and compare the inspector with the data. */
async function checkPixelClicks(page, label) {
  // Prefer cells in the middle of a 5×5 block (a cell is only a few screen pixels wide).
  const wanted = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  const targets = await page.evaluate(findCellsFn, { codesWanted: wanted, r: 2, max: 1 });
  const missing = wanted.filter((c) => !targets.some((t) => t.code === c));
  if (missing.length) targets.push(...(await page.evaluate(findCellsFn, { codesWanted: missing, r: 1, max: 1 })));
  for (const t of targets) {
    await page.mouse.click(t.x, t.y);
    await page.waitForSelector('.pixel-card[data-code]');
    const got = await page.evaluate(({ scene }) => {
      const s = window.__gbw;
      const x = [...s.shown.values()].find((v) => v.scene.scene_id === scene);
      const { grid } = x.loaded;
      // Zoomed out, a cell can be under a screen pixel wide, so the click may land on a
      // neighbour in the same block: compare with the cell that was actually selected.
      const col = Math.floor((s.selection.lon - grid.bbox[0]) / grid.res_deg[0]);
      const row = Math.floor((grid.bbox[3] - s.selection.lat) / grid.res_deg[1]);
      const index = row * grid.width + col;
      const card = document.querySelector('.pixel-card');
      const cid = grid.cluster_id[index];
      const cl = cid != null ? s.clusters.get(cid) : null;
      return {
        code: Number(card.dataset.code),
        scene: card.dataset.scene,
        steps: [...card.querySelectorAll('.step')].map((li) => li.className.replace('step ', '').replace('step-', '')),
        text: card.textContent.replace(/\s+/g, ' '),
        chl: grid.chlor_a[index],
        nflh: grid.nflh[index],
        depth: (s.depth ?? []).find((d) => d.width === grid.width && d.height === grid.height && d.bbox.every((v, i) => Math.abs(v - grid.bbox[i]) < 1e-6))?.depth_m[index] ?? null,
        seabed: !!card.querySelector('.note-seabed'),
        rule: s.manifest.rule,
        margin: cl?.margin ?? null,
        best: cl?.best_ref ?? null,
      };
    }, t);
    // Six checks, the first failure decides: chl >= weak, chl >= dense, nflh raised,
    // closest reference is a bloom, margin, the two comparisons agree.
    // Not dense -> 3 (water match) or 4; dense -> 5.
    const P = 'pass';
    const F = 'fail';
    const S = 'skip';
    const allowed = {
      3: [[F, S, S, S, S, S], [P, F, S, S, S, S], [P, P, F, S, S, S]],
      4: [[P, F, S, S, S, S], [P, P, F, S, S, S]],
      5: [[P, P, P, F, S, S], [P, P, P, P, F, S], [P, P, P, P, P, F]],
      6: [[P, P, P, P, P, P]],
      7: [[P, P, P, P, P, P]],
      8: [[P, P, P, P, P, P]],
    }[t.code];
    const problems = [];
    if (got.scene !== t.scene) problems.push(`card is for ${got.scene}`);
    if (got.code !== t.code) problems.push(`card shows code ${got.code}`);
    if (t.code >= 3) {
      if (!got.text.includes(got.chl.toFixed(2))) problems.push(`chlorophyll ${got.chl.toFixed(2)} not shown`);
      if (got.nflh != null && !got.text.includes(got.nflh.toFixed(4))) problems.push(`nflh ${got.nflh.toFixed(4)} not shown`);
      if (got.margin != null && !got.text.includes(got.margin.toFixed(2))) problems.push(`margin ${got.margin.toFixed(2)} not shown`);
      if (/doesn't match what these checks give/.test(got.text)) problems.push('mismatch warning shown');
    }
    if ((t.code === 1 || t.code >= 3) && got.depth != null && !got.text.includes(`${Math.round(got.depth)} m`)) problems.push(`depth ${got.depth} m not shown`);
    if (t.code === 1 && !/not assessed/.test(got.text)) problems.push('shallow card doesn\'t say "not assessed"');
    if (t.code === 1 && !got.text.includes(`shallower than ${got.rule.shallow_max_m} m`)) problems.push('shallow card lacks the depth limit');
    if (t.code === 1 && got.depth != null && got.depth >= got.rule.shallow_max_m) problems.push(`shallow cell is ${got.depth} m deep`);
    if (t.code === 2 && got.depth != null && got.depth < got.rule.shallow_max_m) problems.push(`no-data cell is only ${got.depth} m deep (shallow comes first)`);
    const flagged = t.code >= 3 && got.depth != null && got.depth >= got.rule.shallow_max_m && got.depth < got.rule.shallow_flag_max_m;
    if (flagged !== got.seabed) problems.push(`seabed warning ${got.seabed ? 'shown' : 'missing'} at ${got.depth} m`);
    if (t.code === 1 && got.chl != null && !got.text.includes(got.chl.toFixed(2))) problems.push('shallow card hides the chlorophyll reading');
    if (allowed && !allowed.some((a) => a.join() === got.steps.join())) problems.push(`steps ${got.steps}`);
    if (t.code === 6 && got.best !== 'cp') problems.push(`best ref ${got.best}`);
    if (t.code >= 6 && !/separation score, not a probability/.test(got.text)) problems.push('confidence caveat missing');
    if (t.code <= 2 && !/not tested|Not part of the analysis/i.test(got.text)) problems.push('mask reason missing');
    check(!problems.length, `${label}: clicked class ${t.code} pixel is explained consistently`, problems.join('; '));
  }
  return targets.map((t) => t.code);
}

const boundsContain = (b, box) => b.getWest() <= box[0] && b.getSouth() <= box[1] && b.getEast() >= box[2] && b.getNorth() >= box[3];

async function runBrowser({ name, launch }) {
  console.log(`\n== ${name}`);
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...launch });
  } catch (err) {
    bad(`launch ${name}: ${err.message.split('\n')[0]}`);
    return;
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const log = [];
  watchConsole(page, log);

  await page.goto(BASE);
  const dates = await page
    .waitForFunction(() => window.__gbw?.dates?.length && window.__gbw.dates, null, { timeout: 20000 })
    .then((h) => h.jsonValue());
  await waitForDate(page, dates[dates.length - 1]);
  ok(`manifest loaded, ${dates.length} dates; opens on the latest`);
  check(await page.evaluate(() => window.__gbw.clusters?.size > 0 && window.__gbw.references?.size === 6), 'cluster table and 6 references loaded');
  check(await page.evaluate(() => (window.__gbw.land?.features?.length ?? 0) > 0), 'land polygons loaded');
  check(await page.evaluate(() => !document.querySelector('.brand svg, .brand img') && document.querySelector('link[rel="icon"]')?.getAttribute('href') === 'data:,' && /Gulf Bloom Watch/.test(document.querySelector('.brand').textContent)),
    'the top bar has the name without a logo, and the tab has no icon');

  // One full-screen map with the panels floating over it.
  const win = await page.evaluate(() => {
    const s = window.__gbw;
    const b = s.view.map.getBounds();
    const boxes = [...s.shown.values()].map((x) => s.manifest.regions[x.scene.region].bbox);
    return { zoom: s.view.map.getZoom(), regions: [...s.shown.values()].map((x) => x.scene.region).join(), all: boxes.length > 0 && boxes.every((box) => b.getWest() <= box[0] && b.getSouth() <= box[1] && b.getEast() >= box[2] && b.getNorth() >= box[3]) };
  });
  check(win.all, "the map window shows the opening date's whole area");
  const layout = await page.evaluate(() => {
    const map = document.getElementById('map').getBoundingClientRect();
    const tl = getComputedStyle(document.getElementById('timeline')).backgroundColor;
    const alpha = Number((tl.match(/[\d.]+(?=\)$)/) ?? [1])[0]);
    return {
      full: map.left === 0 && map.top === 0 && map.width === innerWidth && map.height === innerHeight,
      alpha: /rgba|\/ /.test(tl) ? alpha : 1,
      legendTop: document.getElementById('map-tools').getBoundingClientRect().top < document.querySelector('.sites').getBoundingClientRect().top,
      gone: !document.querySelector('#scene-list, #rule-card, button[data-zoom]'),
    };
  });
  check(layout.full, 'the map fills the whole window');
  check(layout.alpha < 1, `the timeline is see-through (background alpha ${layout.alpha})`);
  check(layout.legendTop, 'legend at top left, watched sites below it');
  check(layout.gone, 'no scene list, naming card or zoom buttons');

  const clickCodes = new Set();
  const clickDates = ['2024-10-30', '2024-12-03', '2025-03-24', '2026-02-14'];
  for (const d of dates) {
    await goDate(page, d);
    const info = await page.evaluate(() => {
      const s = window.__gbw;
      const shown = [...s.shown.values()];
      return {
        loaded: shown.every((x) => x.loaded),
        regions: shown.map((x) => x.scene.region),
        mock: shown.some((x) => x.scene.status === 'mock'),
        mockBanner: !document.getElementById('mock-banner').hidden,
        head: document.getElementById('scene-head').innerText,
        headDate: !!document.querySelector('#scene-head time'),
        zoom: s.view.map.getZoom(),
        frames: s.view.map.getSource('frames').serialize().data.features.map((f) => JSON.stringify(f.geometry.coordinates)),
        wantFrames: shown.map(({ scene }) => {
          const [w, so, e, n] = s.manifest.regions[scene.region].bbox;
          return JSON.stringify([[w, n], [e, n], [e, so], [w, so], [w, n]]);
        }),
        fits: (() => {
          const b = s.view.map.getBounds();
          return shown.every(({ scene }) => {
            const box = s.manifest.regions[scene.region].bbox;
            return b.getWest() <= box[0] + 0.01 && b.getEast() >= box[2] - 0.01 && b.getSouth() <= box[1] + 0.01 && b.getNorth() >= box[3] - 0.01;
          });
        })(),
      };
    });
    check(info.loaded, `${d} loads (${info.regions.join(', ')})`);
    check(info.mockBanner === info.mock, `${d} mock banner matches status`);
    check(/analysis date|held-out test/i.test(info.head), `${d} header shows the evidence level`);
    check(!info.headDate, `${d} top bar leaves the date to the timeline`);
    check(info.frames.length === info.wantFrames.length && info.frames.every((f, i) => f === info.wantFrames[i]), `${d}: only its own area's border is drawn (${info.regions.join(', ')})`);
    // In the opening date's area the view stays; a date in another area (the held-out
    // test date) fits that area instead.
    if (info.regions.join() === win.regions) check(Math.abs(info.zoom - win.zoom) < 1e-6, `${d}: changing the date keeps the map view`);
    else check(info.fits, `${d}: a date in another area (${info.regions.join(', ')}) fits the map to that area`);


    if (name === 'chrome' || clickDates.includes(d)) {
      await zoomToBlooms(page);
      const tally = await checkRenderedPixels(page);
      for (const [code, t] of Object.entries(tally)) {
        check(t.bad.length === 0, `${d} rendered class ${code} pixels match (${t.n} samples)`, t.bad.slice(0, 3).join(' '));
      }
      for (const c of await checkPixelClicks(page, d)) clickCodes.add(c);
      await page.evaluate(() => document.querySelector('[data-action="close-pixel"]')?.click());
      if (name === 'chrome') await page.screenshot({ path: path.join(OUT, `desktop-${d}.png`) });
      await page.evaluate(() => window.__gbw.view.fitTo(Object.values(window.__gbw.manifest.regions)[0].bbox));
      await idle(page);
    }
  }
  check([3, 4, 5, 6, 7, 8].every((c) => clickCodes.has(c)), `pixel clicks covered classes 3-8 (got ${[...clickCodes].sort()})`);

  // The legend lists the risk tiers from the highest down.
  const tierOrder = await page.evaluate(() => [...document.querySelectorAll('.legend-tier-name')].map((e) => e.textContent.trim().toLowerCase()));
  check(tierOrder.join() === 'high,watch,monitor,low,no flag,not assessed', 'the legend lists the tiers High, Watch, Monitor, Low, No flag, Not assessed', tierOrder.join(', '));

  // A dense bloom whose two comparisons pick different references stays unclassified (step 6).
  await goDate(page, '2026-02-14');
  const split = await page.evaluate(() => {
    const s = window.__gbw;
    const { grid, codes } = [...s.shown.values()].find((v) => v.loaded).loaded;
    const W = grid.width;
    const disagrees = (i) => {
      const cl = grid.cluster_id[i] != null ? s.clusters.get(grid.cluster_id[i]) : null;
      return codes[i] === 5 && cl && cl.best_ref_deriv !== cl.best_ref && s.references.get(cl.best_ref)?.group === 'bloom' && cl.margin >= s.manifest.rule.margin_min;
    };
    for (let i = W + 1; i < codes.length - W - 1; i++) {
      if (disagrees(i)) return { lon: grid.bbox[0] + ((i % W) + 0.5) * grid.res_deg[0], lat: grid.bbox[3] - (Math.floor(i / W) + 0.5) * grid.res_deg[1] };
    }
    return null;
  });
  if (split) {
    await page.evaluate(({ lon, lat }) => window.__gbw.view.map.jumpTo({ center: [lon, lat], zoom: 12 }), split);
    await idle(page);
    const pt = await page.evaluate(({ lon, lat }) => {
      const { map } = window.__gbw.view;
      const b = map.getCanvas().getBoundingClientRect();
      const q = map.project([lon, lat]);
      return { x: b.left + q.x, y: b.top + q.y };
    }, split);
    await page.mouse.click(pt.x, pt.y);
    await page.waitForSelector('.pixel-card[data-code]');
    const st = await page.evaluate(() => ({
      code: document.querySelector('.pixel-card').dataset.code,
      steps: [...document.querySelectorAll('.pixel-card .step')].map((li) => li.className.replace('step step-', '')),
      text: document.querySelector('.pixel-card .step:last-child')?.textContent ?? '',
      pigment: !!document.querySelector('.pixel-card .angles.has-deriv .angle-deriv.is-best'),
    }));
    check(st.code === '5' && st.steps.join() === 'pass,pass,pass,pass,pass,fail' && /pigment-feature/.test(st.text) && st.pigment,
      'a dense bloom whose shape and pigment-feature matches disagree fails step 6 and stays a dense unclassified bloom', JSON.stringify(st));
    await page.evaluate(() => document.querySelector('[data-action="close-pixel"]')?.click());
    await page.evaluate(() => window.__gbw.view.fitTo(Object.values(window.__gbw.manifest.regions)[0].bbox));
    await idle(page);
  } else console.log('  skip  no dense pixel with disagreeing comparisons on this date');

  // Assessed water between the shallow limit and the flag depth warns that the seabed may show.
  await goDate(page, '2026-02-14');
  await page.waitForFunction(() => window.__gbw.depth?.length > 0, null, { timeout: 20000 });
  const [lo, hi] = await page.evaluate(() => [window.__gbw.manifest.rule.shallow_max_m, window.__gbw.manifest.rule.shallow_flag_max_m]);
  await zoomToBlooms(page);
  // Flagged: at least the shallow limit and under the flag depth (whole metres).
  let flaggedCell = (await page.evaluate(findCellsFn, { codesWanted: [6], r: 1, max: 1, depthIn: [lo, hi - 1] }))[0];
  if (!flaggedCell) flaggedCell = (await page.evaluate(findCellsFn, { codesWanted: [3, 4], r: 1, max: 1, depthIn: [lo, hi - 1] }))[0];
  const deepCell = (await page.evaluate(findCellsFn, { codesWanted: [6, 3], r: 2, max: 1, depthIn: [hi + 1, 1e6] }))[0];
  const seabedOn = async (cell) => {
    await page.mouse.click(cell.x, cell.y);
    await page.waitForSelector('.pixel-card[data-code]');
    return page.evaluate((index) => {
      const card = document.querySelector('.pixel-card');
      return {
        note: card.querySelector('.note-seabed')?.textContent.replace(/\s+/g, ' ') ?? null,
        peek: card.querySelector('.peek-flag')?.title ?? '',
        chip: card.querySelector('.flag-chip[data-flag="shallow_zone"]')?.textContent.trim() ?? '',
        depth: (() => {
          const s = window.__gbw;
          const { grid } = [...s.shown.values()].find((v) => v.loaded).loaded;
          return (s.depth ?? []).find((d) => d.width === grid.width && d.height === grid.height && d.bbox.every((v, i) => Math.abs(v - grid.bbox[i]) < 1e-6))?.depth_m[index];
        })(),
      };
    }, cell.index);
  };
  if (flaggedCell) {
    const f = await seabedOn(flaggedCell);
    check(!!f.note && f.note.includes(`${f.depth} m deep`) && /seabed may affect this result/.test(f.note) && /seabed/i.test(f.peek) && /^Shallow \d+–\d+ m$/.test(f.chip),
      `a class ${flaggedCell.code} pixel ${f.depth} m deep carries the "${f.chip}" flag and warns that the seabed may affect the result, also when folded`, JSON.stringify(f));
  } else bad('found no assessed pixel in the flagged depth zone to click');
  if (deepCell) {
    const d = await seabedOn(deepCell);
    check(!d.note && !/seabed/i.test(d.peek) && !d.chip, `a pixel ${d.depth} m deep has no seabed flag`);
  }
  await page.evaluate(() => document.querySelector('[data-action="close-pixel"]')?.click());

  // Turbid water: non-bloom water best matching turbid water, with chlorophyll at bloom levels.
  const turbidCell = await page.evaluate(() => {
    const s = window.__gbw;
    const { grid, codes } = [...s.shown.values()].find((v) => v.loaded).loaded;
    const dense = s.manifest.rule.chl_dense_min;
    const W = grid.width;
    const turbid = (i) => {
      const cid = grid.cluster_id[i];
      return codes[i] === 3 && cid != null && s.clusters.get(cid)?.best_ref === 'water_turbid' && grid.chlor_a[i] >= dense;
    };
    for (let i = W + 1; i < codes.length - W - 1; i++) {
      if ([0, 1, -1, W, -W, W + 1, W - 1, -W + 1, -W - 1].every((o) => turbid(i + o))) {
        return { lon: grid.bbox[0] + ((i % W) + 0.5) * grid.res_deg[0], lat: grid.bbox[3] - (Math.floor(i / W) + 0.5) * grid.res_deg[1] };
      }
    }
    return null;
  });
  if (turbidCell) {
    await page.evaluate(({ lon, lat }) => window.__gbw.view.map.jumpTo({ center: [lon, lat], zoom: 10 }), turbidCell);
    await page.waitForTimeout(400);
    await idle(page);
    const at = await page.evaluate(({ lon, lat }) => {
      const m = window.__gbw.view.map;
      const q = m.project([lon, lat]);
      const b = m.getCanvas().getBoundingClientRect();
      return { x: q.x + b.left, y: q.y + b.top };
    }, turbidCell);
    await page.mouse.click(at.x, at.y);
    await page.waitForSelector('.pixel-card[data-code]');
    const t = await page.evaluate(() => {
      const card = document.querySelector('.pixel-card');
      return {
        code: card.dataset.code,
        chip: card.querySelector('.flag-chip[data-flag="turbid"]')?.textContent.trim() ?? '',
        note: card.querySelector('.note-turbid')?.textContent.replace(/\s+/g, ' ') ?? '',
        peek: card.querySelector('.peek-flag')?.title ?? '',
      };
    });
    check(t.code === '3' && t.chip === 'Turbid water' && /likely inflated by sediment/.test(t.note) && /turbid/i.test(t.peek),
      'non-bloom water that looks turbid with chlorophyll at bloom levels carries the "Turbid water" flag and the sediment note', JSON.stringify(t).slice(0, 200));
    await page.evaluate(() => document.querySelector('[data-action="close-pixel"]')?.click());
  } else bad('found no turbid high-chlorophyll pixel on 2026-02-14 to click');

  // The census has no flag counts; flags live in the pixel details.
  check(await page.evaluate(() => !document.querySelector('.flag-sum, .flag-show')), 'the census has no "Flags on this date" list');
  if (turbidCell) {
    await page.evaluate(({ lon, lat }) => window.__gbw.view.map.jumpTo({ center: [lon, lat], zoom: 10 }), turbidCell);
    await page.waitForTimeout(400);
    await idle(page);
    const at = await page.evaluate(({ lon, lat }) => {
      const m = window.__gbw.view.map;
      const q = m.project([lon, lat]);
      const b = m.getCanvas().getBoundingClientRect();
      return { x: q.x + b.left, y: q.y + b.top };
    }, turbidCell);
    await page.mouse.click(at.x, at.y);
  }
  await page.waitForSelector('.pixel-card .note-turbid', { timeout: 5000 }).catch(() => {});

  // The checklist follows the pixel's values; the notes on what can affect the result close the card.
  const order = await page.evaluate(() => {
    const body = document.querySelector('.pixel-card .sec-body-inner');
    const kids = [...body.children].map((el) => (el.matches('.pixel-values') ? 'values' : el.matches('.checklist') ? 'checklist' : el.matches('.cluster') ? 'cluster' : el.matches('.note-turbid') ? 'turbid' : el.matches('.note-seabed') ? 'seabed' : el.matches('.current-note') ? 'current' : null)).filter(Boolean);
    return kids;
  });
  const at = (k) => order.indexOf(k);
  check(at('checklist') === at('values') + 1 && at('turbid') > at('cluster') && at('cluster') > at('checklist') && (at('current') < 0 || at('current') > at('turbid')),
    `pixel details run values, checklist, …, cluster, then the notes (${order.join(' → ')})`);

  // Explanations stay folded behind a More button on their right; the text itself doesn't open them.
  const more = await page.evaluate(() => {
    const box = document.querySelector('.pixel-card .note-turbid');
    const btn = box.querySelector('.more-head > .more-toggle');
    return {
      folded: !box.classList.contains('is-open') && getComputedStyle(box.querySelector('.more-body-inner')).visibility === 'hidden',
      right: btn.getBoundingClientRect().left > box.querySelector('.more-text').getBoundingClientRect().right - 1,
      label: btn.getAttribute('aria-label'),
      text: btn.innerText.trim(),
    };
  });
  await page.click('.pixel-card .note-turbid .more-text');
  const textOpens = await page.evaluate(() => document.querySelector('.pixel-card .note-turbid').classList.contains('is-open'));
  await page.click('.pixel-card .note-turbid .more-toggle');
  await page.waitForTimeout(450);
  const opened = await page.evaluate(() => {
    const box = document.querySelector('.pixel-card .note-turbid');
    return { open: box.classList.contains('is-open'), expanded: box.querySelector('.more-toggle').getAttribute('aria-expanded'), visible: getComputedStyle(box.querySelector('.more-body-inner')).visibility, label: box.querySelector('.more-toggle').getAttribute('aria-label') };
  });
  check(more.folded && more.right && !more.text && /^More about turbid water$/.test(more.label) && !textOpens && opened.open && opened.expanded === 'true' && opened.visible === 'visible' && opened.label === 'Less about turbid water',
    'a flag\'s explanation stays folded behind an arrow button on its right, and only the arrow opens it', JSON.stringify({ more, textOpens, opened }));
  await page.click('.pixel-card .note-turbid .more-toggle');

  // The class precedence checklist folds behind its tally, which matches the checks.
  const list = await page.evaluate(() => {
    const box = document.querySelector('.pixel-card .checklist');
    const states = [...box.querySelectorAll('.step')].map((li) => li.className.match(/step-(\w+)/)[1]);
    return {
      title: box.querySelector('.fold-title').textContent,
      strip: [...box.querySelectorAll('.pstep')].map((el) => el.className.match(/pstep-(\w+)/)[1]).join(),
      steps: states.join(),
      word: box.querySelector('.fold-head .more-pill').innerText.trim(),
      marks: box.querySelectorAll('.pstep svg, .tallies svg, .step-mark svg, .step-result svg').length,
      numbers: [...box.querySelectorAll('.step-mark')].map((m) => m.textContent.trim()).join(),
      tally: box.querySelector('.fold-summary .tallies').textContent.replace(/\s+/g, ' ').trim(),
      folded: box.querySelector('.fold-head').getAttribute('aria-expanded') === 'false' && getComputedStyle(box.querySelector('.more-body-inner')).visibility === 'hidden',
      pass: states.filter((x) => x === 'pass').length,
      fail: states.filter((x) => x === 'fail').length,
      skip: states.filter((x) => x === 'skip').length,
    };
  });
  await page.click('.pixel-card .checklist .fold-head');
  await page.waitForTimeout(450);
  const listOpen = await page.evaluate(() => getComputedStyle(document.querySelector('.pixel-card .checklist .more-body-inner')).visibility === 'visible' && document.querySelector('.pixel-card .checklist .fold-head').getAttribute('aria-expanded') === 'true');
  check(list.title === 'Class precedence checklist' && list.folded && listOpen && list.strip === list.steps && !list.word && !list.marks && list.numbers === '1,2,3,4,5,6' && list.tally.startsWith(`${list.pass} pass ${list.fail} fail`) && (!list.skip || list.tally.includes(`${list.skip} not reached`)),
    `the class precedence checklist starts folded with its strip of checks and tally ("${list.tally}"), in color and words without ticks or crosses, and opens from its bar`, JSON.stringify(list));
  await page.click('.pixel-card .checklist .fold-head');
  await page.evaluate(() => document.querySelector('[data-action="close-pixel"]')?.click());

  // A C. polykrikoides-like pixel works its margin out from the shown angles and the
  // gap between its two best references.
  await zoomToBlooms(page);
  const cpCell = (await page.evaluate(findCellsFn, { codesWanted: [6], r: 2, max: 1 }))[0];
  if (cpCell) {
    await page.mouse.click(cpCell.x, cpCell.y);
    await page.waitForSelector('.pixel-card[data-code="6"]');
    const g = await page.evaluate(() => {
      const s = window.__gbw;
      const { grid } = [...s.shown.values()].find((v) => v.loaded).loaded;
      const col = Math.floor((s.selection.lon - grid.bbox[0]) / grid.res_deg[0]);
      const row = Math.floor((grid.bbox[3] - s.selection.lat) / grid.res_deg[1]);
      const cl = s.clusters.get(grid.cluster_id[row * grid.width + col]);
      const text = document.querySelector('.pixel-card').textContent.replace(/\s+/g, ' ');
      return { text, best: cl.sam_deg[cl.best_ref], second: cl.sam_deg[cl.second_ref], gap: cl.ref_gap_deg, margin: cl.margin };
    });
    const math = `(${g.second.toFixed(2)} − ${g.best.toFixed(2)}) ÷ ${g.gap.toFixed(2)} = ${g.margin.toFixed(2)}`;
    check(g.text.includes(math) && !/Gulf rule/i.test(g.text), `a C. polykrikoides-like pixel works out its margin from the angles and the reference gap (${math})`);
    await page.evaluate(() => document.querySelector('[data-action="close-pixel"]')?.click());
  }
  // A site whose nearest C. polykrikoides-like cell is in that zone says so.
  const seabedSite = await page.evaluate(([lo, hi]) => {
    const s = window.__gbw;
    for (const site of s.sites) {
      const st = s.siteStatuses.get(site.properties.site_id);
      const grid = st?.nearestIndex != null ? s.shown.get(st.region)?.loaded?.grid : null;
      const d = grid ? (s.depth ?? []).find((d) => d.width === grid.width && d.height === grid.height && d.bbox.every((v, i) => Math.abs(v - grid.bbox[i]) < 1e-6))?.depth_m[st.nearestIndex] : null;
      if (d != null && d >= lo && d < hi && (st.status === 'alert' || st.status === 'nearby')) return { id: site.properties.site_id, d };
    }
    return null;
  }, [lo, hi]);
  if (seabedSite) {
    await page.click(`.site-item[data-site="${seabedSite.id}"]`);
    await page.waitForSelector('.site-card');
    const text = (await page.locator('.site-card').innerText()).replace(/\s+/g, ' ');
    check(text.includes(`${seabedSite.d} m deep, where the seabed may affect the result`), `a site whose nearest flagged cell is ${seabedSite.d} m deep says the seabed may affect it`);
    await page.evaluate(() => document.querySelector('[data-action="close-site"]')?.click());
  } else console.log('  skip  no site has its nearest C. polykrikoides-like cell in the flagged depth zone on 2026-02-14');

  // Zoomed right in, a drawn cell's color changes exactly at its true edges: at the
  // north-west corner of a C. polykrikoides-like patch.
  const corner = await page.evaluate(() => {
    const x = [...window.__gbw.shown.values()].find((v) => v.loaded);
    const { grid: g, codes: c } = x.loaded;
    const W = g.width;
    const cp = (i) => c[i] === 6;
    const other = (i) => c[i] >= 3 && c[i] !== 6;
    for (let i = W + 1; i < c.length - W - 1; i++) {
      if (cp(i) && cp(i + 1) && cp(i + W) && cp(i + W + 1) && other(i - 1) && other(i - W) && other(i - W - 1)) {
        return { west: g.bbox[0] + (i % W) * g.res_deg[0], north: g.bbox[3] - Math.floor(i / W) * g.res_deg[1] };
      }
    }
    return null;
  });
  if (corner) {
    await page.evaluate(({ west, north }) => window.__gbw.view.map.jumpTo({ center: [west, north], zoom: 12.5 }), corner);
    await page.waitForTimeout(400);
    await idle(page);
    const at = await page.evaluate(({ west, north }) => {
      const m = window.__gbw.view.map;
      const q = m.project([west, north]);
      const b = m.getCanvas().getBoundingClientRect();
      return { x: Math.round(q.x + b.left), y: Math.round(q.y + b.top) };
    }, corner);
    // 20 px into the patch, across its west edge and across its north edge (within a
    // device pixel: the edge pixel itself can round either way).
    const across = [];
    for (let d = -6; d <= 6; d++) across.push({ axis: 'x', d, x: at.x + d, y: at.y + 20 }, { axis: 'y', d, x: at.x + 20, y: at.y + d });
    const px = await sampleScreen(page, across);
    const red = ([r, g, b]) => r > 140 && g < 100 && b < 100; // C. polykrikoides-like, not the oranges
    const firstRed = (axis) => px.filter((p) => p.axis === axis && red(p.rgb)).reduce((m, p) => Math.min(m, p.d), 99);
    const lastOther = (axis) => px.filter((p) => p.axis === axis && p.d < 0 && !red(p.rgb) && Math.max(...p.rgb) > 150).reduce((m, p) => Math.max(m, p.d), -99);
    const ex = firstRed('x');
    const ey = firstRed('y');
    check(ex >= -1 && ex <= 2 && ey >= -1 && ey <= 2 && lastOther('x') >= -3 && lastOther('y') >= -3,
      `zoomed in, cells are drawn on their true edges (color changes ${ex} px and ${ey} px past the edges)`);
  } else console.log('  skip  no patch corner to check alignment at');

  // Clicking from pixel to pixel keeps the details where they were.
  await page.evaluate(() => window.__gbw.view.fitTo(Object.values(window.__gbw.manifest.regions)[0].bbox));
  await idle(page);
  if (!(await page.evaluate(() => matchMedia('(max-width: 760px)').matches))) {
    await zoomToBlooms(page);
    let pair = await page.evaluate(findCellsFn, { codesWanted: [6, 7], r: 2, max: 1 });
    if (pair.length < 2) pair = await page.evaluate(findCellsFn, { codesWanted: [6, 7], r: 1, max: 1 });
    if (pair.length === 2) {
      await page.mouse.click(pair[0].x, pair[0].y);
      await page.waitForSelector('.spectrum-card, [data-sec="spectrum"]');
      const before = await page.evaluate(() => {
        const sc = document.getElementById('insp-scroll');
        const sec = document.querySelector('[data-sec="spectrum"]');
        sc.scrollTop += sec.getBoundingClientRect().top - sc.getBoundingClientRect().top - 10;
        return { top: sc.scrollTop, at: sec.getBoundingClientRect().top };
      });
      await page.mouse.click(pair[1].x, pair[1].y);
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => ({ top: document.getElementById('insp-scroll').scrollTop, at: document.querySelector('[data-sec="spectrum"]').getBoundingClientRect().top, code: document.querySelector('.pixel-card').dataset.code }));
      check(before.top > 0 && Math.abs(after.at - before.at) <= 2 && after.code === String(pair[1].code),
        `clicking another pixel keeps the details scrolled to the same section (spectrum at ${Math.round(before.at)} px, then ${Math.round(after.at)} px)`);
      await page.evaluate(() => document.querySelector('[data-action="close-pixel"]')?.click());
    } else console.log('  skip  needed two bloom pixels to compare');
  }
  await page.evaluate(() => window.__gbw.view.fitTo(Object.values(window.__gbw.manifest.regions)[0].bbox));
  await idle(page);

  // Timeline: a continuous axis with every date that has data marked, in order.
  const marks = await page.$$eval('.tl-marker[data-date]', (b) => b.map((x) => ({ date: x.dataset.date, x: parseFloat(x.style.left) })));
  check(
    marks.length === dates.length && marks.every((m, i) => i === 0 || (m.date > marks[i - 1].date && m.x > marks[i - 1].x)),
    `timeline marks all ${marks.length} dates with data, placed in time order`,
  );
  const gap = (a, b) => marks.find((m) => m.date === b).x - marks.find((m) => m.date === a).x;
  check(Math.abs(gap('2024-10-11', '2024-10-30') / 19 - gap('2024-12-03', '2024-12-09') / 6) < 0.01, 'distance on the axis is proportional to time');
  await goDate(page, '2025-06-01');
  await page.click('.timeline button[data-next]');
  const afterGap = dates.find((d) => d > '2025-06-01');
  await waitForDate(page, afterGap);
  await page.click('.timeline button[data-next]');
  const second = dates.find((d) => d > afterGap);
  await waitForDate(page, second);
  check(page.url().endsWith(`#date=${second}`), `the next-event button (>|) steps to the next date with data (${afterGap}, then ${second})`);
  await goDate(page, dates.at(-1));
  check(await page.isDisabled('.timeline button[data-next]'), 'the next-event button rests on the last date with data');
  await goDate(page, '2024-10-30');
  await page.click('.tl-marker[data-date="2025-03-24"]');
  await waitForDate(page, '2025-03-24');
  await page.goBack();
  await waitForDate(page, '2024-10-30');
  ok('clicking a marked date opens it; browser Back returns');
  await goDate(page, '2025-03-24');
  await page.click('.timeline button[data-day="1"]');
  await waitForDate(page, '2025-03-25');
  check(await page.inputValue('input[data-unit="day"]') === '25', 'the one-day arrow moves to the next calendar day');
  await page.fill('input[data-unit="year"]', '2025');
  await page.press('input[data-unit="year"]', 'Enter');
  await page.fill('input[data-unit="month"]', 'mar');
  await page.press('input[data-unit="month"]', 'Enter');
  await page.fill('input[data-unit="day"]', '15');
  await page.press('input[data-unit="day"]', 'Enter');
  await waitForDate(page, '2025-03-15');
  ok('typing year, month and day picks that date');
  await page.click('.tl-field-month [data-spin="month:1"]');
  await waitForDate(page, '2025-04-15');
  ok('the month stepper moves one month');
  // Zoom toggle: up = coarser, down = finer, with the level shown between the arrows.
  for (const [stepBtn, level] of [['-1', 'Year'], ['1', 'Month'], ['1', 'Day'], ['-1', 'Month']]) {
    await page.click(`.tl-zoom [data-zoom-step="${stepBtn}"]`);
    const z = await page.evaluate(() => {
      const axis = document.querySelector('.tl-axis').getBoundingClientRect();
      const pick = document.querySelector('.tl-pick').getBoundingClientRect();
      return { label: document.querySelector('.tl-zoom-label').textContent, inView: pick.left >= axis.left && pick.left <= axis.right };
    });
    check(z.label === level && z.inView, `timeline zoom toggle shows "${level}" and keeps the selected day in view`);
  }

  // Folding the timeline leaves only the date controls; unfolding brings the axis back.
  const wide = (await page.locator('#timeline').boundingBox()).width;
  await page.click('.timeline [data-fold]');
  const folded = await page.evaluate(() => ({
    axis: document.querySelector('.tl-axis').getClientRects().length,
    side: document.querySelector('.tl-side').getClientRects().length,
    picker: ['input[data-unit="day"]', '[data-day="1"]', '[data-next]'].every((q) => document.querySelector(`.timeline ${q}`).getClientRects().length > 0),
    width: document.getElementById('timeline').getBoundingClientRect().width,
  }));
  check(!folded.axis && !folded.side && folded.picker && folded.width < wide / 2, `folding the timeline keeps only the date, day arrows and next-event button (${Math.round(folded.width)} px wide)`);
  await page.click('.timeline [data-fold]');
  check(await page.evaluate(() => document.querySelector('.tl-axis').getClientRects().length > 0 && document.querySelector('.tl-pick').getBoundingClientRect().width >= 0), 'unfolding brings the axis back');

  // A day without a processed scene.
  await goDate(page, '2025-06-01');
  const empty = await page.evaluate(() => ({
    status: document.getElementById('map-status').innerText,
    sites: [...document.querySelectorAll('.site-item')].map((b) => b.innerText),
  }));
  check(/No processed scene on 1 Jun 2025/.test(empty.status) && empty.sites.every((t) => /Unknown/.test(t)), 'a day without data says so and sites show Unknown');
  check(await page.isDisabled('#currents') && /not prepared for this date/.test(await page.locator('.map-tools').innerText()), 'a day without data has no currents, and the toggle says so');
  await page.click('#map-status button[data-goto="2025-04-06"]');
  await waitForDate(page, '2025-04-06');
  ok('"Nearest" jumps to the closest date with data');

  // Outside the area is dimmed; site statuses share one width, without borders.
  check(await page.evaluate(() => !!window.__gbw.view.map.getLayer('outside') && window.__gbw.view.map.getSource('outside').serialize().data?.geometry?.coordinates?.length === 2), 'the map outside the area is dimmed');
  const badges = await page.$$eval('.site-item .badge', (b) => b.map((x) => ({ w: Math.round(x.getBoundingClientRect().width), border: getComputedStyle(x).borderTopColor })));
  check(new Set(badges.map((b) => b.w)).size === 1 && badges.every((b) => /, 0\)$|transparent/.test(b.border)), `site status labels share one width without borders (${badges[0]?.w}px)`);

  // About and limits.
  await page.click('#about-btn');
  const about = await page.locator('#about').innerText();
  check(
    /Known limits/i.test(about) && /separation score, not a probability/.test(about) && /Held-out test date/.test(about) && /mock data/i.test(about) &&
      /nflh/.test(about) && /not assessed/.test(about) && /assessed but flagged/.test(about) && /Right at the shore/.test(about) && /30 m/.test(about) && /Next steps/i.test(about),
    'About and limits opens with the method (two-signal gate, shallow not assessed, shallow flag), evidence levels, limits (including the shore), next steps and the mock notice',
  );
  await page.keyboard.press('Escape');
  check(await page.evaluate(() => !document.getElementById('about').open), 'Escape closes About and limits');

  // Light and dark: the toggle flips the theme and recolors the basemap.
  const before = await page.evaluate(() => window.__gbw.view.map.getPaintProperty('land', 'background-color'));
  const cursorsOf = () => page.evaluate(() => ({
    map: getComputedStyle(document.querySelector('.maplibregl-canvas')).cursor,
    body: getComputedStyle(document.body).cursor,
    button: getComputedStyle(document.querySelector('.seg')).cursor,
  }));
  const lightCursors = await cursorsOf();
  await page.click('#theme-btn');
  const after = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    land: window.__gbw.view.map.getPaintProperty('land', 'background-color'),
    bg: getComputedStyle(document.body).backgroundColor,
  }));
  check(after.theme === 'dark' && after.land !== before, `theme toggle switches to dark and recolors the map (${before} → ${after.land})`);
  const darkCursors = await cursorsOf();
  const isDark = (c, fallback) => /^url\("data:image\/svg\+xml,.*%2316191d/.test(c) && c.endsWith(fallback);
  check(isDark(lightCursors.map, 'crosshair') && isDark(lightCursors.body, 'default') && isDark(lightCursors.button, 'pointer') &&
    darkCursors.map === 'crosshair' && ['auto', 'default'].includes(darkCursors.body) && darkCursors.button === 'pointer',
    `in light mode the map's crosshair, the arrow and the hand are dark copies of the system's; in dark mode they are the system's (${darkCursors.map}, ${darkCursors.body}, ${darkCursors.button})`);
  if (name === 'chrome') await page.screenshot({ path: path.join(OUT, 'desktop-dark.png') });
  await page.click('#theme-btn');
  check(await page.evaluate(() => !document.documentElement.dataset.theme), 'toggling again returns to the system theme');

  // Markers stay pinned to their coordinates at every zoom.
  const drift = [];
  for (const z of [6, 8, 10]) {
    await page.evaluate((zoom) => window.__gbw.view.map.jumpTo({ center: [55.03, 25.07], zoom }), z);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    drift.push(
      ...(await page.evaluate(() => {
        const map = window.__gbw.view.map;
        const box = map.getContainer().getBoundingClientRect();
        return [...document.querySelectorAll('.site-marker')].map((el) => {
          const site = window.__gbw.sites.find((s) => s.properties.site_id === el.dataset.site);
          const p = map.project(site.geometry.coordinates);
          const r = el.getBoundingClientRect();
          return Math.hypot(r.left + r.width / 2 - box.left - p.x, r.top + r.height / 2 - box.top - p.y);
        });
      })),
    );
  }
  check(drift.length >= 24 && Math.max(...drift) < 2, `site markers stay on their coordinates at zoom 6, 8 and 10 (max ${Math.max(...drift).toFixed(2)} px)`);

  // Clean coastline: data cells lying on the basemap's land are cut out of the overlay.
  await goDate(page, '2026-02-14');
  await zoomToBox(page, [54.0, 24.2, 56.0, 25.8]);
  await page.evaluate(findCellsFn, { codesWanted: [], r: 0, max: 0 }); // defines window.__onLand
  const landCells = await page.evaluate(() => {
    const s = window.__gbw;
    const { grid, codes } = [...s.shown.values()].find((v) => v.loaded).loaded;
    const map = s.view.map;
    const box = map.getCanvas().getBoundingClientRect();
    const covers = [...document.querySelectorAll('.panel, .panel-tab, .panel-edge, .maplibregl-ctrl, .readout')].filter((el) => el.getClientRects().length > 0).map((el) => el.getBoundingClientRect());
    const covered = (x, y) => covers.some((r) => x > r.left - 6 && x < r.right + 6 && y > r.top - 6 && y < r.bottom + 6);
    const d = grid.res_deg[0] * 0.3;
    const out = [];
    for (let i = 0; i < codes.length && out.length < 12; i++) {
      if (codes[i] < 3) continue; // shallow is a hatch, not a solid color
      const lon = grid.bbox[0] + ((i % grid.width) + 0.5) * grid.res_deg[0];
      const lat = grid.bbox[3] - (Math.floor(i / grid.width) + 0.5) * grid.res_deg[1];
      const p = map.project([lon, lat]);
      if (p.x < 6 || p.y < 6 || p.x > box.width - 6 || p.y > box.height - 6 || covered(p.x + box.left, p.y + box.top)) continue;
      if (![[0, 0], [d, 0], [-d, 0], [0, d], [0, -d]].every(([dx, dy]) => window.__onLand(lon + dx, lat + dy))) continue;
      out.push({ code: codes[i], x: Math.round(p.x + box.left), y: Math.round(p.y + box.top) });
    }
    return out;
  });
  if (!landCells.length) console.log('  note  no data cells lie on the basemap land in view; coastline cut not sampled');
  else {
    const keyOf = await page.evaluate(() => Object.fromEntries(window.__gbw.manifest.classes.map((k) => [k.code, k.key])));
    const colors = { clear: [0x55, 0x98, 0xe7], weak_unclassified: [0xf2, 0xcf, 0x63], dense_unclassified: [0xd9, 0x8a, 0x1c], cp_like: [0xd0, 0x3b, 0x3b], noctiluca_like: [0xb8, 0x41, 0x8f], diatom_like: [0x2f, 0x9c, 0x84] };
    const near = (rgb, c) => !!c && Math.hypot(...rgb.map((v, i) => v - c[i])) < 40;
    const on = await sampleScreen(page, landCells);
    check(on.every((p) => !near(p.rgb, colors[keyOf[p.code]])), `clean coastline: data pixels over land are cut out (${on.length} samples)`);
    await page.uncheck('#landtop');
    await page.waitForTimeout(500);
    await idle(page);
    const off = await sampleScreen(page, landCells);
    check(off.filter((p) => near(p.rgb, colors[keyOf[p.code]])).length >= off.length * 0.75, 'turning "Clean coastline" off shows those pixels again');
    await page.check('#landtop');
    await page.waitForTimeout(500);
  }

  // Sites: every one listed with a status, explained per area, with its location's source.
  await goDate(page, '2026-02-14');
  const nSites = await page.evaluate(() => window.__gbw.sites.length);
  const sites = await page.$$eval('.site-item', (b) => b.map((x) => x.textContent.replace(/\s+/g, ' ')));
  check(sites.length === nSites && sites.some((t) => /Alert|Nearby/.test(t)) && !sites.some((t) => /Watch/.test(t)) && !sites.some((t) => /no processed pass/.test(t)), `all ${nSites} sites have a status on this date (Alert, Nearby, Clear or Unknown)`, sites.slice(0, 5).join(' | '));
  check((await page.$$('.site-marker')).length === nSites, 'all site markers on the map');
  await page.click('.site-item >> nth=4');
  await page.waitForSelector('.site-card');
  const siteText = await page.locator('.site-card').innerText();
  check(/km|No usable water|No C\. polykrikoides/.test(siteText) && /Location: /.test(siteText), 'clicking a site explains its status and names where its location comes from');
  await page.click('[data-action="close-site"]');

  // Distances are by sea: land in the way (Musandam) makes a bloom far, open water doesn't.
  const sea = await page.evaluate(async () => {
    const { siteStatus } = await import('/src/sites.js');
    const s = window.__gbw;
    const { grid, codes } = [...s.shown.values()].find((v) => v.loaded).loaded;
    const cp = [];
    for (let i = 0; i < codes.length; i++) if (codes[i] === 6) cp.push(i);
    const straight = (site) => {
      const [lo, la] = site.geometry.coordinates;
      const k = 111.32 * Math.cos((la * Math.PI) / 180);
      let m = Infinity;
      for (const i of cp) {
        const lon = grid.bbox[0] + ((i % grid.width) + 0.5) * grid.res_deg[0];
        const lat = grid.bbox[3] - (Math.floor(i / grid.width) + 0.5) * grid.res_deg[1];
        m = Math.min(m, Math.hypot((lon - lo) * k, (lat - la) * 110.574));
      }
      return m;
    };
    const one = (id) => {
      const site = s.sites.find((t) => t.properties.site_id === id);
      return site && { ...siteStatus(site, grid, codes), straight: straight(site) };
    };
    return { east: one('gulf_desal_khorfakkan'), open: one('gulf_beach_alkhan') };
  });
  if (sea.east && sea.open) {
    check(sea.east.straight < 75 && sea.east.status !== 'alert' && sea.east.status !== 'nearby',
      `a bloom across Musandam isn't near by sea: Khor Fakkan is ${sea.east.straight.toFixed(0)} km away in a straight line, and ${sea.east.status} by sea`);
    check(sea.open.nearestKm != null && Math.abs(sea.open.nearestKm - sea.open.straight) <= sea.open.straight * 0.05 + 0.5,
      `in open water the sea distance is the straight line (Al Khan Beach ${sea.open.nearestKm?.toFixed(1)} km, straight ${sea.open.straight.toFixed(1)} km)`);
  } else console.log('  skip  the sea-distance sites are missing');

  // Map controls: scale and attribution bottom right above the timeline. The dock right of
  // the timeline has two columns: city names over measuring, then zoom in over zoom out.
  const stack = await page.evaluate(() => {
    const r = (q) => document.querySelector(q)?.getBoundingClientRect();
    const tl = r('#timeline');
    const dock = r('#map-dock');
    const zin = r('#map-dock .maplibregl-ctrl-zoom-in');
    const zout = r('#map-dock .maplibregl-ctrl-zoom-out');
    const names = r('#map-dock [data-dock="places"]');
    const ruler = r('#map-dock [data-dock="measure"]');
    const scale = r('.maplibregl-ctrl-bottom-right .maplibregl-ctrl-scale');
    const attrib = r('.maplibregl-ctrl-bottom-right .maplibregl-ctrl-attrib');
    const ok = !!(tl && dock && zin && zout && names && ruler && scale && attrib);
    return ok && tl.right <= dock.left && dock.bottom <= tl.bottom + 1 && dock.top >= tl.top - 1 &&
      Math.abs(zin.left - zout.left) < 1 && zin.bottom <= zout.top + 1 && Math.abs(names.left - ruler.left) < 1 && names.bottom <= ruler.top + 1 &&
      names.right <= zin.left && Math.abs(zin.right - dock.right) < 2 && !document.querySelector('#map-dock .site-toggle') &&
      scale.bottom <= tl.top && attrib.bottom <= tl.top && !document.querySelector('.maplibregl-ctrl-top-right .maplibregl-ctrl');
  });
  check(stack, 'the dock right of the timeline has city names over measuring, and zoom in over zoom out at the far right; the scale and attribution sit bottom right above it');
  // The site toggles hang under the watched-sites tab, outside the panel, at the place where
  // the slid-away tab ends (so they never move); with the panel shown the short tab leaves a gap.
  const edge = await page.evaluate(() => {
    const sites = document.getElementById('sites');
    const tab = sites.querySelector(':scope > .panel-tab').getBoundingClientRect();
    const tg = sites.querySelector(':scope > .site-toggles')?.getBoundingClientRect();
    const panel = sites.getBoundingClientRect();
    const away = parseFloat(getComputedStyle(sites).getPropertyValue('--sites-tab-away'));
    return tg && {
      fixed: Math.abs(tg.top - (panel.top + 10 + away)) <= 1, gap: Math.round((tg.top - tab.bottom) * 10) / 10,
      left: Math.abs(tg.left - tab.left) < 1, width: Math.abs(tg.width - tab.width) < 1, outside: tg.left >= panel.right - 1, stacked: tg.height > tg.width * 2,
    };
  });
  check(edge && edge.fixed && edge.gap >= 0 && edge.left && edge.width && edge.outside && edge.stacked,
    'the site-type toggles stack under the watched-sites tab, outside the panel, where the slid-away tab ends', JSON.stringify(edge));
  const z0 = await page.evaluate(() => window.__gbw.view.map.getZoom());
  await page.click('#map-dock .maplibregl-ctrl-zoom-in');
  await page.waitForTimeout(600);
  check(await page.evaluate((z) => window.__gbw.view.map.getZoom() > z + 0.5, z0), 'the dock zoom button zooms the map');
  // Each type's toggle hides and shows its markers and list entries.
  const types = await page.$$eval('.site-toggle', (b) => b.map((x) => x.dataset.siteType));
  for (const t of types) {
    await page.click(`.site-toggle[data-site-type="${t}"]`);
    const off = await page.evaluate((t) => {
      const s = window.__gbw;
      const typeOf = (id) => s.sites.find((x) => x.properties.site_id === id)?.properties.type;
      const markers = [...document.querySelectorAll('.site-marker')].map((m) => typeOf(m.dataset.site));
      const items = [...document.querySelectorAll('.site-item')].map((m) => typeOf(m.dataset.site));
      const n = s.sites.filter((x) => x.properties.type !== t).length;
      return { ok: !markers.includes(t) && !items.includes(t) && markers.length === n && items.length === n, pressed: document.querySelector(`.site-toggle[data-site-type="${t}"]`).getAttribute('aria-pressed') };
    }, t);
    await page.click(`.site-toggle[data-site-type="${t}"]`);
    const back = await page.evaluate((n) => document.querySelectorAll('.site-marker').length === n && document.querySelectorAll('.site-item').length === n, nSites);
    check(off.ok && off.pressed === 'false' && back, `the ${t} toggle hides those sites from the map and the list, and brings them back`);
  }
  // Switching site types off never moves the sites panel or its toggles.
  const sitesAt = () => page.evaluate(() => ({ panel: document.getElementById('sites').getBoundingClientRect().top, toggles: document.querySelector('#sites > .site-toggles').getBoundingClientRect().top }));
  const sitesBefore = await sitesAt();
  for (const t of types) await page.click(`.site-toggle[data-site-type="${t}"]`);
  const allOff = await sitesAt();
  const emptyNote = await page.evaluate(() => document.getElementById('site-list').innerText);
  const fewest = await page.evaluate((types) => types.map((t) => [t, window.__gbw.sites.filter((x) => x.properties.type === t).length]).sort((a, b) => a[1] - b[1])[0][0], types);
  await page.click(`.site-toggle[data-site-type="${fewest}"]`);
  const oneOn = await sitesAt();
  for (const t of types) if (t !== fewest) await page.click(`.site-toggle[data-site-type="${t}"]`);
  const stillAt = (a) => Math.abs(a.panel - sitesBefore.panel) < 1 && Math.abs(a.toggles - sitesBefore.toggles) < 1;
  check(stillAt(allOff) && stillAt(oneOn) && /switched off/.test(emptyNote),
    `the sites panel and its toggles stay put with every site type off, or only ${fewest} on`, JSON.stringify({ sitesBefore, allOff, oneOn }));

  // Surface currents: prepared for every scene date; particles animate, patches get drift tracks.
  const curDates = await page.evaluate(() => [...window.__gbw.currentsIndex]);
  check(dates.every((d) => curDates.includes(d)), `surface currents are prepared for all ${dates.length} scene dates`, dates.filter((d) => !curDates.includes(d)).join(', '));
  await page.check('#currents');
  await page.waitForFunction(() => window.__gbw.currents && window.__gbw.flow.isRunning(), null, { timeout: 15000 });
  await page.waitForTimeout(500);
  const flowFrame = () => page.evaluate(() => document.querySelector('.flow-canvas').toDataURL());
  const frameA = await flowFrame();
  await page.waitForTimeout(300);
  const frameB = await flowFrame();
  const driftKinds = await page.evaluate(() => window.__gbw.view.map.getSource('drift').serialize().data.features.map((f) => f.properties.kind));
  const nTracks = driftKinds.filter((k) => k === 'track').length;
  check(frameA !== frameB && frameA.length > 5000 && nTracks > 0 && driftKinds.includes('h24'),
    `surface currents animate, and ${nTracks} C. polykrikoides-like patches get 48-hour drift tracks`);
  const patchSeed = await page.evaluate(() => {
    const x = [...window.__gbw.shown.values()].find((v) => v.loaded);
    const p = x.loaded.patches?.[0];
    return p ? { lon: p.lon, lat: p.lat } : null;
  });
  if (patchSeed) {
    await page.evaluate(({ lon, lat }) => window.__gbw.view.map.jumpTo({ center: [lon, lat], zoom: 9 }), patchSeed);
    await page.waitForTimeout(400);
    await idle(page);
    const at = await page.evaluate(({ lon, lat }) => {
      const m = window.__gbw.view.map;
      const q = m.project([lon, lat]);
      const b = m.getCanvas().getBoundingClientRect();
      return { x: q.x + b.left, y: q.y + b.top };
    }, patchSeed);
    await page.mouse.click(at.x, at.y);
    await page.waitForSelector('.pixel-card[data-code="6"]');
    const note = (await page.locator('.current-note').innerText()).replace(/\s+/g, ' ');
    check(/km\/h toward the \w+/.test(note) && /(drifts about \d+ km|reaches the coast)/.test(note) && /model estimate/i.test(note),
      'a C. polykrikoides-like pixel shows the current there and its patch drift, as a model estimate', note.slice(0, 160));
    const tipState = () => page.evaluate(() => {
      const t = document.querySelector('.hover-tip');
      return { shown: !!t && !t.hidden, text: t?.textContent ?? '' };
    });
    const noteBox = await page.locator('.current-note .sub-label').boundingBox();
    await page.mouse.move(noteBox.x + 20, noteBox.y + 5);
    await page.mouse.move(noteBox.x + 30, noteBox.y + 6);
    await page.waitForTimeout(200);
    const t1 = await tipState();
    const tipGap = await page.evaluate(({ x, y }) => {
      const r = document.querySelector('.hover-tip').getBoundingClientRect();
      return { dx: Math.round(r.left - x), dy: Math.round(r.top - y), flippedX: r.right <= x, flippedY: r.bottom <= y };
    }, { x: noteBox.x + 30, y: noteBox.y + 6 });
    check((tipGap.flippedX || (tipGap.dx >= 10 && tipGap.dx <= 20)) && (tipGap.flippedY || (tipGap.dy >= -2 && tipGap.dy <= 8)),
      `the explanation window opens right beside the pointer (${tipGap.dx}, ${tipGap.dy} px)`, JSON.stringify(tipGap));
    await page.mouse.move(5, 450);
    await page.waitForTimeout(200);
    const t2 = await tipState();
    check(await page.evaluate(() => !document.querySelector('.current-note .more-toggle, .current-note .more-body')) && t1.shown && /Open-Meteo/.test(t1.text) && !t2.shown,
      'hovering the surface current note shows its explanation in a small window by the pointer, with nothing to expand', JSON.stringify({ t1, t2 }));
    await page.evaluate(() => document.querySelector('[data-action="close-pixel"]')?.click());
  }
  const credits = await page.evaluate(() => {
    const el = document.querySelector('.maplibregl-ctrl-attrib-inner');
    return { h: el.getBoundingClientRect().height, text: el.textContent, lineH: parseFloat(getComputedStyle(el).lineHeight) || 16 };
  });
  check(/Currents: Open-Meteo/.test(credits.text) && credits.h <= credits.lineH * 1.5,
    `with the currents on, the map credits stay on one line (${Math.round(credits.h)} px)`, credits.text);
  await page.uncheck('#currents');
  await page.waitForTimeout(200);
  check(await page.evaluate(() => document.querySelector('.flow-canvas').hidden && window.__gbw.view.map.getLayoutProperty('drift-track', 'visibility') === 'none' && !window.__gbw.flow.isRunning()),
    'turning surface currents off hides the particles and the tracks');
  await page.evaluate(() => window.__gbw.view.fitTo(Object.values(window.__gbw.manifest.regions)[0].bbox));
  await idle(page);

  // The legend keeps its scroll position when a display option redraws it.
  {
    const size = page.viewportSize();
    if (size.width > 760) {
      await page.setViewportSize({ width: size.width, height: 600 });
      await page.waitForTimeout(400);
      const before = await page.evaluate(() => {
        const b = document.getElementById('tools-body');
        b.scrollTop = b.scrollHeight;
        return { top: b.scrollTop, room: b.scrollHeight - b.clientHeight };
      });
      await page.click('#truecolor');
      await page.waitForTimeout(300);
      const after = await page.evaluate(() => document.getElementById('tools-body').scrollTop);
      await page.click('#truecolor');
      await page.setViewportSize(size);
      await page.waitForTimeout(400);
      if (before.room > 0) check(after === before.top, `toggling the true-color photo keeps the legend where it was scrolled (${before.top} px, then ${after} px)`);
      else console.log('  skip  the legend fits without scrolling at 600 px');
    }
  }

  // Layers and the chlorophyll legend. Switching slides the dark marker and the legend.
  await page.click('button[data-layer="chl"]');
  const slide = await page.evaluate(async () => {
    const th = document.querySelector('.seg-thumb');
    const start = new DOMMatrix(getComputedStyle(th).transform).m41;
    await new Promise((r) => setTimeout(r, 450));
    const t = th.getBoundingClientRect();
    const b = document.querySelector('.seg.is-on').getBoundingClientRect();
    return { start: Math.round(start), aligned: Math.abs(t.left - b.left) < 1.5 && Math.abs(t.width - b.width) < 1.5, enter: document.querySelector('.legend-swap')?.className ?? '' };
  });
  check(slide.aligned && slide.start < 60 && /enter-from-right/.test(slide.enter),
    `switching layers slides the marker to the chosen button and the legend in from that side (${slide.enter})`, JSON.stringify(slide));
  const legend = await page.locator('.chl-legend').innerText();
  const rule = await page.evaluate(() => window.__gbw.manifest.rule);
  check(legend.includes(`weak ${rule.chl_weak_min}`) && legend.includes(`dense ${rule.chl_dense_min}`), 'chlorophyll legend marks the gates from the manifest');
  const ramp = await page.evaluate(() => document.querySelector('.chl-bar').style.background);
  check(/^linear-gradient\(90deg, rgb\(8, 48, 107\)/.test(ramp) && /rgb\(122, 10, 18\) 100%\)$/.test(ramp), 'chlorophyll scale runs from dark blue to dark red', ramp);
  check(await page.evaluate(() => !document.querySelector('.chl-legend .panel-note, .chl-legend .more')), 'the chlorophyll scale has no description under it');
  const ends = await page.$$eval('.chl-ticks span', (t) => [t[0].textContent, t.at(-1).textContent]);
  // Hovering the map marks the pixel's chlorophyll on the scale.
  await zoomToBlooms(page);
  const hoverCells = await page.evaluate(findCellsFn, { codesWanted: [3, 6], r: 2, max: 1 });
  const cursorAt = {};
  for (const t of hoverCells) {
    await page.mouse.move(t.x, t.y);
    await page.waitForTimeout(250);
    cursorAt[t.code] = await page.evaluate(async ({ scene, index }) => {
      const { chlColor } = await import('/src/scales.js');
      const x = [...window.__gbw.shown.values()].find((v) => v.scene.scene_id === scene);
      const cur = document.querySelector('.chl-cursor');
      const gates = [...document.querySelectorAll('.chl-gate')].map((g) => parseFloat(g.style.left));
      const bg = getComputedStyle(cur.firstElementChild).backgroundColor.match(/\d+/g).slice(0, 3).map(Number);
      const chip = document.querySelector('#readout .readout-value');
      return {
        on: cur.classList.contains('is-on'), left: parseFloat(cur.style.left), text: cur.textContent, chl: x.loaded.grid.chlor_a[index], gates, bg, want: chlColor(x.loaded.grid.chlor_a[index]),
        chip: chip && getComputedStyle(chip).backgroundColor.match(/\d+/g).slice(0, 3).map(Number), chipText: chip?.textContent ?? '',
      };
    }, t);
  }
  const cw = cursorAt[3];
  const cc6 = cursorAt[6];
  check(
    cw?.on && cc6?.on && cw.text.startsWith(cw.chl.toFixed(2)) && cc6.text.startsWith(cc6.chl.toFixed(2)) && cw.left < cw.gates[0] && cc6.left > cc6.gates[1],
    `hovering the map marks the pixel's chlorophyll on the legend scale (water ${cw?.text} at ${cw?.left}%, bloom ${cc6?.text} at ${cc6?.left}%)`,
  );
  // The box is the scale's own color at the hovered value.
  const sameColor = (c) => c?.bg && c.want && c.bg.every((v, i) => Math.abs(v - c.want[i]) <= 2);
  check(sameColor(cw) && sameColor(cc6),
    `the value's box takes the scale's color (water rgb(${cw?.bg}), bloom rgb(${cc6?.bg}))`);
  const chipColor = (c) => c?.chip && c.want && c.chip.every((v, i) => Math.abs(v - c.want[i]) <= 2) && c.chipText.startsWith(c.chl.toFixed(2));
  check(chipColor(cw) && chipColor(cc6), `beside the coordinates, the readout shows the chlorophyll in the map's color there (rgb(${cw?.chip}), rgb(${cc6?.chip}))`);
  await page.mouse.move(5, 450);
  check(ends[0] === '0' && ends[1] === '20+', `chlorophyll scale runs from 0 to 20+ (${ends.join(' … ')})`);
  if (name === 'chrome') await page.screenshot({ path: path.join(OUT, 'desktop-chlorophyll.png') });

  // The fluorescence (nFLH) layer: the threshold marks a step in its scale.
  await page.click('button[data-layer="nflh"]');
  await page.waitForTimeout(300);
  const nTh = await page.evaluate(() => window.__gbw.manifest.rule.nflh_dense_min);
  const nLegend = await page.evaluate(() => ({
    text: document.querySelector('.nflh-legend')?.innerText ?? '',
    ramp: document.querySelector('.nflh-legend .chl-bar')?.style.background ?? '',
    gate: parseFloat(document.querySelector('.nflh-legend .chl-gate')?.style.left ?? 'NaN'),
  }));
  const stepAt = [...nLegend.ramp.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => parseFloat(m[1]));
  check(nLegend.text.includes(`raised ${nTh.toFixed(4)}`) && stepAt.filter((p) => Math.abs(p - nLegend.gate) < 0.2).length === 2,
    `the nFLH layer marks the ${nTh} threshold from the manifest as a step in its scale`);
  const nCells = await page.evaluate(findCellsFn, { codesWanted: [3, 6], r: 2, max: 1 });
  const nAt = {};
  for (const t of nCells) {
    await page.mouse.move(t.x, t.y);
    await page.waitForTimeout(250);
    nAt[t.code] = await page.evaluate(({ scene, index }) => {
      const x = [...window.__gbw.shown.values()].find((v) => v.scene.scene_id === scene);
      const cur = document.querySelector('.chl-cursor');
      const chip = document.querySelector('#readout .readout-value');
      return { left: parseFloat(cur.style.left), on: cur.classList.contains('is-on'), value: x.loaded.grid.nflh[index], readout: document.getElementById('readout').innerText, chip: chip?.style.background ?? '', box: cur.firstElementChild.style.background };
    }, t);
  }
  check(nAt[3]?.on && nAt[6]?.on && nAt[3].left < nLegend.gate && nAt[6].left > nLegend.gate && nAt[6].readout.includes(`nFLH ${nAt[6].value.toFixed(4)}`),
    `hovering marks nFLH on its scale: non-bloom water below the threshold, the C. polykrikoides-like bloom above (${nAt[3]?.value} and ${nAt[6]?.value})`);
  check([3, 6].every((c) => nAt[c]?.chip && nAt[c].chip === nAt[c].box), `the readout shows nFLH in the map's color there (${nAt[3]?.chip}, ${nAt[6]?.chip})`);
  if (name === 'chrome') await page.screenshot({ path: path.join(OUT, 'desktop-nflh.png') });
  await page.mouse.move(5, 450);
  await page.click('button[data-layer="classes"]');
  check(/Shallow water, not assessed/.test(await page.locator('.map-tools').innerText()) && (await page.$$('.map-tools .swatch-hatch')).length === 1, 'legend shows shallow water as hatched "not assessed"');

  // No Gulf rule anywhere: no outline layer, no toggle, no census block.
  check(await page.evaluate(() => !window.__gbw.view.map.getLayer('agree') && !document.querySelector('#agreement, .crosscheck') && !/Gulf rule/i.test(document.body.textContent)),
    'the Gulf rule is gone from the map, the legend and the details');

  // The held-out test date has its own area: the map moves there, and the census
  // checks how its dense-bloom pixels were named (a true-negative check).
  await goDate(page, '2025-03-24');
  await idle(page);
  const tn = await page.evaluate(() => {
    const s = window.__gbw;
    const x = [...s.shown.values()][0];
    const el = document.querySelector('.test-check');
    const c = x.loaded.counts;
    const b = s.view.map.getBounds();
    const box = s.manifest.regions[x.scene.region].bbox;
    return {
      region: x.scene.region, shown: el?.innerText ?? '', all: el?.textContent ?? '', cp: +el?.dataset.cp, dense: +el?.dataset.dense,
      want: { cp: c[6], dense: c[5] + c[6] + c[7] + c[8] },
      fits: b.getWest() <= box[0] + 0.01 && b.getEast() >= box[2] - 0.01 && b.getSouth() <= box[1] + 0.01 && b.getNorth() >= box[3] - 0.01,
    };
  });
  check(tn.region !== 'gulf' && tn.fits, `the held-out date is in its own area (${tn.region}) and the map fits it`);
  check(/^True-negative check/im.test(tn.shown) && /true-negative check only/i.test(tn.all) && !/true-negative check only/i.test(tn.shown) && tn.cp === tn.want.cp && tn.dense === tn.want.dense,
    `a held-out date shows the true-negative check from its own counts (${tn.cp} of ${tn.dense} dense pixels C. p.-like), its caveat behind More`, tn.shown);
  await goDate(page, '2026-02-14');

  // City names: big cities at the starting view, towns as you zoom in; the dock button hides them.
  await page.evaluate(() => window.__gbw.view.fitTo(Object.values(window.__gbw.manifest.regions)[0].bbox));
  await page.waitForTimeout(300);
  const shownNames = () => page.evaluate(() => [...document.querySelectorAll('.place-label')].filter((e) => getComputedStyle(e).display !== 'none').map((e) => e.textContent));
  const startNames = await shownNames();
  await page.evaluate(() => window.__gbw.view.map.jumpTo({ center: [55.5, 25.3], zoom: 9 }));
  await page.waitForTimeout(300);
  const zoomNames = await shownNames();
  check(startNames.includes('Dubai') && startNames.includes('Muscat') && !startNames.includes('Sharjah') && zoomNames.includes('Sharjah') && zoomNames.includes('Ajman'),
    `city names: ${startNames.length} big cities at the starting view, towns join when zoomed in (${zoomNames.length} at zoom 9)`);
  await page.click('[data-dock="places"]');
  const hiddenNames = await shownNames();
  const namesBtn = await page.evaluate(() => document.querySelector('[data-dock="places"]').getAttribute('aria-pressed'));
  await page.reload();
  await waitForDate(page, '2026-02-14');
  await page.waitForFunction(() => !!window.__gbw.measure);
  const afterReload = await page.evaluate(() => ({ cls: document.getElementById('map').classList.contains('hide-places'), pressed: document.querySelector('[data-dock="places"]').getAttribute('aria-pressed') }));
  await page.click('[data-dock="places"]');
  const backNames = await shownNames();
  check(!hiddenNames.length && namesBtn === 'false' && afterReload.cls && afterReload.pressed === 'false' && backNames.length > 0,
    'the dock\'s names button hides the city names, the choice survives a reload, and it shows them again');

  // The dock's measure button: a menu above it, then measuring until it is pressed again.
  await page.click('[data-dock="measure"]');
  const dockMenu = await page.evaluate(() => {
    const m = document.querySelector('.map-menu');
    const b = document.querySelector('[data-dock="measure"]').getBoundingClientRect();
    return m && { items: [...m.querySelectorAll('[role="menuitem"]')].map((x) => x.textContent.trim()), above: m.getBoundingClientRect().bottom <= b.top + 1 };
  });
  await page.click('.map-menu [data-menu="distance"]');
  const mb0 = await page.evaluate(() => ({ snap: window.__gbw.measure.snapshot(), pressed: document.querySelector('[data-dock="measure"]').getAttribute('aria-pressed') }));
  {
    const box = await page.locator('#map').boundingBox();
    await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.waitForTimeout(150);
  }
  const mb1 = await page.evaluate(() => window.__gbw.measure.snapshot().points.length);
  await page.click('[data-dock="measure"]');
  const mb2 = await page.evaluate(() => ({ active: window.__gbw.measure.isActive(), pressed: document.querySelector('[data-dock="measure"]').getAttribute('aria-pressed') }));
  check(dockMenu?.above && dockMenu.items.join() === 'Measure distance,Measure area' && mb0.snap.mode === 'distance' && mb0.snap.points.length === 0 && mb0.pressed === 'true' && mb1 === 1 && !mb2.active && mb2.pressed === 'false',
    'the dock\'s measure button opens Measure distance and Measure area above it, stays pressed while measuring, and ends it when pressed again', JSON.stringify({ dockMenu, mb0, mb1, mb2 }));

  // Right-click: a menu to measure distance or area, as in Google Maps.
  await page.evaluate(() => window.__gbw.view.fitTo(Object.values(window.__gbw.manifest.regions)[0].bbox));
  await page.waitForTimeout(300);
  await page.evaluate(() => document.querySelector('[data-action="close-pixel"]')?.click());
  const mapBox = await page.locator('#map').boundingBox();
  const mapAt = (fx, fy) => ({ x: mapBox.x + mapBox.width * fx, y: mapBox.y + mapBox.height * fy });
  const p0 = mapAt(0.45, 0.45);
  await page.mouse.click(p0.x, p0.y, { button: 'right' });
  await page.waitForSelector('.map-menu', { timeout: 3000 }).catch(() => {});
  const menuItems = await page.evaluate(() => [...document.querySelectorAll('.map-menu [role="menuitem"]')].map((b) => b.textContent.trim()));
  check(menuItems.length === 3 && /\d+\.\d+° N, \d+\.\d+° E/.test(menuItems[0]) && menuItems[1] === 'Measure distance' && menuItems[2] === 'Measure area',
    `right-clicking the map opens a menu: ${menuItems.join(' | ')}`);
  await page.keyboard.press('Escape');
  check(await page.evaluate(() => !document.querySelector('.map-menu')), 'Esc closes the map menu');
  await page.mouse.click(p0.x, p0.y, { button: 'right' });
  await page.click('.map-menu [data-menu="distance"]');
  for (const [fx, fy] of [[0.55, 0.5], [0.6, 0.62]]) {
    const q = mapAt(fx, fy);
    await page.mouse.click(q.x, q.y);
    await page.waitForTimeout(150);
  }
  const haversine = ([lon1, lat1], [lon2, lat2]) => {
    const r = (d) => (d * Math.PI) / 180;
    const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
    return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
  };
  const dist = await page.evaluate(() => ({
    snap: window.__gbw.measure.snapshot(),
    value: Number(document.querySelector('#measure-card .measure-value')?.dataset.value),
    text: document.querySelector('#measure-card .measure-value')?.innerText ?? '',
    label: document.querySelector('.measure-label')?.textContent ?? '',
    pixel: !!window.__gbw.selection,
  }));
  const wantM = dist.snap.points.slice(1).reduce((m, pt, i) => m + haversine(dist.snap.points[i], pt), 0);
  const km = (wantM / 1000).toFixed(wantM < 100000 ? 1 : 0);
  check(dist.snap.mode === 'distance' && dist.snap.points.length === 3 && Math.abs(dist.value - wantM) < 1 && dist.text.includes(`${km} km`) && /nmi/.test(dist.text) && dist.label.includes(`${km} km`) && !dist.pixel,
    `Measure distance adds a point per click, sums the great-circle distance (${dist.text.replace(/\s+/g, ' ')}) and selects no pixel`, JSON.stringify(dist));
  const v1 = await page.evaluate(() => {
    const m = window.__gbw.view.map;
    const p = window.__gbw.measure.snapshot().points[1];
    const q = m.project(p);
    const b = m.getCanvas().getBoundingClientRect();
    return { x: q.x + b.left, y: q.y + b.top };
  });
  await page.mouse.click(v1.x, v1.y);
  await page.waitForTimeout(150);
  const afterRemove = await page.evaluate(() => window.__gbw.measure.snapshot().points.length);
  await page.keyboard.press('Backspace');
  const afterBack = await page.evaluate(() => window.__gbw.measure.snapshot().points.length);
  check(afterRemove === 2 && afterBack === 1, `clicking a point removes it (${afterRemove} left), Backspace removes the last (${afterBack} left)`);
  await page.keyboard.press('Escape');
  check(await page.evaluate(() => !window.__gbw.measure.isActive() && document.getElementById('measure-card').hidden && window.__gbw.view.map.getSource('measure').serialize().data.features.length === 0),
    'Esc ends measuring and clears the line');

  await page.mouse.click(p0.x, p0.y, { button: 'right' });
  await page.click('.map-menu [data-menu="area"]');
  for (const [fx, fy] of [[0.58, 0.45], [0.52, 0.6]]) {
    const q = mapAt(fx, fy);
    await page.mouse.click(q.x, q.y);
    await page.waitForTimeout(150);
  }
  const area = await page.evaluate(() => ({
    snap: window.__gbw.measure.snapshot(),
    value: Number(document.querySelector('#measure-card .measure-value')?.dataset.value),
    text: document.querySelector('#measure-card .measure-value')?.innerText ?? '',
    fill: window.__gbw.view.map.getSource('measure').serialize().data.features.some((f) => f.properties.kind === 'fill'),
  }));
  // A flat local projection of the same triangle: within 1% of the spherical area at this size.
  const pts = area.snap.points;
  const lat0 = (pts.reduce((a, q) => a + q[1], 0) / pts.length) * (Math.PI / 180);
  const xy = pts.map(([lon, lat]) => [6371008.8 * (lon * Math.PI / 180) * Math.cos(lat0), 6371008.8 * (lat * Math.PI / 180)]);
  const flat = Math.abs(xy.reduce((a, [x1, y1], i) => { const [x2, y2] = xy[(i + 1) % xy.length]; return a + x1 * y2 - x2 * y1; }, 0) / 2);
  check(area.snap.mode === 'area' && pts.length === 3 && area.fill && Math.abs(area.value - flat) / flat < 0.01 && /km²/.test(area.text) && /perimeter/.test(area.text),
    `Measure area closes the points into a shape and gives its area and perimeter (${area.text.replace(/\s+/g, ' ')})`, JSON.stringify({ value: area.value, flat }));
  await page.mouse.click(p0.x, p0.y, { button: 'right' });
  check(await page.evaluate(() => [...document.querySelectorAll('.map-menu [role="menuitem"]')].some((b) => b.textContent.trim() === 'Clear measurement')), 'while measuring, the menu offers to clear the measurement');
  await page.click('.map-menu [data-menu="clear"]');
  check(await page.evaluate(() => !window.__gbw.measure.isActive()), 'Clear measurement ends it');
  if (name === 'chrome') {
    await page.mouse.click(p0.x, p0.y, { button: 'right' });
    await page.click('.map-menu [data-menu="distance"]');
    const q = mapAt(0.6, 0.55);
    await page.mouse.click(q.x, q.y);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, 'desktop-measure.png') });
    await page.keyboard.press('Escape');
  }

  // True color: non-bloom water shows the photo, not the class blue.
  await zoomToBox(page, [54.0, 24.2, 56.0, 25.8]);
  const clear = await page.evaluate(findCellsFn, { codesWanted: [3], r: 3, max: 15 });
  await page.fill('#opacity', '100');
  await page.dispatchEvent('#opacity', 'input');
  check(await page.evaluate(() => {
    const el = document.getElementById('opacity');
    return getComputedStyle(el).appearance === 'none' && el.style.getPropertyValue('--fill') === '100%';
  }), 'the overlay slider is drawn in the dashboard style and fills to its value');
  await page.check('#truecolor');
  await page.evaluate(() => new Promise((r) => window.__gbw.view.map.once('idle', r)));
  check(await page.evaluate(() => window.__gbw.view.map.getLayoutProperty('truecolor', 'visibility') !== 'none'), 'true-color layer shown');
  const photo = await sampleScreen(page, clear);
  const blue = [0x55, 0x98, 0xe7];
  const stillBlue = photo.filter((p) => Math.hypot(...p.rgb.map((c, i) => c - blue[i])) < 25);
  check(clear.length > 0 && stillBlue.length === 0, `with the photo on, non-bloom water isn't painted blue (${clear.length} samples)`);
  check(/not drawn over the photo/.test(await page.locator('.map-tools').innerText()), 'legend says non-bloom water is not drawn over the photo');
  if (name === 'chrome') await page.screenshot({ path: path.join(OUT, 'desktop-truecolor.png') });
  await page.uncheck('#truecolor');

  // Hover readout.
  const box = await page.locator('#map').boundingBox();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.3);
  await page.waitForTimeout(150);
  check(await page.locator('#readout').isVisible(), 'hover shows the coordinate/class readout');
  const water = (await page.evaluate(findCellsFn, { codesWanted: [3], r: 2, max: 1 }))[0];
  if (water) {
    await page.mouse.move(water.x, water.y);
    await page.waitForTimeout(150);
    const cur = await page.evaluate(() => ({
      text: document.getElementById('readout').innerText.replace(/\s+/g, ' '),
      turn: document.querySelector('#readout .readout-arrow')?.style.transform ?? '',
    }));
    check(/current \d+\.\d km\/h/.test(cur.text) && /rotate\(\d+deg\)/.test(cur.turn), `the readout gives the net surface current under the cursor (${cur.text.split('current')[1]?.trim()}, ${cur.turn})`);
  }

  // Unknown date in the URL.
  await page.goto(`${BASE}#date=2099-01-01`); // outside the timeline
  await page.waitForFunction(() => !document.getElementById('toast').hidden, null, { timeout: 10000 });
  ok('unknown date in URL shows a friendly notice and falls back');

  if (name === 'chrome') {
    // Pixel + spectrum screenshot.
    await goDate(page, '2026-02-14');
    await zoomToBlooms(page);
    const [cp] = await page.evaluate(findCellsFn, { codesWanted: [6], r: 2, max: 1 });
    await page.mouse.click(cp.x, cp.y);
    await page.waitForSelector('.chart-svg');
    const chart = await page.evaluate(() => ({
      verdict: document.querySelector('.chart-verdict')?.innerText ?? '',
      normalized: document.querySelector('[data-action="chart-normalize"]')?.getAttribute('aria-pressed'),
      legend: document.querySelector('#chart-legend')?.innerText ?? '',
    }));
    check(/confidence \d\.\d\d/.test(chart.verdict) && chart.normalized === 'true' && /Cluster #\d+ mean/.test(chart.legend) && /best match/.test(chart.legend) && /2nd/.test(chart.legend),
      'the chart compares the cluster mean with the best and 2nd references, normalized, with the confidence beside it', JSON.stringify(chart));
    await page.screenshot({ path: path.join(OUT, 'desktop-pixel-cp.png') });

    // Foldable details: folded, the pixel card keeps its class and its risk tier in the tier's color.
    await page.click('.pixel-card .sec-toggle');
    await page.waitForTimeout(450);
    const fold = await page.evaluate(() => {
      const s = window.__gbw;
      const card = document.querySelector('.pixel-card');
      const pill = card.querySelector('.sec-peek .tier-pill');
      const probe = document.createElement('span');
      probe.style.color = `var(--tier-${card.dataset.tier})`;
      document.body.append(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      const cls = s.manifest.classes.find((k) => k.code === Number(card.dataset.code));
      const plain = (t) => t.replace(/\s+/g, ' ');
      return {
        folded: card.classList.contains('is-folded') && card.querySelector('.sec-toggle').getAttribute('aria-expanded') === 'false',
        bodyH: card.querySelector('.sec-body').getBoundingClientRect().height,
        peek: card.querySelector('.sec-peek').innerText.replace(/\s+/g, ' '),
        label: plain(cls.label),
        tier: s.manifest.risk_tiers.find((t) => t.key === cls.risk_tier).label,
        color: pill && getComputedStyle(pill.querySelector('.icon')).color === want,
      };
    });
    check(fold.folded && fold.bodyH < 1 && fold.peek.includes(fold.label) && fold.peek.toLowerCase().includes(fold.tier.toLowerCase()) && fold.color,
      `a folded pixel card keeps its class and risk tier ("${fold.tier}") in the tier's color`, JSON.stringify(fold));
    await goDate(page, '2026-03-14');
    check(await page.evaluate(() => document.querySelector('.pixel-card')?.classList.contains('is-folded')), 'a folded section stays folded on another date');
    await goDate(page, '2026-02-14');
    await page.click('.pixel-card .sec-toggle');
    await page.waitForTimeout(450);
    check(await page.evaluate(() => document.querySelector('.pixel-card .sec-body').getBoundingClientRect().height > 100), 'clicking the header unfolds it again');

    // The rail beside the details lists the sections and jumps to one.
    const railInfo = await page.evaluate(() => ({
      on: document.getElementById('insp-rail').classList.contains('is-on'),
      labels: [...document.querySelectorAll('#insp-rail .rail-label')].map((b) => b.textContent),
      sections: [...document.querySelectorAll('#insp-content > .insp-sec')].map((s) => s.dataset.railName),
    }));
    check(railInfo.on && railInfo.labels.length > 2 && railInfo.labels.join() === railInfo.sections.join(), `the rail lists the details sections (${railInfo.labels.join(', ')})`);
    await page.hover('#insp-rail .rail-track');
    await page.click('#insp-rail .rail-label:text-is("Pixel census")');
    const landed = await page
      .waitForFunction(() => {
        const sc = document.getElementById('insp-scroll');
        const census = document.querySelector('#insp-content > .census');
        return Math.abs(sc.scrollTop - Math.min(census.offsetTop, sc.scrollHeight - sc.clientHeight)) < 2;
      }, null, { timeout: 5000 })
      .then(() => true, () => false);
    await page.waitForTimeout(100);
    const current = await page.evaluate(() => document.querySelector('#insp-rail .rail-label.is-active')?.textContent);
    check(landed && current === 'Pixel census', `clicking a name on the rail scrolls to that section and marks it current (${current})`);
    await page.mouse.move(700, 450);
    await page.evaluate(() => (document.getElementById('insp-scroll').scrollTop = 0));
    await page.waitForTimeout(400);
    check(await page.evaluate(() => [...document.querySelectorAll('#insp-rail .rail-label')].every((b) => getComputedStyle(b).opacity === '0')),
      'scrolling the details shows no section names; they appear only on the rail');

    // The whole header bar folds a section, and its button says what a click does.
    await page.click('.scene-card .sec-label');
    await page.waitForTimeout(450);
    const word = await page.evaluate(() => ({
      folded: document.querySelector('.scene-card').classList.contains('is-folded'),
      text: document.querySelector('.scene-card .sec-toggle').innerText.trim(),
      label: document.querySelector('.scene-card .sec-toggle').getAttribute('aria-label'),
    }));
    await page.click('.scene-card .sec-label');
    await page.waitForTimeout(450);
    const word2 = await page.evaluate(() => document.querySelector('.scene-card .sec-toggle').getAttribute('aria-label'));
    check(word.folded && !word.text && /^show /i.test(word.label) && /^hide /i.test(word2),
      `clicking a section's header bar folds and unfolds it; its button is an arrow only, labelled "${word.label}" / "${word2}"`);

    // Each floating panel slides to its side by its tab, which stays on screen to bring it back.
    for (const id of ['map-tools', 'sites', 'inspector']) {
      await page.click(`#${id} > .panel-tab`);
      await page.waitForTimeout(550);
      const slid = await page.evaluate((id) => {
        const panel = document.getElementById(id);
        const r = panel.getBoundingClientRect();
        const t = panel.querySelector(':scope > .panel-tab').getBoundingClientRect();
        const off = id === 'inspector' ? r.left >= innerWidth - 1 : r.right <= 1;
        return { off, tab: t.left >= -4 && t.right <= innerWidth + 4 && t.width > 12, inert: [...panel.children].filter((c) => !c.matches('.panel-tab, .panel-edge')).every((c) => c.inert) };
      }, id);
      check(slid.off && slid.tab && slid.inert, `the ${id} tab slides the panel off to its side and stays on screen`, JSON.stringify(slid));
      if (id === 'sites') {
        const away = await page.evaluate(() => {
          const sites = document.getElementById('sites');
          const tab = sites.querySelector(':scope > .panel-tab').getBoundingClientRect();
          const tg = sites.querySelector(':scope > .site-toggles');
          const r = tg.getBoundingClientRect();
          const away = parseFloat(getComputedStyle(sites).getPropertyValue('--sites-tab-away'));
          const fits = [...sites.querySelectorAll(':scope > .panel-tab > *')].every((el) => el.hidden || el.getBoundingClientRect().bottom <= tab.bottom);
          return {
            under: Math.abs(r.top - tab.bottom) <= 1 && Math.abs(r.left - tab.left) < 1, same: Math.abs(r.top - (sites.getBoundingClientRect().top + 10 + away)) <= 1,
            fits, onScreen: r.left >= -4 && r.right > 12, usable: !tg.inert,
          };
        });
        const t0 = await page.evaluate(() => document.querySelector('.site-toggle').getAttribute('aria-pressed'));
        await page.click('.site-toggle');
        const t1 = await page.evaluate(() => document.querySelector('.site-toggle').getAttribute('aria-pressed'));
        await page.click('.site-toggle');
        check(away.under && away.same && away.fits && away.onScreen && away.usable && t0 !== t1,
          'with the sites panel away, its type toggles hang flush under the tab, in the same place as when it is shown, and still work', JSON.stringify(away));
      }
      if (id === 'inspector') {
        const right = await page.evaluate(() => {
          const gap = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--gap')) || 12;
          return { space: innerWidth - document.querySelector('.maplibregl-ctrl-bottom-right').getBoundingClientRect().right, gap };
        });
        check(right.space <= right.gap + 2, `with the details away, the scale and credits go all the way right (${Math.round(right.space)} px from the edge)`);
      }
    }
    const pick = (await page.evaluate(findCellsFn, { codesWanted: [3], r: 2, max: 1 }))[0];
    await page.mouse.click(pick.x, pick.y);
    await page.waitForTimeout(550);
    check(await page.evaluate(() => !document.getElementById('inspector').classList.contains('is-side-hidden') && !!document.querySelector('.pixel-card')),
      'clicking the map brings the details panel back');
    for (const id of ['map-tools', 'sites']) await page.click(`#${id} > .panel-tab`);
    await page.waitForTimeout(550);
    check(await page.evaluate(() => ['map-tools', 'sites'].every((id) => document.getElementById(id).getBoundingClientRect().left > 0)), 'the tabs bring the legend and sites back');
    await page.evaluate(() => document.querySelector('[data-action="close-pixel"]')?.click());

    // Swipe compare: a second map right of a divider, with its own date and reading.
    await goDate(page, '2026-02-14');
    await page.click('#compare-toggle');
    const bLoaded = () => page.waitForFunction(() => window.__gbw.compare.open && window.__gbw.cmp?.view() && [...window.__gbw.compare.shown.values()].every((x) => x.loaded || x.error), null, { timeout: 30000 });
    await bLoaded();
    await idle(page);
    const cmp = await page.evaluate(() => {
      const s = window.__gbw;
      const wrap = document.querySelector('.compare-map');
      const marker = document.querySelector('.site-marker');
      return {
        b: s.compare.date, layer: s.compare.layer, pressed: document.getElementById('compare-toggle').getAttribute('aria-pressed'),
        clip: wrap?.style.clipPath === `inset(0px 0px 0px ${s.cmp.splitPx()}px)`,
        belowMarkers: !!(wrap && marker && wrap.compareDocumentPosition(marker) & Node.DOCUMENT_POSITION_FOLLOWING),
        canvases: document.querySelectorAll('#map canvas.maplibregl-canvas').length,
        bar: !document.getElementById('compare-bar').hidden && /14 Feb 2026/.test(document.getElementById('compare-bar').textContent),
        hash: location.hash, timelineTag: !!document.querySelector('.tl-marker[data-date="2025-11-16"] .tl-b'),
      };
    });
    check(cmp.b === '2025-11-16' && cmp.layer === 'classes' && cmp.pressed === 'true' && cmp.clip && cmp.belowMarkers && cmp.canvases === 2 && cmp.bar &&
      cmp.hash.includes('compare=2025-11-16,classes') && cmp.timelineTag,
      'Compare opens a second map right of a divider, on the date before A with the same layer, under the site markers, tagged B on the timeline', JSON.stringify(cmp));
    const handle = await page.evaluate(() => document.querySelector('.compare-handle').getBoundingClientRect().toJSON());
    const x0 = await page.evaluate(() => window.__gbw.cmp.splitPx());
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 - 120, handle.y + handle.height / 2, { steps: 5 });
    await page.mouse.up();
    const x1 = await page.evaluate(() => window.__gbw.cmp.splitPx());
    await page.focus('.compare-handle');
    await page.keyboard.press('ArrowRight');
    const keyed = await page.evaluate(() => ({ x: window.__gbw.cmp.splitPx(), clip: document.querySelector('.compare-map').style.clipPath, now: document.querySelector('.compare-handle').getAttribute('aria-valuenow') }));
    check(Math.abs(x0 - 120 - x1) <= 2 && keyed.x > x1 + 10 && keyed.clip === `inset(0px 0px 0px ${keyed.x}px)` && Number(keyed.now) > 0,
      `dragging the handle and the arrow keys move the divider and the clip (${x0} → ${x1} → ${keyed.x} px)`);
    // Right of the divider, the map and the readout show B where A and B differ.
    const diff = await page.evaluate(() => {
      const s = window.__gbw;
      const map = s.view.map;
      const box = map.getCanvas().getBoundingClientRect();
      const A = [...s.shown.values()].find((v) => v.loaded).loaded;
      const B = [...s.compare.shown.values()].find((v) => v.loaded).loaded;
      const split = s.cmp.splitPx();
      const covers = [...document.querySelectorAll('.panel, .panel-tab, .panel-edge, .maplibregl-ctrl, .readout, .compare-handle')].filter((el) => el.getClientRects().length).map((el) => el.getBoundingClientRect());
      const covered = (x, y) => covers.some((r) => x > r.left - 8 && x < r.right + 8 && y > r.top - 8 && y < r.bottom + 8);
      const label = (c) => s.manifest.classes.find((k) => k.code === c);
      const W = A.grid.width;
      for (let i = W; i < A.codes.length - W; i += 3) {
        const ca = A.codes[i];
        const cb = B.codes[i];
        if (ca < 3 || cb < 3 || ca === cb || [1, -1, W, -W].some((o) => A.codes[i + o] !== ca || B.codes[i + o] !== cb)) continue;
        const lon = A.grid.bbox[0] + ((i % W) + 0.5) * A.grid.res_deg[0];
        const lat = A.grid.bbox[3] - (Math.floor(i / W) + 0.5) * A.grid.res_deg[1];
        const q = map.project([lon, lat]);
        if (q.x < split + 20 || q.x > box.width - 10 || q.y < 10 || q.y > box.height - 10) continue;
        const X = Math.round(box.left + q.x);
        const Y = Math.round(box.top + q.y);
        if (covered(X, Y) || !document.elementFromPoint(X, Y)?.classList.contains('maplibregl-canvas')) continue;
        const css = (k) => getComputedStyle(document.documentElement).getPropertyValue(`--c-${k}`).trim();
        return { x: X, y: Y, a: label(ca).label, b: label(cb).label, colorA: css(label(ca).key), colorB: css(label(cb).key) };
      }
      return null;
    });
    if (diff) {
      await page.mouse.move(diff.x, diff.y);
      await page.waitForTimeout(150);
      const ro = await page.evaluate(() => ({ text: document.getElementById('readout').textContent, here: document.querySelector('.readout-side.is-here .cmp-tag')?.textContent }));
      const plain = (t) => t.replace(/\s+/g, ' ');
      check(plain(ro.text).includes(diff.a) && plain(ro.text).includes(diff.b) && ro.here === 'B', `hovering right of the divider, the readout gives A (${diff.a}) and B (${diff.b}), marking B`, JSON.stringify(ro));
      const [px] = await sampleScreen(page, [{ x: diff.x, y: diff.y }]);
      const hex = (h) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));
      const dist = (rgb, c) => Math.hypot(...rgb.map((v, k) => v - c[k]));
      check(dist(px.rgb, hex(diff.colorB)) < dist(px.rgb, hex(diff.colorA)), `right of the divider the map shows B's class color (rgb ${px.rgb})`);
      await page.mouse.click(diff.x, diff.y);
      await page.waitForSelector('.pixel-card .cmp-line');
      const line = await page.evaluate(() => document.querySelector('.pixel-card .cmp-line').textContent.replace(/\s+/g, ' '));
      check(line.includes('16 Nov 2025') && line.includes(diff.b), "a pixel's details add a line for B at the same cell", line);
      await page.evaluate(() => document.querySelector('[data-action="close-pixel"]')?.click());
    } else console.log('  skip  no cell where A and B differ right of the divider');
    // B's date and reading.
    await page.selectOption('.cmp-date', '2024-12-09');
    await bLoaded();
    check(await page.evaluate(() => window.__gbw.compare.date === '2024-12-09' && location.hash.includes('compare=2024-12-09,classes')), "choosing B's date loads it and records it in the address");
    await page.click('[data-cmp-layer="chl"]');
    await page.waitForTimeout(300);
    const keys = await page.evaluate(() => [...document.querySelectorAll('.legend-side')].map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
    check(keys.length === 2 && /^A ?Classes/.test(keys[0]) && /^B ?Chlorophyll/.test(keys[1]), 'with B on another layer, the legend explains both sides', keys.join(' | '));
    await page.click('[data-cmp-layer="photo"]');
    await page.waitForTimeout(300);
    const photo = await page.evaluate(() => {
      const { map } = window.__gbw.cmp.view();
      return {
        tc: !!map.getLayer('truecolor') && (map.getLayoutProperty('truecolor', 'visibility') ?? 'visible') === 'visible',
        overlay: map.getLayer('overlay-gulf') ? map.getLayoutProperty('overlay-gulf', 'visibility') : 'none',
        credit: /NASA GIBS/.test(document.getElementById('compare-bar').textContent),
      };
    });
    check(photo.tc && photo.overlay === 'none' && photo.credit, "B's Photo shows that date's true-color image alone, with its credit", JSON.stringify(photo));
    await page.click('[data-cmp-layer="classes"]');
    // B on a date in another area (the held-out test date): B draws its own area's border
    // and wash-out, A keeps its own, and B's readings show beyond A's area.
    await page.selectOption('.cmp-date', '2025-03-24');
    await bLoaded();
    await page.evaluate(() => window.__gbw.view.fitTo(window.__gbw.manifest.regions.oman.bbox));
    await idle(page);
    await page.evaluate(() => window.__gbw.cmp.setSplit(0.05));
    await page.waitForTimeout(400);
    const other = await page.evaluate(() => {
      const s = window.__gbw;
      const A = s.view.map;
      const B = s.cmp.view().map;
      const ringOf = ([w, so, e, n]) => JSON.stringify([[w, n], [e, n], [e, so], [w, so], [w, n]]);
      const hole = (m) => JSON.stringify(m.getSource('outside').serialize().data.geometry.coordinates[1]);
      const frames = (m) => m.getSource('frames').serialize().data.features.map((f) => JSON.stringify(f.geometry.coordinates));
      const gulf = s.manifest.regions.gulf.bbox;
      const oman = s.manifest.regions.oman.bbox;
      // A cell of B well outside A's area, right of the divider and clear of the panels.
      const { grid, codes } = [...s.compare.shown.values()].find((v) => v.loaded).loaded;
      const box = A.getCanvas().getBoundingClientRect();
      const covers = [...document.querySelectorAll('.panel, .panel-tab, .panel-edge, .maplibregl-ctrl, .readout, .compare-handle')].filter((el) => el.getClientRects().length).map((el) => el.getBoundingClientRect());
      const covered = (x, y) => covers.some((r) => x > r.left - 8 && x < r.right + 8 && y > r.top - 8 && y < r.bottom + 8);
      const W = grid.width;
      let cell = null;
      for (let i = 2 * W; i < codes.length - 2 * W && !cell; i += 7) {
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
        const k = s.manifest.classes.find((x) => x.code === c);
        cell = { x: X, y: Y, label: k.label, color: getComputedStyle(document.documentElement).getPropertyValue(`--c-${k.key}`).trim() };
      }
      return { aHole: hole(A) === ringOf(gulf), bHole: hole(B) === ringOf(oman), aFrames: frames(A), bFrames: frames(B), gulf: ringOf(gulf), oman: ringOf(oman), cell };
    });
    check(other.aHole && other.bHole && other.aFrames.join() === other.gulf && other.bFrames.join() === other.oman,
      "with B on the held-out date, B outlines and keeps clear its own area, and A keeps its own", JSON.stringify({ aHole: other.aHole, bHole: other.bHole, a: other.aFrames.length, b: other.bFrames.length }));
    if (other.cell) {
      const [px] = await sampleScreen(page, [{ x: other.cell.x, y: other.cell.y }]);
      const want = [1, 3, 5].map((k) => parseInt(other.cell.color.slice(k, k + 2), 16));
      const gap = Math.hypot(...px.rgb.map((v, i) => v - want[i]));
      await page.mouse.move(other.cell.x, other.cell.y);
      await page.waitForTimeout(150);
      const ro = await page.evaluate(() => document.getElementById('readout').textContent.replace(/\s+/g, ' '));
      check(gap < 60 && ro.includes(other.cell.label), `beyond A's area, B shows the held-out date's readings (${other.cell.label}, rgb ${px.rgb}) and the readout gives them`, ro);
      await page.mouse.move(5, 450);
    } else bad("found no held-out cell beyond A's area to look at");
    await page.evaluate(() => window.__gbw.cmp.setSplit(0.5));
    await page.selectOption('.cmp-date', '2024-12-09');
    await bLoaded();
    await page.evaluate(() => window.__gbw.view.fitTo(Object.values(window.__gbw.manifest.regions)[0].bbox));
    await idle(page);
    // Swap: B's date becomes the selected one.
    await page.click('[data-cmp="swap"]');
    await waitForDate(page, '2024-12-09');
    await bLoaded();
    check(await page.evaluate(() => window.__gbw.date === '2024-12-09' && window.__gbw.compare.date === '2026-02-14' && location.hash === '#date=2024-12-09&compare=2026-02-14,classes'),
      'swap makes B the selected date and A the compared one');
    await page.reload();
    await waitForDate(page, '2024-12-09');
    await bLoaded();
    check(await page.evaluate(() => window.__gbw.compare.date === '2026-02-14' && !!document.querySelector('.compare-map')), 'a reload keeps the comparison');
    await page.click('[data-cmp="close"]');
    await page.waitForTimeout(200);
    check(await page.evaluate(() => !document.querySelector('.compare-map, .compare-divider') && document.querySelectorAll('#map canvas.maplibregl-canvas').length === 1 &&
      document.getElementById('compare-bar').hidden && location.hash === '#date=2024-12-09' && document.getElementById('compare-toggle').getAttribute('aria-pressed') === 'false'),
      'closing the comparison removes the second map, the divider and the bar');
    await goDate(page, '2026-02-14');

    // Phone width.
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
    watchConsole(phone, log);
    await phone.goto(`${BASE}#date=2026-02-14`);
    await waitForDate(phone, '2026-02-14');
    const phoneToggles = await phone.evaluate(() => {
      const head = document.querySelector('#sites .panel-head').getBoundingClientRect();
      const tg = document.querySelector('#sites .site-toggles').getBoundingClientRect();
      const list = document.querySelector('#sites .panel-body').getBoundingClientRect();
      return { row: tg.width > tg.height * 2, between: tg.top >= head.bottom - 1 && tg.bottom <= list.top + 1 };
    });
    check(phoneToggles.row && phoneToggles.between, 'on a phone the site-type toggles sit in a row between the sites header and the list', JSON.stringify(phoneToggles));
    const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, 'no sideways scrolling at 390 px', `${overflow}px too wide`);
    // Compare on a phone: the legend slides away to show the map, and the bar spans it.
    await phone.click('#map-tools > .panel-tab');
    await phone.waitForTimeout(500);
    await phone.click('#compare-toggle');
    await phone.waitForFunction(() => window.__gbw.compare.open && window.__gbw.cmp?.view(), null, { timeout: 30000 });
    await phone.waitForTimeout(500);
    const pc = await phone.evaluate(() => {
      const bar = document.getElementById('compare-bar').getBoundingClientRect();
      const tl = document.getElementById('timeline').getBoundingClientRect();
      return { inside: bar.left >= 0 && bar.right <= innerWidth && bar.bottom <= tl.top, legendAway: document.getElementById('map-tools').classList.contains('is-side-hidden'), over: document.documentElement.scrollWidth - innerWidth };
    });
    check(pc.inside && pc.legendAway && pc.over <= 0, 'on a phone, Compare slides the legend away and its bar fits above the timeline', JSON.stringify(pc));
    await phone.click('[data-cmp="close"]');
    check(await phone.evaluate(() => getComputedStyle(document.getElementById('insp-rail')).display === 'none' && !!document.querySelector('.scene-card .sec-toggle')),
      'on a phone the details scroll with the page (no rail) and still fold');
    check(await phone.evaluate(() => {
      const tools = document.getElementById('map-tools');
      const tab = tools.querySelector(':scope > .panel-tab').getBoundingClientRect();
      return tools.classList.contains('is-side-hidden') && tab.left >= -4 && tab.right > 12 && getComputedStyle(document.querySelector('#inspector > .panel-tab')).display === 'none';
    }), 'on a phone the legend starts slid away behind its tab; sites and details have no tab');
    await phone.screenshot({ path: path.join(OUT, 'phone.png') });
    await phone.screenshot({ path: path.join(OUT, 'phone-full.png'), fullPage: true });
    await phone.close();

    // On a touch screen, pressing and holding the map opens the same menu; a tap then adds a point.
    const touchCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true });
    const touch = await touchCtx.newPage();
    watchConsole(touch, log);
    await touch.goto(`${BASE}#date=2026-02-14`);
    await waitForDate(touch, '2026-02-14');
    await touch.waitForFunction(() => !!window.__gbw.measure);
    const cdp = await touchCtx.newCDPSession(touch);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 200, y: 400 }] });
    await touch.waitForTimeout(800);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await touch.waitForTimeout(300);
    const held = await touch.evaluate(() => ({ menu: !!document.querySelector('.map-menu'), selection: !!window.__gbw.selection }));
    if (held.menu) {
      await touch.tap('.map-menu [data-menu="distance"]');
      await touch.waitForTimeout(200);
      await touch.touchscreen.tap(250, 480);
      await touch.waitForTimeout(400);
    }
    const tapped = await touch.evaluate(() => ({ points: window.__gbw.measure.snapshot().points.length, card: !document.getElementById('measure-card').hidden, selection: !!window.__gbw.selection }));
    check(held.menu && !held.selection && tapped.points === 2 && tapped.card && !tapped.selection,
      'on a touch screen, press and hold opens the map menu, and a tap then adds a measuring point', JSON.stringify({ held, tapped }));
    await touchCtx.close();

    // A broken grid file: friendly message, other dates still work.
    const broken = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await broken.route('**/data/scenes/gulf_pace_20260214/grid.json', (route) =>
      route.fulfill({ contentType: 'application/json', body: JSON.stringify({ contract_version: '1.0', scene_id: 'gulf_pace_20260214', bbox: [51.2, 21.8, 60.79, 27.03], res_deg: [0.01, 0.01], width: 959, height: 523, class_code: [0, 1], chlor_a: [], nflh: [], cluster_id: [] }) }),
    );
    await broken.goto(`${BASE}#date=2026-02-14`);
    await waitForDate(broken, '2026-02-14');
    const msg = await broken.locator('.error-card').textContent();
    check(/can't be shown/i.test(msg) && /501557|width × height/.test(msg), 'wrong-length grid shows a friendly error');
    await broken.screenshot({ path: path.join(OUT, 'error-bad-grid.png') });
    await broken.click('.tl-marker[data-date="2026-03-14"]');
    await waitForDate(broken, '2026-03-14');
    check(await broken.evaluate(() => [...window.__gbw.shown.values()].every((x) => x.loaded)), 'another date still loads after the broken one');
    await broken.close();

    // Missing cluster table: classes still draw; explanations say so.
    const noClusters = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const ncLog = [];
    noClusters.on('pageerror', (e) => ncLog.push(e.message));
    await noClusters.route('**/data/clusters.json', (route) => route.fulfill({ status: 404, body: 'not found' }));
    await noClusters.goto(`${BASE}#date=2024-12-03`);
    await waitForDate(noClusters, '2024-12-03');
    await zoomToBlooms(noClusters);
    const [px] = await noClusters.evaluate(findCellsFn, { codesWanted: [6], r: 2, max: 1 });
    await noClusters.mouse.click(px.x, px.y);
    await noClusters.waitForSelector('.pixel-card');
    check(/Cluster details unavailable/.test(await noClusters.locator('.pixel-card').innerText()) && !ncLog.length, 'missing clusters.json: map draws, pixel says cluster details are unavailable');
    await noClusters.close();

    // A manifest from a future major contract version.
    const future = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await future.route('**/data/manifest.json', async (route) => {
      const res = await route.fetch();
      const m = await res.json();
      m.contract_version = '2.0';
      await route.fulfill({ response: res, json: m });
    });
    await future.goto(BASE);
    await future.waitForSelector('#fatal:not([hidden])');
    const fatal = await future.locator('#fatal').innerText();
    check(/contract 2\.0/.test(fatal) && /1\.x/.test(fatal), 'unsupported contract major version is refused with a clear message');
    await future.close();

    // Opening from disk.
    const disk = await browser.newPage();
    await disk.goto(`file:///${path.resolve('index.html').replace(/\\/g, '/')}`);
    check(await disk.locator('#file-warning').isVisible(), 'opening index.html from disk explains how to run a server');
    await disk.close();
  }

  const errors = log.filter((l) => !l.startsWith('warning'));
  check(errors.length === 0, `zero console errors in ${name}`, errors.join(' | '));
  const warnings = log.filter((l) => l.startsWith('warning'));
  if (warnings.length) console.log(`  note  ${warnings.length} console warning(s): ${[...new Set(warnings)].slice(0, 3).join(' | ')}`);

  await browser.close();
}

for (const b of BROWSERS) if (!only || only.includes(b.name)) await runBrowser(b);
console.log(`\n${failures ? `FAILED: ${failures} check(s)` : 'ALL CHECKS PASSED'}  (screenshots in ${OUT})`);
process.exit(failures ? 1 : 0);
