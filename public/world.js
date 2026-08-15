/**
 * The Corridor Factory.
 *
 * The game world is built from a sliding window of corridor "tiles" laid out
 * in front of the player. Each tile is a 4m × 4m × 4m cube chunk of wall/ceiling/
 * floor; per-tile wall layout is determined by a hash(seed + tileIndex) so the
 * sequence is deterministic — the player can replay the same level seed and
 * find the same maze.
 *
 * The Observer Effect implementation:
 *
 *   * Each tile stores its *last observed facing* (the camera yaw when the
 *     player last had the tile within their forward 90° cone).
 *   * If the player's facing changes by more than 90° (i.e., they turned
 *     around), ALL tiles outside the new forward 90° cone become "stale":
 *     they're marked for regeneration.
 *   * On regeneration, the tile mesh is destroyed and a new one built with
 *     a different hash — *the geometry behind the player literally changes.*
 *
 * Bounds: outside the visible window + 30 units we drop the mesh entirely.
 * That means as the player flies forward, unobserved tiles vanish entirely.
 */

import * as THREE from 'three';
import { mulberry32 } from './utils.js';

const TILE_SIZE = 4;
const FORWARD_TILES = 6;
const TOTAL_TILES = 18;
const VISIBLE_RADIUS = 4.5; // tiles either side we keep alive
const FOV_HALF = Math.PI * 0.5; // 90° cone = "observed"

/* Smoothing for the observer-effect reshuffle. Tiles fade in/out instead
   of hard-popping. Tunable constants. */
const RESHUFFLE_YAW_THRESHOLD = 0.18;   // ~10° — lower than the old 20°
const FADE_OUT_DURATION_MS = 600;
const FADE_IN_DURATION_MS = 350;
const STALE_DELAY_MS = 80;              // brief grace before fade-out begins

/**
 * Pick a palette for a given level id.
 * Each palette returns colors as plain objects so they're trivial to swap.
 */
const PALETTES = {
  0: { // Level 0 — backrooms (Liberty65-style)
    name: 'ground',
    floor:     new THREE.Color('#7c6f3d').multiplyScalar(0.85),
    ceiling:   new THREE.Color('#cabc7a').multiplyScalar(0.9),
    wall:      new THREE.Color('#cabc7a'),
    accent:    new THREE.Color('#9b8d57'),
    light:     new THREE.Color('#fff4c2'),
    lightK:    30,
    fog:       new THREE.Color('#1a1a08'),
    fogDensity: 0.045
  },
  1: { // Level 1 — concrete
    name: 'industrial',
    floor:     new THREE.Color('#3d3f44'),
    ceiling:   new THREE.Color('#22242a'),
    wall:      new THREE.Color('#52555b'),
    accent:    new THREE.Color('#36383d'),
    light:     new THREE.Color('#a0b6c4'),
    lightK:    18,
    fog:       new THREE.Color('#0c0e12'),
    fogDensity: 0.05
  },
  2: {  // AC ducts / engine room
    name: 'ducts',
    floor:    new THREE.Color('#3a3025'),
    ceiling:  new THREE.Color('#423524'),
    wall:     new THREE.Color('#5a4a30'),
    accent:   new THREE.Color('#806238'),
    light:    new THREE.Color('#ff9550'),
    lightK:   22,
    fog:      new THREE.Color('#100804'),
    fogDensity: 0.06
  },
  3: { // High-Voltage Station
    name: 'volts',
    floor:    new THREE.Color('#162018'),
    ceiling:  new THREE.Color('#0e1410'),
    wall:     new THREE.Color('#2a4034'),
    accent:   new THREE.Color('#dcff3a'),
    light:    new THREE.Color('#a0ffd0'),
    lightK:   14,
    fog:      new THREE.Color('#040806'),
    fogDensity: 0.055
  },
  4: { // Abandoned Office
    name: 'office',
    floor:    new THREE.Color('#3d4030'),
    ceiling:  new THREE.Color('#d4c890'),
    wall:     new THREE.Color('#7d6b4a'),
    accent:   new THREE.Color('#4a4030'),
    light:    new THREE.Color('#fff08a'),
    lightK:   25,
    fog:      new THREE.Color('#0c0e08'),
    fogDensity: 0.05
  },
  5: { // Hotel
    name: 'hotel',
    floor:    new THREE.Color('#502820'),
    ceiling:  new THREE.Color('#5e3825'),
    wall:     new THREE.Color('#7e4830'),
    accent:   new THREE.Color('#a86438'),
    light:    new THREE.Color('#ffb478'),
    lightK:   20,
    fog:      new THREE.Color('#1a0a06'),
    fogDensity: 0.055
  },
  6: { // Dark Matter (Level 6 / "dark")
    name: 'void',
    floor:    new THREE.Color('#000000'),
    ceiling:  new THREE.Color('#000000'),
    wall:     new THREE.Color('#0a0a0a'),
    accent:   new THREE.Color('#000000'),
    light:    new THREE.Color('#ffffff'),
    lightK:   0,
    fog:      new THREE.Color('#000000'),
    fogDensity: 0.07
  },
  red: { // "!" Shift — Red corridor
    name: 'redshift',
    floor:    new THREE.Color('#1c0008'),
    ceiling:  new THREE.Color('#3a0014'),
    wall:     new THREE.Color('#5a0020'),
    accent:   new THREE.Color('#8a0030'),
    light:    new THREE.Color('#ff003c'),
    lightK:   24,
    fog:      new THREE.Color('#100004'),
    fogDensity: 0.07
  },
  10: { // Singularity
    name: 'glitch',
    floor:    new THREE.Color('#0b0820'),
    ceiling:  new THREE.Color('#100828'),
    wall:     new THREE.Color('#1c0a40'),
    accent:   new THREE.Color('#ff00ff'),
    light:    new THREE.Color('#5cf6ff'),
    lightK:   12,
    fog:      new THREE.Color('#040218'),
    fogDensity: 0.06
  }
};

export class World {
  constructor(scene, seed = 1) {
    this.scene = scene;
    this.seed = seed;
    this.level = 0;
    this.palette = PALETTES[0];
    this.tiles = []; // ordered list of tile objects ahead of the player
    this.root = new THREE.Group();
    this.root.name = 'WorldRoot';
    this.scene.add(this.root);

    // Lights live in a separate group so we don't rebuild them.
    this.lights = [];
    this.dynLights = new THREE.Group();
    this.dynLights.name = 'DynamicLights';
    this.scene.add(this.dynLights);

    this.lastFacing = 0;
    this.regenDist = 0;
    this.exitTile = null;  // index of the tile that will host the EXIT
    this.exitMesh = null;
    this.exitFound = false;

    this.monsters = [];
    this.colliders = []; // Box3 list
    this._tmpVec = new THREE.Vector3();
    this._tmpVec2 = new THREE.Vector3();

    // A reusable BoxBufferGeometry for walls (slimmer than building each
    // primitive individually). We use boxes for the wall + floor + ceiling
    // and add bevels via geometry groups later if we have time.
    this._wallGeo = new THREE.BoxGeometry(1, 1, 1);
  }

  /** lightLevel is the integer level id used by loadLevel(). */
  loadLevel(levelId, seed) {
    this.level = levelId;
    this.seed = seed;
    this.palette = PALETTES[levelId] || PALETTES[0];
    // Drop the existing world instantly.
    for (const t of this.tiles) this._destroyTile(t);
    this.tiles.length = 0;
    // Drop lights.
    for (const l of this.lights) {
      this.dynLights.remove(l);
      if (l.dispose) l.dispose && l.dispose();
    }
    this.lights.length = 0;
    this.monsters.length = 0;
    this.colliders.length = 0;

    this.scene.fog = new THREE.Fog(this.palette.fog, 0.1, 24);
    this.scene.background = this.palette.fog;

    // The tile sequence ahead of the player: indices [0, FORWARD_TILES) of
    // the first build. We rebuild and re-index as the player advances.
    const rng = mulberry32(this.seed);
    this.exitTileIndex = 8 + Math.floor(rng() * 4);
    this.exitFound = false;

    for (let i = 0; i < TOTAL_TILES; i++) this._spawnTile(i, /*freshLayout*/true);
    this._spawnExit();
  }

  /** Build a single tile at index `i`. Tiles are laid in a 1D line that
   *  curls gently so the player isn't walking in a perfect straight line —
   *  they get turned 30-40° per few tiles, creating the sense of drift. */
  _spawnTile(i, freshLayout) {
    const tile = {
      index: i,
      mesh: null,
      colliders: [],   // Box3 entries
      lights: [],      // PointLight entries (already added to scene)
      rng: mulberry32(this.seed * 9973 + i * 31),
      observedFacing: 0,
      stale: false,
      staleTime: 0,
      removed: false,
      // Smoothing state — target opacity is what `update()` lerps toward.
      opacity: 0.0,         // start invisible; _rebuildTile fades in
      targetOpacity: 1.0,
      fadeStartedAt: performance.now(),
      fadingIn: true,
    };
    this.tiles[i] = tile;

    // Compute the tile's center position. It's placed ahead of the previous
    // tile, with a small lateral + turning offset.
    const prev = i > 0 ? this.tiles[i - 1] : null;
    if (prev) {
      // Each tile is TILE_SIZE deep ahead.
      tile.centerZ = prev.centerZ - TILE_SIZE;
      // Lateral wiggle.
      const wig = (tile.rng() - 0.5) * 1.6;
      tile.centerX = (prev.centerX || 0) + wig;
    } else {
      tile.centerX = 0; tile.centerZ = 0;
    }
    tile.center = new THREE.Vector3(tile.centerX, 0, tile.centerZ);

    this._rebuildTile(tile);
  }

  /** Rebuild the geometry of `tile` using a fresh hash of its index, but
   *  keep the same center position. This is the heart of the observer effect:
   *  the same index but a new RNG seed = a different wall layout. */
  _rebuildTile(tile) {
    if (tile.mesh) {
      this.root.remove(tile.mesh);
      tile.mesh.traverse(o => {
        if (o.geometry && o.geometry !== this._wallGeo) o.geometry.dispose();
        if (o.material)  o.material.dispose();
      });
    }
    for (const c of tile.colliders) c.empty && c.empty();
    tile.colliders.length = 0;
    tile.mesh = new THREE.Group();
    tile.mesh.position.copy(tile.center);
    this.root.add(tile.mesh);

    const tRNG = mulberry32(this.seed * 91 + tile.index * 1301 + Math.floor(this.regenDist * 17));

    // Pick how many of the four walls are "open" (with a doorway).
    // 0..4 open — but never 4 (open box). Always at least 1 to keep
    // moving forward possible.
    const openFront = true; // forward wall always has a doorway (movement direction)
    const openBack  = tRNG() < 0.7;
    const openLeft  = tRNG() < 0.45;
    const openRight = tRNG() < 0.45;
    tile.openings = { front: openFront, back: openBack, left: openLeft, right: openRight };
    tile.stale = false;

    const pal = this.palette;

    // ----- Floor -----
    const floor = new THREE.Mesh(this._wallGeo, this._mat(pal.floor));
    floor.scale.set(TILE_SIZE, 0.1, TILE_SIZE);
    floor.position.set(0, -1.95, 0);
    tile.mesh.add(floor);

    // ----- Ceiling -----
    const ceil = new THREE.Mesh(this._wallGeo, this._mat(pal.ceiling));
    ceil.scale.set(TILE_SIZE, 0.1, TILE_SIZE);
    ceil.position.set(0, 2.6, 0);
    tile.mesh.add(ceil);

    // ----- Walls (a wall is a 4m × 4m × 0.2m slab on the boundary) -----
    const wallWalls = [
      { side: 'front', open: openFront, x: 0, z: -TILE_SIZE / 2, ry: 0 },
      { side: 'back',  open: openBack,  x: 0, z:  TILE_SIZE / 2, ry: Math.PI },
      { side: 'left',  open: openLeft,  x: -TILE_SIZE / 2, z: 0, ry:  Math.PI / 2 },
      { side: 'right', open: openRight, x:  TILE_SIZE / 2, z: 0, ry: -Math.PI / 2 },
    ];
    for (const w of wallWalls) {
      // Subdivide the wall into segments so we can cut a doorway.
      // We'll make it as two halves + a lintel above the door.
      const halfW = TILE_SIZE / 2;
      const doorWidth = 1.5;
      const wallTh = 0.2;
      const wallHeight = 4.4;

      if (!w.open) {
        // full wall
        const slab = new THREE.Mesh(this._wallGeo, this._mat(pal.wall));
        slab.scale.set(halfW * 2, wallHeight, wallTh);
        slab.position.set(w.x, 0.25, w.z);
        slab.rotation.y = w.ry;
        tile.mesh.add(slab);
        tile.colliders.push(new THREE.Box3().setFromObject(slab));
      } else {
        // two side panels and a lintel
        const sideWidth = (halfW - doorWidth / 2);
        [-1, 1].forEach(s => {
          const p = new THREE.Mesh(this._wallGeo, this._mat(pal.wall));
          p.scale.set(sideWidth, wallHeight, wallTh);
          p.position.set(w.x + s * (doorWidth / 2 + sideWidth / 2), 0.25, w.z);
          p.rotation.y = w.ry;
          tile.mesh.add(p);
          tile.colliders.push(new THREE.Box3().setFromObject(p));
        });
        // lintel above the door
        const lintel = new THREE.Mesh(this._wallGeo, this._mat(pal.wall));
        const lintelH = wallHeight - 2.3; // door is 2.3 tall
        lintel.scale.set(doorWidth, lintelH, wallTh);
        lintel.position.set(w.x, 0.25 + 2.3 + lintelH / 2, w.z);
        lintel.rotation.y = w.ry;
        tile.mesh.add(lintel);
        tile.colliders.push(new THREE.Box3().setFromObject(lintel));

        // doorframe accent — two thin trim pieces flanking the doorway
        const trimTh = 0.05;
        const trimD = 0.18;
        const trimH = 2.3;
        const localX = (doorWidth / 2);
        [-localX, localX].forEach(off => {
          const t = new THREE.Mesh(this._wallGeo, this._mat(pal.accent));
          t.scale.set(trimTh, trimH, trimD);
          t.position.set(w.x, 0.15, w.z);
          // perpendicular to wall direction
          const right = new THREE.Vector3(Math.cos(w.ry), 0, Math.sin(w.ry))
            .multiplyScalar(off);
          t.position.x += right.x;
          t.position.z += right.z;
          t.rotation.y = w.ry;
          tile.mesh.add(t);
        });
      }
    }

    // ----- Wallpaper / detail stripes -----
    // (Level-0 only) a horizontal accent stripe near the top — purely visual.
    if (pal.name === 'ground') {
      const stripe = new THREE.Mesh(this._wallGeo, this._mat(pal.accent));
      stripe.scale.set(TILE_SIZE, 0.05, 0.04);
      stripe.position.set(0, 1.5, -TILE_SIZE / 2 - 0.12);
      tile.mesh.add(stripe);
    }

    // ----- Lights (fluorescent strips) -----
    if (pal.lightK > 0) {
      // one light per tile, jittered side
      const lx = (tRNG() - 0.5) * (TILE_SIZE - 2);
      const lz = (tRNG() - 0.5) * (TILE_SIZE - 2);
      // a thin fluorescent strip mesh
      const strip = new THREE.Mesh(this._wallGeo,
        new THREE.MeshBasicMaterial({ color: pal.light, toneMapped: false }));
      strip.scale.set(TILE_SIZE - 1.0, 0.06, 0.16);
      strip.position.set(lx, 2.4, lz);
      tile.mesh.add(strip);

      // some flicker
      const point = new THREE.PointLight(pal.light, pal.lightK, 8, 1.6);
      point.position.set(lx, 2.0, lz);
      tile.mesh.add(point);
      tile.lights.push(point);

      // Random: add a dead-flicker light (emits no light but has a strip)
      if (tRNG() < 0.25) {
        const dead = new THREE.Mesh(this._wallGeo,
          new THREE.MeshBasicMaterial({ color: 0x554a30, toneMapped: false }));
        dead.scale.set(TILE_SIZE - 1.0, 0.06, 0.16);
        dead.position.set(-lx, 2.4, -lz);
        dead.rotation.z = 0.04;
        tile.mesh.add(dead);
      }
    }

    // ----- Glitch tiles (purple checkerboard "missing texture")
    if (pal.name === 'glitch' && tRNG() < 0.35) {
      const c = makeCheckerboard();
      const m = new THREE.Mesh(this._wallGeo, c);
      m.scale.set(TILE_SIZE, TILE_SIZE, 0.05);
      m.position.set(0, 0.25, -TILE_SIZE / 2 - 0.18);
      m.rotation.y = 0;
      tile.mesh.add(m);
    }

    // Update stale-age bookkeeping
    tile.lastUsedFacing = this.lastFacing;
    tile.lastRebuildAt = performance.now();

    // Fade-in: every fresh geometry starts at opacity 0 and ramps to 1
    // so the player sees a smooth "materialising" effect instead of a
    // hard pop.
    tile.opacity = 0.0;
    tile.targetOpacity = 1.0;
    tile.fadeStartedAt = performance.now();
    tile.fadingIn = true;
    this._applyTileOpacity(tile, 0.0);
  }

  /** Walk every Mesh in the tile and set material.opacity. We tolerate
   *  arrays (multi-material meshes) and unique materials per tile. */
  _applyTileOpacity(tile, opacity) {
    if (!tile.mesh) return;
    tile.mesh.traverse(o => {
      if (!o.material) return;
      const apply = m => {
        if (!m) return;
        m.transparent = true;
        m.opacity = opacity;
      };
      if (Array.isArray(o.material)) o.material.forEach(apply);
      else apply(o.material);
    });
  }

  _mat(color) {
    // Always start transparent: true so opacity fades work for both
    // fade-in (after a tile rebuild) and fade-out (when the tile leaves
    // the player's observation cone).
    return new THREE.MeshLambertMaterial({
      color,
      transparent: true,
      opacity: 1.0,
      depthWrite: true,
    });
  }

  /** Spawn the exit portal in this level's chosen tile. */
  _spawnExit() {
    if (this.exitMesh) {
      this.root.remove(this.exitMesh);
      this.exitMesh.traverse(o => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
      this.exitMesh = null;
    }
    if (this.exitFound) return;
    const tile = this.tiles[this.exitTileIndex];
    if (!tile) return;

    this.exitMesh = new THREE.Group();
    // A blue doorway standing in the back wall (forward facing when player
    // walks through the tile).
    const frame = new THREE.Mesh(this._wallGeo, this._mat(new THREE.Color('#3aaaff')));
    frame.scale.set(1.6, 2.4, 0.18);
    frame.position.set(0, 0.4, -TILE_SIZE / 2 + 0.06);
    this.exitMesh.add(frame);

    // The "exit" — gentle pulsing inner panel
    const panel = new THREE.Mesh(
      new THREE.PlaneGeometry(1.4, 2.2),
      new THREE.MeshBasicMaterial({
        color: 0x88e0ff,
        transparent: true,
        opacity: 0.85,
        side: THREE.DoubleSide
      })
    );
    panel.position.set(0, 0.4, -TILE_SIZE / 2 + 0.16);
    this.exitMesh.add(panel);
    this.exitPanel = panel;

    // A point light that attracts the player visually
    const pl = new THREE.PointLight(0x88e0ff, 28, 9, 1.4);
    pl.position.set(0, 1.0, -TILE_SIZE / 2);
    this.exitMesh.add(pl);

    this.exitMesh.position.copy(tile.center);
    this.root.add(this.exitMesh);
  }

  /** Move the tile-window so the player always has FORWARD_TILES tiles ahead.
   *  `pos` is the player's world position. */
  advanceTo(pos) {
    // Identify which tile index the player is currently inside.
    let floorIndex = Math.floor(-pos.z / TILE_SIZE); // tiles are stacked in -z
    floorIndex = Math.max(0, floorIndex);

    // Ensure tiles 0..floorIndex+FORWARD_TILES exist.
    const wantHi = floorIndex + FORWARD_TILES + 2;
    while (this.tiles.length <= wantHi) {
      this._spawnTile(this.tiles.length, true);
    }

    // Garbage-collect tiles that are *way* behind the player. "Way behind"
    // is generous — we never destroy a tile the player might still be
    // looking back at, only those out of fog range entirely.
    const BEHIND_Z = pos.z + 60; // tiles with z > this are far behind
    for (let i = 0; i < this.tiles.length; i++) {
      const t = this.tiles[i];
      if (t.removed) continue;
      // Tile is BEHIND the player when its center has bigger Z than the player
      // (remember player walks toward -Z). Their lateral X can be anything.
      if (t.center.z > BEHIND_Z) {
        this._destroyTile(t);
      }
      // ALSO if it's ahead but very far away (>40 tiles in front), kill it.
      if (t.center.z < pos.z - 4 * TILE_SIZE * FORWARD_TILES) {
        this._destroyTile(t);
      }
    }
  }

  /** Apply the observer-effect: when player turns sharply, tiles outside
   *  the new forward 90° cone become stale -> scheduled for regeneration.
   *  We only rebuild on a SIGNIFICANT yaw change (not micro mouse-jitter)
   *  to keep the world stable while the player is looking around. */
  applyObserverEffect(pos, facing) {
    this.regenDist += 0.0008; // accumulates; triggers tile rebuild variety

    let maxDelta = 0;
    const yawTravel = Math.abs(angleDiff(this.lastFacing, facing));
    const isBigTurn = yawTravel > RESHUFFLE_YAW_THRESHOLD;

    for (const t of this.tiles) {
      if (t.removed) continue;
      // Vector from camera to tile center (xz only)
      const dx = t.center.x - pos.x;
      const dz = t.center.z - pos.z;
      const dist = Math.hypot(dx, dz);

      const ang = Math.atan2(dx, -dz);  // angle such that facing=0 → "ahead"
      let rel = angleDiff(facing, ang);

      const tileDist = dist / TILE_SIZE;
      // Don't trigger the observer effect on a tile the player is
      // physically inside — the geometry could change under their feet.
      const inTile = (
        Math.abs(dx) < TILE_SIZE * 0.4 &&
        Math.abs(dz) < TILE_SIZE * 0.4
      );

      if (tileDist < VISIBLE_RADIUS * 2 && !inTile) {
        if (Math.abs(rel) < FOV_HALF) {
          // Tile is in observed cone — refresh bookkeeping.
          t.observedFacing = facing;
          // If this tile was stale (was fading out behind us) and the
          // player turned back, reshuffle it now with a *fresh* RNG hash
          // so the world really does change.
          if (t.stale && (performance.now() - t.staleTime) > 250 && isBigTurn) {
            this._rebuildTile(t);
            t.stale = false;
            t.observedFacing = facing;
          } else if (t.targetOpacity < 1) {
            // Tile is in cone but its opacity is faded — restore it.
            t.targetOpacity = 1.0;
            t.fadingIn = true;
            t.fadeStartedAt = performance.now();
          }
        } else {
          // Tile is OUTSIDE the cone — start fading it out so the
          // observer effect feels smooth instead of jarring.
          if (!t.stale) {
            t.stale = true;
            t.staleTime = performance.now();
          }
          // Begin fade-out after a small grace so jitter doesn't blink.
          const since = performance.now() - t.staleTime;
          if (since > STALE_DELAY_MS) {
            t.targetOpacity = 0.0;
            t.fadingIn = false;
            if (!t.fadeStartedAt || t.fadingIn !== false) {
              t.fadeStartedAt = performance.now();
            }
          }
        }
      }
      const absRel = Math.abs(rel);
      if (absRel > maxDelta) maxDelta = absRel;
    }

    this.lastFacing = facing;
  }

  /** Get the active colliders for the physics check. */
  getColliders() {
    const out = [];
    for (const t of this.tiles) {
      if (t.removed) continue;
      for (const b of t.colliders) out.push(b);
    }
    return out;
  }

  /** Update the exit pulse / draw an observation overlay on stale tiles. */
  update(dt) {
    // Pulse the exit panel so it stands out at distance.
    if (this.exitPanel) {
      const t = performance.now() * 0.003;
      this.exitPanel.material.opacity = 0.5 + 0.4 * (0.5 + 0.5 * Math.sin(t));
    }

    // Smooth tile fade-in / fade-out for the observer-effect reshuffle.
    // Each tile's `opacity` lerps toward its `targetOpacity` over the
    // duration appropriate to its direction of motion.
    const now = performance.now();
    for (const t of this.tiles) {
      if (t.removed) continue;
      const duration = t.fadingIn ? FADE_IN_DURATION_MS : FADE_OUT_DURATION_MS;
      const elapsed = now - (t.fadeStartedAt || now);
      const u = Math.max(0, Math.min(1, elapsed / Math.max(1, duration)));
      const eased = u * u * (3 - 2 * u);  // smoothstep — eases both ends
      const from = t.fadingIn ? 0.0 : 1.0;
      const to   = t.fadingIn ? 1.0 : 0.0;
      const desired = from + (to - from) * eased;
      // Avoid fighting the lerp on every frame when very close to target
      if (Math.abs(desired - t.opacity) < 0.005) continue;
      t.opacity = desired;
      this._applyTileOpacity(t, desired);
    }
  }

  _destroyTile(tile) {
    if (tile.mesh) {
      this.root.remove(tile.mesh);
      tile.mesh.traverse(o => {
        if (o.geometry && o.geometry !== this._wallGeo) o.geometry.dispose();
        if (o.material) o.material.dispose();
      });
    }
    tile.removed = true;
  }
}

/** very small util: shortest signed angle from `a` to `b`, in (-PI, PI] */
function angleDiff(a, b) {
  let d = (b - a);
  while (d >  Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Build a checkerboard-style glitch material. */
function makeCheckerboard() {
  // 8×8 grid of magenta/black squares
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const SIZE = 32;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      ctx.fillStyle = ((x + y) & 1) ? '#40005a' : '#000000';
      ctx.fillRect(x * SIZE, y * SIZE, SIZE, SIZE);
    }
  }
  // crude text squiggle
  ctx.fillStyle = '#ff00ff';
  ctx.font = 'bold 12px monospace';
  for (let i = 0; i < 10; i++) {
    ctx.fillText('ERR', (Math.random() * 200) | 0, (Math.random() * 250 + 8) | 0);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
}
