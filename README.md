# Superposition Backrooms

A first-person quantum-horror game. Walk through a collapsing simulation while a
"probability demon" — the **Red Sphere** — manifests in your forward path.
Survive ten levels of increasing decay until you reach the stable blue door.

## Quick Start

```bash
npm install
npm start
```

Then open `http://localhost:3000`. Click **Initialize Simulation** (this also
unlocks the Web Audio context and requests full-screen).

> **No external CDNs are required.** Three.js is vendored at
> `public/vendor/three/three.module.js` (~1.27 MB) so the game runs even when
> the deployment network can't reach `cdn.jsdelivr.net`.

## Controls

| Action    | PC                                | Mobile                       |
|-----------|-----------------------------------|------------------------------|
| Move      | **W A S D**                       | left joystick                |
| Look      | mouse (click canvas to lock)      | right joystick               |
| Sprint    | **Shift** (drains sanity faster)  | (hold left joystick far)     |
| Reload    | **R** (escape, yes/no prompts)    | (browser refresh)            |

> On a touchscreen device, the joysticks automatically appear. Their movement
> vectors are camera-relative — pushing "up" on the joystick always means
> forward, regardless of whether the phone is in portrait or landscape.

## Deploy on Railway

1. Push this repo to GitHub.
2. In Railway, click **New Project → Deploy from GitHub Repo**, select this repo.
3. Railway auto-detects `npm start` and binds `$PORT` from env. **No env vars
   need to be set; the server defaults to 0.0.0.0:$PORT.**
4. **Important:** the game loads three.js from `cdn.jsdelivr.net`. Make sure
   the deployment environment allows outbound HTTPS to jsDelivr. Railway does
   this by default.

## Game architecture

```
public/
  index.html    — game shell, HUD, loader UI
  style.css     — CRT/glitch/vignette styling
  game.js       — main loop, scene, controls, HUD
  audio.js      — procedural WebAudio engine (no .mp3 files!)
  world.js      — corridor factory + Observer-Effect reshuffling
  monster.js    — Probability Demon (sphere and Red-Shift wall variants)
  levels.js     — the 9 levels in the Decay Sequence
  binaryrain.js — Matrix-style loader effect (real DOM, not faked)
  utils.js      — math helpers
```

All audio is synthesized with the WebAudio API, so the bundle is ~30 KB of
JS — no shipping binary audio assets. The engine fakes being a real
dynamically-mixed engine with:

* **ambient drone** — sawtooth pair into bandpass LF (level-tuned pitch)
* **monster hum** — binaural stereo panned, pitch climbs as it closes
* **heartbeat** — pulse-triggered noise + sine sub, period driven by sanity
* **footstep** — noise burst + bass thump
* **glitch / static burst** — bandpass-resonant noise chuffs
* **whisper** — sweeping filtered pink noise
* **chime / death** — multi-osc chord envelopes

## The Observer Effect in code

```js
applyObserverEffect(playerPos, yaw) {
  // For every tile within fog range:
  //   * if it's in the player's current forward 90° cone, refresh it
  //   * if not, mark it STALE
  //   * if the player turns big (>20° yaw travel since last frame)
  //     AND the tile is currently IN CONE (player looked back at it),
  //     AND it's been stale for >250 ms -> rebuild it with a new RNG seed.
}
```

The hash that's used for each tile's wall-layout is
`mulberry32(seed * 91 + index * 1301 + floor(regenDist * 17))`. As
`regenDist` accumulates, the geometry slowly varies; combined with the
"big turn" trigger, the world literally reshuffles around the observer.

## Levels

| # | Name                  | Theme               | Stability | Audio           |
|---|-----------------------|---------------------|-----------|-----------------|
| 0 | Ground State          | yellow wallpaper    | 100%      | fluorescent hum |
| 1 | Tunneling Effect      | dark concrete        |  95%      | industrial drone|
| 2 | Blocked Ducts         | AC duct / engine    |  90%      | warm hum        |
| 3 | High-Voltage Station  | electric green      |  85%      | high-tension LF |
| 4 | Abandoned Office      | beige office        |  80%      | empty quiet     |
| 5 | The Hotel             | brick/warm          |  72%      | felt warmth     |
| 6 | Dark Matter           | pitch black         |  60%      | no reverb, void |
| ! | Red Shift             | emergency corridor  |  40%      | sirens          |
|10 | The Singularity       | glitch/UV           |  25%      | broken chord    |

## License

MIT.
