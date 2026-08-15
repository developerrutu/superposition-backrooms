/**
 * SUPERPOSITION BACKROOMS — main game module.
 *
 * Architecture overview:
 *
 *   +----------------+   per frame:
 *   |  Player state  |  ----\
 *   +----------------+       \
 *   +--------------+         +-- World.advanceTo(player.pos)
 *   |  World       |  -----> |   World.applyObserverEffect(player.pos, yaw)
 *   | .tiles[]     |  <----- |   World.update(dt)
 *   +--------------+         |
 *   +--------------+         +-- Monster.update(dt, player, level)
 *   |  Monster Mgr |  -----> |   Monster.spawn() when prob crosses threshold
 *   +--------------+         |
 *   +--------------+         +-- Audio.updateMonster(dx, dist)
 *   |  Audio Engine|  <----- |   Audio.playFootstep() etc.
 *   +--------------+         |
 *   +--------------+         +-- HUD.setRadar(...)
 *   |  HUD overlay |  <----- |   HUD.setSanity, HUD.setStability
 *   +--------------+        /
 *   +----------------+  ---/
 *   |   GameLoop     |
 *   +----------------+
 */

import * as THREE from 'three';
import { AudioEngine } from './audio.js';
import { World } from './world.js';
import { MonsterManager } from './monster.js';
import { LEVELS } from './levels.js';
import { buildBinaryRain } from './binaryrain.js';
import { isTouchDevice, clamp, lerp, makeRAFLoop, wrapAngle } from './utils.js';

// ============================================================ DOM refs

const dom = {
  canvas:    document.getElementById('game-canvas'),
  loader:    document.getElementById('loader'),
  binary:    document.getElementById('binary-rain'),
  initBtn:   document.getElementById('init-btn'),
  hud:       document.getElementById('hud'),
  bootLines: Array.from(document.querySelectorAll('.boot-line')),
  levelR:    document.getElementById('level-readout'),
  stabBar:   document.getElementById('stability-bar'),
  sanityBar: document.getElementById('sanity-bar'),
  seenR:     document.getElementById('seen-readout'),
  statusT:   document.getElementById('status-text'),
  subtitle:  document.getElementById('subtitle-text'),
  modal:     document.getElementById('modal'),
  modalT:    document.getElementById('modal-title'),
  modalB:    document.getElementById('modal-body'),
  modalBtn:  document.getElementById('modal-btn'),
  mobile:    document.getElementById('mobile-controls'),
  moveStick: document.getElementById('joystick-move'),
  lookStick: document.getElementById('joystick-look'),
  moveBg:    document.querySelector('#joystick-move .joystick-bg'),
  moveKnob:  document.querySelector('#joystick-move .joystick-knob'),
  lookBg:    document.querySelector('#joystick-look .joystick-bg'),
  lookKnob:  document.querySelector('#joystick-look .joystick-knob'),
  radar:     document.getElementById('radar'),
  radarWalls:    document.getElementById('radar-walls'),
  radarMonsters: document.getElementById('rader-monsters'),
  radarExit:     document.getElementById('radar-exit'),
  radarWorld:    document.getElementById('radar-world'),
  radarFwd:      document.getElementById('radar-fwd'),
  glitch:    document.getElementById('glitch-overlay'),
  fade:      document.getElementById('fade-overlay'),
  vignette:  document.getElementById('vignette'),
};

/* Surface fatal boot errors directly into the loader screen so the user
 * sees *something* even when a module fails to load on their network.   */
window.addEventListener('error', e => {
  if (!e || !e.message) return;
  showBootError(e.message, e.filename);
});
window.addEventListener('unhandledrejection', e => {
  if (!e || !e.reason) return;
  showBootError(String(e.reason && e.reason.message || e.reason), '');
});

function showBootError(message, where) {
  // Don't double-display.
  if (document.getElementById('boot-error')) return;
  const box = document.createElement('div');
  box.id = 'boot-error';
  box.style.cssText = `
    position: fixed; inset: 8vh 6vw; z-index: 60;
    background: rgba(255,0,60,0.12);
    border: 1px solid #ff003c;
    color: #ffb3c0; font-size: 12px; padding: 16px;
    text-align: left; line-height: 1.5;
    border-radius: 4px; box-shadow: 0 0 20px rgba(255,0,60,0.3);
  `;
  box.innerHTML = `
    <div style="color:#ff003c; font-weight:bold; letter-spacing:0.2em; font-size:13px;">
      SIMULATION FAILED TO LOAD
    </div>
    <pre style="white-space:pre-wrap; margin-top:8px;">${escapeHtml(message)}</pre>
    ${where ? `<div style="opacity:0.6; margin-top:6px; font-size:10px;">at ${escapeHtml(where)}</div>` : ''}
    <div style="opacity:0.65; margin-top:10px; font-size:11px;">
      Tap your browser's refresh button. If this persists, your browser may be
      blocking module imports — try a different network or browser.
    </div>
  `;
  document.body.appendChild(box);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

// ============================================================ Globals

const RENDERER_OPTIONS = { antialias: true, powerPreference: 'high-performance' };
let renderer, scene, camera;
let world, audio;
let monsters;          // MonsterManager — initialised after scene is created
let player;            // { position, yaw, pitch, velocity, sanity, … }
let gameState;         // 'menu' | 'play' | 'paused' | 'win' | 'dead'

const KEY_STATE = Object.create(null);
const MOVEMENT_STATE = {
  // -1..1 input magnitudes
  moveX: 0, moveY: 0,  // (moveY = forward/back knob)
  lookX: 0, lookY: 0
};

let stickMove = { active: false, id: -1, dx: 0, dy: 0, max: 50, originRect: null };
let stickLook = { active: false, id: -1, dx: 0, dy: 0, max: 50, originRect: null };

let levelIndex   = 0;
let stability    = 1.0;        // 0..1, decays per second
let runStart     = 0;
let lastMovedAt  = performance.now();

// ====================================================== BOOT SEQUENCE

function bootSequence() {
  buildBinaryRain(dom.binary, { cols: 56 });
  dom.bootLines.forEach((line, idx) => {
    setTimeout(() => line.classList.add('show'), 100 + idx * 240);
  });
}

async function startGame() {
  // Hide loader, fullscreen, instantiate everything.
  gameState = 'play';
  dom.loader.classList.remove('visible');
  dom.hud.classList.remove('hidden');

  // The audio *must* be initiated from the click handler — modern browsers
  // refuse to open an AudioContext anywhere else.
  audio = new AudioEngine();
  audio.init();
  audio.unlock();

  // Request full-screen.
  if (dom.canvas.requestFullscreen) {
    try { await dom.canvas.requestFullscreen({ navigationUI: 'hide' }); } catch (e) {}
  }

  // Initialize Three.js.
  setupRenderer();
  setupScene();
  setupWorld();
  monsters = new MonsterManager(scene);
  setupPlayer();
  setupPointerLock();
  setupInput();
  setupUIHooks();
  applyLevel(0);
  audio.startAmbient(LEVELS[0].id);

  // Begin the loop.
  raf.start();
  runStart = performance.now();
  lastMovedAt = performance.now();
  dom.statusT.textContent = LEVELS[0].prompt;
  dom.subtitle.textContent = LEVELS[0].sub;
  audio.playWhisper();
}

// =========================================================== RENDERER

function setupRenderer() {
  renderer = new THREE.WebGLRenderer({
    canvas: dom.canvas,
    antialias: RENDERER_OPTIONS.antialias,
    powerPreference: RENDERER_OPTIONS.powerPreference,
    alpha: false
  });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  // Tone mapping helps the bloomy emissives look right.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
}

function setupScene() {
  scene = new THREE.Scene();
  // The fog color is overwritten when loadLevel runs.
  scene.background = new THREE.Color(0x000000);

  camera = new THREE.PerspectiveCamera(72, window.innerWidth / window.innerHeight, 0.05, 80);
  camera.position.set(0, 1.6, 0);   // eye height

  // A dim ambient light so unlit geometry is at least faintly visible.
  const amb = new THREE.AmbientLight(0xffffff, 0.18);
  scene.add(amb);
}

function setupWorld() {
  world = new World(scene, 31337);
}

function setupPlayer() {
  player = {
    position: new THREE.Vector3(0, 1.6, 0),
    yaw: 0,   // facing toward -Z when 0
    pitch: 0,
    forward: new THREE.Vector3(Math.sin(0), 0, -Math.cos(0)),
    right:   new THREE.Vector3(Math.cos(0), 0,  Math.sin(0)),
    velocity: new THREE.Vector3(),
    speed: 2.6,        // base walking speed (m/s)
    sprintMultiply: 1.7,
    sanity: 1.0,       // 1.0 = healthy, 0.0 = destruction.
    lastSafeAt: performance.now()
  };
}

// ====================================================== Pointer Lock

function setupPointerLock() {
  const onChange = () => {
    // update cursor label
    if (document.pointerLockElement === dom.canvas) {
      dom.canvas.style.cursor = 'none';
    } else {
      dom.canvas.style.cursor = 'crosshair';
    }
  };
  document.addEventListener('pointerlockchange', onChange);

  // Click the canvas to lock the pointer (only on non-touch devices).
  dom.canvas.addEventListener('click', () => {
    if (gameState !== 'play' || isTouchDevice()) return;
    if (document.pointerLockElement !== dom.canvas) {
      dom.canvas.requestPointerLock();
    }
  });
}

// ====================================================== Input bindings

function setupInput() {
  window.addEventListener('keydown', e => {
    KEY_STATE[e.code] = true;
    if (e.code === 'Escape') {
      // browsers exit pointer-lock automatically.
    }
  });
  window.addEventListener('keyup', e => {
    KEY_STATE[e.code] = false;
  });

  // We need to support both portrait and landscape. The trick is:
  //   joystick value = (touch position) - (joystick's bounding rect center),
  // ALL in screen pixels. The frame is local to the joystick DOM node, so
  // it doesn't matter how the screen is rotated — the knob still means
  // "up = forward" relative to the joystick's bottom centre.
  attachJoystick(dom.moveStick, dom.moveBg, dom.moveKnob, stickMove, /*moveMode*/ true, /*forwards*/ true);
  attachJoystick(dom.lookStick, dom.lookBg, dom.lookKnob, stickLook, /*moveMode*/ false, /*forwards*/ false);
  attachGlobalTouchListeners();
}

function attachJoystick(stickEl, bgEl, knobEl, state, isMove, _forwardsUnused) {
  // For MOBILE only (touch devices). The container is hidden via CSS otherwise.
  // We listen for touchstart ON the joystick container, then listen for
  // touchmove / touchend on the DOCUMENT so we still get events when the
  // finger slides off the joystick element. This is the only way to make
  // the joystick feel correct on real touch devices.
  const getR = () => bgEl.getBoundingClientRect();

  stickEl.addEventListener('touchstart', e => {
    e.preventDefault();
    if (state.active) return;
    const t = e.changedTouches[0];
    state.active = true;
    state.id = t.identifier;
    state.originRect = getR();
    state.originX = t.clientX;
    state.originY = t.clientY;
  }, { passive: false });

  // Re-origin on orientation change so the knob doesn't jump.
  window.addEventListener('orientationchange', () => {
    state.active = false;
    state.id = -1;
    state.dx = state.dy = 0;
    knobEl.style.transform = '';
  });
}

// GLOBAL touchmove/touchend — needed so the joystick keeps tracking the
// finger even when it leaves the joystick element.
function processTouchMoveGlobal(e, state, knobEl) {
  if (!state.active) return;
  for (const t of e.changedTouches) {
    if (t.identifier !== state.id) continue;
    const dx = t.clientX - state.originX;
    const dy = t.clientY - state.originY;
    const m = Math.hypot(dx, dy);
    state.max = state.originRect ? state.originRect.width * 0.42 : 50;
    const clamp_m = Math.min(m, state.max);
    const cx = (m === 0) ? 0 : (dx / m) * clamp_m;
    const cy = (m === 0) ? 0 : (dy / m) * clamp_m;
    knobEl.style.transform = `translate(${cx}px, ${cy}px)`;
    state.dx = cx / state.max;
    state.dy = cy / state.max;
  }
}

function processTouchEndGlobal(e, state, knobEl) {
  if (!state.active) return;
  for (const t of e.changedTouches) {
    if (t.identifier !== state.id) continue;
    state.active = false;
    state.id = -1;
    state.dx = state.dy = 0;
    knobEl.style.transform = '';
  }
}

function attachGlobalTouchListeners() {
  document.addEventListener('touchmove', e => {
    processTouchMoveGlobal(e, stickMove, dom.moveKnob);
    processTouchMoveGlobal(e, stickLook, dom.lookKnob);
  }, { passive: false });
  document.addEventListener('touchend', e => {
    processTouchEndGlobal(e, stickMove, dom.moveKnob);
    processTouchEndGlobal(e, stickLook, dom.lookKnob);
  }, { passive: false });
  document.addEventListener('touchcancel', e => {
    processTouchEndGlobal(e, stickMove, dom.moveKnob);
    processTouchEndGlobal(e, stickLook, dom.lookKnob);
  }, { passive: false });
}

function setupUIHooks() {
  dom.initBtn.addEventListener('click', startGame);
  dom.modalBtn.addEventListener('click', () => {
    dom.modal.classList.remove('show');
    gameState = 'play';
    player.position.set(0, 1.6, 0);
    player.yaw = 0;
    player.pitch = 0;
    player.velocity.set(0, 0, 0);
    player.sanity = 1;
    stability = LEVELS[levelIndex].stability;
    levelIndex = Math.max(0, levelIndex - 1);
    applyLevel(levelIndex);
  });
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
}
function onResize() {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}

// ====================================================== LEVEL FLOW

function applyLevel(idx) {
  const lvl = LEVELS[idx];
  levelIndex = idx;
  dom.levelR.textContent = String(typeof lvl.id === 'number' ? lvl.id : lvl.id.toUpperCase());
  // Reset player into the level's spawn (always start of the corridor chain).
  player.position.set(0, 1.6, 0);
  player.yaw = 0;
  player.pitch = 0;
  stability = lvl.stability;
  monsters.reset();
  audio.stopMonster();
  audio.stopAmbient();
  audio.startAmbient(lvl.id);
  world.loadLevel(lvl.id, 31337 + idx * 31);

  if (lvl.bgAudio === 'void') {
    // Level 6: dim everything as if the lights are gone.
    document.body.style.background = '#000';
    renderer.toneMappingExposure = 0.4;
  } else if (lvl.bgAudio === 'redshift') {
    renderer.toneMappingExposure = 1.0;
    document.body.style.background = '#100';
  } else {
    renderer.toneMappingExposure = 1.0;
    document.body.style.background = '#000';
  }

  dom.statusT.textContent = lvl.prompt;
  dom.subtitle.textContent = lvl.sub;
  dom.fade.classList.remove('on', 'red');
  requestAnimationFrame(() => dom.fade.classList.add('on'));
  setTimeout(() => dom.fade.classList.remove('on'), 380);
}

// ===================================================== GAME LOOP

const raf = makeRAFLoop(loop);

function loop(dt, now) {
  if (gameState !== 'play') {
    renderer.render(scene, camera);
    return;
  }
  // 1. Update input → desired move delta
  updateInput(dt);

  // 2. Move player with collision
  movePlayer(dt);

  // 3. World advance + observer effect
  world.advanceTo(player.position);
  world.applyObserverEffect(player.position, player.yaw);
  world.update(dt);

  // 4. Monster update + spawning probability
  updateMonster(dt, now);

  // 5. Sanity / stability / level progression
  updateMood(dt, now);

  // 6. Audio positional updates
  updateAudio(dt, now);

  // 7. HUD commit
  commitHud();

  // 8. Fire glitch overlay at jagged intervals — players see jitter
  maybeGlitch(now);

  renderer.render(scene, camera);
}

// ---------------------------------------------- input -> player state

function updateInput(dt) {
  // PC binding: merge keyboard + mouse-delta.
  let mx = 0, my = 0;     // move x,y (joystick style: dy is FORWARD if negative)
  if (KEY_STATE['KeyW']) my -= 1;
  if (KEY_STATE['KeyS']) my += 1;
  if (KEY_STATE['KeyA']) mx -= 1;
  if (KEY_STATE['KeyD']) mx += 1;
  // merge in joystick
  // Joystick: dx positive = right, dy positive = down. We define dy negative = forward.
  // So we sum:
  mx += stickMove.dx;
  my += stickMove.dy;     // (we treat dy positive = BACKWARD)

  MOVEMENT_STATE.moveX = clamp(mx, -1, 1);
  MOVEMENT_STATE.moveY = clamp(my, -1, 1);

  // Look: PC uses pointer-lock mouse-delta. Mobile uses joystick.
  if (document.pointerLockElement === dom.canvas) {
    // We accumulate movement from the locked-pointer 'mousemove' events.
    // See pointerLockMove in 'setupPointerLock'.
  }
  // Joystick look: dx→yaw (right positive), dy→pitch (down = look down).
  // Look buffer applies each frame (consumed in movePlayer).
  lookBuffer.x += stickLook.dx * dt * 2.5;
  lookBuffer.y += stickLook.dy * dt * 2.0;
}

const lookBuffer = { x: 0, y: 0 };

// Mouse-delta accumulator bound early so we can wire event listeners before
// the loop runs.
function pointerLockMove(e) {
  if (document.pointerLockElement !== dom.canvas) return;
  // Mouse-motion x/y -> yaw/pitch. We normalize by a fixed sensitivity.
  const sx = 0.0025;
  const sy = 0.0022;
  lookBuffer.x += e.movementX * sx;
  lookBuffer.y += e.movementY * sy;
}
document.addEventListener('mousemove', pointerLockMove);

// ---------------------------------------------- player update

let bobPhase = 0;

function movePlayer(dt) {
  // Apply look buffer (consume so it integrates smoothly).
  //
  // Sign conventions:
  //  YAW:
  //    mouse-right = look-right.
  //    In Three.js default axes, yaw decreasing corresponds to looking
  //    toward +X (right of the default -Z facing), so we SUBTRACT.
  //  PITCH:
  //    mouse-up = look-up.
  //    In Three.js default axes, increasing pitch tilts the camera up
  //    (forward vector rotates from -Z toward +Y). lookBuffer.y is
  //    *negative* when the user moves the mouse/finger up (relative to
  //    viewport coordinates). Subtracting makes the pitch go up. ✓
  player.yaw   -= lookBuffer.x;
  player.pitch  = clamp(player.pitch - lookBuffer.y, -1.2, 1.2);
  lookBuffer.x *= 0.85;
  lookBuffer.y *= 0.85;

  // Compute move vector relative to yaw
  const f = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
  const r = new THREE.Vector3( Math.cos(player.yaw), 0,  Math.sin(player.yaw));
  const sprint = (KEY_STATE['ShiftLeft'] || KEY_STATE['ShiftRight']) ? player.sprintMultiply : 1.0;
  const speed = player.speed * sprint;

  const dx = r.x * MOVEMENT_STATE.moveX + f.x * (-MOVEMENT_STATE.moveY);
  const dz = r.z * MOVEMENT_STATE.moveX + f.z * (-MOVEMENT_STATE.moveY);
  const m  = Math.hypot(dx, dz);
  let vx = m > 0.95 ? dx / m : dx;
  let vz = m > 0.95 ? dz / m : dz;

  vx *= speed; vz *= speed;

  // Collision: sweep X then Z separately against Box3 colliders.
  const oldX = player.position.x;
  const oldZ = player.position.z;
  player.position.x += vx * dt;
  resolveCollisions('x');
  player.position.z += vz * dt;
  resolveCollisions('z');

  // Trigger footstep sound if we actually moved a meaningful distance.
  const dist = Math.hypot(player.position.x - oldX, player.position.z - oldZ);
  if (dist > 0.001) {
    lastMovedAt = performance.now();
    audio.playFootstep(0.6 + Math.random() * 0.4);
  }

  // Subtle head-bob — kicks in only while moving; idle freezes the bob.
  bobPhase += dt * 7.2 * (m > 0.05 ? 1 : 0);
  const bob = Math.sin(bobPhase) * 0.022;
  const bobSide = Math.cos(bobPhase * 0.5) * 0.014;
  camera.position.copy(player.position);
  camera.position.y += bob;
  camera.position.x += bobSide;
  camera.rotation.order = 'YXZ';
  camera.rotation.set(player.pitch, player.yaw, 0);
}

function resolveCollisions(axis) {
  const R = 0.32; // player half-width
  const head = player.position.y;
  for (const box of world.getColliders()) {
    if (box.max.y < head - 1.65 || box.min.y > head + 0.3) continue;
    const dx = player.position.x - clamp(player.position.x, box.min.x, box.max.x);
    const dz = player.position.z - clamp(player.position.z, box.min.z, box.max.z);
    const ox = box.max.x - box.min.x;
    const oz = box.max.z - box.min.z;
    if (Math.abs(dx) < R && box.min.x <= player.position.x && player.position.x <= box.max.x) {
      // colliding into x face
      if (axis === 'x') {
        const sideFactor = (player.position.x - (box.min.x + box.max.x) / 2);
        player.position.x -= Math.sign(sideFactor) * (R - Math.abs(dx) + 0.001);
      }
    }
    if (Math.abs(dz) < R && box.min.z <= player.position.z && player.position.z <= box.max.z) {
      if (axis === 'z') {
        const sideFactor = (player.position.z - (box.min.z + box.max.z) / 2);
        player.position.z -= Math.sign(sideFactor) * (R - Math.abs(dz) + 0.001);
      }
    }
  }
}

// ---------------------------------------------- monster update / spawn

function updateMonster(dt, now) {
  const lvl = LEVELS[levelIndex];

  // Probability-Demon spawn: chance increases with time-stationary. We use
  // a linear formula (clamped) so the demo is predictable — even after a
  // long pause, the chance caps around 35% per frame.
  let p = lvl.spawnProbBase || 0.005;
  const timeStationarySec = (now - lastMovedAt) / 1000;
  p += Math.min(0.32, timeStationarySec * 0.018);

  // Cleanup of the demon when the player has escaped far enough.
  if (monsters.ent) {
    const dx = monsters.ent.mesh.position.x - player.position.x;
    const dz = monsters.ent.mesh.position.z - player.position.z;
    const dist = Math.hypot(dx, dz);
    // If the monster is *way* behind the player (out of view) it despawns.
    // This prevents permanent-noise floor / sanity-drain when the player
    // successfully creates distance.
    const yaw = player.yaw;
    const fx = -Math.sin(yaw), fz = -Math.cos(yaw);
    // dot of (dx,dz) with player's forward; negative = behind the player
    const behind = dx * fx + dz * fz;
    if (behind < -8 && dist > 12) {
      monsters.remove();
      audio.stopMonster();
      // Note: we *don't* reset lastSafeAt here — by leaving it stale we
      // give the player a moment to recover, then bump them.
      player.lastSafeAt = now - 1000;
    }
  }

  // Spawn?
  if (!monsters.ent && Math.random() < p) {
    const f = new THREE.Vector3(-Math.sin(player.yaw), 0, -Math.cos(player.yaw));
    monsters.spawn(player.position, f, lvl.id === 'red' ? 'wall' : 'sphere');
    audio.startMonster();
    audio.playGlitch();
  }

  // Continuous update
  const info = monsters.update(dt, { position: player.position, yaw: player.yaw }, lvl.id);
  if (info && audio && monsters.ent && audio._monsterNodes) {
    audio.updateMonster(info.dist, info.dx);
  }

  // Hit test → game over.
  if (monsters.ent && monsters.hits(player, lvl.id)) {
    onDeath();
  }
}

// ---------------------------------------------- sanity, stability, levels

function updateMood(dt, now) {
  runTimerSec = (now - runStart) / 1000;
  document.getElementById('level-readout').textContent =
    String(typeof LEVELS[levelIndex].id === 'number'
      ? LEVELS[levelIndex].id
      : LEVELS[levelIndex].id.toUpperCase());

  // Stability decays over time. Faster decay at higher levels.
  const decay = (1 - LEVELS[levelIndex].stability) * 0.04;
  stability -= decay * dt;
  stability = Math.max(0.05, stability);

  // Sanity behaviour:
  //   - If monster visible (within 12 units): sanity drains fast
  //   - If monster spawned but not visible: slow drain
  //   - If standing still for 10s+ after spawning: drain accelerates
  //   - If player is running and monster has not spawned for 8s: regen

  let sanityDelta = 0;
  if (monsters.ent) {
    const dx = monsters.ent.mesh.position.x - player.position.x;
    const dz = monsters.ent.mesh.position.z - player.position.z;
    const dist = Math.hypot(dx, dz);
    sanityDelta -= 0.06 * dt * (8 / Math.max(2, dist));

    // reward a 10s grace after the monster despawns
    player.lastSafeAt = now;
  } else {
    if (now - player.lastSafeAt > 1.5) {
      sanityDelta += 0.12 * dt;
    }
  }

  // Standing-still cost (no monster) — small sanity bleed on certain levels
  if (!monsters.ent && (now - lastMovedAt) > 7000 && LEVELS[levelIndex].id !== 'red') {
    sanityDelta -= 0.03 * dt;
  }

  player.sanity = clamp(player.sanity + sanityDelta, 0, 1);
  if (player.sanity <= 0) {
    onDeath();
    return;
  }

  // Level transition: when player reaches the exit of the current level
  // AND has been on it long enough, advance to the next.
  const distToExit = distanceToExit();
  if (distToExit != null && distToExit < 1.5) {
    triggerLevelUp();
  }

  // Heartbeat scheduling tied to sanity.
  let period = 1.2;
  if (player.sanity < 0.7) period = 0.85;
  if (player.sanity < 0.4) period = 0.55;
  if (player.sanity < 0.2) period = 0.32;
  audio.updateHeartbeat(dt, player.sanity < 0.7, period);

  // Update vignette darkness by sanity + level stability.
  const baseDim = 0.5;
  const san = clamp(1 - player.sanity, 0, 1);
  const stab = clamp(1 - stability, 0, 1);
  const dim = baseDim + san * 0.4 + stab * 0.18;
  dom.vignette.style.opacity = dim;
}

function distanceToExit() {
  if (!world.exitMesh) return null;
  const p = world.exitMesh.position;
  return Math.hypot(p.x - player.position.x, p.z - player.position.z);
}

function triggerLevelUp() {
  if (levelIndex >= LEVELS.length - 1) {
    gameState = 'win';
    showModal('SINGULARITY ESCAPED', 'You disconnected the observer. The simulation collapses; you wake up outside it.');
    return;
  }
  // audio chime
  audio.playChime();
  // flash red briefly
  dom.fade.classList.add('on', 'red');
  setTimeout(() => {
    applyLevel(levelIndex + 1);
    audio.stopMonster();
    monsters.reset();
  }, 700);
}

// ---------------------------------------------- audio binding

function updateAudio(dt, now) {
  // Ambient music/floor-creak plays continuously; we don't have to drive it
  // because the AudioEngine maintains its own loop. We do unlock again on
  // every visibility change just to be safe.
  // nothing extra here for now
}

// ---------------------------------------------- HUD commit

function commitHud() {
  // debounce: write to DOM only every ~80 ms
  const now = performance.now();
  if (!commitHud._t || now - commitHud._t > 80) {
    commitHud._t = now;

    // stability bar
    dom.stabBar.style.width = (stability * 100) + '%';
    dom.stabBar.style.background = stability < 0.3
      ? 'linear-gradient(90deg,#ff003c,#fff)'
      : 'linear-gradient(90deg,#7cf6ff,#fff)';
    if (stability < 0.3) dom.stabBar.classList.add('low'); else dom.stabBar.classList.remove('low');

    dom.sanityBar.style.width = (player.sanity * 100) + '%';
    if (player.sanity < 0.4) dom.sanityBar.classList.add('low'); else dom.sanityBar.classList.remove('low');

    // convert yaw degrees to a 3-digit reading
    let deg = ((player.yaw * 180 / Math.PI) % 360 + 360) % 360;
    dom.seenR.textContent = 'FACING: ' + String(Math.round(deg)).padStart(3, '0') + '°';

    // direction text refresh on big turns
    const directionName = compass(deg);
    let promptRefresh = false;
    if (!commitHud._lastDir || commitHud._lastDir !== directionName) {
      commitHud._lastDir = directionName;
      promptRefresh = true;
    }

    drawRadar();
  }
}

function compass(deg) {
  if (deg < 22 || deg > 338) return 'N';
  if (deg < 67) return 'NE';
  if (deg < 112) return 'E';
  if (deg < 157) return 'SE';
  if (deg < 202) return 'S';
  if (deg < 247) return 'SW';
  if (deg < 292) return 'W';
  return 'NW';
}

// ---------------------------------------------- radar

function drawRadar() {
  // The world SVG rotates around the player, but the *player* dot stays
  // exactly in the center. That's the observer effect rendered into radar:
  // the universe moves around the camera.
  const yawDeg = (player.yaw * 180 / Math.PI) % 360;
  dom.radarWorld.setAttribute('transform', `rotate(${yawDeg})`);

  // forward-cone wedge that rotates the same way
  dom.radarFwd.innerHTML = '';
  const fw = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  fw.setAttribute('d', 'M 0 0 L 92 -25 A 92 92 0 0 1 92 25 Z');
  fw.setAttribute('fill', 'rgba(255,245,138,0.10)');
  fw.setAttribute('stroke', 'rgba(255,245,138,0.35)');
  fw.setAttribute('stroke-width', '0.6');
  dom.radarFwd.appendChild(fw);

  // walls: collect colliders within range and plot their centre
  const svgns = 'http://www.w3.org/2000/svg';
  dom.radarWalls.innerHTML = '';
  const colliders = world.getColliders();
  const SCALE = 0.32;  // metres -> svg units
  for (const b of colliders) {
    const dx = (b.min.x + b.max.x) / 2 - player.position.x;
    const dz = (b.min.z + b.max.z) / 2 - player.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 90 / SCALE) continue;
    const w = (b.max.x - b.min.x);
    const h = (b.max.z - b.min.z);
    const cx = dx * SCALE;
    const cy = dz * SCALE;
    if (Math.max(w, h) > 2.5) {
      // the giant floor/ceiling — skip
      continue;
    }
    const rect = document.createElementNS(svgns, 'rect');
    rect.setAttribute('x', (cx - w * SCALE * 0.5).toFixed(1));
    rect.setAttribute('y', (cy - h * SCALE * 0.5).toFixed(1));
    rect.setAttribute('width', Math.max(1, w * SCALE).toFixed(2));
    rect.setAttribute('height', Math.max(1, h * SCALE).toFixed(2));
    rect.setAttribute('fill', 'rgba(124,246,255,0.18)');
    rect.setAttribute('stroke', 'rgba(124,246,255,0.45)');
    rect.setAttribute('stroke-width', '0.4');
    dom.radarWalls.appendChild(rect);
  }

  // monster
  dom.radarMonsters.innerHTML = '';
  if (monsters.ent) {
    const dx = monsters.ent.mesh.position.x - player.position.x;
    const dz = monsters.ent.mesh.position.z - player.position.z;
    const cx = dx * SCALE, cy = dz * SCALE;
    if (monsters.ent.mode === 'wall') {
      // Draw a long bar pointing away from player.
      const len = Math.max(60, Math.hypot(dx, dz) * SCALE);
      const ang = Math.atan2(dz, dx);
      const wall = document.createElementNS(svgns, 'rect');
      wall.setAttribute('x', '-1');
      wall.setAttribute('y', '-1.5');
      wall.setAttribute('width', len);
      wall.setAttribute('height', '3');
      wall.setAttribute('fill', 'rgba(255,0,60,0.55)');
      wall.setAttribute('stroke', 'rgba(255,0,60,0.9)');
      wall.setAttribute('stroke-width', '0.6');
      wall.setAttribute('transform', `translate(${cx.toFixed(1)},${cy.toFixed(1)}) rotate(${(-ang * 180 / Math.PI).toFixed(2)})`);
      dom.radarMonsters.appendChild(wall);
    } else {
      const c = document.createElementNS(svgns, 'circle');
      c.setAttribute('cx', cx.toFixed(1));
      c.setAttribute('cy', cy.toFixed(1));
      c.setAttribute('r', '4');
      c.setAttribute('fill', 'rgba(255,0,60,0.85)');
      c.setAttribute('stroke', '#ffe6ec');
      c.setAttribute('stroke-width', '0.6');
      dom.radarMonsters.appendChild(c);
    }
  }

  // exit
  dom.radarExit.innerHTML = '';
  if (world.exitMesh) {
    const dx = world.exitMesh.position.x - player.position.x;
    const dz = world.exitMesh.position.z - player.position.z;
    const cx = dx * SCALE, cy = dz * SCALE;
    const e = document.createElementNS(svgns, 'rect');
    const w = 6, h = 6;
    e.setAttribute('x', (cx - w/2).toFixed(1));
    e.setAttribute('y', (cy - h/2).toFixed(1));
    e.setAttribute('width', w);
    e.setAttribute('height', h);
    e.setAttribute('fill', 'rgba(100,180,255,0.18)');
    e.setAttribute('stroke', 'rgba(140,220,255,0.9)');
    e.setAttribute('stroke-width', '0.6');
    dom.radarExit.appendChild(e);
  }
}

// ---------------------------------------------- glitch overlay

let glitchPile = 0;
function maybeGlitch(now) {
  // Periodically fire overlay glitch; on certain levels fire more often.
  const lvl = LEVELS[levelIndex];
  const chance = lvl.id === 'red' ? 0.06 : (lvl.id === 10 ? 0.05 : 0.012);
  if (Math.random() < chance * (1 - stability + 0.1)) {
    dom.glitch.classList.remove('fire');
    // force reflow so animation re-triggers
    void dom.glitch.offsetWidth;
    dom.glitch.classList.add('fire');
    audio.playGlitch();
  }
}

// ---------------------------------------------- death & menu

function onDeath() {
  if (gameState !== 'play') return;
  gameState = 'dead';
  audio.stopMonster();
  audio.playDeath();
  setTimeout(() => {
    dom.modal.classList.add('show');
    dom.modalT.textContent = 'SIGNAL LOST';
    dom.modalB.textContent = 'You were observed out of existence at level ' +
      (LEVELS[levelIndex].id) +
      '.';
  }, 350);
}

function showModal(title, body) {
  dom.modal.classList.add('show');
  dom.modalT.textContent = title;
  dom.modalB.textContent = body;
}

// Show the boot UI
bootSequence();

// ----------------------- last: initial setup that runs at import time

// Audio is created only after a user gesture (see AudioEngine.init() call in
// startGame). World/Monster/Player are rebuilt there too so we can fully
// reset between runs (no stale state from a prior playthrough).

// ----------------------- touch device initial setup

// After the page paints, decide whether to show the joystick UI.
// We decide based on pointer-coarse queries + touch capability.
function maybeShowTouch() {
  const show = isTouchDevice();
  if (show) {
    dom.mobile.classList.remove('hidden');
    // hide the crosshair cursor on touch devices
    dom.canvas.style.cursor = 'none';
  } else {
    dom.canvas.style.cursor = 'crosshair';
  }
}
maybeShowTouch();

// Things wired here at import time run once.
// - mouse-delta listening for pointer-locked camera is wired earlier.
// - keyboard listeners are inside setupInput (called from startGame).
// - monster manager is built in startGame (where the scene exists).

