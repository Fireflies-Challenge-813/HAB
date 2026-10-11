// Expandable text: a line that stays in view, and the rest behind an arrow button
// on its right. Used for explanations that read the same every time (what a flag
// means, how the margin is worked out) and for the class precedence checklist, so the
// details stay short until asked. Only the arrow opens one, never a click on the text.
// Which ones the viewer opened is remembered in this browser.

import { esc } from './format.js';

const STORE_KEY = 'gbw-more'; // opened explanations (this browser only)
const CHEVRON = '<svg class="more-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>';
const WORDS = { more: ['More', 'Less'], show: ['Show', 'Hide'] }; // for labels; the buttons show only an arrow

let uid = 0;
const opened = load();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]');
    return new Set(Array.isArray(saved) ? saved : []);
  } catch {
    return new Set();
  }
}

function save() {
  try {
    if (opened.size) localStorage.setItem(STORE_KEY, JSON.stringify([...opened]));
    else localStorage.removeItem(STORE_KEY);
  } catch {
    // Storage blocked: what's open lasts for this visit only.
  }
}

const word = (words, open) => WORDS[words][open ? 1 : 0];

// A bar with its own text (a fold list) is named by that text; a bare arrow by its label.
function toggleHtml({ open, id, what, words, className = '', inner = '' }) {
  const label = inner ? '' : `aria-label="${word(words, open)} ${esc(what)}" title="${word(words, open)} ${esc(what)}"`;
  return `<button type="button" class="more-toggle ${className}" aria-expanded="${open}" aria-controls="${id}" ${label} data-words="${words}" data-what="${esc(what)}">${inner}<span class="more-pill">${CHEVRON}</span></button>`;
}

/**
 * A line in view with a More / Less button on its right; the body unfolds below.
 * @param {object} o
 * @param {string} o.key    what the open state is remembered by
 * @param {string} o.head   the line that stays in view (HTML)
 * @param {string} o.body   what unfolds (HTML)
 * @param {string} [o.lead] content that stays in view under the head line (HTML)
 * @param {string} [o.icon] an icon before the head line (HTML)
 * @param {string} [o.what] what the button's label names, e.g. "about the seabed"
 * @param {string} [o.className]
 * @param {string} [o.attrs] extra attributes on the box
 */
export function moreHtml({ key, head, body, lead = '', icon = '', what = 'explanation', className = '', attrs = '' }) {
  if (!body) return `<div class="more ${className}" ${attrs}><div class="more-head">${icon}<div class="more-text">${head}</div></div>${lead}</div>`;
  const open = opened.has(key);
  const id = `more-${key}-${++uid}`;
  return `
    <div class="more ${className} ${open ? 'is-open' : ''}" data-more="${esc(key)}" ${attrs}>
      <div class="more-head">${icon}<div class="more-text">${head}</div>${toggleHtml({ open, id, what, words: 'more' })}</div>
      ${lead}
      <div class="more-body" id="${id}"><div class="more-body-inner">${body}</div></div>
    </div>`;
}

/**
 * A list whose whole header bar opens and closes it, with a short summary in the bar.
 * @param {{ key: string, title: string, summary: string, body: string, what: string, className?: string }} o
 */
export function foldListHtml({ key, title, summary, body, what, className = '' }) {
  const open = opened.has(key);
  const id = `more-${key}-${++uid}`;
  const inner = `<span class="fold-title">${title}</span> <span class="fold-summary">${summary}</span> `;
  return `
    <div class="more fold-list ${className} ${open ? 'is-open' : ''}" data-more="${esc(key)}">
      ${toggleHtml({ open, id, what, words: 'show', className: 'fold-head', inner })}
      <div class="more-body" id="${id}"><div class="more-body-inner">${body}</div></div>
    </div>`;
}

/** Opens or closes one rendered box and remembers it. */
export function setOpen(box, on) {
  box.classList.toggle('is-open', on);
  const btn = box.firstElementChild.matches('.more-toggle') ? box.firstElementChild : box.firstElementChild.querySelector(':scope > .more-toggle');
  if (btn) {
    const w = word(btn.dataset.words, on);
    btn.setAttribute('aria-expanded', String(on));
    if (btn.hasAttribute('aria-label')) {
      btn.setAttribute('aria-label', `${w} ${btn.dataset.what}`);
      btn.title = `${w} ${btn.dataset.what}`;
    }
  }
  if (on) opened.add(box.dataset.more);
  else opened.delete(box.dataset.more);
  save();
}

/** Opens and closes the boxes under root, from their buttons only. */
export function bindMore(root) {
  root.addEventListener('click', (e) => {
    const btn = e.target.closest('.more-toggle');
    if (!btn || !root.contains(btn)) return;
    const box = btn.closest('.more');
    setOpen(box, !box.classList.contains('is-open'));
  });
}
