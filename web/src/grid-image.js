// Draws a contract grid as map tiles, so every screen pixel shows exactly the
// cell under it, at every zoom.
//
// Each 256-pixel Web Mercator tile is filled pixel by pixel: the pixel's centre
// goes to longitude and latitude, and from there to its grid cell with the same
// arithmetic a click uses (contract.js cellAt). Cell edges therefore land on the
// true lines of latitude and longitude, where the Gulf-rule outlines and the
// selection box are drawn. (A single stretched image can't do this: MapLibre
// rounds an image's corners to a coarse grid, and grid rows aren't evenly
// spaced in Mercator y.)

export const TILE_SIZE = 256;

// Diagonal stripes over hatched cells, HATCH_PERIOD tile pixels apart.
const HATCH_PERIOD = 6;

/**
 * Per-cell RGBA from class codes.
 * @param {Uint8Array} codes
 * @param {(Array<number>|null)[]} rgbaByCode  index = class code; null = transparent
 */
export function paintClasses(codes, rgbaByCode) {
  const out = new Uint8ClampedArray(codes.length * 4);
  for (let i = 0; i < codes.length; i++) {
    const rgba = rgbaByCode[codes[i]];
    if (rgba) out.set(rgba, i * 4);
  }
  return out;
}

/**
 * Per-cell RGBA from a value array (null = transparent), e.g. chlorophyll.
 * @param {(number|null)[]} values
 * @param {(v: number) => number[]} colorOf  value → [r, g, b]
 */
export function paintValues(values, colorOf) {
  const out = new Uint8ClampedArray(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) continue;
    const [r, g, b] = colorOf(v);
    out[i * 4] = r;
    out[i * 4 + 1] = g;
    out[i * 4 + 2] = b;
    out[i * 4 + 3] = 255;
  }
  return out;
}

/** Longitude of a tile-space x (0–1 across the world). */
const lonOf = (x01) => x01 * 360 - 180;
/** Latitude of a tile-space y (0–1 from the north edge of Web Mercator). */
const latOf = (y01) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y01))) * 180) / Math.PI;
const x01Of = (lon) => (lon + 180) / 360;
const y01Of = (lat) => (1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2;

/** Land polygons with their bounding boxes, worked out once per land object. */
const landIndex = new WeakMap();
function indexLand(land) {
  let index = landIndex.get(land);
  if (!index) {
    index = [];
    for (const f of land.features ?? []) {
      const g = f.geometry;
      const polys = g?.type === 'Polygon' ? [g.coordinates] : g?.type === 'MultiPolygon' ? g.coordinates : [];
      for (const poly of polys) {
        const box = [180, 90, -180, -90];
        for (const [lon, lat] of poly[0]) {
          if (lon < box[0]) box[0] = lon;
          if (lat < box[1]) box[1] = lat;
          if (lon > box[2]) box[2] = lon;
          if (lat > box[3]) box[3] = lat;
        }
        index.push({ poly, box });
      }
    }
    landIndex.set(land, index);
  }
  return index;
}

/**
 * Draws one tile of an overlay.
 * - layer.grid: the contract grid; layer.rgba: per-cell RGBA (paintClasses / paintValues)
 * - layer.hatch ({ cells: 1 = hatched, rgba }): stripes over those cells
 * - layer.land (GeoJSON land polygons): cut out, so the basemap or the photo shows on land
 * Display only: the grid values themselves are untouched.
 * @returns {HTMLCanvasElement|OffscreenCanvas|null} null when the tile misses the grid
 */
export function renderTile(layer, z, x, y, size = TILE_SIZE) {
  const { grid, rgba, hatch, land } = layer;
  const [west, south, east, north] = grid.bbox;
  const [resLon, resLat] = grid.res_deg;
  const { width: W, height: H } = grid;
  const n = 2 ** z;
  const tileWest = lonOf(x / n);
  const tileEast = lonOf((x + 1) / n);
  const tileNorth = latOf(y / n);
  const tileSouth = latOf((y + 1) / n);
  if (tileEast <= west || tileWest >= east || tileSouth >= north || tileNorth <= south) return null;

  // Grid column of every pixel column, and grid row of every pixel row (-1 = outside).
  const cols = new Int32Array(size);
  for (let px = 0; px < size; px++) {
    const lon = lonOf((x + (px + 0.5) / size) / n);
    const col = Math.floor((lon - west) / resLon);
    cols[px] = col >= 0 && col < W ? col : -1;
  }
  const rows = new Int32Array(size);
  for (let py = 0; py < size; py++) {
    const lat = latOf((y + (py + 0.5) / size) / n);
    const row = Math.floor((north - lat) / resLat);
    rows[py] = row >= 0 && row < H ? row : -1;
  }

  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(size, size) : Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(size, size);
  const out = image.data;
  const [hr, hg, hb, ha] = hatch?.rgba ?? [0, 0, 0, 0];
  const hA = ha / 255;
  for (let py = 0; py < size; py++) {
    const row = rows[py];
    if (row < 0) continue;
    const base = row * W;
    for (let px = 0; px < size; px++) {
      const col = cols[px];
      if (col < 0) continue;
      const cell = base + col;
      const s = cell * 4;
      const o = (py * size + px) * 4;
      let r = rgba[s];
      let g = rgba[s + 1];
      let b = rgba[s + 2];
      let a = rgba[s + 3];
      if (hatch && hatch.cells[cell] && (px + py) % HATCH_PERIOD < 2) {
        // The stripe over the cell's color ("source over").
        const bA = a / 255;
        const oA = hA + bA * (1 - hA);
        if (oA > 0) {
          r = (hr * hA + r * bA * (1 - hA)) / oA;
          g = (hg * hA + g * bA * (1 - hA)) / oA;
          b = (hb * hA + b * bA * (1 - hA)) / oA;
        }
        a = oA * 255;
      }
      out[o] = r;
      out[o + 1] = g;
      out[o + 2] = b;
      out[o + 3] = a;
    }
  }
  ctx.putImageData(image, 0, 0);

  if (land) {
    const px = (lon) => (x01Of(lon) * n - x) * size;
    const py = (lat) => (y01Of(lat) * n - y) * size;
    ctx.globalCompositeOperation = 'destination-out';
    for (const { poly, box } of indexLand(land)) {
      if (box[2] < tileWest || box[0] > tileEast || box[3] < tileSouth || box[1] > tileNorth) continue;
      ctx.beginPath();
      for (const ring of poly) {
        ring.forEach(([lon, lat], i) => (i ? ctx.lineTo(px(lon), py(lat)) : ctx.moveTo(px(lon), py(lat))));
        ctx.closePath();
      }
      ctx.fill('evenodd');
    }
  }
  return canvas;
}

/** A tile as PNG bytes, the form MapLibre's raster sources load. */
export async function tilePng(layer, z, x, y) {
  // A tile beside the grid is a single clear pixel (MapLibre stretches it).
  const canvas = renderTile(layer, z, x, y) ?? (typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : Object.assign(document.createElement('canvas'), { width: 1, height: 1 }));
  const blob = canvas.convertToBlob
    ? await canvas.convertToBlob({ type: 'image/png' })
    : await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blob.arrayBuffer();
}
