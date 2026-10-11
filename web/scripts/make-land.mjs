// Builds web/public/land.geojson: land polygons for each area box, so the map
// can draw land above the class/chlorophyll pixels for a clean coastline.
//
//   npm run land        (rerun whenever the area boxes in data/manifest.json change)
//
// Land = area box − water, where water comes from the same OpenFreeMap vector
// tiles as the basemap, so the drawn coast matches the basemap exactly.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import polygonClipping from 'polygon-clipping';

const here = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST = path.resolve(here, '../../data/manifest.json');
const OUT = path.resolve(here, '../public/land.geojson');
const TILEJSON = 'https://tiles.openfreemap.org/planet';
const ZOOM = 10;
const PAD_DEG = 0.1;
const DECIMALS = 4; // about 11 m

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

async function fetchTile(template, z, x, y) {
  const url = template.replace('{z}', z).replace('{x}', x).replace('{y}', y);
  const res = await fetch(url);
  if (res.status === 204 || res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return new VectorTile(new PbfReader(buf));
}

function polygonsOf(geometry) {
  if (geometry.type === 'Polygon') return [geometry.coordinates];
  if (geometry.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

const round = (v) => Math.round(v * 10 ** DECIMALS) / 10 ** DECIMALS;

async function landFor(region, [west, south, east, north], template) {
  const box = [west - PAD_DEG, south - PAD_DEG, east + PAD_DEG, north + PAD_DEG];
  const xs = [lon2x(box[0], ZOOM), lon2x(box[2], ZOOM)];
  const ys = [lat2y(box[3], ZOOM), lat2y(box[1], ZOOM)];
  let water = [];
  let tiles = 0;
  for (let x = xs[0]; x <= xs[1]; x++) {
    for (let y = ys[0]; y <= ys[1]; y++) {
      const tile = await fetchTile(template, ZOOM, x, y);
      tiles++;
      const layer = tile?.layers.water;
      if (!layer) continue;
      const polys = [];
      for (let i = 0; i < layer.length; i++) {
        const f = layer.feature(i);
        if (f.properties.brunnel === 'tunnel' || f.properties.class === 'swimming_pool') continue;
        polys.push(...polygonsOf(f.toGeoJSON(x, y, ZOOM).geometry));
      }
      if (polys.length) water = polygonClipping.union(water, ...polys.map((p) => [p]));
    }
  }
  const boxPoly = [[[box[0], box[1]], [box[2], box[1]], [box[2], box[3]], [box[0], box[3]], [box[0], box[1]]]];
  const land = polygonClipping.difference(boxPoly, water);
  const coordinates = land.map((poly) => poly.map((ring) => ring.map(([lon, lat]) => [round(lon), round(lat)])));
  console.log(`${region}: ${tiles} tiles, ${coordinates.length} land polygons`);
  return { type: 'Feature', properties: { region }, geometry: { type: 'MultiPolygon', coordinates } };
}

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const tilejson = await (await fetch(TILEJSON)).json();
const template = tilejson.tiles[0];
const features = [];
for (const [region, info] of Object.entries(manifest.regions)) features.push(await landFor(region, info.bbox, template));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(
  OUT,
  JSON.stringify({
    type: 'FeatureCollection',
    attribution: 'Derived from OpenFreeMap / OpenMapTiles water polygons © OpenStreetMap contributors',
    features,
  }),
);
console.log(`wrote ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(2)} MB)`);
