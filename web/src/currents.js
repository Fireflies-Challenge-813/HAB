// Surface currents for the selected date, from files prepared by
// scripts/fetch-currents.mjs (public/currents/): hourly Open-Meteo / Météo-France
// SMOC currents on a 0.25° grid, 72 hours from 00:00 UTC of the date.
// Also: where C. polykrikoides-like and green Noctiluca-like patches would drift
// with the surface water.

const M_PER_DEG = 111320;

let indexPromise = null;
const cache = new Map();

async function fetchJson(rel) {
  const res = await fetch(new URL(rel, document.baseURI));
  if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
  return res.json();
}

/** The dates that have currents prepared (a Set); empty when there are none. */
export function loadCurrentsIndex() {
  indexPromise ??= fetchJson('currents/index.json')
    .then((i) => new Set(Array.isArray(i.dates) ? i.dates : []))
    .catch(() => new Set());
  return indexPromise;
}

/**
 * The currents field of a date: u and v in m/s (NaN where there is no water), per
 * hour, plus meanU / meanV over the date's 24 hours (the net flow, tides averaged out).
 */
export function loadCurrents(date) {
  if (!cache.has(date)) {
    cache.set(
      date,
      fetchJson(`currents/${date}.json`).then((f) => {
        const n = f.width * f.height;
        const toMs = (a) => Float32Array.from(a, (x) => (x == null ? NaN : x / 100));
        const u = toMs(f.u);
        const v = toMs(f.v);
        const meanU = new Float32Array(n).fill(NaN);
        const meanV = new Float32Array(n).fill(NaN);
        for (let i = 0; i < n; i++) {
          let su = 0;
          let sv = 0;
          let k = 0;
          for (let h = 0; h < 24; h++) {
            const a = u[h * n + i];
            const b = v[h * n + i];
            if (Number.isNaN(a) || Number.isNaN(b)) continue;
            su += a;
            sv += b;
            k++;
          }
          if (k >= 12) {
            meanU[i] = su / k;
            meanV[i] = sv / k;
          }
        }
        return { date, source: f.source, bbox: f.bbox, step: f.step_deg, width: f.width, height: f.height, hours: f.hours, u, v, meanU, meanV };
      }),
    );
  }
  return cache.get(date);
}

/** Bilinear value of one hourly (or the mean) layer at a point: [u, v] in m/s, or null. */
function bilinear(f, U, V, offset, lon, lat) {
  const x = (lon - f.bbox[0]) / f.step - 0.5;
  const y = (f.bbox[3] - lat) / f.step - 0.5;
  if (x < -0.5 || y < -0.5 || x > f.width - 0.5 || y > f.height - 0.5) return null;
  const i0 = Math.floor(x);
  const j0 = Math.floor(y);
  const fx = x - i0;
  const fy = y - j0;
  let su = 0;
  let sv = 0;
  let sw = 0;
  for (const [di, dj, w] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
    const i = Math.min(f.width - 1, Math.max(0, i0 + di));
    const j = Math.min(f.height - 1, Math.max(0, j0 + dj));
    const a = U[offset + j * f.width + i];
    const b = V[offset + j * f.width + i];
    if (Number.isNaN(a) || Number.isNaN(b) || w === 0) continue;
    su += a * w;
    sv += b * w;
    sw += w;
  }
  return sw > 1e-6 ? [su / sw, sv / sw] : null;
}

/** Net (24-hour mean) current at a point: [u, v] in m/s, or null. */
export const meanAt = (f, lon, lat) => bilinear(f, f.meanU, f.meanV, 0, lon, lat);

/** Current at a point and time (hours from 00:00 UTC of the date, fractional). */
export function currentAt(f, lon, lat, hour) {
  const n = f.width * f.height;
  const h0 = Math.floor(hour);
  if (h0 < 0 || h0 + 1 >= f.hours) return null;
  const a = bilinear(f, f.u, f.v, h0 * n, lon, lat);
  const b = bilinear(f, f.u, f.v, (h0 + 1) * n, lon, lat);
  if (!a || !b) return null;
  const t = hour - h0;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Bloom patches of one class (code): 4-connected groups of its cells of at least
 * minCells, the largest first (at most max). Each starts from the patch cell
 * nearest its centroid.
 */
export function bloomPatches(grid, codes, code, { minCells = 15, max = 8 } = {}) {
  const { width: W, height: H } = grid;
  const seen = new Uint8Array(codes.length);
  const found = [];
  for (let s = 0; s < codes.length; s++) {
    if (codes[s] !== code || seen[s]) continue;
    const cells = [s];
    seen[s] = 1;
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k];
      const r = Math.floor(i / W);
      const c = i % W;
      for (const j of [c > 0 ? i - 1 : -1, c < W - 1 ? i + 1 : -1, r > 0 ? i - W : -1, r < H - 1 ? i + W : -1]) {
        if (j >= 0 && !seen[j] && codes[j] === code) {
          seen[j] = 1;
          cells.push(j);
        }
      }
    }
    if (cells.length >= minCells) found.push(cells);
  }
  found.sort((a, b) => b.length - a.length);
  return found.slice(0, max).map((cells, id) => {
    let sr = 0;
    let sc = 0;
    for (const i of cells) {
      sr += Math.floor(i / W);
      sc += i % W;
    }
    const mr = sr / cells.length;
    const mc = sc / cells.length;
    let seed = cells[0];
    let best = Infinity;
    for (const i of cells) {
      const d = (Math.floor(i / W) - mr) ** 2 + ((i % W) - mc) ** 2;
      if (d < best) {
        best = d;
        seed = i;
      }
    }
    const lon = grid.bbox[0] + ((seed % W) + 0.5) * grid.res_deg[0];
    const lat = grid.bbox[3] - (Math.floor(seed / W) + 0.5) * grid.res_deg[1];
    return { id, code, size: cells.length, cells: new Set(cells), lon, lat };
  });
}

/**
 * Where surface water starting at (lon, lat) at startHour (UTC, on the date) goes
 * over the next `hours`, following the hourly currents (tides included): RK4 in
 * 15-minute steps. isWater(lon, lat) stops it at the coast.
 * @returns {{ path: number[][], stoppedAt: number|null }} path has one point per hour
 */
export function driftTrack(f, lon, lat, isWater, { startHour = 9, hours = 48 } = {}) {
  const dt = 900;
  const stepsPerHour = 3600 / dt;
  const path = [[lon, lat]];
  let x = lon;
  let y = lat;
  const vel = (px, py, t) => {
    const c = currentAt(f, px, py, t);
    if (!c) return null;
    const k = M_PER_DEG * Math.cos((py * Math.PI) / 180);
    return [c[0] / k, c[1] / M_PER_DEG]; // degrees per second
  };
  for (let h = 0; h < hours; h++) {
    for (let s = 0; s < stepsPerHour; s++) {
      const t = startHour + h + s / stepsPerHour;
      const k1 = vel(x, y, t);
      const k2 = k1 && vel(x + (k1[0] * dt) / 2, y + (k1[1] * dt) / 2, t + dt / 7200);
      const k3 = k2 && vel(x + (k2[0] * dt) / 2, y + (k2[1] * dt) / 2, t + dt / 7200);
      const k4 = k3 && vel(x + k3[0] * dt, y + k3[1] * dt, t + dt / 3600);
      if (!k4) return { path, stoppedAt: h };
      const nx = x + ((k1[0] + 2 * k2[0] + 2 * k3[0] + k4[0]) * dt) / 6;
      const ny = y + ((k1[1] + 2 * k2[1] + 2 * k3[1] + k4[1]) * dt) / 6;
      if (!isWater(nx, ny)) {
        path.push([nx, ny]);
        return { path, stoppedAt: h + (s + 1) / stepsPerHour };
      }
      x = nx;
      y = ny;
    }
    path.push([x, y]);
  }
  return { path, stoppedAt: null };
}

/** Great-circle distance in km. */
export function distanceKm([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];

/** "northeast" etc. for a flow toward (u east, v north). */
export function towardWord(u, v) {
  const deg = ((Math.atan2(u, v) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(deg / 45) % 8];
}

/** Compass word from one point toward another. */
export function bearingWord([lon1, lat1], [lon2, lat2]) {
  return towardWord((lon2 - lon1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180), lat2 - lat1);
}

