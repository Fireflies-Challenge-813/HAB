// Foldable sections for the details panel, and the rail that stands in for a
// panel's scrollbar: a segment per item (a details section, a watched site, a
// legend group), a frame over the part in view, and the item names while the
// pointer is on the rail. Clicking a name, or a segment, scrolls there.

import { esc } from './format.js';

const STORE_KEY = 'gbw-sections'; // folded sections (this browser only)
const LABEL_H = 20; // rail label height, px
const LABEL_GAP = 3;
const CHEVRON = '<svg class="sec-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg>';
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let uid = 0;

/** The section keys the viewer folded last time. */
export function loadFolded() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
    return new Set(Array.isArray(saved) ? saved : []);
  } catch {
    return new Set();
  }
}

function saveFolded(folded) {
  try {
    if (folded.size) localStorage.setItem(STORE_KEY, JSON.stringify([...folded]));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // Storage blocked: folding lasts for this visit only.
  }
}

const toggleWord = (folded) => (folded ? 'Show' : 'Hide');

/**
 * HTML for one foldable section. Its header is a bar that folds and unfolds it,
 * ending in an arrow button (up: hide, down: show).
 * @param {object} o
 * @param {string} o.key     what the fold is remembered by: pixel, spectrum, site, scene or census
 * @param {string} o.name    plain-text name, also shown on the rail
 * @param {string} o.label   the header (HTML)
 * @param {string} o.body    the content (HTML)
 * @param {string} [o.peek]  the one-line summary shown while folded (HTML)
 * @param {string} [o.actions] badges beside the header (HTML); they stay visible while folded
 * @param {string} [o.close] a close button, after the arrow button (HTML)
 * @param {string} [o.accent] a CSS color for the folded card and the rail segment
 * @param {boolean} [o.folded]
 */
export function sectionHtml({ key, name, label, body, peek = '', actions = '', close = '', accent = '', folded = false, className = '', style = '', attrs = '' }) {
  const id = `sec-${key}-${++uid}`;
  const css = `${accent ? `--accent:${accent};` : ''}${style}`;
  const what = esc(name.toLowerCase());
  return `
    <section class="insp-sec ${className} ${folded ? 'is-folded' : ''}" data-sec="${esc(key)}" data-rail-name="${esc(name)}" ${accent ? `data-rail-accent="${esc(accent)}"` : ''} ${css ? `style="${css}"` : ''} ${attrs}>
      <div class="sec-head">
        <span class="sec-label">${label}</span>
        ${actions}
        <button type="button" class="sec-toggle" aria-expanded="${!folded}" aria-controls="${id}" aria-label="${toggleWord(folded)} ${what}" title="${toggleWord(folded)} ${what}">
          ${CHEVRON}
        </button>
        ${close}
      </div>
      ${peek ? `<div class="sec-peek" aria-hidden="${!folded}"><div class="sec-peek-inner">${peek}</div></div>` : ''}
      <div class="sec-body" id="${id}"><div class="sec-body-inner">${body}</div></div>
    </section>`;
}

/** Folds or unfolds a rendered section and remembers it. */
export function setFolded(section, on, folded) {
  section.classList.toggle('is-folded', on);
  const toggle = section.querySelector('.sec-toggle');
  const what = section.dataset.railName.toLowerCase();
  toggle.setAttribute('aria-expanded', String(!on));
  toggle.setAttribute('aria-label', `${toggleWord(on)} ${what}`);
  toggle.title = `${toggleWord(on)} ${what}`;
  section.querySelector('.sec-peek')?.setAttribute('aria-hidden', String(!on));
  if (on) folded.add(section.dataset.sec);
  else folded.delete(section.dataset.sec);
  saveFolded(folded);
}

/**
 * The rail beside a scrolling panel. Items are the elements in `content` with
 * data-rail-name (the label) and, optionally, data-rail-accent (a CSS color).
 * @param {HTMLElement} scroller  the element that scrolls
 * @param {HTMLElement} rail      an empty element beside the scroller
 * @param {{ content?: HTMLElement, spy?: boolean, names?: 'all' | 'one', onOpen?: (item: HTMLElement) => void }} [options]
 *   content: the element holding the items (default: the scroller);
 *   spy: mark the item that fills most of the view as current;
 *   names: on hover, show every item's name, or only the one under the pointer (for long lists);
 *   onOpen: called when a folded item is picked on the rail.
 */
export function createRail(scroller, rail, { content = scroller, spy = true, names = 'all', onOpen = null } = {}) {
  rail.classList.toggle('names-one', names === 'one');
  rail.innerHTML = `
    <div class="rail-track" aria-hidden="true"></div>
    <div class="rail-thumb" aria-hidden="true"></div>
    <nav class="rail-labels" aria-label="Go to"></nav>`;
  const track = rail.querySelector('.rail-track');
  const thumb = rail.querySelector('.rail-thumb');
  const nav = rail.querySelector('.rail-labels');
  let items = [];
  let tops = [];
  let active = -1;
  let frame = 0;

  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(layout);
  };

  function rebuild() {
    track.innerHTML = items.map((it, i) => `<span class="rail-seg" data-i="${i}"></span>`).join('');
    nav.innerHTML = items
      .map((it, i) => `<button type="button" class="rail-label" data-i="${i}" style="--i:${i}">${esc(it.dataset.railName)}</button>`)
      .join('');
    active = -1;
  }

  function layout() {
    frame = 0;
    const now = [...content.querySelectorAll('[data-rail-name]')];
    if (now.length !== items.length || now.some((it, i) => it !== items[i] || nav.children[i].textContent !== it.dataset.railName)) {
      items = now;
      rebuild();
    }
    const sh = scroller.scrollHeight;
    const ch = scroller.clientHeight;
    const on = items.length > 0 && sh > ch + 2;
    rail.classList.toggle('is-on', on);
    if (!on) return;

    // Item positions in the scroller's content, from the top of what scrolls.
    const origin = scroller.getBoundingClientRect().top + scroller.clientTop - scroller.scrollTop;
    const H = track.clientHeight;
    const k = H / sh;
    const centres = [];
    tops = items.map((it, i) => {
      const r = it.getBoundingClientRect();
      const top = (r.top - origin) * k;
      const h = Math.max(3, r.height * k - 2);
      const seg = track.children[i];
      seg.style.transform = `translateY(${top.toFixed(1)}px)`;
      seg.style.height = `${h.toFixed(1)}px`;
      const accent = it.dataset.railAccent || 'var(--ink-3)';
      seg.style.setProperty('--seg', accent);
      nav.children[i].style.setProperty('--seg', accent);
      seg.classList.toggle('is-folded', it.classList.contains('is-folded'));
      centres.push(top + h / 2);
      return { top: r.top - origin, height: r.height };
    });
    thumb.style.transform = `translateY(${(scroller.scrollTop * k).toFixed(1)}px)`;
    thumb.style.height = `${Math.max(14, ch * k).toFixed(1)}px`;

    // Labels sit beside their segments; shown all at once, they're pushed apart so they never overlap.
    const ys = centres.map((c) => Math.min(H - LABEL_H, c - LABEL_H / 2));
    if (names === 'all') {
      for (let i = 1; i < ys.length; i++) ys[i] = Math.max(ys[i], ys[i - 1] + LABEL_H + LABEL_GAP);
      ys[ys.length - 1] = Math.min(ys.at(-1), H - LABEL_H);
      for (let i = ys.length - 2; i >= 0; i--) ys[i] = Math.min(ys[i], ys[i + 1] - LABEL_H - LABEL_GAP);
    }
    ys.forEach((y, i) => (nav.children[i].style.transform = `translateY(${Math.max(0, y).toFixed(1)}px)`));

    if (!spy) return;
    // You are in the item that fills most of the view.
    const top = scroller.scrollTop;
    let best = 0;
    let bestPx = -1;
    tops.forEach((t, i) => {
      const px = Math.min(top + ch, t.top + t.height) - Math.max(top, t.top);
      if (px > bestPx + 1) {
        best = i;
        bestPx = px;
      }
    });
    if (best !== active) {
      active = best;
      for (const el of [...track.children, ...nav.children]) el.classList.toggle('is-active', Number(el.dataset.i) === active);
      for (const b of nav.children) {
        if (Number(b.dataset.i) === active) b.setAttribute('aria-current', 'true');
        else b.removeAttribute('aria-current');
      }
    }
  }

  function jump(i) {
    const it = items[i];
    if (!it) return;
    if (onOpen && it.classList.contains('is-folded')) onOpen(it);
    const top = tops[i]?.top ?? 0;
    scroller.scrollTo({ top: Math.max(0, top - 4), behavior: reducedMotion.matches ? 'auto' : 'smooth' });
  }

  nav.addEventListener('click', (e) => {
    const b = e.target.closest('.rail-label');
    if (b) jump(Number(b.dataset.i));
  });
  nav.addEventListener('pointerover', (e) => {
    const b = e.target.closest('.rail-label');
    for (const seg of track.children) seg.classList.toggle('is-hover', !!b && seg.dataset.i === b.dataset.i);
  });
  nav.addEventListener('pointerleave', () => {
    for (const seg of track.children) seg.classList.remove('is-hover');
  });
  /** The item drawn at a pointer's height on the track. */
  function itemAt(clientY) {
    const y = (clientY - track.getBoundingClientRect().top) * (scroller.scrollHeight / track.clientHeight);
    let i = 0;
    tops.forEach((t, j) => {
      if (t.top <= y) i = j;
    });
    return i;
  }

  // A click on the track goes to the item drawn there.
  track.addEventListener('click', (e) => jump(itemAt(e.clientY)));
  // For long lists only the name under the pointer shows.
  if (names === 'one') {
    rail.addEventListener('pointermove', (e) => {
      if (e.target.closest('.rail-labels') || !items.length) return;
      const i = itemAt(e.clientY);
      for (const el of [...track.children, ...nav.children]) {
        const on = Number(el.dataset.i) === i;
        el.classList.toggle(el.classList.contains('rail-seg') ? 'is-hover' : 'is-peek', on);
      }
    });
    rail.addEventListener('pointerleave', () => {
      for (const el of [...track.children, ...nav.children]) el.classList.remove('is-hover', 'is-peek');
    });
  }
  // Dragging the frame scrolls the panel.
  thumb.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    thumb.setPointerCapture(e.pointerId);
    const y0 = e.clientY;
    const s0 = scroller.scrollTop;
    const k = scroller.scrollHeight / track.clientHeight;
    rail.classList.add('is-dragging');
    const move = (ev) => (scroller.scrollTop = s0 + (ev.clientY - y0) * k);
    const end = () => {
      thumb.removeEventListener('pointermove', move);
      thumb.removeEventListener('pointerup', end);
      thumb.removeEventListener('pointercancel', end);
      rail.classList.remove('is-dragging');
    };
    thumb.addEventListener('pointermove', move);
    thumb.addEventListener('pointerup', end);
    thumb.addEventListener('pointercancel', end);
  });
  rail.addEventListener('wheel', (e) => scroller.scrollBy({ top: e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY }), { passive: true });
  scroller.addEventListener('scroll', schedule, { passive: true });
  // Content grows and shrinks (sections fold, lists change), so the rail follows it frame by frame.
  const observer = new ResizeObserver(schedule);
  observer.observe(scroller);
  if (content !== scroller) observer.observe(content);

  return { refresh: schedule };
}
