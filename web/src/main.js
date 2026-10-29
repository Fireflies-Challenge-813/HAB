import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import {
  loadManifest, loadClusters, loadReferences, loadSites, loadGrid, loadSpectra, loadDepth, depthAt, seabedFlag,
  cellAt, cellCenter, classAreaKm2, ContractError,
} from './contract.js';
import { createMap, DEFAULT_OVERLAY_OPACITY } from './map.js';
import { paintClasses, paintValues } from './grid-image.js';
import {
  CLASS_COLORS, TIER_CLASS, TIER_ICONS, HATCH, hexToRgb, chlColor, chlPosition, chlGradientCss, CHL_MAX,
  nflhColor, nflhPosition, nflhGradientCss, nflhMax,
} from './scales.js';
import { explainPixel, pixelCardHtml, pixelFlags, refLabel } from './inspector.js';
import { renderChart } from './chart.js';
import { createTimeline, isIsoDate, toISO } from './timeline.js';
import { sectionHtml, setFolded, loadFolded, createRail } from './sections.js';
import { moreHtml, bindMore } from './more.js';
import { createMeasure } from './measure.js';
import { createCompare } from './compare.js';
import { bindTips } from './tip.js';
import { PLACES, PLACE_ZOOMS } from './places.js';
import { renderAbout } from './about.js';
import { loadCurrentsIndex, loadCurrents, meanAt, bloomPatches, driftTrack, distanceKm, towardWord, bearingWord } from './currents.js';
import { createFlowLayer } from './flow.js';
import { siteStatus, noPassStatus, statusExplanation, SITE_STATUS } from './sites.js';
import {
  esc, richText, icon, fmtDate, fmtLatLon, fmtInt, fmtChl, fmtNflh, fmtAngle, fmtMargin,
  roleInfo, roleBadge, statusBadge, SENSORS, SITE_TYPES,
} from './format.js';

const LAYERS = ['classes', 'chl', 'nflh']; // the legend's layer buttons, in order
// What the right side of the compare divider can show: a layer, or the date's true-color photo.
const READINGS = { classes: 'Classes', chl: 'Chlorophyll', nflh: 'nFLH', photo: 'Photo' };
// Class codes, in precedence order (DATA_CONTRACT.md section 6).
const LAND = 0;
const SHALLOW = 1;
const CLEAR = 3;
const CP_LIKE = 6;
const NOCTILUCA_LIKE = 7;
/** Codes whose chlorophyll and fluorescence readings are drawn: shallow water and assessed water. */
const hasReading = (code) => code === SHALLOW || code >= CLEAR;

// Reference line colors in the spectrum chart (bloom refs match their class).
const REF_COLORS = {
  cp: CLASS_COLORS.cp_like,
  noctiluca_green: CLASS_COLORS.noctiluca_like,
  diatom: CLASS_COLORS.diatom_like,
  water_clear: CLASS_COLORS.clear,
  water_turbid: '#8c7a4f',
  seabed: '#a8a294',
};

// Site statuses as colors defined on the page root (for the folded summary and the rail).
const STATUS_ACCENT = { alert: 'var(--tier-high)', nearby: 'var(--tier-watch)', clear: 'var(--ink-2)', unknown: 'var(--ink-3)' };

// One color source for the map and the interface: the class palette in
// scales.js becomes CSS variables (--c-<class key>, --tier-<tier key>).
{
  const root = document.documentElement.style;
  for (const [key, color] of Object.entries(CLASS_COLORS)) if (color) root.setProperty(`--c-${key}`, color);
  for (const [tier, key] of Object.entries(TIER_CLASS)) root.setProperty(`--tier-${tier}`, key ? CLASS_COLORS[key] : 'var(--ink-3)');
}

const $ = (id) => document.getElementById(id);
const els = {
  topbar: document.querySelector('.topbar'),
  sceneHead: $('scene-head'),
  mockBanner: $('mock-banner'),
  themeBtn: $('theme-btn'),
  sitesPanel: document.querySelector('.sites'),
  siteList: $('site-list'),
  siteSummary: $('site-summary'),
  map: $('map'),
  tools: $('map-tools'),
  toolsHead: $('tools-head'),
  toolsBody: $('tools-body'),
  toolsRail: $('tools-rail'),
  sitesRail: $('sites-rail'),
  readout: $('readout'),
  measureCard: $('measure-card'),
  compareBar: $('compare-bar'),
  mapStatus: $('map-status'),
  timeline: $('timeline'),
  mapDock: $('map-dock'),
  aboutBtn: $('about-btn'),
  about: $('about'),
  inspector: $('inspector'),
  inspScroll: $('insp-scroll'),
  inspContent: $('insp-content'),
  inspRail: $('insp-rail'),
  toast: $('toast'),
  fatal: $('fatal'),
};

const phoneQuery = window.matchMedia('(max-width: 760px)');
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

// What this browser remembers between visits (localStorage). Declared before
// `state`, which reads them as it starts.
const CURRENTS_KEY = 'gbw-currents'; // surface currents switched on
const SITE_TYPES_KEY = 'gbw-site-types'; // site types hidden from the map and list
const PLACES_KEY = 'gbw-place-names'; // city names hidden
const SIDE_KEY = 'gbw-panels'; // panels slid to the side

const state = {
  manifest: null,
  problems: new Map(), // scene_id → why the manifest entry can't be used
  loadFailures: new Map(), // scene_id → ContractError from loading its grid
  scenes: [], // usable scenes, by date then area
  dates: [], // unique dates that have scenes, ascending
  range: null, // { start, max, end }: the timeline's span; max = latest pickable day
  timeline: null, // from createTimeline()
  date: null, // selected date (any day in the range, with or without scenes)
  shown: new Map(), // region → { scene, loaded, error } for the selected date
  clusters: null, // Map cluster_id → cluster
  clusterWavelengths: null,
  clusterFit: null, // how the clusters were fitted (clusters.json fit)
  clusterUnits: 'sr^-1', // of the cluster curves: Rrs, or 'normalized' (unit length)
  clustersError: null,
  references: null, // Map ref_id → reference
  sites: [],
  hiddenSiteTypes: loadHiddenSiteTypes(), // site types switched off by the toggles under the sites tab
  showCurrents: loadShowCurrents(), // animated surface currents and drift tracks
  showPlaces: loadShowPlaces(), // UAE and Oman city names on the map
  currentsIndex: new Set(), // dates with currents prepared (public/currents/)
  currents: null, // the selected date's currents field, while the layer is shown
  currentsField: null, // the selected date's currents field whenever prepared (the hover readout)
  flow: null, // the particle layer, from createFlowLayer()
  currentsToken: 0,
  land: null, // land polygons (web/public/land.geojson), cut out of the overlays
  depth: [], // each area's depth file (water depth per cell) that the manifest names
  siteStatuses: new Map(), // site_id → status on the selected date
  alertCount: 0, // sites on Alert on the selected date
  view: null, // map wrapper from createMap()
  viewReady: null,
  fitted: false,
  area: null, // the areas (regions) of the last date shown, to notice a change of area
  layer: 'classes', // or 'chl' (chlorophyll) or 'nflh' (fluorescence)
  sideHidden: loadSideHidden(), // { tools, sites, inspector }: panels slid to the side
  trueColor: false,
  landOnTop: true,
  opacity: DEFAULT_OVERLAY_OPACITY,
  selection: null, // { lon, lat } of the clicked point, kept across dates
  selectedSite: null,
  chart: { normalize: true, showAll: false },
  folded: loadFolded(), // keys of the details sections the viewer folded
  rails: null, // { inspector, sites, tools }: the panels' rails, from createRail()
  selectToken: 0,
  drawToken: 0,
  cmp: null, // the swipe-compare divider and second map, from createCompare()
  // Swipe compare: B's date and reading (READINGS key), its scenes like `shown`, and a load token.
  compare: { open: false, date: null, layer: null, shown: new Map(), token: 0 },
};

boot();

async function boot() {
  if (location.protocol === 'file:') return; // index.html explains what to do

  const side = Promise.allSettled([loadClusters(), loadReferences(), loadSites(), loadLand()]);
  try {
    const { manifest, problems } = await loadManifest();
    state.manifest = manifest;
    state.problems = problems;
  } catch (err) {
    showFatal(err);
    return;
  }

  loadCurrentsIndex().then((index) => {
    state.currentsIndex = index;
    renderTools();
    updateCurrents();
  });

  // Water depth is only needed for pixel details, so it loads in the background.
  loadDepth(state.manifest).then((depth) => {
    state.depth = depth;
    if (depth && (state.selection || state.selectedSite)) renderInspector();
  });

  const [clusters, references, sites, land] = await side;
  if (clusters.status === 'fulfilled') {
    state.clusters = clusters.value.clusters;
    state.clusterWavelengths = clusters.value.wavelengths_nm;
    state.clusterFit = clusters.value.fit;
    state.clusterUnits = clusters.value.units;
  } else {
    state.clustersError = clusters.reason;
    console.warn('Cluster table unavailable:', clusters.reason?.message);
  }
  if (references.status === 'fulfilled') state.references = references.value;
  else console.warn('References unavailable:', references.reason?.message);
  if (sites.status === 'fulfilled') state.sites = sites.value;
  else console.warn('Sites unavailable:', sites.reason?.message);
  if (land.status === 'fulfilled') state.land = land.value;
  else console.warn('Land polygons unavailable; data pixels will show at the coast:', land.reason?.message);

  const regionOrder = Object.keys(state.manifest.regions);
  state.scenes = state.manifest.scenes
    .filter((s) => !state.problems.has(s.scene_id))
    .sort((a, b) => a.date.localeCompare(b.date) || regionOrder.indexOf(a.region) - regionOrder.indexOf(b.region));
  if (state.scenes.length === 0) {
    showFatal(new ContractError('None of the scenes in the manifest can be shown.', {
      detail: [...state.problems].map(([id, why]) => `${id}: ${why}`).join('\n'),
    }));
    return;
  }
  state.dates = [...new Set(state.scenes.map((s) => s.date))];
  if (state.problems.size) {
    for (const [id, why] of state.problems) console.warn(`Scene ${id} can't be shown: ${why}`);
    toast(`${state.problems.size} scene${state.problems.size > 1 ? 's' : ''} in the manifest can't be shown: ${[...state.problems.keys()].join(', ')}. Run the validator for details.`);
  }

  // The timeline spans whole years, from the first scene's year to the year of
  // today (or of the last scene), so dates sit in their true place in time.
  const now = new Date();
  const today = toISO(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const max = [today, state.dates.at(-1)].sort().at(-1);
  state.range = { start: `${state.dates[0].slice(0, 4)}-01-01`, max, end: `${max.slice(0, 4)}-12-31` };
  state.timeline = createTimeline(els.timeline, { ...state.range, onSelect: goToDate, onStep: step });

  state.rails = {
    inspector: createRail(els.inspScroll, els.inspRail, {
      content: els.inspContent,
      onOpen: (sec) => setFolded(sec, false, state.folded),
    }),
    sites: createRail(els.siteList, els.sitesRail, { spy: false, names: 'one' }),
    tools: createRail(els.toolsBody, els.toolsRail, { spy: false, names: 'one' }),
  };
  setupSidePanels();
  addSiteToggles();
  renderTools();
  bindEvents();
  updateThemeButton();
  trackPanelSizes();

  state.viewReady = createMap(els.map, {
    bbox: areaBox(),
    padding: mapPadding,
    theme: effectiveTheme(),
    onHover: showReadout,
    onLeave: () => {
      els.readout.hidden = true;
      showScaleCursor(null);
    },
    onClick: onMapClick,
  })
    .then((view) => {
      view.setFocus(areaBox());
      state.view = view;
      state.flow = createFlowLayer(view.map);
      state.measure = createMeasure(view, {
        card: els.measureCard,
        onCopy: (text) => toast(text ? `Copied ${text}` : "Couldn't copy the coordinates in this browser."),
        onChange: (active) => els.mapDock.querySelector('[data-dock="measure"]')?.setAttribute('aria-pressed', String(active)),
      });
      addDockTools();
      view.mountZoom(els.mapDock);
      addPlaceLabels();
      state.cmp = createCompare({
        mainView: view,
        host: els.map,
        createView: (el) => createMap(el, { bbox: areaBox(), padding: mapPadding, theme: effectiveTheme(), passive: true }),
        bounds: () => {
          const pad = mapPadding();
          return [pad.left, els.map.clientWidth - pad.right];
        },
      });
      return view;
    })
    .catch((err) => {
      showFatal(
        err?.engineMissing
          ? new ContractError("The map engine couldn't be loaded.", {
              detail: String(err?.message ?? err),
              hint: "The server didn't deliver MapLibre's module files (vendor/maplibre-gl/*.mjs) as JavaScript. Use npm run dev or npm run preview locally; GitHub Pages and Netlify serve them correctly.",
            })
          : new ContractError("The map couldn't start in this browser.", {
              detail: String(err?.message ?? err),
              hint: 'Gulf Bloom Watch needs WebGL. Try an up-to-date Chrome, Edge, Firefox or Safari, and check that hardware acceleration is on.',
            }),
      );
    });

  window.addEventListener('hashchange', onHashChange);
  onHashChange();
}

async function loadLand() {
  const res = await fetch(new URL('land.geojson', document.baseURI), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`land.geojson: HTTP ${res.status}`);
  return res.json();
}

/** The union of the area boxes. */
function areaBox() {
  return unionBox(Object.values(state.manifest.regions).map((r) => r.bbox));
}

/** The box of a date's scenes (their areas), or null when it has none. */
function dateBox(date) {
  const boxes = scenesOn(date).map((s) => state.manifest.regions[s.region]?.bbox).filter(Boolean);
  return boxes.length ? unionBox(boxes) : null;
}

/**
 * The areas (region keys) a date shows: its scenes' areas; on a day without data, the
 * last area shown (so the view doesn't jump), else the first area.
 */
function areasOf(date) {
  const own = [...new Set(scenesOn(date).map((s) => s.region))];
  if (own.length) return own;
  const last = (state.area ?? '').split(',').filter((r) => state.manifest.regions[r]);
  return last.length ? last : [Object.keys(state.manifest.regions)[0]];
}

/** The box of the areas a date shows: everything outside it is washed out. */
const areasBox = (date) => unionBox(areasOf(date).map((r) => state.manifest.regions[r].bbox));

/** The borders of the areas a date shows, dashed where an area has no loaded grid; shown is region → { loaded }. */
function framesFor(date, shown) {
  return areasOf(date).map((region) => {
    const x = shown.get(region);
    return { bbox: x?.loaded?.grid.bbox ?? state.manifest.regions[region].bbox, has_data: !!x?.loaded };
  });
}

const boxContains = ([w, s, e, n], { lng, lat }) => lng >= w && lng <= e && lat >= s && lat <= n;

/** True when the whole map view lies inside a box. */
function viewInside([w, s, e, n]) {
  const b = state.view.map.getBounds();
  return b.getWest() >= w && b.getEast() <= e && b.getSouth() >= s && b.getNorth() <= n;
}
const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function unionBox(boxes) {
  return [
    Math.min(...boxes.map((b) => b[0])),
    Math.min(...boxes.map((b) => b[1])),
    Math.max(...boxes.map((b) => b[2])),
    Math.max(...boxes.map((b) => b[3])),
  ];
}

/** Publishes the floating panels' real sizes as CSS variables for the layout. */
function trackPanelSizes() {
  const root = document.documentElement.style;
  const update = () => {
    root.setProperty('--top-h', `${Math.round(els.topbar.offsetHeight)}px`);
    root.setProperty('--tl-h', `${Math.round(els.timeline.offsetHeight)}px`);
    root.setProperty('--sites-h', phoneQuery.matches ? '0px' : `${Math.round(els.sitesPanel.offsetHeight)}px`);
  };
  update();
  const observer = new ResizeObserver(update);
  for (const el of [els.topbar, els.timeline, els.sitesPanel]) observer.observe(el);
  phoneQuery.addEventListener('change', update);
}

/** Map padding that keeps fitted areas clear of the floating panels. */
function mapPadding() {
  const m = els.map.getBoundingClientRect();
  const r = (el) => el.getBoundingClientRect();
  const gap = 12;
  const pad = {
    top: Math.max(gap, r(els.topbar).bottom - m.top + gap),
    bottom: Math.max(gap, m.bottom - r(els.timeline).top + gap),
    left: gap,
    right: gap,
  };
  if (!phoneQuery.matches) {
    pad.left = Math.max(r(els.tools).right, r(els.sitesPanel).right) - m.left + gap;
    pad.right = m.right - r(els.inspector).left + gap;
  }
  // Never squeeze the visible map below 160 × 120 px.
  const squeeze = (a, b, size, min) => {
    const over = a + b - (size - min);
    return over > 0 ? [Math.max(0, a - over / 2), Math.max(0, b - over / 2)] : [a, b];
  };
  [pad.left, pad.right] = squeeze(pad.left, pad.right, m.width, 160);
  [pad.top, pad.bottom] = squeeze(pad.top, pad.bottom, m.height, 120);
  return pad;
}

// ---------------------------------------------------------------- theme

function effectiveTheme() {
  return document.documentElement.dataset.theme ?? (darkQuery.matches ? 'dark' : 'light');
}

function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  const system = darkQuery.matches ? 'dark' : 'light';
  try {
    if (next === system) localStorage.removeItem('gbw-theme');
    else localStorage.setItem('gbw-theme', next);
  } catch {
    // Storage blocked: the choice lasts for this visit only.
  }
  if (next === system) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  onThemeChange();
}

function onThemeChange() {
  state.view?.setTheme(effectiveTheme());
  updateThemeButton();
}

function updateThemeButton() {
  const label = effectiveTheme() === 'dark' ? 'Switch to light' : 'Switch to dark';
  els.themeBtn.title = label;
  els.themeBtn.querySelector('.visually-hidden').textContent = label;
}

// ---------------------------------------------------------------- side panels


function loadShowCurrents() {
  try {
    return localStorage.getItem(CURRENTS_KEY) !== '0';
  } catch {
    return true;
  }
}

function loadShowPlaces() {
  try {
    return localStorage.getItem(PLACES_KEY) !== '0';
  } catch {
    return true;
  }
}


function loadHiddenSiteTypes() {
  try {
    const saved = JSON.parse(localStorage.getItem(SITE_TYPES_KEY) ?? '[]');
    return new Set(Array.isArray(saved) ? saved : []);
  } catch {
    return new Set();
  }
}


function loadSideHidden() {
  try {
    const saved = JSON.parse(localStorage.getItem(SIDE_KEY) ?? '{}');
    return saved && typeof saved === 'object' ? saved : {};
  } catch {
    return {};
  }
}

/** Gives each floating panel a tab on its inner edge that slides it to the side and back. */
function setupSidePanels() {
  for (const panel of document.querySelectorAll('.side-panel')) {
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'panel-tab';
    tab.setAttribute('aria-controls', panel.id);
    tab.innerHTML = `
      <svg class="panel-tab-arrow" viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5"/></svg>
      <span class="panel-tab-label" aria-hidden="true">${esc(panel.dataset.sideName)}</span>
      <span class="panel-tab-count mono" aria-hidden="true" hidden></span>`;
    tab.addEventListener('click', () => setSideHidden(panel.dataset.side, !panel.classList.contains('is-side-hidden')));
    panel.append(tab);
  }
  applySideHidden();
  phoneQuery.addEventListener('change', applySideHidden);
}

// On a phone only the legend floats; sites and details sit in the page, so they don't slide away.
const canSlide = (key) => key === 'tools' || !phoneQuery.matches;
const isSideHidden = (key) => canSlide(key) && (state.sideHidden[key] ?? (key === 'tools' && phoneQuery.matches));

function applySideHidden() {
  for (const panel of document.querySelectorAll('.side-panel')) {
    const key = panel.dataset.side;
    const hidden = isSideHidden(key);
    panel.classList.toggle('is-side-hidden', hidden);
    // The tab, and whatever hangs under it (the site toggles), stay usable while the panel is away.
    for (const child of panel.children) if (!child.matches('.panel-tab, .panel-edge')) child.inert = hidden;
    const tab = panel.querySelector('.panel-tab');
    const alerts = key === 'sites' && hidden && state.alertCount ? ` (${state.alertCount} on Alert)` : '';
    const label = `${hidden ? 'Show' : 'Hide'} ${panel.dataset.sideName.toLowerCase()}${alerts}`;
    tab.setAttribute('aria-expanded', String(!hidden));
    tab.setAttribute('aria-label', label);
    tab.title = label;
    document.body.classList.toggle(`hide-${key}`, hidden);
  }
}

function setSideHidden(key, hidden) {
  state.sideHidden[key] = hidden;
  try {
    localStorage.setItem(SIDE_KEY, JSON.stringify(state.sideHidden));
  } catch {
    // Storage blocked: the choice lasts for this visit only.
  }
  applySideHidden();
}

// ---------------------------------------------------------------- about

function openAbout() {
  if (!els.about.dataset.ready) {
    els.about.innerHTML = renderAbout({ manifest: state.manifest, references: state.references, scenes: state.scenes, fit: state.clusterFit });
    els.about.dataset.ready = '1';
  }
  els.about.showModal();
  els.about.querySelector('.about-body').scrollTop = 0;
}

// ---------------------------------------------------------------- events

function bindEvents() {
  els.themeBtn.addEventListener('click', toggleTheme);
  darkQuery.addEventListener('change', onThemeChange);
  els.mapStatus.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-goto]');
    if (btn) goToDate(btn.dataset.goto);
  });
  els.aboutBtn.addEventListener('click', openAbout);
  els.about.addEventListener('click', (e) => {
    // A click on the backdrop (outside the dialog box) or the close button closes it.
    if (e.target === els.about || e.target.closest('[data-action="close-about"]')) els.about.close();
  });
  els.siteList.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-site]');
    if (btn) selectSite(btn.dataset.site);
  });
  bindMore(els.inspector);
  bindMore(els.tools);
  bindTips();
  els.inspector.addEventListener('click', (e) => {
    // The whole header bar folds and unfolds its section, except the buttons in it.
    const head = e.target.closest('.sec-head');
    const fold = e.target.closest('.sec-toggle, .sec-peek') ?? (head && !e.target.closest('button, a') ? head : null);
    if (fold) {
      const sec = fold.closest('.insp-sec');
      setFolded(sec, !sec.classList.contains('is-folded'), state.folded);
      return;
    }
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === 'close-pixel') clearSelection();
    if (action === 'close-site') {
      state.selectedSite = null;
      renderSites();
      renderInspector();
    }
    if (action === 'chart-normalize') {
      state.chart.normalize = !state.chart.normalize;
      renderInspector();
    }
    if (action === 'chart-all') {
      state.chart.showAll = !state.chart.showAll;
      renderInspector();
    }
  });
  els.tools.addEventListener('click', (e) => {
    if (e.target.closest('#compare-toggle')) {
      if (state.compare.open) closeCompare();
      else {
        // On a phone the legend covers the map: slide it away to show the comparison.
        if (phoneQuery.matches) setSideHidden('tools', true);
        openCompare();
      }
      return;
    }
    const btn = e.target.closest('button[data-layer]');
    if (!btn || btn.dataset.layer === state.layer) return;
    state.layer = btn.dataset.layer;
    renderTools();
    drawOverlays();
    renderCompareBar();
    writeHash();
  });
  els.compareBar.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const c = state.compare;
    if (btn.dataset.cmpLayer && btn.dataset.cmpLayer !== c.layer) setCompare({ layer: btn.dataset.cmpLayer });
    const act = btn.dataset.cmp;
    if (act === 'prev') setCompare({ date: dataDateBefore(c.date) ?? c.date });
    if (act === 'next') setCompare({ date: dataDateAfter(c.date) ?? c.date });
    if (act === 'swap') swapCompare();
    if (act === 'close') closeCompare();
  });
  els.compareBar.addEventListener('change', (e) => {
    if (e.target.dataset.cmp === 'date' && isIsoDate(e.target.value)) setCompare({ date: e.target.value });
  });
  els.tools.addEventListener('input', (e) => {
    if (e.target.id === 'opacity') {
      state.opacity = Number(e.target.value) / 100;
      e.target.style.setProperty('--fill', `${e.target.value}%`);
      state.view?.setOverlayOpacity(state.opacity);
      state.cmp?.view()?.setOverlayOpacity(state.opacity);
      els.tools.querySelector('#opacity-value').textContent = `${e.target.value}%`;
    }
  });
  els.tools.addEventListener('change', (e) => {
    if (e.target.id === 'truecolor') {
      state.trueColor = e.target.checked;
      state.view?.setTrueColor(state.trueColor ? state.date : null);
      renderTools();
      drawOverlays();
    }
    if (e.target.id === 'landtop') {
      state.landOnTop = e.target.checked;
      drawOverlays();
    }
    if (e.target.id === 'currents') {
      state.showCurrents = e.target.checked;
      try {
        localStorage.setItem(CURRENTS_KEY, state.showCurrents ? '1' : '0');
      } catch {
        /* private mode: the choice lasts for this visit only */
      }
      renderTools();
      updateCurrents();
    }
  });
}

// ---------------------------------------------------------------- URL state

function dateFromHash() {
  const d = new URLSearchParams(location.hash.slice(1)).get('date');
  return isIsoDate(d) && d >= state.range.start && d <= state.range.max ? d : null;
}

function onHashChange() {
  const params = new URLSearchParams(location.hash.slice(1));
  const asked = params.get('date');
  let date = dateFromHash();
  if (!date) {
    date = state.dates[state.dates.length - 1];
    if (asked) toast(`“${asked}” is outside the timeline. Showing the latest date with data instead.`);
    history.replaceState(null, '', `#date=${date}`);
  }
  selectDate(date);
  // Swipe compare: compare=YYYY-MM-DD,reading (B's date and what it shows).
  const [bDate, bLayer] = (params.get('compare') ?? '').split(',');
  const c = state.compare;
  if (state.dates.includes(bDate) && bLayer in READINGS) {
    if (!c.open) openCompare({ date: bDate, layer: bLayer });
    else if (bDate !== c.date || bLayer !== c.layer) setCompare({ date: bDate, layer: bLayer });
  } else if (c.open && !params.has('compare')) closeCompare();
}

/** The hash for a date, keeping the comparison (B's date and reading) while it's open. */
function hashFor(date) {
  const c = state.compare;
  return `#date=${date}${c.open && c.date ? `&compare=${c.date},${c.layer}` : ''}`;
}

/** Records the current comparison in the hash without a new history entry. */
function writeHash() {
  if (state.date) history.replaceState(null, '', hashFor(state.date));
}

function goToDate(date) {
  location.hash = hashFor(date).slice(1);
}

/** Moves to the previous (-1) or next (+1) date that has data. */
function step(delta) {
  const next = delta < 0 ? dataDateBefore(state.date) : dataDateAfter(state.date);
  if (next) goToDate(next);
}

const dataDateBefore = (date) => state.dates.filter((d) => d < date).at(-1) ?? null;
const dataDateAfter = (date) => state.dates.find((d) => d > date) ?? null;

const scenesOn = (date) => state.scenes.filter((s) => s.date === date);
const shownList = () => [...state.shown.values()];
const loadedList = () => shownList().filter((x) => x.loaded);

// ---------------------------------------------------------------- selection

async function selectDate(date) {
  if (state.date === date && loadedList().length) return;
  const token = ++state.selectToken;
  state.date = date;
  state.shown = new Map(scenesOn(date).map((s) => [s.region, { scene: s, loaded: null, error: null }]));

  document.title = `${fmtDate(date)} · Gulf Bloom Watch`;
  renderSceneHead();
  renderTimeline();
  renderCompareBar();
  els.mockBanner.hidden = !shownList().some((x) => x.scene.status === 'mock');
  els.readout.hidden = true;
  state.siteStatuses = new Map();
  renderSites();
  renderInspector();
  setMapStatus('loading', `Loading ${esc(fmtDate(date))}`);

  try {
    await state.viewReady;
  } catch {
    return; // showFatal already explained it
  }
  const results = await Promise.allSettled(shownList().map((x) => loadGrid(x.scene)));
  if (token !== state.selectToken || !state.view) return;

  shownList().forEach((x, i) => {
    const r = results[i];
    if (r.status === 'fulfilled') {
      x.loaded = r.value;
      state.loadFailures.delete(x.scene.scene_id);
    } else {
      x.error = r.reason;
      state.loadFailures.set(x.scene.scene_id, r.reason);
      if (!(r.reason instanceof ContractError)) console.error(r.reason);
    }
  });

  // The first view fits the date's area. When a date is in another area (the
  // held-out test date has its own box), the map fits that area too, unless the
  // view is already inside it (zoomed in on a place both areas cover).
  const box = dateBox(date);
  const area = scenesOn(date).map((s) => s.region).join(',');
  if (!state.fitted) {
    state.view.fitTo(box ?? areaBox());
    state.fitted = true;
  } else if (box && area !== state.area && !viewInside(box)) {
    state.view.fitTo(box, !reducedMotion());
  }
  if (area) state.area = area;
  state.view.setFocus(areasBox(date));
  drawOverlays();
  updateCurrents();
  if (state.trueColor) state.view.setTrueColor(date);
  updateAreaFrames();
  renderTimeline();
  computeSiteStatuses();
  renderSites();
  if (state.selection) updateSelectionOutline();

  const failed = shownList().filter((x) => x.error);
  if (!state.shown.size) setMapStatus('empty', emptyDateHtml(date));
  else if (failed.length && !loadedList().length) setMapStatus('error', sceneErrorHtml(failed[0].error));
  else {
    setMapStatus(null);
    if (failed.length) toast(`${failed.map((x) => state.manifest.regions[x.scene.region].label).join(', ')}: this date couldn't be loaded.`);
  }
  renderInspector();
  prefetchNeighbors(date);
}

async function drawOverlays() {
  if (!state.view) return;
  const token = ++state.drawToken;
  for (const region of Object.keys(state.manifest.regions)) {
    const x = state.shown.get(region);
    if (!x?.loaded) {
      state.view.clearOverlay(region);
      continue;
    }
    const layer = overlayFor(x.loaded, state.layer);
    if (token !== state.drawToken) return; // a newer redraw has started
    state.view.showOverlay(region, layer);
  }
  drawCompare();
}

/**
 * What an overlay draws for a loaded grid and a layer ('classes', 'chl' or 'nflh'):
 * per-cell colors, the shallow-water hatch and the land cut-out (map.js showOverlay).
 */
function overlayFor({ grid, codes }, layer) {
  // Shallow water is hatched: not assessed on the class layer, a reading the
  // seabed may have raised on the chlorophyll and fluorescence layers.
  const shallow = codes.map((c) => (c === SHALLOW ? 1 : 0));
  let rgba;
  let hatch;
  if (layer === 'chl') {
    rgba = paintValues(grid.chlor_a.map((v, i) => (hasReading(codes[i]) ? v : null)), chlColor);
    hatch = { cells: shallow, rgba: HATCH.chl };
  } else if (layer === 'nflh') {
    const threshold = state.manifest.rule.nflh_dense_min;
    rgba = paintValues(grid.nflh.map((v, i) => (hasReading(codes[i]) ? v : null)), (v) => nflhColor(v, threshold));
    hatch = { cells: shallow, rgba: HATCH.chl };
  } else {
    hatch = { cells: shallow, rgba: HATCH.classes };
    // Over the true-color photo, non-bloom water is left clear so the real water shows.
    const palette = [...state.manifest.classes]
      .sort((a, b) => a.code - b.code)
      .map((k) => (CLASS_COLORS[k.key] && k.code !== SHALLOW && !(state.trueColor && k.code === CLEAR) ? [...hexToRgb(CLASS_COLORS[k.key]), 255] : null));
    rgba = paintClasses(codes, palette);
  }
  return { grid, rgba, hatch, land: state.landOnTop ? state.land : null };
}

// ---------------------------------------------------------------- swipe compare

const compareLoaded = () => [...state.compare.shown.values()].filter((x) => x.loaded);

/** Opens the comparison: B starts on the date before A (else after), showing A's layer. */
async function openCompare(opts = {}) {
  try {
    await state.viewReady;
  } catch {
    return;
  }
  if (!state.cmp) return;
  const c = state.compare;
  c.date = opts.date ?? c.date ?? dataDateBefore(state.date) ?? dataDateAfter(state.date) ?? state.date;
  c.layer = opts.layer ?? c.layer ?? state.layer;
  c.open = true;
  document.body.classList.add('is-comparing');
  renderTools();
  renderTimeline();
  renderCompareBar();
  writeHash();
  try {
    await state.cmp.open();
  } catch (err) {
    console.error(err);
    toast("The comparison map couldn't start in this browser.");
    closeCompare();
    return;
  }
  await loadCompare();
}

function closeCompare() {
  const c = state.compare;
  c.open = false;
  c.token++;
  state.cmp?.close();
  document.body.classList.remove('is-comparing');
  renderTools();
  renderTimeline();
  renderCompareBar();
  writeHash();
  if (state.selection) renderInspector();
}

/** Changes B's date and/or reading. */
function setCompare({ date, layer }) {
  const c = state.compare;
  const newDate = date && date !== c.date;
  if (date) c.date = date;
  if (layer) c.layer = layer;
  renderTools();
  renderTimeline();
  renderCompareBar();
  writeHash();
  if (newDate) loadCompare();
  else drawCompare();
}

/** Swaps the two sides: B's date becomes the selected date (with its full details), A's goes right. */
function swapCompare() {
  const c = state.compare;
  const [aDate, aLayer] = [state.date, state.layer];
  const [bDate, bLayer] = [c.date, c.layer];
  c.date = aDate;
  // The photo only exists on the right; with it, only the dates swap.
  if (bLayer !== 'photo') {
    c.layer = aLayer;
    state.layer = bLayer;
  }
  renderTools();
  loadCompare();
  if (bDate !== aDate) goToDate(bDate);
  else {
    drawOverlays();
    writeHash();
  }
}

async function loadCompare() {
  const c = state.compare;
  const token = ++c.token;
  c.shown = new Map(scenesOn(c.date).map((s) => [s.region, { scene: s, loaded: null, error: null }]));
  renderCompareBar();
  const list = [...c.shown.values()];
  const results = await Promise.allSettled(list.map((x) => loadGrid(x.scene)));
  if (token !== c.token) return;
  list.forEach((x, i) => {
    if (results[i].status === 'fulfilled') x.loaded = results[i].value;
    else x.error = results[i].reason;
  });
  drawCompare();
  renderCompareBar();
  if (state.selection) renderInspector();
}

/**
 * Draws B: its overlay (or only its photo), with A's display settings, and an area
 * (the border and the wash-out outside it). When either side is on the held-out test
 * date's own area, B frames that area, so the comparison stays on the test region;
 * otherwise B frames its own date's area.
 */
function drawCompare() {
  const c = state.compare;
  const b = state.cmp?.view();
  if (!c.open || !b) return;
  const photo = c.layer === 'photo';
  const main = Object.keys(state.manifest.regions)[0];
  const own = areasOf(c.date);
  const areas = own.join() === main && areasOf(state.date).join() !== main ? areasOf(state.date) : own;
  const hasData = compareLoaded().length > 0;
  c.box = unionBox(areas.map((r) => state.manifest.regions[r].bbox));
  b.setFocus(c.box);
  b.setFrames(areas.map((r) => ({ bbox: c.shown.get(r)?.loaded?.grid.bbox ?? state.manifest.regions[r].bbox, has_data: hasData })));
  b.setOverlayOpacity(state.opacity);
  b.setTrueColor(photo || state.trueColor ? c.date : null);
  for (const region of Object.keys(state.manifest.regions)) {
    const x = c.shown.get(region);
    if (photo || !x?.loaded) b.clearOverlay(region);
    else b.showOverlay(region, clipToBox(overlayFor(x.loaded, c.layer), c.box));
  }
}

/** An overlay with the cells outside a box left out: B shows readings only inside the area it frames. */
function clipToBox(layer, box) {
  const { grid } = layer;
  const [w, s, e, n] = box;
  const [gw, gs, ge, gn] = grid.bbox;
  if (gw >= w - 1e-9 && ge <= e + 1e-9 && gs >= s - 1e-9 && gn <= n + 1e-9) return layer;
  const { width: W, height: H } = grid;
  const [rl, rt] = grid.res_deg;
  const rgba = new Uint8ClampedArray(layer.rgba);
  const cells = layer.hatch ? layer.hatch.cells.slice() : null;
  for (let row = 0; row < H; row++) {
    const lat = gn - (row + 0.5) * rt;
    for (let col = 0; col < W; col++) {
      const lon = gw + (col + 0.5) * rl;
      if (lat >= s && lat <= n && lon >= w && lon <= e) continue;
      const i = row * W + col;
      rgba[i * 4 + 3] = 0;
      if (cells) cells[i] = 0;
    }
  }
  return { ...layer, rgba, hatch: layer.hatch && { ...layer.hatch, cells } };
}

/** B's scene and cell at a point, only inside the area B frames. */
function compareHit(lon, lat) {
  const c = state.compare;
  if (c.box && !boxContains(c.box, { lng: lon, lat })) return null;
  return hitIn(c.shown, lon, lat);
}

/** The bar at the bottom of the map: what A and B show, and B's date and reading. */
function renderCompareBar() {
  const c = state.compare;
  els.compareBar.hidden = !c.open;
  if (!c.open) {
    els.compareBar.innerHTML = '';
    return;
  }
  const focusKey = els.compareBar.contains(document.activeElement) ? document.activeElement.dataset.cmp ?? document.activeElement.dataset.cmpLayer : null;
  const loading = [...c.shown.values()].some((x) => !x.loaded && !x.error);
  const failed = [...c.shown.values()].some((x) => x.error);
  const role = scenesOn(c.date)[0]?.role;
  const options = state.dates
    .map((d) => `<option value="${esc(d)}" ${d === c.date ? 'selected' : ''}>${esc(fmtDate(d))}${d === state.date ? ' (A)' : ''}</option>`)
    .join('');
  const prev = dataDateBefore(c.date);
  const next = dataDateAfter(c.date);
  const note = [
    c.layer === 'photo' ? 'True color: <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA GIBS</a>.' : '',
    loading ? 'Loading B.' : failed ? 'B couldn’t be loaded.' : '',
    'Sites and currents follow A.',
  ].filter(Boolean).join(' ');
  els.compareBar.innerHTML = `
    <div class="cmp-row">
      <span class="cmp-side cmp-a" title="Left of the divider: the date picked in the timeline and the layer picked in the legend">
        <span class="cmp-tag">A</span><span class="mono">${esc(fmtDate(state.date))}</span><span class="muted">${READINGS[state.layer]}</span>
      </span>
      <button type="button" class="icon-btn cmp-swap" data-cmp="swap" title="Swap A and B" aria-label="Swap A and B">${icon('swap')}</button>
      <span class="cmp-side cmp-b">
        <span class="cmp-tag">B</span>
        <button type="button" class="icon-btn" data-cmp="prev" ${prev ? '' : 'disabled'} title="Date before" aria-label="B: date before">${icon('chevronLeft')}</button>
        <select class="cmp-date mono" data-cmp="date" aria-label="Date B${role ? `, ${esc(roleInfo(role).label)}` : ''}" title="${role ? esc(roleInfo(role).label) : ''}">${options}</select>
        <button type="button" class="icon-btn" data-cmp="next" ${next ? '' : 'disabled'} title="Date after" aria-label="B: date after">${icon('chevronRight')}</button>
      </span>
      <button type="button" class="icon-btn cmp-close" data-cmp="close" title="Stop comparing" aria-label="Stop comparing">${icon('close')}</button>
    </div>
    <div class="cmp-row">
      <div class="seg-group seg-small cmp-readings" role="group" aria-label="What B shows">
        ${Object.entries(READINGS).map(([k, name]) => `<button type="button" class="seg ${k === c.layer ? 'is-on' : ''}" data-cmp-layer="${k}" aria-pressed="${k === c.layer}"${k === 'photo' ? ' title="NASA true-color photo of date B"' : ''}>${name}</button>`).join('')}
      </div>
      <span class="cmp-note muted">${note}</span>
    </div>`;
  if (focusKey) els.compareBar.querySelector(`[data-cmp="${focusKey}"], [data-cmp-layer="${focusKey}"]`)?.focus({ preventScroll: true });
}

/** A line in a pixel's details: B's class and values at the same cell. */
function compareLineHtml(lon, lat) {
  const c = state.compare;
  if (!c.open) return '';
  const hit = compareHit(lon, lat);
  const head = `<span class="cmp-tag">B</span><span class="mono">${esc(fmtDate(c.date))}</span>`;
  if (!hit) return `<p class="cmp-line">${head}<span class="muted">${compareLoaded().length ? 'no data at this point' : 'loading'}</span></p>`;
  const { grid, codes } = hit.loaded;
  const i = hit.cell.index;
  const k = classByCode(codes[i]);
  const chl = grid.chlor_a[i];
  const nflh = grid.nflh?.[i] ?? null;
  const values = hasReading(codes[i]) ? [chl != null ? `${fmtChl(chl)} mg/m³` : '', nflh != null ? `nFLH ${fmtNflh(nflh)}` : ''].filter(Boolean).join(' · ') : '';
  return `<p class="cmp-line" title="Date B at the same cell (right of the compare divider)">${head}${swatch(k.key)}<span>${richText(k.label)}</span>${values ? `<span class="mono muted">${values}</span>` : ''}</p>`;
}

/** Water by the shown scene's land mask (the currents never run over land). */
function isWaterAt(lon, lat) {
  const hit = hitAt(lon, lat);
  return !!hit && hit.loaded.codes[hit.cell.index] !== LAND;
}

/**
 * Surface currents for the selected date: the particle animation (net flow over the
 * day) and the 48-hour drift tracks of the C. polykrikoides-like and green
 * Noctiluca-like patches.
 */
async function updateCurrents() {
  if (!state.view || !state.flow) return;
  const token = ++state.currentsToken;
  const date = state.date;
  // The legend's toggle says whether this date has currents prepared.
  const ready = state.currentsIndex.has(date);
  if (ready !== state.currentsReady) {
    state.currentsReady = ready;
    renderTools();
  }
  const hadField = !!state.currents;
  const hide = () => {
    state.currents = null;
    state.flow.setVisible(false);
    state.view.setDriftVisible(false);
    if (hadField && state.selection) renderInspector();
  };
  // The field loads whenever the date has currents (the hover readout uses it);
  // the animation, tracks and pixel note follow the toggle.
  if (!ready || !loadedList().length) {
    state.currentsField = null;
    hide();
    return;
  }
  let field;
  try {
    field = await loadCurrents(date);
  } catch (err) {
    console.warn('Currents unavailable:', err.message);
    return;
  }
  if (token !== state.currentsToken || date !== state.date) return;
  state.currentsField = field;
  if (!state.showCurrents) {
    hide();
    return;
  }
  state.currents = field;
  state.flow.setField(field, isWaterAt);
  state.flow.setVisible(true);
  state.view.setDrift(driftFeatures(field));
  state.view.setDriftVisible(true);
  if (state.selection) renderInspector();
}

/** The drift tracks' species, by the class their patch belongs to. */
const DRIFT_SPECIES = { [CP_LIKE]: 'cp', [NOCTILUCA_LIKE]: 'noctiluca' };

/** Drift tracks of the shown scenes' C. polykrikoides-like and green Noctiluca-like patches, as map features. */
function driftFeatures(field) {
  const features = [];
  for (const x of loadedList()) {
    const { grid, codes } = x.loaded;
    x.loaded.patches ??= [...bloomPatches(grid, codes, CP_LIKE), ...bloomPatches(grid, codes, NOCTILUCA_LIKE)];
    for (const patch of x.loaded.patches) {
      const species = DRIFT_SPECIES[patch.code];
      const point = (kind, coordinates) => ({ type: 'Feature', properties: { kind, species }, geometry: { type: 'Point', coordinates } });
      if (patch.trackDate !== field.date) {
        patch.track = driftTrack(field, patch.lon, patch.lat, isWaterAt);
        patch.trackDate = field.date;
      }
      const { path, stoppedAt } = patch.track;
      if (path.length < 2) continue;
      features.push({ type: 'Feature', properties: { kind: 'track', species }, geometry: { type: 'LineString', coordinates: path } });
      if (path[24] && (stoppedAt == null || stoppedAt >= 24)) features.push(point('h24', path[24]));
      if (path[48] && stoppedAt == null) features.push(point('h48', path[48]));
      if (stoppedAt != null) {
        const [lon, lat] = path.at(-1);
        const d = 0.012;
        features.push({ type: 'Feature', properties: { kind: 'stop', species }, geometry: { type: 'MultiLineString', coordinates: [[[lon - d, lat - d], [lon + d, lat + d]], [[lon - d, lat + d], [lon + d, lat - d]]] } });
      }
    }
  }
  return { type: 'FeatureCollection', features };
}

/** The pixel card's lines on the surface current here and, in a tracked patch, its drift. */
function currentNoteHtml(hit, lon, lat) {
  if (!state.currents) return '';
  const uv = meanAt(state.currents, lon, lat);
  const patch = hit.loaded.patches?.find((p) => p.cells.has(hit.cell.index) && p.trackDate === state.currents.date);
  if (!uv && !patch) return '';
  const lines = [];
  if (uv) {
    const ms = Math.hypot(uv[0], uv[1]);
    lines.push(`<p>Here: <span class="mono">${(ms * 3.6).toFixed(1)} km/h</span> toward the ${towardWord(uv[0], uv[1])}, net over the day <span class="muted">(about ${Math.round(ms * 86.4)} km a day)</span>.</p>`);
  }
  if (patch) {
    const { path, stoppedAt } = patch.track;
    const leg = (h) => `about <span class="mono">${Math.round(distanceKm(path[0], path[h]))} km</span> toward the ${bearingWord(path[0], path[h])} in ${h} hours`;
    const legs = [24, 48].filter((h) => path[h] && (stoppedAt == null || stoppedAt >= h)).map(leg);
    const coast = stoppedAt != null ? `reaches the coast after about ${Math.max(1, Math.round(stoppedAt))} hours` : '';
    const moves = [legs.length ? `drifts ${legs.join(' and ')}` : '', coast].filter(Boolean).join(', then ');
    const name = patch.code === NOCTILUCA_LIKE ? 'green Noctiluca-like' : 'C. polykrikoides-like';
    lines.push(`<p>${richText(`If it moves with the surface water, this ${name} patch`)} ${moves}.</p>`);
  }
  return tipped('div', 'current-note', CURRENT_NOTE_TIP, `<p class="sub-label">Surface current · model estimate${icon('info', 'icon tip-mark')}</p>${lines.join('')}`);
}

const CURRENT_NOTE_TIP = 'From Open-Meteo (Météo-France SMOC). Wind, the algae’s own swimming, growth and decay aren’t included, so a drift is a direction to watch, not a forecast of arrival.';
const CURRENTS_KEY_TIP = 'Particles follow the net current over the day (tides averaged out), sped up so the motion shows. A track shows where the patch would go if it moved with the surface water. A model estimate.';

/** An element whose explanation shows in a small window near the pointer (tip.js); screen readers get it inline. */
function tipped(tag, className, tip, html) {
  return `<${tag} class="${className} has-tip" data-tip="${esc(tip)}" tabindex="0">${html}<span class="visually-hidden"> ${esc(tip)}</span></${tag}>`;
}

/** Outlines only the selected date's area: the test date's box shows on the test date alone. */
function updateAreaFrames() {
  if (!state.view) return;
  state.view.setFrames(framesFor(state.date, state.shown));
}

function prefetchNeighbors(date) {
  setTimeout(() => {
    for (const d of [dataDateAfter(date), dataDateBefore(date)]) if (d) for (const s of scenesOn(d)) loadGrid(s).catch(() => {});
  }, 400);
}

/** The scene in `shown` (region → { scene, loaded }) whose grid contains a point, with the cell. */
function hitIn(shown, lon, lat) {
  for (const x of shown.values()) {
    if (!x.loaded) continue;
    const cell = cellAt(x.loaded.grid, lon, lat);
    if (cell) return { ...x, cell };
  }
  return null;
}

/** The shown scene whose grid contains a point, with the cell. */
const hitAt = (lon, lat) => hitIn(state.shown, lon, lat);

function onMapClick(lngLat) {
  // While measuring, clicks add and remove points instead of picking pixels.
  if (state.measure?.handleClick(lngLat)) return;
  if (!loadedList().length) return;
  // From one pixel to the next the details stay where they were, so the same
  // section can be compared; from a site or the hint they start at the top.
  const fromPixel = !!state.selection && !state.selectedSite;
  state.selection = { lon: lngLat.lng, lat: lngLat.lat };
  state.selectedSite = null;
  if (isSideHidden('inspector')) setSideHidden('inspector', false);
  updateSelectionOutline();
  renderSites();
  renderInspector({ keepScroll: fromPixel });
  if (!fromPixel) els.inspScroll.scrollTop = 0;
  if (phoneQuery.matches && !fromPixel) els.inspector.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function updateSelectionOutline() {
  const hit = state.selection && hitAt(state.selection.lon, state.selection.lat);
  if (!hit) {
    state.view?.clearSelection();
    return;
  }
  const { grid } = hit.loaded;
  const [west, , , north] = grid.bbox;
  const [rl, rt] = grid.res_deg;
  const { row, col } = hit.cell;
  state.view.showSelection([west + col * rl, north - (row + 1) * rt, west + (col + 1) * rl, north - row * rt]);
}

function clearSelection() {
  state.selection = null;
  state.view?.clearSelection();
  renderInspector();
}

// ---------------------------------------------------------------- sites

/**
 * Each site's status from the date's grids: the one with usable water near the site
 * and the most urgent status. A site no grid reaches is outside this date's area.
 */
function computeSiteStatuses() {
  state.siteStatuses = new Map();
  const loaded = loadedList();
  const failed = shownList().some((x) => x.error);
  for (const site of state.sites) {
    const [lon, lat] = site.geometry.coordinates;
    let best = null;
    let inside = null;
    for (const x of loaded) {
      const st = { ...siteStatus(site, x.loaded.grid, x.loaded.codes), region: x.scene.region };
      if (boxContains(x.loaded.grid.bbox, { lng: lon, lat })) inside ??= st;
      if (!st.waterCells) continue;
      const rank = SITE_STATUS[st.status].rank - SITE_STATUS[best?.status]?.rank;
      if (!best || rank > 0 || (rank === 0 && (st.nearestKm ?? 1e9) < (best.nearestKm ?? 1e9))) best = st;
    }
    state.siteStatuses.set(
      site.properties.site_id,
      best ?? inside ?? noPassStatus(failed ? 'error' : loaded.length ? 'outside' : 'nopass'),
    );
  }
}

function siteStatusBadge(status) {
  const info = SITE_STATUS[status];
  return `<span class="badge site-status site-${status}">${icon(info.icon)}<span>${info.label}</span></span>`;
}

function siteSubline(st) {
  if (!st) return 'Checking';
  if (st.reason === 'nopass') return 'no processed pass on this date';
  if (st.reason === 'error') return "this date couldn't be loaded";
  if (st.reason === 'outside') return "outside this date's area";
  if (st.nearestKm != null) return `<span class="mono">${Math.round(st.nearestKm)} km</span> to nearest <em>C.&nbsp;p.</em>-like`;
  return st.status === 'unknown' ? 'no usable water nearby' : 'none within 75 km';
}

const bySeverity = (a, b) =>
  (SITE_STATUS[state.siteStatuses.get(b.properties.site_id)?.status]?.rank ?? -1) -
    (SITE_STATUS[state.siteStatuses.get(a.properties.site_id)?.status]?.rank ?? -1) ||
  (state.siteStatuses.get(a.properties.site_id)?.nearestKm ?? 1e9) - (state.siteStatuses.get(b.properties.site_id)?.nearestKm ?? 1e9);

const siteShown = (site) => !state.hiddenSiteTypes.has(site.properties.type);

function renderSites() {
  // Most urgent first; site types switched off on the map are left out here too.
  const visible = state.sites.filter(siteShown);
  const sites = [...visible].sort(bySeverity);
  els.siteList.innerHTML = sites.length
    ? `<ul class="site-items" role="list">${sites
        .map((site) => {
          const p = site.properties;
          const st = state.siteStatuses.get(p.site_id);
          const type = SITE_TYPES[p.type] ?? SITE_TYPES.other;
          return `
            <li data-rail-name="${esc(p.name)}" data-rail-accent="${STATUS_ACCENT[st?.status] ?? ''}">
              <button type="button" class="site-item ${state.selectedSite === p.site_id ? 'is-current' : ''}" data-site="${esc(p.site_id)}">
                <span class="site-type" title="${esc(type.label)}">${icon(type.icon)}</span>
                <span class="site-text">
                  <span class="site-name">${esc(p.name)}</span>
                  <span class="site-sub">${siteSubline(st)}</span>
                </span>
                ${st ? siteStatusBadge(st.status) : ''}
              </button>
            </li>`;
        })
        .join('')}</ul>`
    : `<p class="panel-note">${state.sites.length ? 'Every site type is switched off. Turn one back on with the site-type buttons.' : 'No watched sites.'}</p>`;

  state.rails?.sites.refresh();

  const counts = {};
  for (const site of visible) {
    const st = state.siteStatuses.get(site.properties.site_id);
    if (st) counts[st.status] = (counts[st.status] ?? 0) + 1;
  }
  // Slid away, the sites tab still shows how many are on Alert.
  state.alertCount = counts.alert ?? 0;
  const tabCount = els.sitesPanel.querySelector('.panel-tab-count');
  if (tabCount) {
    tabCount.hidden = !state.alertCount;
    tabCount.textContent = state.alertCount;
    applySideHidden();
  }
  els.siteSummary.innerHTML = Object.keys(SITE_STATUS)
    .filter((k) => counts[k] && k !== 'clear' && k !== 'unknown')
    .map((k) => `<span class="count site-${k}">${icon(SITE_STATUS[k].icon)}<span class="mono">${counts[k]}</span> ${SITE_STATUS[k].label}</span>`)
    .join('') || (state.siteStatuses.size ? `<span class="count">${fmtInt(visible.length)} sites</span>` : '');

  if (!state.view) return;
  state.view.setMarkers(
    visible.map((site) => {
      const p = site.properties;
      const st = state.siteStatuses.get(p.site_id);
      const status = st?.status ?? 'unknown';
      const type = SITE_TYPES[p.type] ?? SITE_TYPES.other;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `site-marker site-${status} ${st?.reason ? 'is-nodata' : ''} ${state.selectedSite === p.site_id ? 'is-current' : ''}`;
      el.dataset.site = p.site_id;
      el.title = `${p.name}: ${SITE_STATUS[status].label}`;
      el.innerHTML = `${icon(type.icon)}<span class="site-marker-status">${icon(SITE_STATUS[status].icon)}</span>`;
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        selectSite(p.site_id);
      });
      const [lon, lat] = site.geometry.coordinates;
      return { lon, lat, element: el };
    }),
  );
}

/**
 * One toggle per site type, stacked under the watched-sites tab (outside the panel,
 * sliding with it): each shows or hides that type on the map and in the list.
 */
function addSiteToggles() {
  const order = Object.keys(SITE_TYPES);
  const types = [...new Set(state.sites.map((s) => s.properties.type))].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  if (!types.length) return;
  const el = document.createElement('div');
  el.className = 'site-toggles panel-edge';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Watched sites shown on the map and in the list');
  el.innerHTML = types
    .map((t) => `<button type="button" class="site-toggle" data-site-type="${esc(t)}">${icon((SITE_TYPES[t] ?? SITE_TYPES.other).icon)}</button>`)
    .join('');
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-site-type]');
    if (!btn) return;
    const t = btn.dataset.siteType;
    if (state.hiddenSiteTypes.has(t)) state.hiddenSiteTypes.delete(t);
    else state.hiddenSiteTypes.add(t);
    try {
      localStorage.setItem(SITE_TYPES_KEY, JSON.stringify([...state.hiddenSiteTypes]));
    } catch {
      /* private mode: the choice lasts for this visit only */
    }
    const current = state.sites.find((s) => s.properties.site_id === state.selectedSite);
    if (current && !siteShown(current)) {
      state.selectedSite = null;
      renderInspector();
    }
    updateSiteToggles();
    renderSites();
  });
  els.sitesPanel.append(el);
  els.sitesPanel.classList.add('has-edge'); // the tab and the toggles share one edge (styles.css)
  updateSiteToggles();
}

/** The dock's left column: city names on or off, and measuring. */
function addDockTools() {
  const el = document.createElement('div');
  el.className = 'maplibregl-ctrl maplibregl-ctrl-group dock-tools';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Map tools');
  el.innerHTML = `
    <button type="button" class="dock-toggle" data-dock="places">${icon('label')}</button>
    <button type="button" class="dock-btn" data-dock="measure" aria-pressed="false" aria-label="Measure distance or area" title="Measure distance or area">${icon('ruler')}</button>`;
  el.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-dock]');
    if (btn?.dataset.dock === 'places') setShowPlaces(!state.showPlaces);
    if (btn?.dataset.dock === 'measure') state.measure?.buttonPress(btn);
  });
  els.mapDock.append(el);
  updatePlacesButton();
}

function updatePlacesButton() {
  const btn = els.mapDock.querySelector('[data-dock="places"]');
  if (!btn) return;
  const label = state.showPlaces ? 'Hide city names' : 'Show city names';
  btn.setAttribute('aria-pressed', String(state.showPlaces));
  btn.setAttribute('aria-label', label);
  btn.title = label;
}

function setShowPlaces(on) {
  state.showPlaces = on;
  try {
    localStorage.setItem(PLACES_KEY, on ? '1' : '0');
  } catch {
    /* private mode: the choice lasts for this visit only */
  }
  els.map.classList.toggle('hide-places', !on);
  updatePlacesButton();
}

/**
 * UAE and Oman city names: a dot at each city with its name beside it. Big cities
 * show first; towns join as you zoom in (PLACE_ZOOMS), so names don't crowd.
 */
function addPlaceLabels() {
  const { map } = state.view;
  state.view.setLabels(
    PLACES.map((p) => {
      const element = document.createElement('div');
      element.className = `place-label rank-${p.rank} side-${p.side}`;
      element.setAttribute('aria-hidden', 'true');
      element.innerHTML = `<span class="place-name">${esc(p.name)}</span>`;
      return { lon: p.lon, lat: p.lat, element };
    }),
  );
  const zoomed = () => {
    const z = map.getZoom();
    els.map.classList.toggle('places-z1', z >= PLACE_ZOOMS[1]);
    els.map.classList.toggle('places-z2', z >= PLACE_ZOOMS[2]);
    els.map.classList.toggle('places-z3', z >= PLACE_ZOOMS[3]);
  };
  map.on('zoom', zoomed);
  zoomed();
  els.map.classList.toggle('hide-places', !state.showPlaces);
}

function updateSiteToggles() {
  for (const btn of document.querySelectorAll('.site-toggle')) {
    const t = btn.dataset.siteType;
    const info = SITE_TYPES[t] ?? SITE_TYPES.other;
    const n = state.sites.filter((s) => s.properties.type === t).length;
    const on = !state.hiddenSiteTypes.has(t);
    btn.setAttribute('aria-pressed', String(on));
    btn.title = `${info.plural} (${n}): ${on ? 'shown. Click to hide' : 'hidden. Click to show'}`;
    btn.setAttribute('aria-label', `${info.plural} (${n})`);
  }
}

function selectSite(siteId) {
  const site = state.sites.find((s) => s.properties.site_id === siteId);
  if (!site) return;
  state.selectedSite = siteId;
  state.selection = null;
  if (isSideHidden('inspector')) setSideHidden('inspector', false);
  state.view?.clearSelection();
  const [lon, lat] = site.geometry.coordinates;
  state.view?.flyTo(lon, lat, 8.5);
  renderSites();
  renderInspector();
  els.inspScroll.scrollTop = 0;
}

// ---------------------------------------------------------------- rendering

const classByCode = (code) => state.manifest.classes.find((k) => k.code === code);
const classByKey = (key) => state.manifest.classes.find((k) => k.key === key);
const tierByKey = (key) => state.manifest.risk_tiers.find((t) => t.key === key);

function swatch(key, extra = '') {
  if (key === 'shallow') return `<span class="swatch swatch-hatch ${extra}" style="--swatch:var(--c-shallow)"></span>`;
  return CLASS_COLORS[key]
    ? `<span class="swatch ${extra}" style="--swatch:var(--c-${key})"></span>`
    : `<span class="swatch swatch-none ${extra}" title="Not drawn"></span>`;
}

/** A foldable details section, folded if the viewer folded that kind of section before. */
const section = (o) => sectionHtml({ ...o, folded: state.folded.has(o.key) });

/** The one-line summary of a folded section. */
const peekRow = (html) => `<span class="peek-row">${html}</span>`;

function tierPill(tier) {
  return `<span class="tier-pill tier-${esc(tier.key)}">${icon(TIER_ICONS[tier.key])}<span>${esc(tier.label)}</span></span>`;
}

function closeButton(action, what) {
  return `<button type="button" class="icon-btn" data-action="${action}" title="Close">${icon('close')}<span class="visually-hidden">Close ${what}</span></button>`;
}

function renderSceneHead() {
  const list = shownList();
  if (!list.length) {
    els.sceneHead.innerHTML = '<span class="head-title">No processed scene on this date</span>';
    return;
  }
  const title = list.map((x) => x.scene.title || x.scene.scene_id).join(' / ');
  els.sceneHead.innerHTML = `
    <span class="head-title">${richText(title)}</span>
    ${[...new Set(list.map((x) => x.scene.role))].map((r) => roleBadge(r)).join('')}
    <span class="head-sensor">${esc([...new Set(list.map((x) => SENSORS[x.scene.sensor] ?? x.scene.sensor))].join(', '))}</span>`;
}

function renderTimeline() {
  state.timeline.update(
    state.date,
    state.dates.map((d) => {
      const scenes = scenesOn(d);
      return {
        date: d,
        roles: [...new Set(scenes.map((s) => s.role))],
        failed: scenes.some((s) => state.loadFailures.has(s.scene_id)),
        compare: state.compare.open && d === state.compare.date,
        label: scenes.map((s) => `${roleInfo(s.role).label}${s.status === 'mock' ? ' (mock)' : ''}`).join('; '),
      };
    }),
  );
}

function renderTools() {
  const { rule } = state.manifest;
  const tiers = [...state.manifest.risk_tiers].sort((a, b) => b.rank - a.rank);
  const classLegend = tiers
    .map((t) => {
      const classes = state.manifest.classes.filter((k) => k.risk_tier === t.key).sort((a, b) => b.code - a.code);
      if (!classes.length) return '';
      return `
        <li class="legend-tier tier-${esc(t.key)}" data-rail-name="${esc(t.label)}" data-rail-accent="var(--tier-${esc(t.key)})">
          <span class="legend-tier-name">${icon(TIER_ICONS[t.key])}${esc(t.label)}</span>
          <ul role="list">${classes
            .map((k) => {
              const hidden = k.key === 'land' || (state.trueColor && k.code === CLEAR);
              const note = k.key === 'land' ? 'not drawn' : 'not drawn over the photo';
              return `<li>${hidden ? swatch('land') : swatch(k.key)}<span>${richText(k.label)}${hidden ? ` <span class="muted">(${note})</span>` : ''}</span></li>`;
            })
            .join('')}</ul>
        </li>`;
    })
    .join('');

  // Surface currents: available for dates with a prepared file.
  const curReady = state.currentsIndex.has(state.date);
  const curOn = state.showCurrents && curReady;
  const currentsRow = `
        <label class="tool-check ${curReady ? '' : 'is-disabled'}">
          <input type="checkbox" id="currents" ${curOn ? 'checked' : ''} ${curReady ? '' : 'disabled'} />
          <span>Surface currents <span class="muted">(${curReady ? 'model, animated' : 'not prepared for this date'})</span></span>
        </label>
        ${curOn ? tipped('p', 'panel-note current-key', CURRENTS_KEY_TIP, `${richText('Drift of a patch:')} <span class="drift-kind"><svg class="legend-line" viewBox="0 0 24 6" aria-hidden="true"><line x1="1" y1="3" x2="23" y2="3" stroke-dasharray="4 3"/></svg>${richText('C. polykrikoides-like,')}</span> <span class="drift-kind"><svg class="legend-line is-dotted" viewBox="0 0 24 6" aria-hidden="true"><line x1="2" y1="3" x2="23" y2="3" stroke-dasharray="0.1 4"/></svg>${richText('green Noctiluca-like;')}</span> <span class="drift-dot" aria-hidden="true"></span>24 h, <span class="drift-ring" aria-hidden="true"></span>48 h, × at the coast.${icon('info', 'icon tip-mark')}`) : ''}`;

  const ticks = [0, 0.1, 0.3, 1, 3, 10, 20];
  const gates = [
    ['weak', rule.chl_weak_min],
    ['dense', rule.chl_dense_min],
  ];
  const chlLegend = `
    <div class="chl-legend" data-rail-name="Chlorophyll scale">
      <div class="chl-bar" style="background:${chlGradientCss()}">
        ${gates.map(([name, v]) => `<span class="chl-gate" style="left:${(chlPosition(v) * 100).toFixed(2)}%"><span>${name} ${fmtChl(v).replace(/\.00$/, '')}</span></span>`).join('')}
        <span class="chl-cursor" aria-hidden="true"><span class="mono"></span></span>
      </div>
      <div class="chl-ticks mono">${ticks.map((t) => `<span style="left:${(chlPosition(t) * 100).toFixed(2)}%">${t}${t === CHL_MAX ? '+' : ''}</span>`).join('')}</div>
    </div>`;

  const toolsTop = els.toolsBody.scrollTop;
  const focusId = els.tools.contains(document.activeElement) ? document.activeElement.id || document.activeElement.dataset.layer : null;
  // Fluorescence: a linear scale with a sharp step at the manifest's threshold.
  const nTh = rule.nflh_dense_min;
  const nTop = nflhMax(nTh);
  const nTicks = [0, 0.2, 0.4, 0.6, 0.8].filter((t) => t < nTop).concat(nTop);
  const nflhLegend = `
    <div class="chl-legend nflh-legend" data-rail-name="nFLH scale">
      <div class="chl-bar" style="background:${nflhGradientCss(nTh)}">
        <span class="chl-gate" style="left:${(nflhPosition(nTh, nTh) * 100).toFixed(2)}%"><span>raised ${fmtNflh(nTh)}</span></span>
        <span class="chl-cursor" aria-hidden="true"><span class="mono"></span></span>
      </div>
      <div class="chl-ticks mono">${nTicks.map((t) => `<span style="left:${(nflhPosition(t, nTh) * 100).toFixed(2)}%">${t === nTop ? `${t.toFixed(1)}+` : t}</span>`).join('')}</div>
    </div>`;

  // Switching layers, the dark marker slides from the old button to the new one,
  // and the legend slides in from the side of the new layer.
  const was = LAYERS.indexOf(state.toolsLayer ?? state.layer);
  const now = LAYERS.indexOf(state.layer);
  state.toolsLayer = state.layer;
  const cmpLabel = state.compare.open ? 'Stop comparing' : 'Compare with another date or reading';
  els.toolsHead.innerHTML = `
    <div class="seg-group seg-slide" role="group" aria-label="Map layer" style="--i:${was}">
      <span class="seg-thumb" aria-hidden="true"></span>
      <button type="button" class="seg ${state.layer === 'classes' ? 'is-on' : ''}" data-layer="classes" aria-pressed="${state.layer === 'classes'}">Classes</button>
      <button type="button" class="seg ${state.layer === 'chl' ? 'is-on' : ''}" data-layer="chl" aria-pressed="${state.layer === 'chl'}">Chlorophyll</button>
      <button type="button" class="seg ${state.layer === 'nflh' ? 'is-on' : ''}" data-layer="nflh" aria-pressed="${state.layer === 'nflh'}" title="Fluorescence line height">nFLH</button>
    </div>
    <button type="button" class="icon-btn cmp-toggle" id="compare-toggle" aria-pressed="${state.compare.open}" title="${cmpLabel}" aria-label="${cmpLabel}">${icon('compare')}</button>`;
  if (was !== now) {
    const group = els.toolsHead.querySelector('.seg-slide');
    void group.offsetWidth; // start from the old button
    group.style.setProperty('--i', now);
  }
  const enter = was === now ? '' : now > was ? 'enter-from-right' : 'enter-from-left';
  // Comparing two different layers, the legend explains both: A's, then B's.
  const c = state.compare;
  const twoKeys = c.open && c.layer !== state.layer && c.layer !== 'photo';
  const keyFor = (layer) => (layer === 'classes' ? `<ul class="legend-tiers" role="list">${classLegend}</ul>` : layer === 'nflh' ? nflhLegend : chlLegend);
  const sideHead = (tag, layer, where) => `<p class="legend-side"><span class="cmp-tag">${tag}</span>${READINGS[layer]} <span class="muted">${where}</span></p>`;
  els.toolsBody.innerHTML = `
      <div class="legend-swap ${enter}">${twoKeys ? sideHead('A', state.layer, 'left of the divider') : ''}${keyFor(state.layer)}</div>
      ${twoKeys ? `<div class="legend-b" data-rail-name="B: ${READINGS[c.layer]}">${sideHead('B', c.layer, 'right of the divider')}${keyFor(c.layer)}</div>` : ''}
      <div class="tool-rows" data-rail-name="Display">
        <div class="tool-row">
          <label for="opacity">Overlay</label>
          <input type="range" class="slider" id="opacity" min="0" max="100" step="5" value="${Math.round(state.opacity * 100)}" style="--fill:${Math.round(state.opacity * 100)}%" />
          <span class="mono" id="opacity-value">${Math.round(state.opacity * 100)}%</span>
        </div>
        <label class="tool-check">
          <input type="checkbox" id="truecolor" ${state.trueColor ? 'checked' : ''} />
          <span>True-color photo of this date <span class="muted">(NASA VIIRS)</span></span>
        </label>
        <label class="tool-check">
          <input type="checkbox" id="landtop" ${state.landOnTop ? 'checked' : ''} />
          <span>Clean coastline <span class="muted">(hide pixels on land)</span></span>
        </label>${currentsRow}
      </div>`;
  els.toolsBody.scrollTop = toolsTop;
  if (focusId) (document.getElementById(focusId) ?? els.tools.querySelector(`[data-layer="${focusId}"]`))?.focus({ preventScroll: true });
  state.rails?.tools.refresh();
}

/**
 * Redraws the details panel. With keepScroll, the section at the top of the view
 * stays at the same height on screen, even when the sections above it change.
 */
function renderInspector({ keepScroll = true } = {}) {
  const scroller = els.inspScroll;
  const top = scroller.getBoundingClientRect().top;
  // The anchor is the first section that starts in view, else the one the view is inside.
  const secs = keepScroll ? [...els.inspContent.querySelectorAll(':scope > .insp-sec')] : [];
  const viewBottom = top + scroller.clientHeight;
  const anchor =
    secs.find((sec) => sec.getBoundingClientRect().top >= top - 4 && sec.getBoundingClientRect().top < viewBottom) ??
    secs.find((sec) => sec.getBoundingClientRect().bottom > top + 1);
  const anchorKey = anchor?.dataset.sec;
  const anchorOffset = anchor ? anchor.getBoundingClientRect().top - top : 0;
  const scrollTop = scroller.scrollTop;
  const parts = [];
  if (state.selectedSite) parts.push(siteCard());
  else if (state.selection) parts.push(...pixelCards());
  else parts.push(`<p class="insp-hint">${icon('pointer')}<span>Click the map to see why a pixel got its class, or pick a watched site.</span></p>`);
  for (const x of shownList()) {
    parts.push(sceneCard(x.scene), x.error ? '' : censusCard(x));
  }
  if (!state.shown.size) {
    parts.push(section({
      key: 'scene',
      name: 'Scene',
      label: 'Scene',
      peek: peekRow(`<span class="peek-text muted">No processed scene on ${esc(fmtDate(state.date))}</span>`),
      body: `<p class="muted">No processed scene on ${esc(fmtDate(state.date))}. Pick a marked day on the timeline.</p>`,
    }));
  }
  els.inspContent.innerHTML = parts.join('');
  const chartRoot = els.inspContent.querySelector('#chart');
  if (chartRoot) drawChart(chartRoot);
  if (keepScroll) {
    const same = anchorKey && els.inspContent.querySelector(`:scope > .insp-sec[data-sec="${anchorKey}"]`);
    scroller.scrollTop = same ? scroller.scrollTop + same.getBoundingClientRect().top - top - anchorOffset : scrollTop;
  }
  state.rails?.inspector.refresh();
}

function pixelCards() {
  if (!loadedList().length) return [];
  const hit = hitAt(state.selection.lon, state.selection.lat);
  if (!hit) {
    return [section({
      key: 'pixel',
      name: 'Pixel',
      className: 'is-focus pixel-card',
      label: `Point <span class="mono">${esc(fmtLatLon(state.selection.lat, state.selection.lon))}</span>`,
      close: closeButton('close-pixel', 'point details'),
      peek: peekRow('<span class="peek-text muted">No data on this date</span>'),
      body: '<p class="muted">No processed pass covers this point on this date.</p>',
    })];
  }
  const { grid, codes } = hit.loaded;
  const { lon, lat } = cellCenter(grid, hit.cell.row, hit.cell.col);
  const ctx = {
    manifest: state.manifest, scene: hit.scene, grid, codes, index: hit.cell.index, lon, lat,
    clusters: state.clusters, clustersError: state.clustersError, references: state.references, depth: state.depth,
    currentHtml: currentNoteHtml(hit, lon, lat),
    compareHtml: compareLineHtml(lon, lat),
  };
  const ex = explainPixel(ctx);
  const cls = classByCode(ex.code);
  const tier = tierByKey(cls.risk_tier);
  const focus = CLASS_COLORS[cls.key] ? `var(--c-${cls.key})` : 'var(--ink)';
  // Folded, the card keeps its class and its risk tier, in the tier's color.
  const cards = [section({
    key: 'pixel',
    name: 'Pixel',
    className: 'is-focus pixel-card',
    style: `--focus:${focus}`,
    attrs: `data-code="${ex.code}" data-scene="${esc(hit.scene.scene_id)}" data-tier="${esc(tier.key)}"`,
    accent: `var(--tier-${tier.key})`,
    label: `Pixel <span class="mono">${esc(fmtLatLon(lat, lon))}</span>`,
    close: closeButton('close-pixel', 'pixel details'),
    peek: peekRow(`<span class="peek-main">${swatch(cls.key)}<span class="peek-text">${richText(cls.label)}</span>${cautionMark(pixelFlags(ctx, ex))}</span>${tierPill(tier)}`),
    body: pixelCardHtml(ctx, ex),
  })];
  if (ex.code >= CLEAR) cards.push(spectrumCard(ex));
  return cards;
}

/** Folded, a pixel card keeps one caution mark for its cautionary flags, which its tooltip lists. */
function cautionMark(flags) {
  const notes = flags.filter((f) => f.caution).map((f) => f.note).join(' ');
  return notes ? `<span class="peek-flag" title="${esc(notes)}">${icon('warning')}<span class="visually-hidden">${esc(notes)}</span></span>` : '';
}

/** The folded spectrum card's summary: the match in a few words. */
function peekVerdict(ex) {
  const c = ex.cluster;
  if (!c) return 'Cluster details unavailable';
  const best = richText(refLabel(state.references, c.best_ref));
  if (ex.confidence) return `${richText(classByCode(ex.code).label.replace(/ bloom$/, ''))} · confidence <span class="mono">${fmtMargin(c.margin)}</span> (${esc(ex.confidence.label)})`;
  if (state.references?.get(c.best_ref)?.group === 'water') return `Closest: ${best}, a water type`;
  if (c.margin < state.manifest.rule.margin_min) return `Closest: ${best}, too close to call`;
  return `Looks most like ${best}; not a dense bloom`;
}

/** One line next to the chart: how well the cluster matches, or why it isn't named. */
function matchVerdict(ex) {
  const c = ex.cluster;
  if (!c) return '';
  const { rule } = state.manifest;
  const best = refLabel(state.references, c.best_ref);
  if (ex.confidence) {
    return `<strong>${richText(classByCode(ex.code).label)}</strong>, confidence <span class="mono">${fmtMargin(c.margin)}</span> (${esc(ex.confidence.label)})`;
  }
  if (state.references?.get(c.best_ref)?.group === 'water') {
    return `Closest reference: ${richText(best)} (<span class="mono">${fmtAngle(c.sam_deg[c.best_ref])}°</span>), a water type, so the cluster isn't named as a bloom.`;
  }
  if (c.margin < rule.margin_min) {
    return `Closest reference: ${richText(best)}, but the margin <span class="mono">${fmtMargin(c.margin)}</span> is below <span class="mono">${fmtMargin(rule.margin_min)}</span>: too close to call.`;
  }
  return `The cluster looks most like ${richText(best)} (margin <span class="mono">${fmtMargin(c.margin)}</span>), but this pixel isn't a dense bloom, so no species is named.`;
}

function spectrumCard(ex) {
  const verdict = matchVerdict(ex);
  const best = ex.cluster?.best_ref;
  const color = best && REF_COLORS[best];
  return section({
    key: 'spectrum',
    name: 'Cluster spectrum',
    className: 'spectrum-card',
    label: 'Cluster spectrum',
    peek: peekRow(`${color ? `<svg class="legend-line" viewBox="0 0 24 6" aria-hidden="true"><line x1="1" y1="3" x2="23" y2="3" style="stroke:${color}" stroke-width="2.2" stroke-dasharray="5 3"/></svg>` : ''}<span class="peek-text">${peekVerdict(ex)}</span>`),
    body: `
      ${verdict ? `<p class="chart-verdict">${verdict}</p>` : ''}
      <p class="chart-source" id="chart-source">Loading spectra</p>
      <div class="seg-group seg-small chart-tools" role="group" aria-label="Chart options">
        <button type="button" class="seg ${state.chart.normalize ? 'is-on' : ''}" data-action="chart-normalize" aria-pressed="${state.chart.normalize}">Compare shapes</button>
        <button type="button" class="seg ${state.chart.showAll ? 'is-on' : ''}" data-action="chart-all" aria-pressed="${state.chart.showAll}">All references</button>
      </div>
      <div class="chart" id="chart"></div>
      <ul class="chart-legend" id="chart-legend" role="list"></ul>`,
  });
}

async function drawChart(root) {
  const date = state.date;
  const hit = state.selection && hitAt(state.selection.lon, state.selection.lat);
  if (!hit) return;
  const { grid, codes } = hit.loaded;
  const { cell } = hit;
  const spectra = await loadSpectra(hit.scene);
  if (date !== state.date || !root.isConnected) return;

  const cid = grid.cluster_id[cell.index];
  const cluster = state.clusters && cid != null ? state.clusters.get(cid) : null;
  const series = [];
  let source = '';
  const ink = 'var(--ink)';

  // 1. The cluster's mean spectrum: the curve that was compared with the references.
  if (cluster && state.clusterWavelengths) {
    series.push({ id: 'cluster', label: `Cluster #${cluster.cluster_id} mean`, wl: state.clusterWavelengths, values: cluster.mean_rrs, color: ink, width: 2.4 });
    source = `This pixel's cluster (#${cluster.cluster_id}): its mean PACE spectrum, the curve that was compared with the references.`;
  }
  // 2. Otherwise the pixel's own stored spectrum (nearest probe within ~1.5 cells).
  if (!series.length && spectra) {
    const { lon, lat } = cellCenter(grid, cell.row, cell.col);
    const [rl, rt] = grid.res_deg;
    let best = null;
    for (const p of spectra.probes) {
      const d = Math.hypot((p.lon - lon) / rl, (p.lat - lat) / rt);
      if (d <= 1.5 && (!best || d < best.d)) best = { p, d };
    }
    if (best) {
      series.push({ id: 'pixel', label: 'This pixel', wl: spectra.wavelengths_nm, values: best.p.rrs, color: ink, width: 2.4 });
      source = `Cluster details are unavailable, so this pixel's stored spectrum is shown (sample ${best.p.probe_id}).`;
    }
  }
  // 3. Otherwise the class average for this scene.
  if (!series.length && spectra?.class_means?.[String(codes[cell.index])]) {
    series.push({ id: 'class', label: 'Class average', wl: spectra.wavelengths_nm, values: spectra.class_means[String(codes[cell.index])], color: ink, width: 2.4 });
    source = 'Cluster details are unavailable and no spectrum is stored for this pixel, so the class average for this date is shown.';
  }

  const sourceEl = els.inspector.querySelector('#chart-source');
  const legendEl = els.inspector.querySelector('#chart-legend');
  if (!series.length) {
    sourceEl.textContent = 'No spectrum is stored for this pixel or its class on this date.';
    root.innerHTML = '';
    return;
  }

  if (state.references) {
    const ids = state.chart.showAll || !cluster ? [...state.references.keys()] : [cluster.best_ref, cluster.second_ref];
    for (const id of ids) {
      const ref = state.references.get(id);
      if (!ref) continue;
      const role = cluster && id === cluster.best_ref ? 'best match' : cluster && id === cluster.second_ref ? '2nd' : '';
      series.push({
        id,
        label: `${refLabel(state.references, id)}${role ? ` (${role})` : ''}`,
        wl: ref.wavelengths_nm,
        values: ref.rrs,
        color: REF_COLORS[id] ?? '#7a8296',
        dash: role === 'best match' ? '5 3' : '2 3',
        width: role ? 1.8 : 1.2,
      });
    }
  }

  const placeholder = state.references && [...state.references.values()].some((r) => /placeholder/i.test(`${r.label} ${r.source}`));
  const shapeFrom = state.manifest.rule.sam_range_nm?.[0] ?? null;
  const shaded = shapeFrom != null ? ` Shaded below ${esc(shapeFrom)} nm: not used by the shape comparison.` : '';
  sourceEl.innerHTML = `${esc(source)}${shaded}${placeholder ? ' <strong>Reference spectra are placeholders.</strong>' : ''}`;
  const units = series[0].id === 'cluster' ? state.clusterUnits : 'sr^-1';
  renderChart(root, { series, normalize: state.chart.normalize, units, shapeFrom });
  legendEl.innerHTML = series
    .map((s) => `<li><svg class="legend-line" viewBox="0 0 24 6" aria-hidden="true"><line x1="1" y1="3" x2="23" y2="3" style="stroke:${s.color}" stroke-width="2.2" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''}/></svg>${richText(s.label)}</li>`)
    .join('');
}

/** Depth of a site's nearest C. polykrikoides-like cell, when it's in water shallow enough for the seabed to show. */
function siteSeabedDepth(p, st) {
  const x = state.shown.get(st?.region ?? p.region);
  if (st?.nearestIndex == null || !x?.loaded) return null;
  const d = depthAt(state.depth, x.loaded.grid, st.nearestIndex);
  return seabedFlag(state.manifest.rule, d) ? d : null;
}

function siteCard() {
  const site = state.sites.find((s) => s.properties.site_id === state.selectedSite);
  if (!site) return '';
  const p = site.properties;
  const st = state.siteStatuses.get(p.site_id);
  const type = SITE_TYPES[p.type] ?? SITE_TYPES.other;
  const [lon, lat] = site.geometry.coordinates;
  return section({
    key: 'site',
    name: 'Site',
    className: `is-focus site-card ${st ? `site-${st.status}` : ''}`,
    style: '--focus:var(--status, var(--ink))',
    accent: STATUS_ACCENT[st?.status] ?? '',
    label: `${icon(type.icon)}${esc(type.label)}`,
    close: closeButton('close-site', 'site details'),
    peek: peekRow(`<span class="peek-main"><span class="peek-text">${esc(p.name)}</span></span>${st ? siteStatusBadge(st.status) : ''}`),
    body: `
      <h2 class="sec-title">${esc(p.name)}</h2>
      ${st ? `<p class="site-status-line">${siteStatusBadge(st.status)}<span class="muted">on ${esc(fmtDate(state.date))}</span></p><p>${richText(statusExplanation(st, siteSeabedDepth(p, st)))}</p>` : '<p class="muted">Status appears once the date has loaded.</p>'}
      <p class="muted small mono">${esc(fmtLatLon(lat, lon))}</p>
      ${p.source ? `<p class="site-source muted small">${p.approximate ? '<span class="tag">Approximate</span> ' : ''}Location: ${p.source_url ? `<a href="${esc(p.source_url)}" target="_blank" rel="noopener">${esc(p.source)}</a>` : esc(p.source)}</p>` : ''}
      ${/^Example /.test(p.name) ? `<p class="note">${icon('warning')}<span>Example site with a made-up name, for building the interface.</span></p>` : ''}`,
  });
}

function sceneCard(s) {
  const role = roleInfo(s.role);
  const region = state.manifest.regions[s.region];
  return section({
    key: 'scene',
    name: 'Scene',
    className: `scene-card role-${esc(s.role)}`,
    label: 'Scene',
    actions: statusBadge(s.status),
    peek: peekRow(`${icon(role.icon, `icon role-${esc(s.role)}`)}<span class="peek-text">${esc(role.label)} · ${richText(s.title || s.scene_id)}</span>`),
    body: `
      <h2 class="sec-title">${richText(s.title || s.scene_id)}</h2>
      ${moreHtml({
        key: 'evidence',
        className: 'evidence',
        head: `<p class="evidence-title">${icon(role.icon, `icon role-${esc(s.role)}`)}<span>Evidence level: <strong>${esc(role.label)}</strong></span></p>`,
        body: `<p>${richText(role.blurb)}</p>`,
        what: 'about this evidence level',
      })}
      ${s.context ? `<p class="context">${richText(s.context)}</p>` : ''}
      ${sourceLinks(s)}
      <dl class="facts">
        <div><dt>Date</dt><dd><time class="mono" datetime="${esc(s.date)}">${esc(fmtDate(s.date))}</time></dd></div>
        <div><dt>Sensor</dt><dd>${esc(SENSORS[s.sensor] ?? s.sensor)}</dd></div>
        <div><dt>Products</dt><dd class="mono">${(s.products ?? []).map(esc).join('<br>') || 'n/a'}</dd></div>
        <div><dt>Area</dt><dd>${esc(region.label)}</dd></div>
        <div><dt>Scene ID</dt><dd class="mono">${esc(s.scene_id)}</dd></div>
      </dl>`,
  });
}

function censusCard(x) {
  if (!x.loaded) {
    return section({
      key: 'census',
      name: 'Pixel census',
      className: 'census is-loading',
      label: 'Pixel census',
      peek: peekRow('<span class="peek-text muted">Counting pixels</span>'),
      body: '<p class="muted">Counting pixels</p>',
    });
  }
  const { grid, codes, counts } = x.loaded;
  const water = counts.slice(CLEAR).reduce((a, b) => a + b, 0);
  const cp = counts[CP_LIKE];
  const area = cp ? classAreaKm2(grid, codes, CP_LIKE) : 0;
  const rows = state.manifest.classes
    .filter((k) => k.code >= 1)
    .sort((a, b) => (tierByKey(b.risk_tier).rank - tierByKey(a.risk_tier).rank) || b.code - a.code)
    .map((k) => {
      const n = counts[k.code];
      const share = water && k.code >= CLEAR ? (n / water) * 100 : null;
      return `
        <li class="${n ? '' : 'is-zero'}">
          <span class="census-label">${swatch(k.key)}<span>${richText(k.label)}</span></span>
          <span class="census-bar" aria-hidden="true">${share != null ? `<span style="width:${share.toFixed(2)}%;--swatch:var(--c-${k.key})"></span>` : ''}</span>
          <span class="census-share mono">${share != null && n ? `${share < 0.1 ? '<0.1' : share.toFixed(1)}%` : ''}</span>
          <span class="census-num mono">${fmtInt(n)}</span>
        </li>`;
    })
    .join('');

  return section({
    key: 'census',
    name: 'Pixel census',
    className: 'census',
    label: 'Pixel census',
    peek: peekRow(`${swatch('cp_like')}<span class="peek-text"><span class="mono">${fmtInt(cp)}</span> <em>C.&nbsp;p.</em>-like pixels · <span class="mono">${fmtInt(area)}</span> km²</span>`),
    body: `
      <div class="census-kpis">
        <div class="kpi kpi-cp">
          <span class="kpi-value mono">${fmtInt(cp)}</span>
          <span class="kpi-label"><em>C.&nbsp;polykrikoides</em>-like pixels</span>
        </div>
        <div class="kpi">
          <span class="kpi-value mono">${fmtInt(area)}<small> km²</small></span>
          <span class="kpi-label">flagged area</span>
        </div>
        <div class="kpi">
          <span class="kpi-value mono">${fmtInt(water)}</span>
          <span class="kpi-label">analysed water pixels</span>
        </div>
      </div>
      <ul class="census-list" role="list">${rows}</ul>
      <p class="panel-note">Share of analysed water, from ${fmtInt(grid.width * grid.height)} cells (${grid.width} × ${grid.height} grid).</p>
      ${testCheckHtml(x)}`,
  });
}

/**
 * On the held-out test date: how its dense-bloom pixels were named. NASA described
 * the bloom as likely Noctiluca, so any C. polykrikoides-like pixel is a possible false alarm.
 */
function testCheckHtml(x) {
  if (x.scene.role !== 'held_out_test') return '';
  const { counts } = x.loaded;
  const keys = ['cp_like', 'noctiluca_like', 'diatom_like', 'dense_unclassified'];
  const rows = keys.map((key) => ({ k: classByKey(key), n: counts[classByKey(key).code] }));
  const dense = rows.reduce((a, r) => a + r.n, 0);
  const cp = rows[0].n;
  const pct = (n) => (dense ? `${((n / dense) * 100).toFixed(1)}%` : '0%');
  const verdict = cp ? 'disagree' : 'agree';
  const text = !dense
    ? 'No dense-bloom pixels on this date.'
    : cp
      ? `${fmtInt(cp)} of the ${fmtInt(dense)} dense-bloom pixels are ${richText('C. polykrikoides')}-like on a bloom NASA described as likely ${richText('Noctiluca')}: a possible false alarm.`
      : `None of the ${fmtInt(dense)} dense-bloom pixels are ${richText('C. polykrikoides')}-like, on a bloom NASA described as likely ${richText('Noctiluca')}.`;
  return moreHtml({
    key: 'true-negative',
    className: `test-check test-${verdict}`,
    attrs: `data-test="${verdict}" data-cp="${cp}" data-dense="${dense}"`,
    head: '<p class="sub-label">True-negative check</p>',
    lead: `<p>${icon(verdict === 'agree' ? 'check' : 'warning')}<span>${text}</span></p>`,
    body: `<dl class="cc-list">${rows.map((r) => `<div><dt class="mono">${pct(r.n)}</dt><dd>${richText(r.k.label)} <span class="muted mono">(${fmtInt(r.n)})</span></dd></div>`).join('')}</dl>
      <p class="muted small">Shares of the dense-bloom pixels. A true-negative check only: the bloom's species wasn't confirmed by water sampling.</p>`,
    what: 'about the true-negative check',
  });
}

/** The scene's source and its other links (scene.links), one per line, without repeats. */
function sourceLinks(s) {
  const more = Array.isArray(s.links) ? s.links : [];
  const links = [...(s.source_url ? [{ label: null, url: s.source_url }] : []), ...more];
  const key = (url) => url.replace(/\/$/, '');
  const labels = new Map(more.filter((l) => l?.label && typeof l.url === 'string').map((l) => [key(l.url), l.label]));
  const seen = new Set();
  return links
    .filter((l) => typeof l?.url === 'string' && /^https?:\/\//.test(l.url))
    .filter((l) => (seen.has(key(l.url)) ? false : seen.add(key(l.url))))
    .map((l) => `<a class="source-link" href="${esc(l.url)}" target="_blank" rel="noopener">${icon('external')}<span>Source: ${esc(l.label || labels.get(key(l.url)) || hostOf(l.url))}</span></a>`)
    .join('');
}

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------- map overlays

function showReadout(lngLat, point) {
  if (!loadedList().length) return;
  const where = `<span class="mono">${esc(fmtLatLon(lngLat.lat, lngLat.lng))}</span>`;
  const hit = hitAt(lngLat.lng, lngLat.lat);
  const comparing = state.compare.open && state.cmp?.isOpen();
  if (comparing) {
    // Both sides at the cursor, each tagged; the side under the cursor is marked.
    const here = point ? state.cmp.sideAt(point.x) : 'a';
    const side = (key, h, layer) =>
      `<span class="readout-side ${here === key ? 'is-here' : ''}"><span class="cmp-tag">${key.toUpperCase()}</span>${h ? readoutValueHtml(h, layer) : '<span class="muted">no data</span>'}</span>`;
    els.readout.innerHTML = `${where}${side('a', hit, state.layer)}${side('b', compareHit(lngLat.lng, lngLat.lat), state.compare.layer)}`;
  } else if (!hit) {
    els.readout.innerHTML = `${where}<span class="muted">no data on this date</span>`;
  } else {
    els.readout.innerHTML = `${where}${readoutValueHtml(hit, state.layer)}${readoutCurrent(lngLat, hit.loaded.codes[hit.cell.index])}`;
  }
  if (hit && hasReading(hit.loaded.codes[hit.cell.index])) {
    const { grid } = hit.loaded;
    showScaleCursor(state.layer === 'nflh' ? grid.nflh?.[hit.cell.index] ?? null : grid.chlor_a[hit.cell.index]);
  } else showScaleCursor(null);
  els.readout.hidden = false;
}

/**
 * A pixel's class and value as a layer shows it: on the chlorophyll and fluorescence
 * layers the value in the color the map uses, otherwise the class with its chlorophyll.
 */
function readoutValueHtml(hit, layer) {
  const { grid, codes } = hit.loaded;
  const i = hit.cell.index;
  const k = classByCode(codes[i]);
  const chl = grid.chlor_a[i];
  const nflh = grid.nflh?.[i] ?? null;
  const shown = hasReading(codes[i]); // the pixels the value layers draw
  const v = layer === 'nflh' ? nflh : chl;
  if ((layer === 'chl' || layer === 'nflh') && shown && v != null) {
    const nflhLayer = layer === 'nflh';
    const rgb = nflhLayer ? nflhColor(v, state.manifest.rule.nflh_dense_min) : chlColor(v);
    const text = nflhLayer ? `nFLH ${fmtNflh(v)}` : `${fmtChl(v)} mg/m³`;
    return `<span class="readout-value mono" style="background:rgb(${rgb.join(' ')});color:${inkOn(rgb)}">${text}</span><span class="muted">${richText(k.label)}</span>`;
  }
  const value = layer !== 'nflh' && shown && chl != null ? `<span class="mono muted">${fmtChl(chl)} mg/m³</span>` : '';
  return `${swatch(k.key)}<span>${richText(k.label)}</span>${value}`;
}

/** The net surface current under the cursor (where prepared, over water): an arrow and the speed. */
function readoutCurrent(lngLat, code) {
  if (!state.currentsField || code === LAND) return '';
  const uv = meanAt(state.currentsField, lngLat.lng, lngLat.lat);
  if (!uv) return '';
  const deg = ((Math.atan2(uv[0], uv[1]) * 180) / Math.PI + 360) % 360;
  const kmh = Math.hypot(uv[0], uv[1]) * 3.6;
  return `<span class="readout-current" title="Net surface current over the day, flowing toward the ${towardWord(uv[0], uv[1])} (model estimate, Open-Meteo)"><span class="muted">current</span><span class="readout-arrow" style="transform:rotate(${deg.toFixed(0)}deg)">${icon('arrow')}</span><span class="mono">${kmh.toFixed(1)} km/h</span></span>`;
}

/** On the chlorophyll and fluorescence layers, a line on the legend's scale marks the hovered pixel's value. */
function showScaleCursor(value) {
  const cursor = els.toolsBody.querySelector('.legend-swap .chl-cursor'); // A's scale
  if (!cursor) return;
  cursor.classList.toggle('is-on', value != null);
  if (value == null) return;
  const nflhLayer = state.layer === 'nflh';
  const threshold = state.manifest.rule.nflh_dense_min;
  const pos = nflhLayer ? nflhPosition(value, threshold) : chlPosition(value);
  cursor.style.left = `${(pos * 100).toFixed(2)}%`;
  cursor.dataset.edge = pos < 0.08 ? 'start' : pos > 0.92 ? 'end' : '';
  const label = cursor.firstElementChild;
  const top = nflhLayer ? nflhMax(threshold) : CHL_MAX;
  const text = nflhLayer ? fmtNflh(value) : fmtChl(value);
  label.textContent = value >= top ? `${text} (${nflhLayer ? top.toFixed(1) : top}+)` : text;
  // The value's box takes the scale's color there, with whichever text reads better on it.
  const rgb = nflhLayer ? nflhColor(value, threshold) : chlColor(value);
  label.style.background = `rgb(${rgb.join(' ')})`;
  label.style.color = inkOn(rgb);
}

/** White or near-black, whichever reads better on a color ([r, g, b]). */
function inkOn(rgb) {
  const lin = rgb.map((c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const lum = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return 1.05 / (lum + 0.05) >= (lum + 0.05) / 0.05 ? '#fff' : '#111';
}

function setMapStatus(kind, html = '') {
  els.mapStatus.hidden = !kind;
  els.mapStatus.className = `map-status ${kind ? `is-${kind}` : ''}`;
  els.mapStatus.innerHTML =
    kind === 'loading' ? `<span class="spinner" aria-hidden="true"></span><span>${html}</span>` : html;
}

function emptyDateHtml(date) {
  const before = dataDateBefore(date);
  const after = dataDateAfter(date);
  const go = (d, dir) =>
    d ? `<button type="button" class="seg" data-goto="${esc(d)}">${dir < 0 ? '‹ ' : ''}${esc(fmtDate(d))}${dir > 0 ? ' ›' : ''}</button>` : '';
  return `
    <div class="empty-card panel">
      <p><strong>No processed scene on ${esc(fmtDate(date))}.</strong> Satellite data is only processed for the marked days.</p>
      ${before || after ? `<p class="empty-nav"><span class="muted">Nearest:</span>${go(before, -1)}${go(after, 1)}</p>` : ''}
    </div>`;
}

function sceneErrorHtml(err) {
  const e = err instanceof ContractError ? err : new ContractError('Something went wrong loading this scene.', { detail: String(err?.message ?? err) });
  return `
    <div class="error-card panel">
      <h2>${icon('warning')}<span>This scene can't be shown</span></h2>
      <p>${esc(e.message)}</p>
      ${e.hint ? `<p class="muted">${esc(e.hint)}</p>` : ''}
      ${e.detail ? `<details><summary>Technical detail</summary><pre>${esc(e.detail)}</pre></details>` : ''}
      <p class="muted small">The other dates aren't affected. Pick another date.</p>
    </div>`;
}

let toastTimer;
function toast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (els.toast.hidden = true), 6000);
}

function showFatal(err) {
  const e = err instanceof ContractError ? err : new ContractError('Something went wrong starting the dashboard.', { detail: String(err?.message ?? err) });
  const hint =
    e.hint ||
    (e.kind === 'missing'
      ? 'If you are running locally, generate the data first: python pipeline/make_mock_data.py'
      : 'Run python pipeline/validate_contract.py data to see exactly what is wrong.');
  els.fatal.innerHTML = `
    <div class="fatal-card">
      <h1>${esc(e.message)}</h1>
      <p>${esc(hint)}</p>
      ${e.detail ? `<details open><summary>Technical detail</summary><pre>${esc(e.detail)}</pre></details>` : ''}
    </div>`;
  els.fatal.hidden = false;
  if (!(err instanceof ContractError)) console.error(err);
}

// Read-only handle for scripts/check.mjs (headless browser checks).
window.__gbw = state;
