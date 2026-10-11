// Watched-site status, computed in the browser (DATA_CONTRACT.md section 10).
// Distances are measured by sea: the shortest way through the water, around land,
// so a bloom on the far side of a peninsula doesn't count as near.

// Interface settings (not data thresholds): distances from a site to flagged cells.
export const ALERT_KM = 25;
export const NEAR_KM = 75;
const SEED_KM = 5; // sites (plants, beaches) sit up to a few km inland of the grid's water

const LAND = 0;
const FIRST_WATER_CLASS = 3; // codes 3–8: water the pipeline could assess
const CP_LIKE = 6;
const KM_PER_DEG_LAT = 110.574;
const GRID_SLACK = 1.09; // an 8-neighbour path is at most ~8% longer than the straight line

export const SITE_STATUS = {
  alert: { label: 'Alert', icon: 'tierHigh', rank: 3 },
  nearby: { label: 'Nearby', icon: 'eye', rank: 2 },
  clear: { label: 'Clear', icon: 'check', rank: 1 },
  unknown: { label: 'Unknown', icon: 'question', rank: 0 },
};

/** A small binary min-heap of (distance, cell) pairs. */
function createHeap() {
  let key = new Float64Array(1024);
  let val = new Int32Array(1024);
  let n = 0;
  return {
    get size() {
      return n;
    },
    push(k, v) {
      if (n === key.length) {
        const k2 = new Float64Array(n * 2);
        const v2 = new Int32Array(n * 2);
        k2.set(key);
        v2.set(val);
        key = k2;
        val = v2;
      }
      let i = n++;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (key[parent] <= k) break;
        key[i] = key[parent];
        val[i] = val[parent];
        i = parent;
      }
      key[i] = k;
      val[i] = v;
    },
    /** Removes the smallest; returns its cell, with its distance in .last. */
    pop() {
      const top = val[0];
      this.last = key[0];
      const k = key[--n];
      const v = val[n];
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && key[c + 1] < key[c]) c++;
        if (key[c] >= k) break;
        key[i] = key[c];
        val[i] = val[c];
        i = c;
      }
      key[i] = k;
      val[i] = v;
      return top;
    },
  };
}

/**
 * Status of one site against a loaded grid, with distances by sea.
 * @returns {{ status, nearestKm: number|null, nearestIndex: number|null, waterCells: number }}
 */
export function siteStatus(site, grid, codes) {
  const [lon0, lat0] = site.geometry.coordinates;
  const [west, , , north] = grid.bbox;
  const [resLon, resLat] = grid.res_deg;
  const W = grid.width;
  const kmPerDegLon = 111.32 * Math.cos((lat0 * Math.PI) / 180);
  const kx = resLon * kmPerDegLon; // km per cell, east–west
  const ky = resLat * KM_PER_DEG_LAT; // km per cell, north–south
  const kd = Math.hypot(kx, ky);

  // Only the cells that could be within reach: a window around the site.
  const reach = NEAR_KM + SEED_KM;
  const r0 = Math.max(0, Math.floor((north - (lat0 + reach / KM_PER_DEG_LAT)) / resLat));
  const r1 = Math.min(grid.height - 1, Math.floor((north - (lat0 - reach / KM_PER_DEG_LAT)) / resLat));
  const c0 = Math.max(0, Math.floor((lon0 - reach / kmPerDegLon - west) / resLon));
  const c1 = Math.min(W - 1, Math.floor((lon0 + reach / kmPerDegLon - west) / resLon));
  if (r0 > r1 || c0 > c1) return { status: 'unknown', nearestKm: null, nearestIndex: null, waterCells: 0 };
  const ww = c1 - c0 + 1;
  const wh = r1 - r0 + 1;
  const dist = new Float64Array(ww * wh).fill(Infinity); // 64-bit, like the heap keys it is compared with
  const done = new Uint8Array(ww * wh);
  const centre = (r, c) => [west + (c + 0.5) * resLon, north - (r + 0.5) * resLat];
  const straight = (r, c) => {
    const [lon, lat] = centre(r, c);
    return Math.hypot((lon - lon0) * kmPerDegLon, (lat - lat0) * KM_PER_DEG_LAT);
  };
  const isWater = (r, c) => r >= r0 && r <= r1 && c >= c0 && c <= c1 && codes[r * W + c] !== LAND;
  // Whether the straight line from the site to a cell stays over water (sampled every ~0.5 km).
  const clearLine = (r, c) => {
    const [lon1, lat1] = centre(r, c);
    const km = straight(r, c);
    const steps = Math.ceil(km / 0.5);
    let seenWater = false;
    for (let k = 1; k <= steps; k++) {
      const t = k / steps;
      const lon = lon0 + (lon1 - lon0) * t;
      const lat = lat0 + (lat1 - lat0) * t;
      const rr = Math.floor((north - lat) / resLat);
      const cc = Math.floor((lon - west) / resLon);
      const water = isWater(rr, cc);
      // Land is allowed only at the start, between the site and its shore.
      if (water) seenWater = true;
      else if (seenWater || km * t > SEED_KM) return false;
    }
    return true;
  };

  const heap = createHeap();
  const seed = (r, c, d) => {
    const w = (r - r0) * ww + (c - c0);
    if (d < dist[w]) {
      dist[w] = d;
      heap.push(d, w);
    }
  };
  // Seeds: water within SEED_KM of the site, at their straight-line distance.
  const sr = Math.ceil(SEED_KM / ky);
  const sc = Math.ceil(SEED_KM / kx);
  const rs = Math.floor((north - lat0) / resLat);
  const cs = Math.floor((lon0 - west) / resLon);
  for (let r = rs - sr; r <= rs + sr; r++) {
    for (let c = cs - sc; c <= cs + sc; c++) {
      if (!isWater(r, c)) continue;
      const d = straight(r, c);
      if (d <= SEED_KM) seed(r, c, d);
    }
  }

  const steps = [
    [0, 1, kx], [0, -1, kx], [1, 0, ky], [-1, 0, ky],
    [1, 1, kd], [1, -1, kd], [-1, 1, kd], [-1, -1, kd],
  ];
  let nearest = Infinity;
  let nearestIndex = null;
  let water = 0;
  while (heap.size) {
    const w = heap.pop();
    const d = heap.last;
    if (done[w] || d > dist[w]) continue;
    // Past the point where a nearer flagged cell could still turn up, and with usable
    // water already found (or out of range), the answer is settled.
    const limit = Number.isFinite(nearest) ? Math.min(reach, nearest * GRID_SLACK) : reach;
    if (d > limit && (water || d > NEAR_KM)) break;
    done[w] = 1;
    const r = r0 + Math.floor(w / ww);
    const c = c0 + (w % ww);
    const code = codes[r * W + c];
    if (d <= NEAR_KM && code >= FIRST_WATER_CLASS) water++;
    if (code === CP_LIKE) {
      // In open water the distance is the straight line; around land, the path.
      const km = clearLine(r, c) ? straight(r, c) : d;
      if (km < nearest) {
        nearest = km;
        nearestIndex = r * W + c;
      }
    }
    for (const [dr, dc, cost] of steps) {
      const rr = r + dr;
      const cc = c + dc;
      if (!isWater(rr, cc)) continue;
      // No slipping diagonally between two land cells.
      if (dr && dc && !isWater(r + dr, c) && !isWater(r, c + dc)) continue;
      const nd = d + cost;
      if (nd <= reach) seed(rr, cc, nd);
    }
  }

  let status = 'clear';
  if (!water) status = 'unknown';
  else if (nearest <= ALERT_KM) status = 'alert';
  else if (nearest <= NEAR_KM) status = 'nearby';
  return { status, nearestKm: nearest <= NEAR_KM ? nearest : null, nearestIndex: nearest <= NEAR_KM ? nearestIndex : null, waterCells: water };
}

/** Status for a site whose area has no usable scene on the selected date. */
export function noPassStatus(reason = 'nopass') {
  return { status: 'unknown', nearestKm: null, nearestIndex: null, waterCells: 0, reason };
}

/**
 * Plain-language explanation of a site's status. seabedDepth: the nearest flagged
 * cell's depth when it lies in shallow water where the seabed may show, else null.
 */
export function statusExplanation({ status, nearestKm, reason }, seabedDepth = null) {
  const km = nearestKm == null ? null : Math.round(nearestKm);
  if (reason === 'nopass') return 'No processed satellite pass over this area on this date, so the status is unknown.';
  if (reason === 'error') return "This area's data for this date couldn't be loaded, so the status is unknown.";
  if (reason === 'outside') return "This date's data covers another area, so the status is unknown here.";
  const seabed = seabedDepth == null ? '' : ` That cell is in water ${Math.round(seabedDepth)} m deep, where the seabed may affect the result.`;
  switch (status) {
    case 'alert':
      return `A C. polykrikoides-like cell is ${km} km away by sea, within the ${ALERT_KM} km alert distance.${seabed}`;
    case 'nearby':
      return `The nearest C. polykrikoides-like cell is ${km} km away by sea: inside the ${NEAR_KM} km nearby distance, outside the ${ALERT_KM} km alert distance.${seabed}`;
    case 'unknown':
      return `No usable water within ${NEAR_KM} km by sea on this date (cloud, or water too shallow to assess), so the status can't be judged.`;
    default:
      return `No C. polykrikoides-like cells within ${NEAR_KM} km by sea on this date.`;
  }
}
