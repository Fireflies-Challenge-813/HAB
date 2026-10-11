// A small window near the pointer with an element's explanation (data-tip), shown
// while the pointer is over the element, on keyboard focus, or on a tap on a touch
// screen. The element holds the same text for screen readers (visually hidden), so
// the window itself is hidden from them.

let tipEl = null;
let current = null;

function box() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'hover-tip';
    tipEl.setAttribute('aria-hidden', 'true');
    tipEl.hidden = true;
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

/** Just right of the pointer's arrow, level with its tip; flipped where it would leave the window. */
function place(x, y) {
  const t = box();
  const pad = 8;
  let left = x + 16;
  let top = y + 2;
  if (left + t.offsetWidth > innerWidth - pad) left = Math.max(pad, x - t.offsetWidth - 8);
  if (top + t.offsetHeight > innerHeight - pad) top = Math.max(pad, y - t.offsetHeight - 6);
  t.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
}

function show(target, x, y) {
  current = target;
  const t = box();
  t.textContent = target.dataset.tip;
  t.hidden = false;
  place(x, y);
}

function hide() {
  current = null;
  if (tipEl) tipEl.hidden = true;
}

/** Shows the tips of every [data-tip] element under root. */
export function bindTips(root = document) {
  root.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return;
    const target = e.target.closest?.('[data-tip]') ?? null;
    if (target === current) return;
    if (target) show(target, e.clientX, e.clientY);
    else hide();
  });
  root.addEventListener('pointermove', (e) => {
    if (current && e.pointerType !== 'touch') place(e.clientX, e.clientY);
  });
  root.addEventListener('pointerout', (e) => {
    if (current && e.pointerType !== 'touch' && !e.relatedTarget) hide(); // left the window
  });
  // On a touch screen a tap shows the tip; the next tap anywhere hides it.
  root.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    const target = e.target.closest?.('[data-tip]') ?? null;
    if (target && target !== current) show(target, e.clientX, e.clientY);
    else hide();
  });
  root.addEventListener('focusin', (e) => {
    const target = e.target.closest?.('[data-tip]');
    if (!target) return;
    const r = target.getBoundingClientRect();
    show(target, r.left + 8, r.bottom - 10);
  });
  root.addEventListener('focusout', (e) => {
    if (current && !current.contains(e.relatedTarget)) hide();
  });
  window.addEventListener('scroll', hide, { capture: true, passive: true });
}
