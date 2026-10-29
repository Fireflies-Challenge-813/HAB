// The MapLibre map: a label-free basemap, an optional true-color photo, one
// data overlay per area (tiles drawn in the browser, land cut out, see grid-image.js),
// area outlines and labels, the selected cell and the watched sites. A second, passive map (compare.js) can follow the first one.

import { tilePng, TILE_SIZE } from './grid-image.js';

// OpenFreeMap: free OpenMapTiles vector tiles, no key or sign-up. Styled here
// with land, water and borders only, so there are no place labels and no glyphs.
const BASEMAP_TILEJSON = 'https://tiles.openfreemap.org/planet';
const BASEMAP_ATTRIBUTION =
  '<a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

// NASA GIBS daily true color (free, no key). Change the layer here if needed.
const GIBS_LAYER = 'VIIRS_NOAA20_CorrectedReflectance_TrueColor';
const gibsTiles = (date) =>
  `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${GIBS_LAYER}/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`;
const CURRENTS_ATTRIBUTION =
  'Currents: <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>, Copernicus Marine';
const DRIFT_LAYERS = ['drift-halo', 'drift-track-noctiluca', 'drift-track-cp', 'drift-stop', 'drift-24', 'drift-48'];
const GIBS_ATTRIBUTION =
  'True color: <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA GIBS</a>';

export const DEFAULT_OVERLAY_OPACITY = 0.88;

// Basemap and map-chrome colors per theme. Neutral grays only: hue on the map
// belongs to the data (the class palette and the chlorophyll scale).
const THEMES = {
  light: { land: '#f3f4f4', water: '#ccd4da', coast: '#a3adb4', borders: '#8f959b', ink: '#16191d', halo: '#ffffff', outside: '#d3d7db', outsideOpacity: 0.7 },
  dark: { land: '#24272b', water: '#111519', coast: '#454e57', borders: '#5d646c', ink: '#eef0f2', halo: '#0b0d10', outside: '#0a0c0f', outsideOpacity: 0.6 },
};

function styleFor(t) {
  return {
    version: 8,
    sources: {
      basemap: { type: 'vector', url: BASEMAP_TILEJSON, attribution: BASEMAP_ATTRIBUTION },
    },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': t.land } },
      {
        id: 'water',
        type: 'fill',
        source: 'basemap',
        'source-layer': 'water',
        filter: ['!=', ['get', 'brunnel'], 'tunnel'],
        paint: { 'fill-color': t.water, 'fill-antialias': true },
      },
      // True color and the data overlays are inserted here, below the coastline.
      {
        id: 'coast',
        type: 'line',
        source: 'basemap',
        'source-layer': 'water',
        paint: { 'line-color': t.coast, 'line-width': ['interpolate', ['linear'], ['zoom'], 3, 0.3, 8, 0.9] },
      },
      {
        id: 'borders',
        type: 'line',
        source: 'basemap',
        'source-layer': 'boundary',
        filter: ['all', ['==', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]],
        paint: { 'line-color': t.borders, 'line-width': 0.8, 'line-dasharray': [4, 2] },
      },
    ],
  };
}

const emptyFc = { type: 'FeatureCollection', features: [] };

// Overlay tiles are drawn in the browser from the grid: gbwgrid://{view}.{region}/{version}/{z}/{x}/{y}.
// The protocol is global to MapLibre, so one handler serves every map; each map keys
// its overlays by its own id. The version changes with every redraw, so MapLibre
// fetches fresh tiles.
const overlayRegistry = new Map(); // `${viewId}.${region}` → { layer, version }
let protocolReady = false;
let viewCount = 0;

function addGridProtocol(maplibregl) {
  if (protocolReady) return;
  protocolReady = true;
  maplibregl.addProtocol('gbwgrid', async (params) => {
    const [, key, z, x, y] = params.url.match(/^gbwgrid:\/\/([^/]+)\/\d+\/(\d+)\/(\d+)\/(\d+)/) ?? [];
    const entry = overlayRegistry.get(key);
    if (!entry) throw new Error(`No overlay for ${key}`);
    return { data: await tilePng(entry.layer, Number(z), Number(x), Number(y)) };
  });
}

function ring([west, south, east, north]) {
  return [[west, north], [east, north], [east, south], [west, south], [west, north]];
}

/**
 * Creates the map once MapLibre has loaded.
 * @param {HTMLElement} container
 * @param {{ bbox: number[], padding: () => object, theme: 'light'|'dark',
 *           onHover?: Function, onLeave?: Function, onClick?: Function, passive?: boolean }} options
 *   padding: map padding that keeps fitted boxes clear of the floating panels
 *   passive: a map that only shows (no controls, no input), moved by another map's mirror()
 */
export async function createMap(container, { bbox, padding, theme, onHover, onLeave, onClick, passive = false }) {
  let maplibregl;
  try {
    maplibregl = await import(/* @vite-ignore */ new URL('vendor/maplibre-gl/maplibre-gl.mjs', document.baseURI).href);
  } catch (err) {
    err.engineMissing = true;
    throw err;
  }

  let themeName = theme;
  let colors = THEMES[theme] ?? THEMES.light;
  const map = new maplibregl.Map({
    container,
    style: styleFor(colors),
    bounds: bbox,
    fitBoundsOptions: { padding: padding() },
    minZoom: 3,
    maxZoom: 13,
    renderWorldCopies: false,
    dragRotate: false,
    pitchWithRotate: false,
    touchPitch: false,
    interactive: !passive,
    attributionControl: passive ? false : { compact: true },
  });
  if (!passive) {
    map.touchZoomRotate.disableRotation();
    map.keyboard.disableRotation();
    // The scale sits beside the attribution, bottom right; zoom goes in the dock beside
    // the timeline (mountZoom).
    map.addControl(new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 110 }), 'bottom-right');
  }

  const viewId = String(++viewCount);
  const overlayKeys = new Set(); // this map's entries in overlayRegistry
  addGridProtocol(maplibregl);

  await new Promise((resolve, reject) => {
    map.once('load', resolve);
    map.once('error', (e) => reject(e.error ?? e));
  });
  // After load, tile hiccups (offline, a blocked CDN) shouldn't break anything;
  // the overlay doesn't depend on the basemap.
  map.on('error', (e) => console.warn('Map warning:', e.error?.message ?? e));
  if (!passive) {
    // On phones the attribution starts folded behind its (i) button.
    if (window.matchMedia('(max-width: 760px)').matches) container.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show');
    // On one line it can be cut short on a narrow map; hovering it shows every credit.
    const credits = container.querySelector('.maplibregl-ctrl-attrib-inner');
    if (credits) new MutationObserver(() => (credits.title = credits.textContent)).observe(credits, { childList: true, subtree: true, characterData: true });
  }

  // Everything outside the study area is washed out, so the area reads as the focus
  // (over the basemap and the true-color photo alike).
  map.addSource('outside', { type: 'geojson', data: emptyFc });
  map.addLayer({ id: 'outside', type: 'fill', source: 'outside', paint: { 'fill-color': colors.outside, 'fill-opacity': colors.outsideOpacity, 'fill-antialias': false } });

  map.addSource('frames', { type: 'geojson', data: emptyFc });
  map.addLayer({
    id: 'frames',
    type: 'line',
    source: 'frames',
    paint: {
      'line-color': colors.ink,
      'line-opacity': ['case', ['get', 'has_data'], 0.55, 0.3],
      'line-width': 1,
      'line-dasharray': [3, 3],
    },
  });
  // Where C. polykrikoides-like (dashed) and green Noctiluca-like (dotted) patches
  // would drift with the surface current: a dot at +24 h, a ring at +48 h, a cross
  // where a track meets the coast. C. polykrikoides-like tracks draw on top.
  map.addSource('drift', { type: 'geojson', data: emptyFc, attribution: CURRENTS_ATTRIBUTION });
  const isKind = (k) => ['==', ['get', 'kind'], k];
  map.addLayer({ id: 'drift-halo', type: 'line', source: 'drift', filter: ['any', isKind('track'), isKind('stop')], layout: { 'line-cap': 'round', visibility: 'none' }, paint: { 'line-color': colors.halo, 'line-width': 4, 'line-opacity': 0.85 } });
  const isSpecies = (k) => ['==', ['get', 'species'], k];
  map.addLayer({ id: 'drift-track-noctiluca', type: 'line', source: 'drift', filter: ['all', isKind('track'), isSpecies('noctiluca')], layout: { 'line-cap': 'round', visibility: 'none' }, paint: { 'line-color': colors.ink, 'line-width': 2.2, 'line-dasharray': [0, 2] } });
  map.addLayer({ id: 'drift-track-cp', type: 'line', source: 'drift', filter: ['all', isKind('track'), isSpecies('cp')], layout: { visibility: 'none' }, paint: { 'line-color': colors.ink, 'line-width': 1.8, 'line-dasharray': [2, 1.6] } });
  map.addLayer({ id: 'drift-stop', type: 'line', source: 'drift', filter: isKind('stop'), layout: { 'line-cap': 'round', visibility: 'none' }, paint: { 'line-color': colors.ink, 'line-width': 2 } });
  map.addLayer({ id: 'drift-24', type: 'circle', source: 'drift', filter: isKind('h24'), layout: { visibility: 'none' }, paint: { 'circle-radius': 4, 'circle-color': colors.ink, 'circle-stroke-color': colors.halo, 'circle-stroke-width': 1.5 } });
  map.addLayer({ id: 'drift-48', type: 'circle', source: 'drift', filter: isKind('h48'), layout: { visibility: 'none' }, paint: { 'circle-radius': 5, 'circle-color': colors.halo, 'circle-stroke-color': colors.ink, 'circle-stroke-width': 2 } });

  map.addSource('selection', { type: 'geojson', data: emptyFc });
  map.addLayer({ id: 'selection-halo', type: 'line', source: 'selection', paint: { 'line-color': colors.halo, 'line-width': 4.5 } });
  map.addLayer({ id: 'selection', type: 'line', source: 'selection', paint: { 'line-color': colors.ink, 'line-width': 2 } });

  // A distance or area being measured (measure.js): a fill, a haloed line and the points.
  map.addSource('measure', { type: 'geojson', data: emptyFc });
  map.addLayer({ id: 'measure-fill', type: 'fill', source: 'measure', filter: isKind('fill'), paint: { 'fill-color': colors.ink, 'fill-opacity': 0.1 } });
  map.addLayer({ id: 'measure-halo', type: 'line', source: 'measure', filter: isKind('line'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': colors.halo, 'line-width': 5 } });
  map.addLayer({ id: 'measure-line', type: 'line', source: 'measure', filter: isKind('line'), layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': colors.ink, 'line-width': 2 } });
  map.addLayer({ id: 'measure-vertex', type: 'circle', source: 'measure', filter: isKind('vertex'), paint: { 'circle-radius': 5, 'circle-color': colors.halo, 'circle-stroke-color': colors.ink, 'circle-stroke-width': 2 } });

  if (onHover) map.on('mousemove', (e) => onHover(e.lngLat, e.point));
  if (onClick) map.on('click', (e) => onClick(e.lngLat));
  if (onLeave) map.getCanvas().addEventListener('mouseleave', onLeave);

  // Shown state that a following map (mirror) copies: date-independent geometry and the theme.
  const shared = { measure: null, selection: null };
  const followers = new Set();

  let overlayOpacity = DEFAULT_OVERLAY_OPACITY;
  let siteMarkers = [];
  let labelMarkers = [];

  // The photo and the overlays go just above the basemap water, below the coastline.
  const belowLand = () => 'coast';
  const overlayIds = () => map.getStyle().layers.filter((l) => l.id.startsWith('overlay-')).map((l) => l.id);

  const replaceMarkers = (old, items) => {
    for (const m of old) m.remove();
    return items.map(({ lon, lat, element, anchor = 'center' }) =>
      new maplibregl.Marker({ element, anchor }).setLngLat([lon, lat]).addTo(map),
    );
  };

  const view = {
    map,

    /**
     * Shows an area's overlay, drawn as tiles from layer = { grid, rgba, hatch, land }
     * (see grid-image.js renderTile).
     */
    showOverlay(region, layer) {
      const id = `overlay-${region}`;
      const key = `${viewId}.${region}`;
      const version = (overlayRegistry.get(key)?.version ?? 0) + 1;
      overlayRegistry.set(key, { layer, version });
      overlayKeys.add(key);
      const tiles = [`gbwgrid://${key}/${version}/{z}/{x}/{y}`];
      const source = map.getSource(id);
      if (source) {
        source.setTiles(tiles);
        map.setLayoutProperty(id, 'visibility', 'visible');
      } else {
        // Tiles are drawn up to zoom 14 (zoom 13 on a high-density screen), so cells stay crisp.
        map.addSource(id, { type: 'raster', tiles, tileSize: TILE_SIZE, bounds: layer.grid.bbox, minzoom: 0, maxzoom: 14 });
        map.addLayer(
          {
            id,
            type: 'raster',
            source: id,
            paint: { 'raster-resampling': 'nearest', 'raster-fade-duration': 0, 'raster-opacity': overlayOpacity },
          },
          belowLand(),
        );
      }
    },

    clearOverlay(region) {
      const id = `overlay-${region}`;
      if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', 'none');
    },

    /** Drift tracks: a FeatureCollection of { kind: 'track' | 'stop' } lines and { kind: 'h24' | 'h48' } points, each with species 'cp' | 'noctiluca'. */
    setDrift(fc) {
      map.getSource('drift').setData(fc ?? emptyFc);
    },

    setDriftVisible(on) {
      for (const id of DRIFT_LAYERS) map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    },

    /** Dims the map outside a box ([w, s, e, n]): the area of the date this map shows. */
    setFocus(box) {
      const world = [[-180, -85], [-180, 85], [180, 85], [180, -85], [-180, -85]];
      map.getSource('outside').setData({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [world, ring(box)] } });
    },

    /** Outlines area boxes; areas: [{ bbox, has_data }] (dashed where there's no data). */
    setFrames(areas) {
      map.getSource('frames').setData({
        type: 'FeatureCollection',
        features: areas.map((a) => ({ type: 'Feature', properties: { has_data: a.has_data }, geometry: { type: 'LineString', coordinates: ring(a.bbox) } })),
      });
    },

    setOverlayOpacity(value) {
      overlayOpacity = value;
      for (const id of overlayIds()) map.setPaintProperty(id, 'raster-opacity', value);
    },

    /** NASA true-color photo for a date (YYYY-MM-DD), or null to hide it. */
    setTrueColor(date) {
      if (!date) {
        if (map.getLayer('truecolor')) map.setLayoutProperty('truecolor', 'visibility', 'none');
        return;
      }
      const source = map.getSource('truecolor');
      if (source) {
        source.setTiles([gibsTiles(date)]);
        map.setLayoutProperty('truecolor', 'visibility', 'visible');
      } else {
        map.addSource('truecolor', { type: 'raster', tiles: [gibsTiles(date)], tileSize: 256, maxzoom: 9, attribution: GIBS_ATTRIBUTION });
        map.addLayer({ id: 'truecolor', type: 'raster', source: 'truecolor', paint: { 'raster-fade-duration': 0 } }, overlayIds()[0] ?? belowLand());
      }
    },

    showSelection(cellBox) {
      shared.selection = cellBox;
      map.getSource('selection').setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: ring(cellBox) } });
      for (const f of followers) f.showSelection(cellBox);
    },

    clearSelection() {
      shared.selection = null;
      map.getSource('selection').setData(emptyFc);
      for (const f of followers) f.clearSelection();
    },

    /** The measurement: a FeatureCollection of { kind: 'fill' | 'line' | 'vertex' } features, or null. */
    setMeasure(fc) {
      shared.measure = fc;
      map.getSource('measure').setData(fc ?? emptyFc);
      for (const f of followers) f.setMeasure(fc);
    },

    /** Puts MapLibre's zoom in and out buttons at the end of a container outside the map. */
    mountZoom(container) {
      container.append(new maplibregl.NavigationControl({ showCompass: false }).onAdd(map));
    },

    /** Replaces the site markers. Each item: { lon, lat, element }. */
    setMarkers(items) {
      siteMarkers = replaceMarkers(siteMarkers, items);
    },

    /** Replaces the place labels (city names). Each item: { lon, lat, element, anchor }. */
    setLabels(items) {
      labelMarkers = replaceMarkers(labelMarkers, items);
    },

    /** Recolors the basemap and map chrome for 'light' or 'dark'. */
    setTheme(name) {
      themeName = name;
      for (const f of followers) f.setTheme(name);
      colors = THEMES[name] ?? THEMES.light;
      map.setPaintProperty('land', 'background-color', colors.land);
      map.setPaintProperty('water', 'fill-color', colors.water);
      map.setPaintProperty('coast', 'line-color', colors.coast);
      map.setPaintProperty('borders', 'line-color', colors.borders);
      map.setPaintProperty('frames', 'line-color', colors.ink);
      map.setPaintProperty('outside', 'fill-color', colors.outside);
      map.setPaintProperty('outside', 'fill-opacity', colors.outsideOpacity);
      map.setPaintProperty('drift-halo', 'line-color', colors.halo);
      map.setPaintProperty('drift-track-noctiluca', 'line-color', colors.ink);
      map.setPaintProperty('drift-track-cp', 'line-color', colors.ink);
      map.setPaintProperty('drift-stop', 'line-color', colors.ink);
      map.setPaintProperty('drift-24', 'circle-color', colors.ink);
      map.setPaintProperty('drift-24', 'circle-stroke-color', colors.halo);
      map.setPaintProperty('drift-48', 'circle-color', colors.halo);
      map.setPaintProperty('drift-48', 'circle-stroke-color', colors.ink);
      map.setPaintProperty('selection-halo', 'line-color', colors.halo);
      map.setPaintProperty('selection', 'line-color', colors.ink);
      map.setPaintProperty('measure-fill', 'fill-color', colors.ink);
      map.setPaintProperty('measure-halo', 'line-color', colors.halo);
      map.setPaintProperty('measure-line', 'line-color', colors.ink);
      map.setPaintProperty('measure-vertex', 'circle-color', colors.halo);
      map.setPaintProperty('measure-vertex', 'circle-stroke-color', colors.ink);
    },

    /** Fits a box into the part of the map not covered by panels. */
    fitTo(box, animate = false) {
      map.setPadding({ top: 0, bottom: 0, left: 0, right: 0 }); // fitBounds adds any camera padding left by flyTo
      map.fitBounds(box, { padding: padding(), duration: animate ? 600 : 0 });
    },

    flyTo(lon, lat, zoom = 9) {
      map.flyTo({ center: [lon, lat], zoom: Math.max(map.getZoom(), zoom), duration: 700, padding: padding() });
    },

    /**
     * Makes another (passive) map follow this one: the same camera on every move, and
     * the same measurement, selected cell and theme (the area border and wash-out are its own). Returns a
     * function that stops following.
     */
    mirror(other) {
      followers.add(other);
      const sync = () =>
        other.map.jumpTo({ center: map.getCenter(), zoom: map.getZoom(), bearing: map.getBearing(), pitch: map.getPitch(), padding: map.getPadding() });
      map.on('move', sync);
      sync();
      other.setTheme(themeName);
      other.setMeasure(shared.measure);
      if (shared.selection) other.showSelection(shared.selection);
      else other.clearSelection();
      return () => {
        followers.delete(other);
        map.off('move', sync);
      };
    },

    /** Removes the map and its overlay tiles (used for the passive compare map). */
    remove() {
      for (const key of overlayKeys) overlayRegistry.delete(key);
      overlayKeys.clear();
      map.remove();
    },
  };
  return view;
}
