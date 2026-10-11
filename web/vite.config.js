import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// The contract files live at the repo root (../data). The app fetches them at
// the relative URL `data/...`, so the dev server serves that folder and the
// build copies it next to index.html. In mock mode (npm run dev:mock) the dev
// server serves the generated mock data (../mock-data) instead, for the full
// check suite; the build always ships ../data.
const DATA_DIR = path.resolve(here, '../data');
const MOCK_DATA_DIR = path.resolve(here, '../mock-data');

// MapLibre v6 starts its worker from a file beside its own module, so it can't
// be bundled. Its three ES modules are served (and copied) unchanged instead.
const MAPLIBRE_DIR = path.resolve(here, 'node_modules/maplibre-gl/dist');
const MAPLIBRE_FILES = ['maplibre-gl.mjs', 'maplibre-gl-shared.mjs', 'maplibre-gl-worker.mjs'];

const CONTENT_TYPES = {
  '.json': 'application/json; charset=utf-8',
  '.geojson': 'application/geo+json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
};

function serveFrom(dir, only) {
  return (req, res) => {
    const rel = decodeURIComponent((req.url || '/').split('?')[0]).replace(/^\/+/, '');
    const file = path.resolve(dir, rel);
    const allowed = file.startsWith(dir + path.sep) && (!only || only.includes(rel));
    fs.readFile(allowed ? file : '', (err, body) => {
      if (err) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }
      res.setHeader('Content-Type', CONTENT_TYPES[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.end(body);
    });
  };
}

function contractAndVendorFiles(mode) {
  let outDir;
  const served = mode === 'mock' ? MOCK_DATA_DIR : DATA_DIR;
  return {
    name: 'gbw-contract-and-vendor-files',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      if (!fs.existsSync(path.join(served, 'manifest.json'))) {
        server.config.logger.warn(`No contract data in ${served}.${mode === 'mock' ? ' Run: python pipeline/make_mock_data.py' : ''}`);
      }
      server.middlewares.use('/data', serveFrom(served));
      server.middlewares.use('/vendor/maplibre-gl', serveFrom(MAPLIBRE_DIR, MAPLIBRE_FILES));
    },
    writeBundle() {
      if (!fs.existsSync(path.join(DATA_DIR, 'manifest.json'))) {
        throw new Error(`No contract data in ${DATA_DIR}. Run: python pipeline/import_map_export.py <export folder>`);
      }
      fs.cpSync(DATA_DIR, path.join(outDir, 'data'), { recursive: true });
      const vendor = path.join(outDir, 'vendor', 'maplibre-gl');
      fs.mkdirSync(vendor, { recursive: true });
      for (const f of MAPLIBRE_FILES) fs.copyFileSync(path.join(MAPLIBRE_DIR, f), path.join(vendor, f));
    },
  };
}

export default defineConfig(({ mode }) => ({
  base: './',
  appType: 'mpa',
  plugins: [contractAndVendorFiles(mode)],
  server: { port: mode === 'mock' ? 5174 : 5173, host: '127.0.0.1', strictPort: true },
  preview: { port: 4173, host: '127.0.0.1' },
  build: { target: 'es2022' },
}));
