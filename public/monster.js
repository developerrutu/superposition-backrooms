/**
 * The Probability Demon.
 *
 * It does not pathfind. It does not A*. The "AI" is:
 *
 *   * spawn-probability() rises the longer the player remains stationary in
 *     one observed state;
 *   * spawning picks a random tile ahead of the player (within their forward
 *     cone) and the demon materialises there;
 *   * every frame, the demon moves toward the player position with a slight
 *     random lateral offset (the lateral offset is what prevents cheesy
 *     wall-runs away from the monster).
 *   * collision is simple: if the player and demon are < 0.9 units apart the
 *     simulation collapses (player dies).
 *
 * The "Red Shift" level inverts these rules: the demon becomes a wall of
 * code behind the player, consuming everything. That variant is wired
 * through `mode: 'wall'`.
 *
 * Decoy handling: at higher levels we spawn N "decoys" — invisible variants
 * whose audio hum is silent. Only the real one emits hum. (Cheap fake via
 * making all decoys invisible and pure synthetic audio-from-real.)
 */

import * as THREE from 'three';

export class MonsterManager {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.scene.add(this.root);

    // Hub holding all active demon meshes (one real + decoys).
    this.ent = null;
    this.decoys = [];
  }

  /** Reset state for a fresh level. */
  reset() {
    if (this.ent) this._destroyEntity(this.ent);
    this.ent = null;
    for (const d of this.decoys) this._destroyDecoy(d);
    this.decoys.length = 0;
  }

  /** Mode: 'sphere' (default backrooms-style) or 'wall' (red-shift). */
  spawn(playerPos, playerForward, mode = 'sphere') {
    if (this.ent) return;
    if (mode === 'wall') {
      this.ent = this._spawnWall(playerPos, playerForward);
      return;
    }
    this.ent = this._spawnSphere(playerPos, playerForward);
  }

  _spawnSphere(playerPos, playerForward) {
    // Place the sphere 18-26 units ahead in the player's forward direction,
    // with a small lateral random offset for lateral menace.
    const ahead = 18 + Math.random() * 8;
    const side  = (Math.random() - 0.5) * 6;
    const fx = playerForward.x, fz = playerForward.z;
    const sx = -fz, sz = fx; // perpendicular
    const pos = new THREE.Vector3(
      playerPos.x + fx * ahead + sx * side,
      1.4,                       // floating chest-height
      playerPos.z + fz * ahead + sz * side
    );
    const grp = new THREE.Group();
    grp.position.copy(pos);

    // The orb itself: emissive red with a subtle pulse glow.
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(0.6, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0xff003c, toneMapped: false })
    );
    grp.add(sphere);

    // An outer bloom-like aura (additive)
    const aura = new THREE.Mesh(
      new THREE.SphereGeometry(1.1, 18, 18),
      new THREE.MeshBasicMaterial({
        color: 0xff5570,
        transparent: true,
        opacity: 0.18,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        toneMapped: false
      })
    );
    grp.add(aura);

    // A point light that lights up the corridors red
    const light = new THREE.PointLight(0xff003c, 8, 12, 1.8);
    grp.add(light);

    this.root.add(grp);
    return {
      mode: 'sphere',
      mesh: grp,
      sphere, aura, light,
      velocity: new THREE.Vector3(),
      vel: 0,
      pulsePhase: 0
    };
  }

  _spawnWall(playerPos, playerForward) {
    // Big red mesh that chases the player from behind — only the "Red Shift" level uses this.
    const grp = new THREE.Group();
    grp.position.set(playerPos.x + playerForward.x * -22, 0, playerPos.z + playerForward.z * -22);

    const wall = new THREE.Mesh(
      new THREE.BoxGeometry(40, 8, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xff003c, toneMapped: false })
    );
    grp.add(wall);
    const aur = new THREE.Mesh(
      new THREE.BoxGeometry(42, 9, 0.7),
      new THREE.MeshBasicMaterial({
        color: 0xff5570, transparent: true, opacity: 0.25,
        blending: THREE.AdditiveBlending, depthWrite: false
      })
    );
    grp.add(aur);
    const pl = new THREE.PointLight(0xff003c, 14, 30);
    pl.position.set(0, 0, 1);
    grp.add(pl);
    this.root.add(grp);
    return { mode: 'wall', mesh: grp, light: pl, vel: 0 };
  }

  /** Frame update:
   *   dt       — seconds since last frame
   *   player   — the player object (must have `position`, `forward`, `yaw`)
   *   level    — current level id (used for evolution features)
   */
  update(dt, player, level) {
    if (!this.ent) return;

    if (this.ent.mode === 'sphere') {
      // Acceleration ramps over time. Closer → faster.
      const dx = player.position.x - this.ent.mesh.position.x;
      const dy = 1.4            - this.ent.mesh.position.y;
      const dz = player.position.z - this.ent.mesh.position.z;
      const dist = Math.hypot(dx, dz);
      const levelBonus = level >= 4 ? 1.4 : 1.0;
      // base velocity grows linearly with proximity
      const targetSpeed = (1.6 + (1 - Math.min(1, dist / 10)) * 3.0) * levelBonus;
      this.ent.vel = lerpV(this.ent.vel, targetSpeed, dt * 0.8);

      // Direction with tiny lateral wobble
      const wob = Math.sin(performance.now() * 0.003) * 0.3;
      const tx = dx + (dz * wob);
      const tz = dz - (dx * wob);
      const m = Math.hypot(tx, tz) || 1;
      const normX = tx / m, normZ = tz / m;

      this.ent.mesh.position.x += normX * this.ent.vel * dt;
      this.ent.mesh.position.z += normZ * this.ent.vel * dt;
      this.ent.mesh.position.y += dy * dt * 1.2;

      // Pulse the aura
      this.ent.pulsePhase += dt * 4;
      const pulse = 0.16 + 0.08 * Math.sin(this.ent.pulsePhase);
      this.ent.aura.material.opacity = pulse;
      this.ent.aura.scale.setScalar(1 + 0.08 * Math.sin(this.ent.pulsePhase * 0.7));

      return { mode: 'sphere', dx, dz, dist, y: this.ent.mesh.position.y };
    }

    if (this.ent.mode === 'wall') {
      // chase the player
      const dx = player.position.x - this.ent.mesh.position.x;
      const dz = player.position.z - this.ent.mesh.position.z;
      const distXZ = Math.hypot(dx, dz);
      // Speed: faster than the sphere; level 10 triviality.
      const speed = 3.5;
      const m = distXZ || 1;
      this.ent.mesh.position.x += (dx / m) * speed * dt;
      this.ent.mesh.position.z += (dz / m) * speed * dt;
      // Face the player
      this.ent.mesh.lookAt(player.position);
      return { mode: 'wall', dx, dz, dist: distXZ, y: 0 };
    }
  }

  /** Has the demon reached the player? */
  hits(player, level) {
    if (!this.ent) return false;
    if (this.ent.mode === 'wall') {
      // Distance check along the wall direction
      return hasWallHit(this.ent.mesh, player.position);
    }
    const dx = player.position.x - this.ent.mesh.position.x;
    const dz = player.position.z - this.ent.mesh.position.z;
    return Math.hypot(dx, dz) < 0.7;
  }

  remove() {
    if (this.ent) this._destroyEntity(this.ent);
    this.ent = null;
  }

  _destroyEntity(e) {
    this.root.remove(e.mesh);
    e.mesh.traverse(o => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) o.material.dispose();
    });
  }
  _destroyDecoy(d) {
    this.root.remove(d.mesh);
    if (d.mesh.geometry) d.mesh.geometry.dispose();
    if (d.mesh.material) d.mesh.material.dispose();
  }
}

function lerpV(a, b, t) { return a + (b - a) * t; }

function hasWallHit(wallMesh, playerPos) {
  // Project player onto the wall's plane (the face pointing at the player)
  // The wall has a quaternion that aligns its +Z with playerPos. Box is 40×8×0.5.
  const local = wallMesh.worldToLocal(playerPos.clone());
  return Math.abs(local.x) < 20 && Math.abs(local.y) < 4 && local.z > -0.4 && local.z < 0.4;
}
