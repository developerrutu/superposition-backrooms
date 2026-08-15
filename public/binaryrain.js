/**
 * Binary rain — a Matrix-style effect rendered as actual DOM elements,
 * floating over the canvas the same way the spec described.
 *
 * We deliberately use DOM (not the WebGL canvas) because:
 *   1. There are 80+ columns worth of glyphs, which are cheaper as text
 *   2. Animating them with CSS animations lets the GPU handle them
 *   3. They sit above the canvas like a real loading screen overlay,
 *      not a faked-in-engine effect.
 */
export function buildBinaryRain(host, opts = {}) {
  const cols     = opts.cols     ?? 60;
  const minDur   = opts.minDur   ?? 8;   // seconds
  const maxDur   = opts.maxDur   ?? 16;
  const densities = opts.densities ?? [0, 1];

  host.innerHTML = '';
  const colWidth = 100 / cols;
  for (let i = 0; i < cols; i++) {
    const col = document.createElement('div');
    col.className = 'rain-col';
    const dur = minDur + Math.random() * (maxDur - minDur);
    const delay = -Math.random() * maxDur;
    col.style.left = (i * colWidth + (Math.random() * 0.6 - 0.3) * colWidth) + '%';
    col.style.animationDuration = dur + 's';
    col.style.animationDelay    = delay + 's';
    col.style.fontSize = (10 + Math.random() * 8) + 'px';
    col.style.opacity = 0.3 + Math.random() * 0.7;
    col.style.color = Math.random() < 0.04 ? '#ff003c' : ''; // occasional red glitch
    populateCol(col);
    host.appendChild(col);
  }
}

function populateCol(col) {
  // Each column is a long string of binary digits. We re-roll a slice on a
  // timer to give the impression of data flowing.
  const length = 28 + Math.random() * 22;
  let str = '';
  for (let j = 0; j < length; j++) str += Math.random() < 0.5 ? '0' : '1';
  col.textContent = str;
  // Periodically scramble a section so the rain doesn't appear frozen.
  setInterval(() => {
    if (!col.isConnected) return;
    const children = col.textContent;
    if (!children) return;
    let s = '';
    for (let k = 0; k < children.length; k++) {
      if (Math.random() < 0.06) s += (Math.random() < 0.5 ? '0' : '1');
      else                     s += children[k];
    }
    col.textContent = s;
  }, 120 + Math.random() * 220);
}
