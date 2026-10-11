// Loads and checks the contract files in data/ (docs/DATA_CONTRACT.md).
// Field names are used exactly as the contract spells them.

export const SUPPORTED_MAJOR = 1;
const CLASS_CODES = [0, 1, 2, 3, 4, 5, 6, 7, 8];
const TIER_KEYS = ['not_assessed', 'none', 'low', 'monitor', 'watch', 'high'];

export class ContractError extends Error {
  /**
   * @param {string} message  plain-language summary for the UI
   * @param {object} [extra]  { detail, hint, kind }
   */
  constructor(message, { detail = '', hint = '', kind = 'invalid' } = {}) {
    super(message);
    this.detail = detail;
    this.hint = hint;
    this.kind = kind;
  }
}

export function dataUrl(relPath) {
  return new URL(`data/${relPath}`, document.baseURI).href;
}

async function fetchJson(relPath, what) {
  const url = dataUrl(relPath);
  let res;
  try {
    res = await fetch(url, { cache: 'no-cache' });
  } catch (err) {
    throw new ContractError(`Couldn't reach ${what}.`, {
      detail: `${relPath}: ${err.message}`,
      hint: 'Check that the local server is still running.',
      kind: 'network',
    });
  }
  if (!res.ok) {
    throw new ContractError(`${capitalize(what)} is missing.`, {
      detail: `data/${relPath} returned HTTP ${res.status}.`,
      kind: 'missing',
    });
  }
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new ContractError(`${capitalize(what)} isn't valid JSON.`, { detail: `data/${relPath}: ${err.message}` });
  }
}

function checkVersion(obj, what, relPath) {
  const version = obj?.contract_version;
  if (typeof version !== 'string' || !/^\d+\.\d+$/.test(version)) {
    throw new ContractError(`${capitalize(what)} has no readable contract version.`, {
      detail: `data/${relPath}: contract_version is ${JSON.stringify(version)}.`,
    });
  }
  const major = Number(version.split('.')[0]);
  if (major !== SUPPORTED_MAJOR) {
    throw new ContractError(
      `${capitalize(what)} uses data contract ${version}, but this dashboard reads contract ${SUPPORTED_MAJOR}.x.`,
      {
        detail: `data/${relPath}: contract_version "${version}".`,
        hint: 'Update the dashboard to the new contract, or re-export the data with the matching contract version.',
        kind: 'version',
      },
    );
  }
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isBox = (b) => Array.isArray(b) && b.length === 4 && b.every(isNum) && b[0] < b[2] && b[1] < b[3];

/**
 * Loads data/manifest.json. Throws ContractError when the whole manifest is
 * unusable; a scene with a problem is reported in `problems` and skipped by
 * the caller, so one bad scene never hides the others.
 */
export async function loadManifest() {
  const rel = 'manifest.json';
  const manifest = await fetchJson(rel, 'the scene manifest (data/manifest.json)');
  checkVersion(manifest, 'the scene manifest', rel);

  const rule = manifest.rule;
  const ruleKeys = ['chl_weak_min', 'chl_dense_min', 'nflh_dense_min', 'margin_min'];
  if (!rule || !ruleKeys.every((k) => isNum(rule[k])) || !Array.isArray(rule.confidence_bands)) {
    throw new ContractError("The manifest doesn't contain the thresholds.", {
      detail: `manifest.rule needs numbers for ${ruleKeys.join(', ')} and a confidence_bands list.`,
      hint: 'The dashboard never guesses thresholds. Re-export the manifest with update_manifest().',
    });
  }
  const classes = Array.isArray(manifest.classes) ? manifest.classes : [];
  const missing = CLASS_CODES.filter((c) => !classes.some((k) => k.code === c && k.key && k.label && TIER_KEYS.includes(k.risk_tier)));
  if (missing.length) {
    throw new ContractError("The manifest's class list is incomplete.", {
      detail: `Missing or incomplete class code(s): ${missing.join(', ')}.`,
    });
  }
  const tiers = Array.isArray(manifest.risk_tiers) ? manifest.risk_tiers : [];
  if (!TIER_KEYS.every((k) => tiers.some((t) => t.key === k && t.label))) {
    throw new ContractError("The manifest's risk-tier list is incomplete.", { detail: `Expected tiers: ${TIER_KEYS.join(', ')}.` });
  }
  if (!manifest.regions || typeof manifest.regions !== 'object') {
    throw new ContractError("The manifest doesn't list any areas.", { detail: 'manifest.regions is missing.' });
  }
  if (!Array.isArray(manifest.scenes) || manifest.scenes.length === 0) {
    throw new ContractError('There are no scenes in the manifest yet.', {
      hint: 'Run python pipeline/make_mock_data.py to create mock scenes, or export a real one.',
      kind: 'empty',
    });
  }

  const problems = new Map();
  const seen = new Set();
  for (const scene of manifest.scenes) {
    const id = scene?.scene_id;
    let problem = null;
    if (typeof id !== 'string' || !id) problem = 'It has no scene_id.';
    else if (seen.has(id)) problem = 'Its scene_id appears twice in the manifest.';
    else if (!manifest.regions[scene.region]) problem = `Its area "${scene.region}" isn't in the manifest's area list.`;
    else if (typeof scene.files?.grid !== 'string') problem = "It doesn't name a grid file.";
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(scene.date ?? '')) problem = `Its date "${scene.date}" isn't YYYY-MM-DD.`;
    if (typeof id === 'string') seen.add(id);
    if (problem) problems.set(id ?? `#${manifest.scenes.indexOf(scene)}`, problem);
  }

  return { manifest, problems };
}

/**
 * Loads data/clusters.json. Returns { clusters: Map, wavelengths_nm, fit, units } or
 * throws ContractError; the caller keeps going without cluster details.
 */
export async function loadClusters() {
  const rel = 'clusters.json';
  const what = 'the cluster table (data/clusters.json)';
  const obj = await fetchJson(rel, what);
  checkVersion(obj, 'the cluster table', rel);
  const wl = obj.wavelengths_nm;
  if (!Array.isArray(wl) || !wl.length || !wl.every(isNum)) {
    throw new ContractError("The cluster table's wavelengths are missing.", { detail: 'clusters.json: wavelengths_nm.' });
  }
  const clusters = new Map();
  for (const c of obj.clusters ?? []) {
    if (!Number.isInteger(c.cluster_id) || !c.sam_deg || !c.best_ref || !c.second_ref || !isNum(c.margin)) {
      throw new ContractError("The cluster table doesn't match the data contract.", {
        detail: `clusters.json: cluster ${JSON.stringify(c.cluster_id)} is missing cluster_id, sam_deg, best_ref, second_ref or margin.`,
      });
    }
    clusters.set(c.cluster_id, c);
  }
  return { clusters, wavelengths_nm: wl, fit: obj.fit ?? {}, units: obj.units === 'normalized' ? 'normalized' : 'sr^-1' };
}

/** Loads data/references.json as a Map ref_id → reference. Throws ContractError. */
export async function loadReferences() {
  const rel = 'references.json';
  const obj = await fetchJson(rel, 'the reference spectra (data/references.json)');
  checkVersion(obj, 'the reference spectra', rel);
  const refs = new Map();
  for (const r of obj.references ?? []) {
    if (r.ref_id && Array.isArray(r.wavelengths_nm) && Array.isArray(r.rrs)) refs.set(r.ref_id, r);
  }
  return refs;
}

/** Loads data/sites.geojson. Throws ContractError. */
export async function loadSites() {
  const obj = await fetchJson('sites.geojson', 'the watched sites (data/sites.geojson)');
  if (obj?.type !== 'FeatureCollection' || !Array.isArray(obj.features)) {
    throw new ContractError("The watched-sites file isn't a GeoJSON FeatureCollection.", { detail: 'data/sites.geojson' });
  }
  return obj.features.filter(
    (f) => f?.geometry?.type === 'Point' && f.geometry.coordinates?.length === 2 && f.properties?.site_id,
  );
}

const gridCache = new Map();

/** Loads and checks a scene's grid.json. Cached; a failed load can be retried. */
export function loadGrid(scene) {
  if (!gridCache.has(scene.scene_id)) {
    const promise = fetchGrid(scene).catch((err) => {
      gridCache.delete(scene.scene_id);
      throw err;
    });
    gridCache.set(scene.scene_id, promise);
  }
  return gridCache.get(scene.scene_id);
}

async function fetchGrid(scene) {
  const rel = scene.files.grid;
  const what = `the grid file for “${scene.title || scene.scene_id}”`;
  const grid = await fetchJson(rel, what);
  checkVersion(grid, what, rel);

  const fail = (detail) => {
    throw new ContractError(`${capitalize(what)} doesn't match the data contract.`, { detail: `data/${rel}: ${detail}` });
  };

  if (grid.scene_id !== scene.scene_id) fail(`scene_id is "${grid.scene_id}", expected "${scene.scene_id}".`);
  if (!isBox(grid.bbox)) fail('bbox must be [west, south, east, north].');
  if (!Array.isArray(grid.res_deg) || grid.res_deg.length !== 2 || !grid.res_deg.every((r) => isNum(r) && r > 0)) {
    fail('res_deg must be two positive numbers.');
  }
  const { width, height } = grid;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    fail('width and height must be positive integers.');
  }
  const [west, south, east, north] = grid.bbox;
  const [resLon, resLat] = grid.res_deg;
  if (Math.abs((east - west) / resLon - width) > 0.5 || Math.abs((north - south) / resLat - height) > 0.5) {
    fail(`bbox, res_deg and the ${width}×${height} size don't agree.`);
  }

  const n = width * height;
  for (const field of ['class_code', 'chlor_a', 'nflh', 'cluster_id']) {
    if (!Array.isArray(grid[field])) fail(`${field} is missing.`);
    if (grid[field].length !== n) fail(`${field} has ${grid[field].length} values; width × height is ${n}.`);
  }

  const codes = new Uint8Array(n);
  const counts = new Array(CLASS_CODES.length).fill(0);
  for (let i = 0; i < n; i++) {
    const c = grid.class_code[i];
    if (!Number.isInteger(c) || c < 0 || c > 8) fail(`class_code[${i}] is ${JSON.stringify(c)}; codes are 0–8.`);
    codes[i] = c;
    counts[c]++;
  }

  return { grid, codes, counts };
}

/**
 * Loads every area's depth file (water depth of every cell of that area's grid) that
 * the manifest names (regions.<area>.depth_file). Resolves to the usable ones, as a list.
 */
export async function loadDepth(manifest) {
  const files = Object.values(manifest.regions ?? {}).map((r) => r?.depth_file).filter(Boolean);
  const loaded = await Promise.all(
    files.map(async (rel) => {
      try {
        const d = await fetchJson(rel, 'the depth file');
        checkVersion(d, 'the depth file', rel);
        if (!isBox(d.bbox) || !Array.isArray(d.res_deg) || !Array.isArray(d.depth_m) || d.depth_m.length !== d.width * d.height) {
          throw new ContractError("The depth file doesn't match the data contract.", { detail: `data/${rel}` });
        }
        return d;
      } catch (err) {
        console.warn(`Depth unavailable (${rel}):`, err.message);
        return null;
      }
    }),
  );
  return loaded.filter(Boolean);
}

/** Depth (m) of a cell, from the depth file on the same grid as the scene; else null. */
export function depthAt(depths, grid, index) {
  const depth = (depths ?? []).find(
    (d) =>
      d.width === grid.width && d.height === grid.height &&
      d.bbox.every((v, i) => Math.abs(v - grid.bbox[i]) < 1e-6) &&
      d.res_deg.every((v, i) => Math.abs(v - grid.res_deg[i]) < 1e-9),
  );
  return depth ? depth.depth_m[index] ?? null : null;
}

/**
 * True when an assessed cell's depth is in the shallow-but-assessed zone, at least
 * rule.shallow_max_m and under rule.shallow_flag_max_m deep, where the seabed may still show.
 * False when either threshold or the depth is missing.
 */
export function seabedFlag(rule, d) {
  const lo = rule.shallow_max_m;
  const hi = rule.shallow_flag_max_m;
  return typeof d === 'number' && Number.isFinite(lo) && Number.isFinite(hi) && d >= lo && d < hi;
}

const spectraCache = new Map();

/** Loads a scene's optional spectra.json; resolves to null when the scene has none or it's unusable. */
export function loadSpectra(scene) {
  const rel = scene.files?.spectra;
  if (!rel) return Promise.resolve(null);
  if (!spectraCache.has(scene.scene_id)) {
    spectraCache.set(
      scene.scene_id,
      fetchJson(rel, 'the sample spectra')
        .then((sp) => (sp?.scene_id === scene.scene_id && Array.isArray(sp.wavelengths_nm) && Array.isArray(sp.probes) ? sp : null))
        .catch((err) => {
          console.warn(`Spectra for ${scene.scene_id} unavailable:`, err.message);
          return null;
        }),
    );
  }
  return spectraCache.get(scene.scene_id);
}

/** Grid cell under a lon/lat, per contract section 5; null outside the grid. */
export function cellAt(grid, lon, lat) {
  const [west, , , north] = grid.bbox;
  const [resLon, resLat] = grid.res_deg;
  const col = Math.floor((lon - west) / resLon);
  const row = Math.floor((north - lat) / resLat);
  if (col < 0 || row < 0 || col >= grid.width || row >= grid.height) return null;
  return { row, col, index: row * grid.width + col };
}

/** Cell center of a row/col. */
export function cellCenter(grid, row, col) {
  const [west, , , north] = grid.bbox;
  const [resLon, resLat] = grid.res_deg;
  return { lon: west + (col + 0.5) * resLon, lat: north - (row + 0.5) * resLat };
}

/** Approximate area of every cell with a given class, in km². */
export function classAreaKm2(grid, codes, code) {
  const [, , , north] = grid.bbox;
  const [resLon, resLat] = grid.res_deg;
  let area = 0;
  for (let row = 0; row < grid.height; row++) {
    const lat = north - (row + 0.5) * resLat;
    const cellKm2 = resLon * 111.32 * Math.cos((lat * Math.PI) / 180) * resLat * 110.574;
    const start = row * grid.width;
    for (let col = 0; col < grid.width; col++) if (codes[start + col] === code) area += cellKm2;
  }
  return area;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
