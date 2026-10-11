// Measure distance and area on the map, as in Google Maps: right-click (or press
// and hold on a touch screen) for a menu, or use the measure button in the map's
// dock, pick a measure, then click to add points.
// Click a point to remove it, drag one to move it; Backspace removes the last
// point, and Esc or the card's close button ends the measurement.

import { esc, icon, fmtLatLon } from './format.js';

const R_MEAN = 6371008.8; // m, mean Earth radius (great-circle distances)
const R_WGS84 = 6378137; // m, equatorial radius (spherical polygon area, as in GeoJSON area tools)
const HOLD_MS = 550; // press and hold on a touch screen opens the menu
const rad = (d) => (d * Math.PI) / 180;

/** Great-circle distance between two [lon, lat] points, in metres. */
export function distanceM([lon1, lat1], [lon2, lat2]) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_MEAN * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Length of a path of [lon, lat] points, in metres. */
export function lineLengthM(points) {
  let m = 0;
  for (let i = 1; i < points.length; i++) m += distanceM(points[i - 1], points[i]);
  return m;
}

/** Area of the polygon a ring of [lon, lat] points closes, on the sphere, in square metres. */
export function polygonAreaM2(points) {
  if (points.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < points.length; i++) {
    const [lon1, lat1] = points[i];
    const [lon2, lat2] = points[(i + 1) % points.length];
    sum += rad(lon2 - lon1) * (2 + Math.sin(rad(lat1)) + Math.sin(rad(lat2)));
  }
  return Math.abs((sum * R_WGS84 * R_WGS84) / 2);
}

const dec = (v, d) => v.toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });

/** "850 m", "12.4 km", "152 km". */
export function fmtDistance(m) {
  if (m < 1000) return `${Math.round(m)} m`;
  const km = m / 1000;
  return `${dec(km, km < 100 ? 1 : 0)} km`;
}

/** Nautical miles, for the sea: "6.7 nmi". */
const fmtNmi = (m) => `${dec(m / 1852, m / 1852 < 10 ? 2 : 1)} nmi`;

/** "4,200 m²", "0.42 km²", "38.2 km²", "1,250 km²". */
export function fmtArea(m2) {
  if (m2 < 10000) return `${dec(Math.round(m2), 0)} m²`;
  const km2 = m2 / 1e6;
  return `${dec(km2, km2 < 10 ? 2 : km2 < 1000 ? 1 : 0)} km²`;
}

/**
 * Wires measuring into the map.
 * @param {object} view       the map view from map.js (map, setMeasure)
 * @param {object} o
 * @param {HTMLElement} o.card  an empty element for the measurement card
 * @param {(text: string) => void} o.onCopy  called after the coordinates are copied
 * @param {(active: boolean) => void} [o.onChange]  called whenever measuring starts or ends
 */
export function createMeasure(view, { card, onCopy, onChange }) {
  const { map } = view;
  const container = map.getContainer();
  let mode = null; // 'distance' | 'area' while measuring
  let points = [];
  let menu = null;
  let menuAnchor = null; // the button a menu opened from, if not the map
  let drag = null;
  let holdTimer = 0;
  let suppressUntil = 0; // the click that closes the menu or ends a drag does nothing else

  const label = document.createElement('div');
  label.className = 'measure-label';
  label.hidden = true;
  container.appendChild(label);

  // ------------------------------------------------------------ drawing

  function geojson() {
    const features = [];
    if (mode === 'area' && points.length >= 3) {
      features.push({ type: 'Feature', properties: { kind: 'fill' }, geometry: { type: 'Polygon', coordinates: [[...points, points[0]]] } });
    }
    const path = mode === 'area' && points.length >= 3 ? [...points, points[0]] : points;
    if (path.length >= 2) features.push({ type: 'Feature', properties: { kind: 'line' }, geometry: { type: 'LineString', coordinates: path } });
    points.forEach((p, i) => features.push({ type: 'Feature', properties: { kind: 'vertex', i }, geometry: { type: 'Point', coordinates: p } }));
    return { type: 'FeatureCollection', features };
  }

  function values() {
    const length = lineLengthM(points);
    if (mode === 'distance') return { main: points.length >= 2 ? fmtDistance(length) : null, sub: points.length >= 2 ? fmtNmi(length) : '' };
    const area = polygonAreaM2(points);
    const perimeter = points.length >= 3 ? length + distanceM(points.at(-1), points[0]) : length;
    return { main: points.length >= 3 ? fmtArea(area) : null, sub: points.length >= 3 ? `perimeter ${fmtDistance(perimeter)}` : '' };
  }

  function placeLabel() {
    if (label.hidden || !points.length) return;
    const p = map.project(points.at(-1));
    label.style.transform = `translate(${Math.round(p.x + 10)}px, ${Math.round(p.y - 10)}px) translateY(-100%)`;
  }

  function render() {
    view.setMeasure(mode ? geojson() : null);
    container.classList.toggle('is-measuring', !!mode);
    document.body.classList.toggle('is-measuring', !!mode);
    onChange?.(!!mode);
    if (!mode) {
      card.hidden = true;
      label.hidden = true;
      return;
    }
    const v = values();
    const need = mode === 'area' ? 3 : 2;
    const hint = points.length < need
      ? `Click the map to add ${points.length ? 'the next point' : 'a point'}${mode === 'area' ? ` (${need - points.length} more to make an area)` : ''}.`
      : 'Click to add a point, drag a point to move it, click it to remove it.';
    card.innerHTML = `
      <div class="measure-head">
        <span class="measure-kind">${mode === 'area' ? 'Area' : 'Distance'}</span>
        <button type="button" class="measure-close" data-measure="close" aria-label="End measuring" title="End measuring (Esc)">${icon('close')}</button>
      </div>
      <p class="measure-value" data-value="${mode === 'area' ? polygonAreaM2(points).toFixed(0) : lineLengthM(points).toFixed(0)}">${v.main ? `<strong class="mono">${esc(v.main)}</strong>${v.sub ? ` <span class="mono muted">${esc(v.sub)}</span>` : ''}` : '<span class="muted">No measurement yet</span>'}</p>
      <p class="measure-hint">${esc(hint)}</p>`;
    card.hidden = false;
    label.hidden = !v.main;
    if (v.main) label.textContent = v.main;
    placeLabel();
  }

  // ------------------------------------------------------------ measuring

  function start(kind, lngLat) {
    mode = kind;
    points = lngLat ? [[lngLat.lng, lngLat.lat]] : [];
    render();
  }

  function end() {
    mode = null;
    points = [];
    drag = null;
    render();
  }

  function vertexAt(point) {
    const hit = map.queryRenderedFeatures(point, { layers: ['measure-vertex'] })[0];
    return hit ? hit.properties.i : -1;
  }

  /**
   * A map click: closes the menu, or adds or removes a point while measuring.
   * @returns {boolean} true when the click was used here (no pixel is selected)
   */
  function handleClick(lngLat) {
    if (Date.now() < suppressUntil) return true;
    if (menu) {
      closeMenu();
      return true;
    }
    if (!mode) return false;
    const i = vertexAt(map.project(lngLat));
    if (i >= 0) points.splice(i, 1);
    else points.push([lngLat.lng, lngLat.lat]);
    render();
    return true;
  }

  // Dragging a point moves it (mouse or one finger).
  function dragStart(e) {
    if (!mode || (e.points && e.points.length !== 1) || e.originalEvent?.button > 0) return;
    const i = vertexAt(e.point);
    if (i < 0) return;
    e.preventDefault();
    drag = { i, moved: false };
    map.dragPan.disable();
    container.classList.add('is-dragging-point');
  }
  function dragMove(e) {
    if (!drag) return;
    drag.moved = true;
    points[drag.i] = [e.lngLat.lng, e.lngLat.lat];
    render();
  }
  function dragEnd() {
    if (!drag) return;
    if (drag.moved) suppressUntil = Date.now() + 350; // the click that ends a drag doesn't add a point
    drag = null;
    map.dragPan.enable();
    container.classList.remove('is-dragging-point');
  }
  map.on('mousedown', dragStart);
  map.on('touchstart', dragStart);
  map.on('mousemove', dragMove);
  map.on('touchmove', dragMove);
  map.on('mouseup', dragEnd);
  map.on('touchend', dragEnd);
  map.on('touchcancel', dragEnd);
  map.on('move', placeLabel);

  // The pointer shows a point can be grabbed.
  map.on('mousemove', (e) => {
    if (!mode || drag) return;
    container.classList.toggle('is-over-point', vertexAt(e.point) >= 0);
  });

  // ------------------------------------------------------------ the menu

  /** Closes the menu; after a click outside it (swallowClick), that click does nothing else on the map. */
  function closeMenu(swallowClick = false) {
    if (!menu) return;
    menu.remove();
    menu = null;
    menuAnchor = null;
    if (swallowClick) suppressUntil = Date.now() + 350;
    document.removeEventListener('pointerdown', onOutside, true);
  }

  function onOutside(e) {
    // A press on the button the menu came from is left to that button (it closes the menu).
    if (menu && !menu.contains(e.target) && !menuAnchor?.contains(e.target)) closeMenu(true);
  }

  /**
   * The menu: at a map point (with that point's coordinates first), or above a
   * button (anchor) with just the two measures.
   */
  function openMenu({ point = null, lngLat = null, anchor = null }) {
    closeMenu();
    const where = lngLat ? fmtLatLon(lngLat.lat, lngLat.lng) : '';
    menu = document.createElement('div');
    menu.className = `map-menu ${anchor ? 'is-anchored' : ''}`;
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', lngLat ? `Map menu at ${where}` : 'Measure');
    const item = (action, iconName, text, extra = '') =>
      `<button type="button" role="menuitem" class="map-menu-item ${extra}" data-menu="${action}">${icon(iconName)}<span>${text}</span></button>`;
    menu.innerHTML = `
      ${lngLat ? `${item('copy', 'pin', `<span class="mono">${esc(where)}</span>`, 'map-menu-coords')}<div class="map-menu-rule" role="separator"></div>` : ''}
      ${item('distance', 'ruler', 'Measure distance')}
      ${item('area', 'area', 'Measure area')}
      ${mode ? item('clear', 'close', 'Clear measurement') : ''}`;
    if (anchor) {
      // Above the button, lined up with its right edge.
      menuAnchor = anchor;
      document.body.appendChild(menu);
      const r = anchor.getBoundingClientRect();
      const x = Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8));
      const y = Math.max(8, r.top - menu.offsetHeight - 6);
      menu.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    } else {
      // Beside the pointer, kept inside the map.
      container.appendChild(menu);
      const w = menu.offsetWidth;
      const h = menu.offsetHeight;
      const x = Math.min(point.x + 2, container.clientWidth - w - 8);
      const y = point.y + h + 8 > container.clientHeight ? Math.max(8, point.y - h - 2) : point.y + 2;
      menu.style.transform = `translate(${Math.max(8, x)}px, ${y}px)`;
    }
    menu.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-menu]');
      if (!btn) return;
      const action = btn.dataset.menu;
      closeMenu();
      if (action === 'copy') {
        navigator.clipboard?.writeText(where).then(() => onCopy?.(where), () => onCopy?.(null));
      }
      if (action === 'distance' || action === 'area') start(action, lngLat);
      if (action === 'clear') end();
      if (!anchor) map.getCanvas().focus({ preventScroll: true });
    });
    menu.addEventListener('keydown', (e) => {
      const items = [...menu.querySelectorAll('[role="menuitem"]')];
      const at = items.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        items[(at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      } else if (e.key === 'Tab') closeMenu();
    });
    document.addEventListener('pointerdown', onOutside, true);
    menu.querySelector('[data-menu="distance"]').focus({ preventScroll: true });
  }

  map.on('contextmenu', (e) => {
    e.preventDefault();
    e.originalEvent?.preventDefault();
    openMenu({ point: e.point, lngLat: e.lngLat });
  });
  map.getCanvas().addEventListener('contextmenu', (e) => e.preventDefault());
  map.on('movestart', (e) => {
    if (e.originalEvent) closeMenu();
  });

  // Press and hold on a touch screen opens the menu.
  const cancelHold = () => {
    clearTimeout(holdTimer);
    holdTimer = 0;
  };
  map.on('touchstart', (e) => {
    cancelHold();
    if (e.points.length !== 1 || drag) return;
    const { point, lngLat } = e;
    holdTimer = setTimeout(() => openMenu({ point, lngLat }), HOLD_MS);
  });
  map.on('touchmove', (e) => {
    if (holdTimer && e.points.length === 1) cancelHold();
  });
  map.on('touchend', () => {
    cancelHold();
    // Lifting the finger after the menu opened isn't a tap on the map.
    if (menu) suppressUntil = Date.now() + 450;
  });
  map.on('touchcancel', cancelHold);

  card.addEventListener('click', (e) => {
    if (e.target.closest('[data-measure="close"]')) end();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (menu) closeMenu();
      else if (mode) end();
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && mode && points.length && !e.target.closest?.('input, textarea, [contenteditable]')) {
      e.preventDefault();
      points.pop();
      render();
    }
  });

  /** The dock's measure button: ends a measurement, or opens (and closes) the menu above it. */
  function buttonPress(button) {
    if (mode) end();
    else if (menu && menuAnchor === button) closeMenu();
    else openMenu({ anchor: button });
  }

  return {
    handleClick,
    buttonPress,
    start: (kind) => start(kind, null),
    isActive: () => !!mode,
    /** For checks: the mode and the points. */
    snapshot: () => ({ mode, points: points.map((p) => [...p]) }),
    end,
  };
}
