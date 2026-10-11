// Animated surface currents, in the style of Ventusky: short-lived particles
// drift with the net current and leave fading trails.
//
// A canvas sits over the map. When the view settles, the current is sampled
// every few screen pixels into a velocity grid, so each frame only looks up and
// moves particles. During a pan or zoom the canvas clears and waits. With
// "reduce motion" set, static arrows replace the animation.

import { meanAt } from './currents.js';

const CELL = 5; // screen px between velocity samples
// Calm and slow, as on Ventusky: 0.2 m/s ≈ 15 px a second at 60 frames a second.
const SPEED = 1.2; // screen px a frame per m/s
const FADE = 0.96; // trail kept per frame (longer trails for the slower motion)
const PX_PER_PARTICLE = 420; // one particle per this many px² of water
const MAX_PARTICLES = 3000;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * @param map  the MapLibre map
 * @returns {{ setField(field, isWater): void, setVisible(on: boolean): void, isRunning(): boolean }}
 */
export function createFlowLayer(map) {
  const canvas = document.createElement('canvas');
  canvas.className = 'flow-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  map.getCanvas().after(canvas); // under the site markers, over the data
  const ctx = canvas.getContext('2d');

  let field = null;
  let isWater = () => true;
  let visible = false;
  let moving = false;
  let frame = 0;
  let cols = 0;
  let rows = 0;
  let vx = new Float32Array(0);
  let vy = new Float32Array(0);
  let water = []; // grid cells with a current, for spawning
  let px = new Float32Array(0);
  let py = new Float32Array(0);
  let age = new Uint16Array(0);
  let life = new Uint16Array(0);
  let width = 0;
  let height = 0;

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const box = map.getCanvas().getBoundingClientRect();
    width = box.width;
    height = box.height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Velocity on a screen grid, from the net current where there is water. */
  function sampleGrid() {
    cols = Math.ceil(width / CELL);
    rows = Math.ceil(height / CELL);
    vx = new Float32Array(cols * rows).fill(NaN);
    vy = new Float32Array(cols * rows).fill(NaN);
    water = [];
    if (!field) return;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const { lng, lat } = map.unproject([(c + 0.5) * CELL, (r + 0.5) * CELL]);
        if (!isWater(lng, lat)) continue;
        const uv = meanAt(field, lng, lat);
        if (!uv) continue;
        const i = r * cols + c;
        // Web Mercator keeps angles, so east and north map straight to screen x and -y.
        vx[i] = uv[0] * SPEED;
        vy[i] = -uv[1] * SPEED;
        water.push(i);
      }
    }
  }

  function spawn(k) {
    const i = water[(Math.random() * water.length) | 0];
    px[k] = ((i % cols) + Math.random()) * CELL;
    py[k] = (Math.floor(i / cols) + Math.random()) * CELL;
    age[k] = 0;
    life[k] = 90 + ((Math.random() * 130) | 0);
  }

  function seed() {
    const n = Math.min(MAX_PARTICLES, Math.round((water.length * CELL * CELL) / PX_PER_PARTICLE));
    px = new Float32Array(n);
    py = new Float32Array(n);
    age = new Uint16Array(n);
    life = new Uint16Array(n);
    for (let k = 0; k < n; k++) {
      spawn(k);
      age[k] = (Math.random() * life[k]) | 0; // start at staggered ages
    }
  }

  const clear = () => ctx.clearRect(0, 0, width, height);

  function step() {
    frame = 0;
    if (!visible || moving || !water.length) return;
    // Fade what is there, then draw this frame's segments on top.
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = `rgba(0, 0, 0, ${FADE})`;
    ctx.fillRect(0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';
    ctx.beginPath();
    for (let k = 0; k < px.length; k++) {
      if (age[k] >= life[k]) {
        spawn(k);
        continue;
      }
      const c = Math.floor(px[k] / CELL);
      const r = Math.floor(py[k] / CELL);
      const i = r * cols + c;
      const dx = c >= 0 && c < cols && r >= 0 && r < rows ? vx[i] : NaN;
      if (Number.isNaN(dx)) {
        spawn(k);
        continue;
      }
      const nx = px[k] + dx;
      const ny = py[k] + vy[i];
      ctx.moveTo(px[k], py[k]);
      ctx.lineTo(nx, ny);
      px[k] = nx;
      py[k] = ny;
      age[k]++;
    }
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    ctx.stroke();
    frame = requestAnimationFrame(step);
  }

  /** Reduced motion: one still frame of arrows along the current. */
  function drawArrows() {
    clear();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    const gap = Math.round(36 / CELL);
    for (let r = Math.floor(gap / 2); r < rows; r += gap) {
      for (let c = Math.floor(gap / 2); c < cols; c += gap) {
        const i = r * cols + c;
        if (Number.isNaN(vx[i])) continue;
        const sp = Math.hypot(vx[i], vy[i]);
        if (sp < 0.05) continue;
        const len = Math.min(16, 4 + sp * 5);
        const ux = vx[i] / sp;
        const uy = vy[i] / sp;
        const x0 = (c + 0.5) * CELL - (ux * len) / 2;
        const y0 = (r + 0.5) * CELL - (uy * len) / 2;
        const x1 = x0 + ux * len;
        const y1 = y0 + uy * len;
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - ux * 4 - uy * 3, y1 - uy * 4 + ux * 3);
        ctx.moveTo(x1, y1);
        ctx.lineTo(x1 - ux * 4 + uy * 3, y1 - uy * 4 - ux * 3);
      }
    }
    ctx.stroke();
  }

  function restart() {
    cancelAnimationFrame(frame);
    frame = 0;
    clear();
    canvas.hidden = !visible || !field;
    if (canvas.hidden) return;
    resize();
    sampleGrid();
    if (reducedMotion.matches) {
      drawArrows();
      return;
    }
    seed();
    frame = requestAnimationFrame(step);
  }

  map.on('movestart', () => {
    moving = true;
    cancelAnimationFrame(frame);
    frame = 0;
    clear();
  });
  map.on('moveend', () => {
    moving = false;
    if (visible) restart();
  });
  map.on('resize', () => visible && restart());
  reducedMotion.addEventListener?.('change', () => visible && restart());

  return {
    setField(f, waterTest) {
      field = f;
      isWater = waterTest ?? (() => true);
      restart();
    },
    setVisible(on) {
      if (on === visible) return;
      visible = on;
      restart();
    },
    isRunning: () => frame !== 0,
  };
}
