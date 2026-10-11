// The date timeline, modeled on NASA Worldview's: year / month / day fields
// with steppers, one-day arrows, a jump to the next date with data, and a
// continuous time axis with a zoom toggle (year / month / day). A strip along
// the top of the axis shows which days have data; below it each such day
// carries its role symbol. The handle marks the selected day and can be
// dragged. Any day in the range can be picked; days without a processed scene
// simply show no data. The arrow at the right end folds the timeline down to
// the date controls.

import { esc, icon, fmtDate, roleInfo } from './format.js';

const DAY_MS = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const toUTC = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10));
export const toISO = (t) => new Date(t).toISOString().slice(0, 10);
export const addDays = (iso, n) => toISO(toUTC(iso) + n * DAY_MS);
const daysBetween = (a, b) => Math.round((toUTC(b) - toUTC(a)) / DAY_MS);
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate(); // m: 0-11

/** Is this a real calendar date written as YYYY-MM-DD? */
export function isIsoDate(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && toISO(toUTC(s)) === s;
}

/** Moves a date by whole months, keeping the day where the month allows. */
function addMonths(iso, n) {
  const m = +iso.slice(5, 7) - 1 + n;
  const yy = +iso.slice(0, 4) + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return toISO(Date.UTC(yy, mm, Math.min(+iso.slice(8, 10), daysInMonth(yy, mm))));
}

// Pixels per day at each zoom, coarsest first. "year" fits the whole range into the axis.
const ZOOMS = [
  { key: 'year', label: 'Year', ppd: null },
  { key: 'month', label: 'Month', ppd: 6 },
  { key: 'day', label: 'Day', ppd: 34 },
];
const COLLAPSE_KEY = 'gbw-timeline'; // remembers a folded timeline (this browser only)
const LANE_GAP = 12; // role symbols closer than this (px) go to the second row
const ARROW = {
  left: '<path d="M10 3 5 8l5 5"/>',
  right: '<path d="m6 3 5 5-5 5"/>',
  up: '<path d="m4 10 4-4 4 4"/>',
  down: '<path d="m4 6 4 4 4-4"/>',
  next: '<path d="m3.5 3 5 5-5 5"/><path d="M12 3v10"/>',
  fold: '<path d="M8.5 3 3.5 8l5 5M13 3 8 8l5 5"/>',
  unfold: '<path d="m3 3 5 5-5 5M7.5 3l5 5-5 5"/>',
};
const svg = (path) => `<svg viewBox="0 0 16 16" aria-hidden="true">${path}</svg>`;

/**
 * @param {HTMLElement} root
 * @param {{ start: string, max: string, end: string, onSelect: (iso: string) => void, onStep: (delta: number) => void }} options
 *   start / end: the axis range; max: the latest pickable day.
 *   onStep(±1): move to the previous / next date that has data (arrow keys on the axis).
 */
export function createTimeline(root, { start, max, end, onSelect, onStep }) {
  let zoom = 'month';
  let items = []; // [{ date, roles, failed, label }]
  let selected = null;
  let ppd = 6;
  let trackKey = '';
  let collapsed = false;
  try {
    collapsed = localStorage.getItem(COLLAPSE_KEY) === 'collapsed';
  } catch {
    // Storage blocked: start unfolded.
  }

  root.innerHTML = `
    <div class="tl-picker" role="group" aria-label="Date">
      ${field('year', 'Year', 4)}${field('month', 'Month', 3)}${field('day', 'Day', 2)}
      <div class="tl-steps">
        <span class="tl-steps-label mono">1 day</span>
        <button type="button" class="tl-arrow" data-day="-1" title="One day earlier">${svg(ARROW.left)}<span class="visually-hidden">One day earlier</span></button>
        <button type="button" class="tl-arrow" data-day="1" title="One day later">${svg(ARROW.right)}<span class="visually-hidden">One day later</span></button>
      </div>
      <div class="tl-steps">
        <span class="tl-steps-label mono">Next</span>
        <button type="button" class="tl-arrow" data-next title="Next date with data">${svg(ARROW.next)}<span class="visually-hidden">Next date with data</span></button>
      </div>
    </div>
    <div class="tl-axis" tabindex="0" role="group" aria-label="Timeline. Marked days have processed scenes. Left and right arrow keys move between them.">
      <div class="tl-track"></div>
    </div>
    <div class="tl-side">
      <div class="tl-zoom" role="group" aria-label="Timeline zoom">
        <button type="button" class="tl-spin" data-zoom-step="-1" title="Zoom out">${svg(ARROW.up)}<span class="visually-hidden">Zoom out</span></button>
        <span class="tl-zoom-label mono" aria-live="polite"></span>
        <button type="button" class="tl-spin" data-zoom-step="1" title="Zoom in">${svg(ARROW.down)}<span class="visually-hidden">Zoom in</span></button>
      </div>
      <p class="tl-key">
        <span>${icon('bloomDate')}Analysis, bloom</span>
        <span>${icon('calmDate')}Analysis, calm</span>
        <span>${icon('testDate')}Held-out test</span>
      </p>
    </div>
    <button type="button" class="tl-fold" data-fold></button>`;

  const axis = root.querySelector('.tl-axis');
  const track = root.querySelector('.tl-track');
  const foldBtn = root.querySelector('[data-fold]');
  const inputs = Object.fromEntries(['year', 'month', 'day'].map((u) => [u, root.querySelector(`input[data-unit="${u}"]`)]));

  function field(unit, label, size) {
    return `
      <div class="tl-field tl-field-${unit}">
        <button type="button" class="tl-spin" data-spin="${unit}:1" tabindex="-1" aria-label="Next ${unit}">${svg(ARROW.up)}</button>
        <input class="tl-input mono" data-unit="${unit}" aria-label="${label}" size="${size}" maxlength="${size}" autocomplete="off" spellcheck="false" ${unit === 'month' ? '' : 'inputmode="numeric"'} />
        <button type="button" class="tl-spin" data-spin="${unit}:-1" tabindex="-1" aria-label="Previous ${unit}">${svg(ARROW.down)}</button>
      </div>`;
  }

  const clamp = (iso) => (iso < start ? start : iso > max ? max : iso);
  const totalDays = daysBetween(start, end) + 1;
  const xOf = (iso) => daysBetween(start, iso) * ppd + ppd / 2;
  const dayAt = (clientX) => {
    const x = clientX - track.getBoundingClientRect().left;
    return addDays(start, Math.max(0, Math.min(totalDays - 1, Math.floor(x / ppd))));
  };

  function pick(iso) {
    const d = clamp(iso);
    if (d !== selected) onSelect(d);
    else setFields(); // undo an out-of-range edit
  }

  function spin(unit, n) {
    dirty.clear();
    if (selected) pick(unit === 'day' ? addDays(selected, n) : addMonths(selected, unit === 'month' ? n : 12 * n));
  }

  // ---------- fields
  // A field being edited keeps its text until it is committed (Enter or leaving it).
  const dirty = new Set();
  function setFields(keepEdits = false) {
    if (!selected) return;
    const values = { year: selected.slice(0, 4), month: MONTHS[+selected.slice(5, 7) - 1].toUpperCase(), day: selected.slice(8, 10) };
    for (const [unit, input] of Object.entries(inputs)) if (!(keepEdits && dirty.has(unit))) input.value = values[unit];
  }

  /** Reads all three fields (a field left invalid keeps the selected date's value). */
  function fromFields() {
    let y = +selected.slice(0, 4);
    let m = +selected.slice(5, 7) - 1;
    let d = +selected.slice(8, 10);
    const yv = inputs.year.value.trim();
    const mv = inputs.month.value.trim();
    const dv = inputs.day.value.trim();
    if (/^\d{4}$/.test(yv)) y = +yv;
    const byName = MONTHS.findIndex((name) => name.toLowerCase() === mv.slice(0, 3).toLowerCase());
    if (byName >= 0) m = byName;
    else if (/^\d{1,2}$/.test(mv) && +mv >= 1 && +mv <= 12) m = +mv - 1;
    if (/^\d{1,2}$/.test(dv) && +dv >= 1) d = +dv;
    dirty.clear();
    pick(toISO(Date.UTC(y, m, Math.min(d, daysInMonth(y, m)))));
  }

  root.addEventListener('click', (e) => {
    const t = e.target;
    const spinBtn = t.closest('[data-spin]');
    if (spinBtn) {
      const [unit, n] = spinBtn.dataset.spin.split(':');
      return spin(unit, Number(n));
    }
    const dayBtn = t.closest('[data-day]');
    if (dayBtn) return spin('day', Number(dayBtn.dataset.day));
    if (t.closest('[data-next]')) {
      const next = nextEvent();
      return next && pick(next);
    }
    const z = t.closest('[data-zoom-step]');
    if (z) {
      const i = ZOOMS.findIndex((q) => q.key === zoom) + Number(z.dataset.zoomStep);
      if (i < 0 || i >= ZOOMS.length) return;
      zoom = ZOOMS[i].key;
      return render(true);
    }
    if (t.closest('[data-fold]')) return setCollapsed(!collapsed);
    // Keyboard activation of a marker (pointer clicks are handled on pointerup).
    const mk = t.closest('.tl-marker');
    if (mk && e.detail === 0) pick(mk.dataset.date);
  });

  for (const [unit, input] of Object.entries(inputs)) {
    input.addEventListener('input', () => dirty.add(unit));
    input.addEventListener('change', fromFields);
    input.addEventListener('focus', () => input.select());
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        spin(unit, e.key === 'ArrowUp' ? 1 : -1);
        requestAnimationFrame(() => inputs[unit].select());
      }
      if (e.key === 'Enter') fromFields();
      if (e.key === 'Escape') {
        dirty.clear();
        setFields();
        input.blur();
      }
    });
  }

  // ---------- axis: drag the background to pan, drag the handle to scrub,
  // click to pick a day, wheel to scroll.
  let drag = null;
  axis.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = {
      x: e.clientX,
      scroll: axis.scrollLeft,
      moved: false,
      handle: !!e.target.closest('.tl-pick'),
      marker: e.target.closest('.tl-marker')?.dataset.date ?? null,
    };
    if (drag.handle) e.preventDefault();
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (Math.abs(dx) > 4) drag.moved = true;
    if (!drag.moved) return;
    if (drag.handle) {
      const iso = clamp(dayAt(e.clientX));
      track.querySelector('.tl-pick').style.left = `${xOf(iso)}px`;
      showHover(iso);
    } else {
      axis.scrollLeft = drag.scroll - dx;
    }
  });
  window.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.handle && d.moved) return pick(dayAt(e.clientX));
    if (d.moved) return;
    if (d.marker) return pick(d.marker);
    let iso = dayAt(e.clientX);
    // Snap to a day with data within a few pixels.
    const x = e.clientX - track.getBoundingClientRect().left;
    const near = items.find((it) => Math.abs(xOf(it.date) - x) <= Math.max(5, ppd / 2));
    if (near) iso = near.date;
    pick(iso);
  });

  function showHover(iso) {
    const hover = track.querySelector('.tl-hover');
    hover.style.left = `${xOf(iso)}px`;
    hover.querySelector('span').textContent = fmtDate(iso);
    hover.hidden = false;
  }
  axis.addEventListener('pointermove', (e) => {
    if (!drag?.moved) showHover(dayAt(e.clientX));
  });
  axis.addEventListener('pointerleave', () => {
    if (!drag) track.querySelector('.tl-hover').hidden = true;
  });
  axis.addEventListener(
    'wheel',
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      axis.scrollLeft += e.deltaY;
    },
    { passive: false },
  );
  axis.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      onStep(e.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  new ResizeObserver(() => zoom === 'year' && render(true)).observe(axis);

  // ---------- folding: only the date controls stay
  function setCollapsed(on, remember = true) {
    collapsed = on;
    if (remember) {
      try {
        if (on) localStorage.setItem(COLLAPSE_KEY, 'collapsed');
        else localStorage.removeItem(COLLAPSE_KEY);
      } catch {
        // Storage blocked: the choice lasts for this visit only.
      }
    }
    root.classList.toggle('is-collapsed', on);
    const label = on ? 'Show the timeline' : 'Fold the timeline';
    foldBtn.innerHTML = `${svg(on ? ARROW.unfold : ARROW.fold)}<span class="visually-hidden">${label}</span>`;
    foldBtn.title = label;
    foldBtn.setAttribute('aria-expanded', String(!on));
    if (!on) render(true); // the axis had no width while folded
  }
  setCollapsed(collapsed, false);

  // ---------- drawing
  function render(recentre = false) {
    if (collapsed) return;
    const z = ZOOMS.find((q) => q.key === zoom);
    ppd = z.ppd ?? Math.max(0.2, (axis.clientWidth - 4) / totalDays);
    const key = `${zoom}|${ppd.toFixed(3)}|${items.map((i) => `${i.date}${i.roles}${i.failed}${i.compare ? "B" : ""}`).join()}`;
    if (recentre || key !== trackKey) {
      trackKey = key;
      track.style.width = `${totalDays * ppd}px`;
      track.dataset.zoom = zoom;
      track.innerHTML = trackHtml();
    }
    const zi = ZOOMS.indexOf(z);
    root.querySelector('.tl-zoom-label').textContent = z.label;
    root.querySelector('[data-zoom-step="-1"]').disabled = zi === 0;
    root.querySelector('[data-zoom-step="1"]').disabled = zi === ZOOMS.length - 1;
    placeSelection(recentre);
  }

  /** The first date with data after the selected day, if any. */
  const nextEvent = () => items.find((it) => it.date > selected)?.date ?? null;

  /** Arrows that would leave the range, or a next-event jump with no later event, are disabled. */
  function updateButtons() {
    root.querySelector('[data-day="-1"]').disabled = selected <= start;
    root.querySelector('[data-day="1"]').disabled = selected >= max;
    const next = nextEvent();
    const btn = root.querySelector('[data-next]');
    btn.disabled = !next;
    btn.title = next ? `Next date with data: ${fmtDate(next)}` : 'No later date with data';
  }

  function trackHtml() {
    const width = totalDays * ppd;
    const parts = [];
    // Month ticks; labels along the bottom ("SEP 2026" when zoomed in).
    let y = +start.slice(0, 4);
    let m = +start.slice(5, 7) - 1;
    for (let iso = start; iso <= end; ) {
      const x = daysBetween(start, iso) * ppd;
      const monthW = daysInMonth(y, m) * ppd;
      const isYear = m === 0;
      let label = '';
      // Years view: the year sits at January, so February stays unlabeled when months are narrow.
      if (zoom === 'year') label = isYear ? `<b>${y}</b>` : monthW >= 30 ? MONTHS[m] : monthW >= 10 && m !== 1 ? MONTHS[m][0] : '';
      else label = `<b>${MONTHS[m]}</b> ${y}`;
      parts.push(`<span class="tl-mtick ${isYear ? 'is-year' : ''}" style="left:${x}px"><span class="mono">${label}</span></span>`);
      if (++m > 11) {
        m = 0;
        y++;
      }
      iso = toISO(Date.UTC(y, m, 1));
    }
    if (zoom === 'day') {
      for (let i = 0; i < totalDays; i++) {
        const day = +addDays(start, i).slice(8, 10);
        if (day !== 1) parts.push(`<span class="tl-dlabel mono" style="left:${i * ppd + ppd / 2}px">${day}</span>`);
      }
    }
    // After the latest pickable day (today): no data can exist yet.
    if (max < end) {
      const x = (daysBetween(start, max) + 1) * ppd;
      parts.push(`<span class="tl-future" style="left:${x}px;width:${width - x}px"></span>`);
    }
    // Coverage strip, then the role symbol of each day with data.
    const w = Math.max(2, ppd - (ppd > 8 ? 2 : 0));
    let lastX = -Infinity;
    for (const it of items) {
      const x = xOf(it.date);
      parts.push(`<span class="tl-cover" style="left:${x - w / 2}px;width:${w}px"></span>`);
      const lane = x - lastX < LANE_GAP ? 1 : 0;
      if (lane === 0) lastX = x;
      parts.push(`
        <button type="button" class="tl-marker" data-date="${esc(it.date)}" data-lane="${lane}" style="left:${x}px" tabindex="-1"
          title="${esc(`${fmtDate(it.date)}: ${it.label}${it.compare ? ' (compared as B)' : ''}`)}">${icon(roleInfo(it.roles[0]).icon)}${it.failed ? icon('warning', 'icon tl-warn') : ''}${it.compare ? '<span class="tl-b" aria-hidden="true">B</span>' : ''}<span class="visually-hidden">${esc(`${fmtDate(it.date)}, ${it.label}`)}</span></button>`);
    }
    parts.push(
      `<span class="tl-pick" title="Drag to change the date"><span class="tl-pick-handle">${svg('<path d="M6 6.5v4M8 6.5v4M10 6.5v4"/>')}</span></span>`,
      '<span class="tl-hover" hidden><span></span></span>',
    );
    return `<div class="tl-band" style="width:${width}px;${ppd >= 4 ? `background-size:${ppd}px 100%` : 'background-image:none'}"></div>${parts.join('')}`;
  }

  function placeSelection(recentre) {
    if (!selected) return;
    const x = xOf(selected);
    track.querySelector('.tl-pick').style.left = `${x}px`;
    for (const mk of track.querySelectorAll('.tl-marker')) {
      const cur = mk.dataset.date === selected;
      mk.classList.toggle('is-current', cur);
      if (cur) mk.setAttribute('aria-current', 'true');
      else mk.removeAttribute('aria-current');
    }
    const margin = Math.min(80, axis.clientWidth / 4);
    if (recentre || x < axis.scrollLeft + margin || x > axis.scrollLeft + axis.clientWidth - margin) {
      axis.scrollLeft = x - axis.clientWidth / 2;
    }
  }

  return {
    /** Shows the selected date and the dates that have data. */
    update(date, nextItems) {
      const first = selected == null;
      selected = date;
      items = nextItems;
      setFields(true);
      updateButtons();
      render(first);
    },
  };
}
