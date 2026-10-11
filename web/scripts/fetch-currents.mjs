// Builds web/public/currents/: hourly surface currents for every scene date, so
// the dashboard shows them from its own files, with no live API calls.
//
//   npm run currents            (rerun when the scene dates change; finished dates are skipped)
//   npm run currents -- --force (fetch everything again)
//
// Source: the Open-Meteo Marine API (free, no key), Météo-France SMOC currents
// (Copernicus Marine): hourly, 0.08°, tides included. Each date gets 72 hours
// from 00:00 UTC (the day itself, plus two days for the 48-hour drift tracks),
// sampled on a 0.25° grid over the water of that date's area box (dates in another
// area, like the held-out test date, get their own box). A date whose saved box
// differs from its area's is fetched again.
//
// The free tier allows 600 calls a minute, 5,000 an hour and 10,000 a day; each
// location is a call for up to 14 days of data. Dates close together share one
// request window, and the pace stays under the per-minute limit. Timeouts,
// network errors and "too many requests" are retried.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.resolve(here, '../../data');
const OUT = path.resolve(here, '../public/currents');
const API = 'https://marine-api.open-meteo.com/v1/marine';
const STEP = 0.25; // degrees between sample points
const HOURS = 72; // per date, from 00:00 UTC
const BATCH = 50; // locations per request
const PER_MINUTE = 450; // calls a minute, under the free limit of 600
const MAX_WINDOW_DAYS = 14; // one call per location up to two weeks
const MAX_TRIES = 20;
const force = process.argv.includes('--force');

const DAY = 86400000;
const toISO = (t) => new Date(t).toISOString().slice(0, 10);
const parseDay = (d) => Date.parse(`${d}T00:00:00Z`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- what to fetch -----------------------------------------------------------
const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest.json'), 'utf8'));
const dates = [...new Set(manifest.scenes.map((s) => s.date))].sort();
const union = (boxes) => [Math.min(...boxes.map((b) => b[0])), Math.min(...boxes.map((b) => b[1])), Math.max(...boxes.map((b) => b[2])), Math.max(...boxes.map((b) => b[3]))];
// Each date's box: the union of its scenes' areas.
const boxOf = (d) => union(manifest.scenes.filter((s) => s.date === d).map((s) => manifest.regions[s.region].bbox));

// Sample points: grid centres with water within two cells of an area's depth file (read only).
const depths = Object.values(manifest.regions)
  .map((r) => r.depth_file && path.join(DATA, r.depth_file))
  .filter((f) => f && fs.existsSync(f))
  .map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const nearWater = (depth, lon, lat) => {
  const [w, s, e, n] = depth.bbox;
  if (lon < w || lon > e || lat < s || lat > n) return null; // not this area
  const [rl, rt] = depth.res_deg;
  const c0 = Math.floor((lon - w) / rl);
  const r0 = Math.floor((n - lat) / rt);
  for (let dr = -2; dr <= 2; dr++)
    for (let dc = -2; dc <= 2; dc++) {
      const r = r0 + dr;
      const c = c0 + dc;
      if (r >= 0 && r < depth.height && c >= 0 && c < depth.width && depth.depth_m[r * depth.width + c] != null) return true;
    }
  return false;
};
const isWater = (lon, lat) => {
  if (!depths.length) return true;
  const verdicts = depths.map((d) => nearWater(d, lon, lat)).filter((v) => v != null);
  return verdicts.length ? verdicts.some(Boolean) : true;
};

fs.mkdirSync(OUT, { recursive: true });
const fileOf = (d) => path.join(OUT, `${d}.json`);
const fieldBox = (bbox, W, H) => [bbox[0], +(bbox[3] - H * STEP).toFixed(4), +(bbox[0] + W * STEP).toFixed(4), bbox[3]];
/** True when the date's saved file covers its area's box. */
const done = (d, want) => {
  if (!fs.existsSync(fileOf(d))) return false;
  try {
    const have = JSON.parse(fs.readFileSync(fileOf(d), 'utf8')).bbox;
    return have.every((v, i) => Math.abs(v - want[i]) < 1e-6);
  } catch {
    return false;
  }
};

// Dates that are no longer scenes are removed, so the site doesn't ship them.
const stale = fs.readdirSync(OUT).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && !dates.includes(f.slice(0, 10)));
for (const f of stale) fs.unlinkSync(path.join(OUT, f));
if (stale.length) console.log(`removed ${stale.length} old dates (${stale.map((f) => f.slice(0, 10)).join(', ')})`);

// One group per area box; each has its own sample points and request windows.
const groups = new Map();
for (const d of dates) {
  const bbox = boxOf(d);
  const key = bbox.join(',');
  if (!groups.has(key)) groups.set(key, { bbox, dates: [] });
  groups.get(key).dates.push(d);
}
for (const g of groups.values()) {
  g.W = Math.floor((g.bbox[2] - g.bbox[0]) / STEP + 1e-9);
  g.H = Math.floor((g.bbox[3] - g.bbox[1]) / STEP + 1e-9);
  g.points = [];
  for (let row = 0; row < g.H; row++)
    for (let col = 0; col < g.W; col++) {
      const lon = +(g.bbox[0] + (col + 0.5) * STEP).toFixed(4);
      const lat = +(g.bbox[3] - (row + 0.5) * STEP).toFixed(4);
      if (isWater(lon, lat)) g.points.push({ index: row * g.W + col, lon, lat });
    }
  // Request windows: each date needs [D, D+2]; neighbours share a window of at most 14 days.
  g.windows = [];
  for (const d of g.dates) {
    const start = parseDay(d);
    const end = start + 2 * DAY;
    const last = g.windows.at(-1);
    if (last && (end - last.start) / DAY + 1 <= MAX_WINDOW_DAYS) {
      last.end = Math.max(last.end, end);
      last.dates.push(d);
    } else g.windows.push({ start, end, dates: [d] });
  }
  const want = fieldBox(g.bbox, g.W, g.H);
  g.todo = g.windows.filter((w) => force || w.dates.some((d) => !done(d, want)));
  const calls = g.todo.length * g.points.length;
  console.log(`Box [${g.bbox.join(', ')}]: ${g.dates.length} dates in ${g.windows.length} windows; ${g.points.length} sample points (${g.W}×${g.H} grid, ${STEP}°).`);
  console.log(g.todo.length ? `  ${g.todo.length} windows to fetch: about ${calls} calls, ${Math.ceil(calls / PER_MINUTE)} minutes.` : '  Every date is already fetched.');
}

// --- fetching ------------------------------------------------------------------
const recent = []; // [time, calls] of the last minute
async function pace(n) {
  for (;;) {
    const now = Date.now();
    while (recent.length && now - recent[0][0] > 60000) recent.shift();
    const used = recent.reduce((s, [, c]) => s + c, 0);
    if (used + n <= PER_MINUTE) break;
    await sleep(1000);
  }
  recent.push([Date.now(), n]);
}

async function fetchBatch(batch, w) {
  const url =
    `${API}?latitude=${batch.map((p) => p.lat).join(',')}&longitude=${batch.map((p) => p.lon).join(',')}` +
    `&hourly=ocean_current_velocity,ocean_current_direction&start_date=${toISO(w.start)}&end_date=${toISO(w.end)}` +
    '&timezone=GMT&cell_selection=sea';
  for (let attempt = 1; ; attempt++) {
    await pace(batch.length);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (res.ok) {
        const body = await res.json();
        return Array.isArray(body) ? body : [body];
      }
      const text = await res.text();
      if (res.status !== 429 && res.status < 500) throw Object.assign(new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`), { fatal: true });
      const wait = res.status === 429 ? 60000 : Math.min(60000, 2000 * attempt);
      console.log(`  HTTP ${res.status}${res.status === 429 ? ' (too many requests)' : ''}; retrying in ${wait / 1000} s`);
      await sleep(wait);
    } catch (err) {
      if (err.fatal || attempt >= MAX_TRIES) throw err;
      const wait = Math.min(60000, 2000 * attempt);
      console.log(`  ${err.name === 'TimeoutError' ? 'timed out' : err.message}; retrying in ${wait / 1000} s`);
      await sleep(wait);
    }
    if (attempt >= MAX_TRIES) throw new Error(`gave up after ${MAX_TRIES} tries`);
  }
}

const writeJson = (file, obj) => {
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(obj));
  fs.renameSync(`${file}.tmp`, file);
};
const writeIndex = () => {
  const have = dates.filter((d) => fs.existsSync(fileOf(d)));
  writeJson(path.join(OUT, 'index.json'), { source: 'Open-Meteo Marine API: Météo-France SMOC currents (Copernicus Marine)', step_deg: STEP, hours: HOURS, dates: have });
};

let fastest = 0;
let nulls = 0;
let values = 0;
for (const { bbox, W, H, points, todo } of groups.values()) for (const w of todo) {
  const days = Math.round((w.end - w.start) / DAY) + 1;
  // speed (m/s) and direction per point, per hour of the window
  const speed = new Map();
  const dir = new Map();
  for (let i = 0; i < points.length; i += BATCH) {
    const batch = points.slice(i, i + BATCH);
    const got = await fetchBatch(batch, w);
    if (got.length !== batch.length) throw new Error(`asked for ${batch.length} points, got ${got.length}`);
    got.forEach((loc, k) => {
      const t0 = Date.parse(`${loc.hourly.time[0]}:00Z`);
      if (t0 !== w.start) throw new Error(`series starts at ${loc.hourly.time[0]}, expected ${toISO(w.start)}T00:00`);
      speed.set(batch[k].index, loc.hourly.ocean_current_velocity.map((v) => (v == null ? null : v / 3.6)));
      dir.set(batch[k].index, loc.hourly.ocean_current_direction);
    });
    process.stdout.write(`\r${w.dates.join(', ')}: ${Math.min(i + BATCH, points.length)}/${points.length} points`);
  }
  process.stdout.write('\n');
  for (const d of w.dates) {
    const offset = Math.round((parseDay(d) - w.start) / DAY) * 24;
    const u = new Array(HOURS * W * H).fill(null);
    const v = new Array(HOURS * W * H).fill(null);
    for (const p of points) {
      const s = speed.get(p.index);
      const a = dir.get(p.index);
      for (let h = 0; h < HOURS; h++) {
        const sp = s[offset + h];
        const dg = a[offset + h];
        values++;
        if (sp == null || dg == null) {
          nulls++;
          continue;
        }
        fastest = Math.max(fastest, sp);
        // Direction is where the water flows towards, clockwise from north.
        const r = (dg * Math.PI) / 180;
        u[h * W * H + p.index] = Math.round(sp * Math.sin(r) * 100); // cm/s, east
        v[h * W * H + p.index] = Math.round(sp * Math.cos(r) * 100); // cm/s, north
      }
    }
    writeJson(fileOf(d), {
      date: d,
      source: 'Open-Meteo Marine API: Météo-France SMOC currents (Copernicus Marine), hourly, tides included',
      fetched_utc: new Date().toISOString(),
      bbox: fieldBox(bbox, W, H),
      step_deg: STEP,
      width: W,
      height: H,
      start_utc: `${d}T00:00:00Z`,
      hours: HOURS,
      units: 'cm/s; u east, v north; null where there is no water',
      u,
      v,
    });
    console.log(`  wrote currents/${d}.json (${days}-day window)`);
  }
  writeIndex();
}
writeIndex();
if (values) console.log(`Fastest current ${fastest.toFixed(2)} m/s; ${((nulls / values) * 100).toFixed(1)}% of values missing.`);
if (fastest > 3) console.warn('WARNING: currents above 3 m/s. Check the units.');
