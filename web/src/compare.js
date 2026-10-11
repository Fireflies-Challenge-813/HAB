// Swipe compare: a second, passive map (B) over the main one (A), shown only right of
// a vertical divider. The main map keeps every input (drag, zoom, clicks, measuring);
// B follows its camera (map.js mirror) and draws its own date and reading.
//
// B sits inside the main map, after its canvas and the currents layer and before the
// DOM markers, so the site markers and city names stay on top on both sides.

const KEY_STEP = 0.02; // arrow keys move the divider by 2% of the map's width

/**
 * @param {{ mainView: object, host: HTMLElement, createView: (el: HTMLElement) => Promise<object>,
 *           bounds: () => [number, number], onSplit?: (px: number) => void }} options
 *   host: the main map's container; createView: makes the passive map in a container;
 *   bounds: the open part of the map (left and right edge, in px) for the starting
 *   position and for Home and End
 */
export function createCompare({ mainView, host, createView, bounds, onSplit }) {
  let view = null;
  let opening = null;
  let unmirror = null;
  let split = null; // the divider's place, as a share of the map's width
  let wrap = null;
  let divider = null;

  const width = () => host.clientWidth || 1;
  new ResizeObserver(() => place()).observe(host); // the divider keeps its share of the width
  const px = () => Math.round((split ?? 0.5) * width());

  function place() {
    if (!wrap) return;
    const x = px();
    wrap.style.clipPath = `inset(0 0 0 ${x}px)`;
    divider.style.setProperty('--x', `${x}px`);
    const handle = divider.querySelector('.compare-handle');
    handle.setAttribute('aria-valuenow', String(Math.round((split ?? 0.5) * 100)));
    onSplit?.(x);
  }

  function setSplit(next) {
    split = Math.min(1, Math.max(0, next));
    place();
  }

  function build() {
    wrap = document.createElement('div');
    wrap.className = 'compare-map';
    wrap.setAttribute('aria-hidden', 'true');
    const inner = document.createElement('div');
    inner.className = 'compare-map-inner';
    wrap.append(inner);
    const canvases = host.querySelector('.maplibregl-canvas-container');
    const after = canvases.querySelector('.flow-canvas') ?? canvases.querySelector('.maplibregl-canvas');
    after.after(wrap);

    divider = document.createElement('div');
    divider.className = 'compare-divider';
    divider.innerHTML = `
      <span class="compare-line" aria-hidden="true"></span>
      <span class="compare-handle" role="separator" tabindex="0" aria-orientation="vertical"
        aria-valuemin="0" aria-valuemax="100" aria-label="Compare divider: date A on the left, date B on the right">
        <span class="compare-tag">A</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 4.5 2.5 8 6 11.5M10 4.5 13.5 8 10 11.5"/></svg>
        <span class="compare-tag">B</span>
      </span>`;
    host.append(divider);

    // Drag the line or the handle with a mouse, a pen or a finger.
    const grab = divider.querySelectorAll('.compare-line, .compare-handle');
    for (const el of grab) {
      el.addEventListener('pointerdown', (e) => {
        if (e.button > 0) return;
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        divider.classList.add('is-dragging');
        const left = host.getBoundingClientRect().left;
        const move = (ev) => setSplit((ev.clientX - left) / width());
        const up = () => {
          divider.classList.remove('is-dragging');
          el.removeEventListener('pointermove', move);
          el.removeEventListener('pointerup', up);
          el.removeEventListener('pointercancel', up);
        };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
        el.addEventListener('pointercancel', up);
      });
    }
    divider.querySelector('.compare-handle').addEventListener('keydown', (e) => {
      const [lo, hi] = bounds();
      const moves = {
        ArrowLeft: () => split - KEY_STEP,
        ArrowRight: () => split + KEY_STEP,
        Home: () => lo / width(),
        End: () => hi / width(),
      };
      if (!moves[e.key]) return;
      e.preventDefault();
      setSplit(moves[e.key]());
    });
    return inner;
  }

  return {
    /** Shows the divider and the B map (made once, on first use). Resolves to B's view. */
    async open() {
      if (view) return view;
      if (opening) return opening;
      opening = (async () => {
        const inner = build();
        if (split == null) {
          const [lo, hi] = bounds();
          split = (lo + hi) / 2 / width();
        }
        place();
        view = await createView(inner);
        unmirror = mainView.mirror(view);
        return view;
      })();
      try {
        return await opening;
      } finally {
        opening = null;
      }
    },

    /** Removes the B map (freeing its WebGL context) and the divider. */
    close() {
      unmirror?.();
      unmirror = null;
      view?.remove();
      view = null;
      wrap?.remove();
      divider?.remove();
      wrap = null;
      divider = null;
    },

    view: () => view,
    isOpen: () => !!wrap,
    /** The divider's x in the map, in px. */
    splitPx: px,
    setSplit,
    /** 'a' or 'b': the side of the divider an x (in map px) falls on. */
    sideAt: (x) => (x < px() ? 'a' : 'b'),
  };
}
