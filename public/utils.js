/**
 * utility helpers shared by the game.
 */
export const TAU = Math.PI * 2;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const lerp  = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => t * t * (3 - 2 * t);

/** wrap an angle to (-PI, PI] */
export function wrapAngle(a) {
  let r = a % TAU;
  if (r > Math.PI)  r -= TAU;
  if (r <= -Math.PI) r += TAU;
  return r;
}

/** deterministic mulberry32 — used to keep a per-level seed so a respawn
 *  drops the player into *the same* room layout, not a new one. */
export function mulberry32(seed) {
  let t = (seed >>> 0) || 1;
  return function () {
    t = (t + 0x6D2B79F5) >>> 0;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** detect mobile (incl. iPadOS desktop mode) — used to gate the touch UI */
export function isTouchDevice() {
  return (
    'ontouchstart' in window ||
    navigator.maxTouchPoints > 0 ||
    (window.matchMedia && window.matchMedia('(pointer: coarse)').matches)
  );
}

/** request animation frame with delta-time handling. */
export function makeRAFLoop(step) {
  let raf = 0;
  let last = performance.now();
  function tick(now) {
    const dt = Math.min(0.05, (now - last) / 1000); // cap at 50ms (slow tab)
    last = now;
    step(dt, now);
    raf = requestAnimationFrame(tick);
  }
  function start() {
    cancelAnimationFrame(raf);
    last = performance.now();
    raf = requestAnimationFrame(tick);
  }
  function stop() { cancelAnimationFrame(raf); }
  return { start, stop };
}
