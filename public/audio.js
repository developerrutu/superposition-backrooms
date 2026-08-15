/**
 * Procedural audio engine.
 *
 * Everything is synthesized with the WebAudio API, so we never have to ship
 * binary audio files and we can dynamically tune the horror soundscape
 * frame-by-frame (distance-pan a monster, pitch-shift a hum, glitch-out a
 * static burst, etc.).
 *
 * The engine has four concerns:
 *
 *   1. ambient drone — a low monotone the level drops beneath everything
 *   2. monster hum    — a positional binaural drone tied to a 3D point
 *   3. one-shots      — footsteps, glitche, heartbeats, doors, whispers
 *   4. master bus     — a single gain that responds to sanity / vignette
 */

const PI2 = Math.PI * 2;

export class AudioEngine {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.music = null;
    this.ambient = null;
    this.monsterBus = null;
    this.heartBus = null;
    this.lastHFreqAt = 0;
    this.lastFootstepAt = 0;
    this.started = false;

    // Heartbeat scheduling state
    this._heartEnabled = false;
    this._heartTimer = 0;
    this._heartPhase = 0;

    // We make sure the engine survives a runtime iOS interruption etc.
    this._noiseBuffer = null;
  }

  /** Create the AudioContext. Browsers gate context creation behind a user
   *  gesture (pointerdown/etc.), so this MUST be called from the init-btn
   *  click or equivalent. After this, every other method is safe to call. */
  init() {
    if (this.started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    this.ctx = new AC({ latencyHint: 'interactive' });
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }

    // Pre-build a 2-second pink-ish noise buffer used as a raw ingredient
    // for footsteps, static, whispers, and the room hum.
    this._noiseBuffer = this._buildNoiseBuffer(2.0);

    this.master   = this.ctx.createGain(); this.master.gain.value = 0.7;
    this.music    = this.ctx.createGain(); this.music.gain.value  = 0.0; // we use ambient + monster
    this.ambient  = this.ctx.createGain(); this.ambient.gain.value = 0.0;
    this.monsterBus = this.ctx.createGain(); this.monsterBus.gain.value = 0.0;
    this.heartBus   = this.ctx.createGain(); this.heartBus.gain.value   = 0.0;

    this.ambient.connect(this.master);
    this.monsterBus.connect(this.master);
    this.heartBus.connect(this.master);
    this.master.connect(this.ctx.destination);

    this.started = true;
  }

  /** Make a buffer of pinkish noise. Pink noise has more energy in the lows,
   *  which gives a kind of "warm static" — much creepier than pure white. */
  _buildNoiseBuffer(seconds) {
    const sr = this.ctx.sampleRate;
    const length = (sr * seconds) | 0;
    const buf = this.ctx.createBuffer(1, length, sr);
    const data = buf.getChannelData(0);
    let b0=0, b1=0, b2=0, b3=0, b4=0, b5=0, b6=0;
    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
    }
    return buf;
  }

  /** Resume the context if a tab was background-ed. */
  unlock() {
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
  }

  /** Sudden loud adrenaline burst — triggered on monster-spawn. */
  setMasterAmpMul(m) {
    if (this.master) this.master.gain.value = clampMaster(m);
  }
  getMasterAmp() { return this.master ? this.master.gain.value : 0.7; }

  // ---------------------------------------------------------------- AMBIENT

  /** Start a low drone appropriate for the current level.
   *  Detuning two slightly-detuned oscillators into a bandpass creates the
   *  slow "siren" sound; pink noise adds texture; an LFO modulates filter
   *  cutoff so it sounds *alive*. */
  startAmbient(level) {
    if (!this.started) return;
    this.stopAmbient();

    const ctx = this.ctx;
    const dst = this.ambient;
    const freqBase = levelAmbientFreq(level);

    // Sig 1: dual pitch slightly detuned
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o1.type = 'sawtooth'; o2.type = 'sawtooth';
    o1.frequency.value = freqBase;
    o2.frequency.value = freqBase * 1.005;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 240;
    lp.Q.value = 8;

    const lfo = ctx.createOscillator();
    const lfoGain = ctx.createGain();
    lfo.frequency.value = 0.07;
    lfoGain.gain.value = 80;
    lfo.connect(lfoGain);
    lfoGain.connect(lp.frequency);

    o1.connect(lp); o2.connect(lp); lp.connect(dst);

    // Sig 2: pink-noise hiss, level-modulated
    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer; noise.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass'; nf.frequency.value = 600; nf.Q.value = 1.5;
    const ng = ctx.createGain(); ng.gain.value = 0.18;
    noise.connect(nf); nf.connect(ng); ng.connect(dst);

    // Sig 3: a slow chord tone — fifth
    const o3 = ctx.createOscillator();
    o3.type = 'sine'; o3.frequency.value = freqBase * 0.5; // octave down
    const o3g = ctx.createGain(); o3g.gain.value = 0.06;
    o3.connect(o3g); o3g.connect(dst);

    const t = ctx.currentTime;
    dst.gain.cancelScheduledValues(t);
    dst.gain.setValueAtTime(0, t);
    dst.gain.linearRampToValueAtTime(levelAmbientGain(level), t + 1.5);

    o1.start(t); o2.start(t); lfo.start(t); noise.start(t); o3.start(t);

    this._ambientNodes = { o1, o2, lfo, noise, o3 };
  }

  stopAmbient() {
    if (!this.started || !this.ambient) return;
    const t = this.ctx.currentTime;
    this.ambient.gain.cancelScheduledValues(t);
    this.ambient.gain.linearRampToValueAtTime(0, t + 0.4);
    if (this._ambientNodes) {
      const nodes = this._ambientNodes;
      delete this._ambientNodes;
      setTimeout(() => {
        try { Object.values(nodes).forEach(n => n.stop && n.stop()); } catch (e) {}
      }, 600);
    }
  }

  // ----------------------------------------------------------- MONSTER HUM

  /** The monster has a moving 3D point; we feed its position relative to the
   *  player to a PannerNode-equivalent setup: a StereoPannerNode + a gain
   *  modulator. The volume curve ramps in sharply between 6 and 0.6 units
   *  so it stays *just* audible at long range, dominant when close. */
  startMonster() {
    if (!this.started || this._monsterNodes) return;
    const ctx = this.ctx;
    const dst = this.monsterBus;

    // Two oscillators, fundamental + perfect fifth — dissonant / uncanny.
    const o1 = ctx.createOscillator();
    const o2 = ctx.createOscillator();
    o1.type = 'sawtooth'; o2.type = 'sine';
    o1.frequency.value = 70;
    o2.frequency.value = 105; // perfect fifth, with beatings
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 220; lp.Q.value = 6;
    o1.connect(lp); o2.connect(lp);

    // LFO drives pitch slowly up and down — keeps things unstable.
    const lfo = ctx.createOscillator();
    const lfoG = ctx.createGain();
    lfo.frequency.value = 3.5; lfoG.gain.value = 8;
    lfo.connect(lfoG); lfoG.connect(o1.frequency);

    // Layered white-noise hiss at a different center freq → adds menace.
    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer; noise.loop = true;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass'; nf.frequency.value = 220; nf.Q.value = 5;
    const ng = ctx.createGain(); ng.gain.value = 0.25;
    noise.connect(nf); nf.connect(ng);

    // StereoPan + distance gain go last.
    const pan = ctx.createStereoPanner();
    const dg = ctx.createGain(); dg.gain.value = 0.0;
    lp.connect(pan); ng.connect(pan);
    pan.connect(dg); dg.connect(dst);

    const t = ctx.currentTime;
    dst.gain.cancelScheduledValues(t);
    dst.gain.setValueAtTime(0, t);
    dst.gain.linearRampToValueAtTime(1, t + 0.7);

    o1.start(t); o2.start(t); lfo.start(t); noise.start(t);

    this._monsterNodes = { o1, o2, lfo, noise, pan, dg, lp };
  }

  /** Continuously update monster positional audio.   `dist` is the distance
   *  in world units from the monster to the player.  `dx` is the horizontal
   *  offset: positive = monster on the right of the player. */
  updateMonster(dist, dx) {
    if (!this._monsterNodes) return;
    const { dg, pan, o1, lp } = this._monsterNodes;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    // Distance-to-gain: 1.0 at 0.8 units, asymptotes to 0.05 at 6 units.
    // Curve: gain = 1/(1+dist^1.4) * 0.95 + 0.05
    const dd = Math.max(0.4, dist);
    const g = (1 / (1 + Math.pow(dd, 1.4))) * 0.95 + 0.05;
    const target = Math.max(0.05, Math.min(1.0, g));
    dg.gain.setTargetAtTime(target, t, 0.12);

    // Stereo pan: -1 .. +1. Add a sign-flip on landscape for stereo mode
    // because some browsers get weird about panning depth. Clamped.
    const p = Math.max(-1, Math.min(1, dx / 4));
    pan.pan.setTargetAtTime(p, t, 0.18);

    // Pitch climbs as the demon closes.
    const pitch = 70 + (1 - g) * 80; // 70 baseline, up to ~150 close-in
    o1.frequency.setTargetAtTime(pitch, t, 0.2);

    // Filter opens up as distance shrinks — opening up releases more bass.
    const cutoff = 220 + (1 - g) * 380;
    lp.frequency.setTargetAtTime(cutoff, t, 0.2);
  }

  stopMonster() {
    if (!this._monsterNodes) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    this.monsterBus.gain.cancelScheduledValues(t);
    this.monsterBus.gain.linearRampToValueAtTime(0, t + 0.4);
    const nodes = this._monsterNodes;
    delete this._monsterNodes;
    setTimeout(() => {
      try { Object.values(nodes).forEach(n => n.stop && n.stop()); } catch (e) {}
    }, 600);
  }

  // -------------------------------------------------------------- ONE-SHOTS

  /** Procedural footstep — short bursts of low-passed noise + click thump. */
  playFootstep(roughness = 1.0) {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    if (t - this.lastFootstepAt < 0.18) return; // rate-limit
    this.lastFootstepAt = t;

    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass'; filter.frequency.value = 220 * roughness;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.3, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);

    noise.connect(filter); filter.connect(g); g.connect(this.master);
    noise.start(t); noise.stop(t + 0.25);
  }

  /** Static-like radio glitch — short noise burst through resonant bandpass. */
  playGlitch() {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1500 + Math.random() * 2200;
    filter.Q.value = 15;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.18, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
    noise.connect(filter); filter.connect(g); g.connect(this.master);
    noise.start(t); noise.stop(t + 0.1);
  }

  /** Heartbeat: low boom + soft click. Called repeatedly by the scheduler. */
  playHeartbeat(strong) {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const low = ctx.createOscillator();
    low.frequency.value = strong ? 50 : 65;
    low.type = 'sine';
    const lg = ctx.createGain();
    lg.gain.setValueAtTime(0, t);
    lg.gain.linearRampToValueAtTime(strong ? 0.5 : 0.25, t + 0.02);
    lg.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
    low.connect(lg); lg.connect(this.heartBus);
    low.start(t); low.stop(t + 0.4);

    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer;
    const nf = ctx.createBiquadFilter();
    nf.type = 'bandpass'; nf.frequency.value = 90; nf.Q.value = 2;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0, t);
    ng.gain.linearRampToValueAtTime(0.12, t + 0.005);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
    noise.connect(nf); nf.connect(ng); ng.connect(this.heartBus);
    noise.start(t); noise.stop(t + 0.2);
  }

  /** Soft whisper: slow amplitude-shaped pink noise through a bandpass. */
  playWhisper() {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const noise = ctx.createBufferSource();
    noise.buffer = this._noiseBuffer;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1400;
    f.Q.value = 12;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05, t + 0.4);
    g.gain.linearRampToValueAtTime(0, t + 1.6);
    noise.connect(f); f.connect(g); g.connect(this.master);
    noise.start(t); noise.stop(t + 1.8);
  }

  /** The "exit discovered" tone: high triad arpeggio. */
  playChime() {
    if (!this.started) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    [523.25, 659.25, 783.99].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.type = 'triangle';
      const g = ctx.createGain();
      const t = t0 + i * 0.08;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.18, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 1.6);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + 1.8);
    });
  }

  /** Death sting: detuned chord blasting into distortion. */
  playDeath() {
    if (!this.started) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const freqs = [40, 70, 130, 220];
    freqs.forEach((f, i) => {
      const o = ctx.createOscillator();
      o.frequency.value = f;
      o.type = ['sine', 'sawtooth', 'square', 'sine'][i];
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.4, t + 0.05);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 2.5);
      o.connect(g); g.connect(this.master);
      o.start(t); o.stop(t + 2.6);
    });
  }

  /** Continuous heartbeat scheduler — call from update(dt). */
  updateHeartbeat(dt, enabled, period) {
    this._heartEnabled = enabled;
    if (!enabled) { this._heartTimer = 0; this.heartBus.gain.value = 0; return; }
    const t = this.ctx.currentTime;
    this.heartBus.gain.value = 0.6;
    this._heartTimer += dt;
    if (this._heartTimer >= period) {
      this._heartTimer = 0;
      this.playHeartbeat(period < 0.7);
    }
  }
}

function clampMaster(m) { return Math.max(0, Math.min(1.2, m)); }

/** Frequency of the drone for each level — used to make the soundscape
 *  feel like *progressing* deeper, not looping. */
function levelAmbientFreq(level) {
  if (level === 0)   return 110; // fluorescent hum region
  if (level === 1)   return 75;  // industrial
  if (level >= 3 && level <= 6) return 65;
  if (level === 'dark' || level === 6) return 45;
  if (level === 'red')  return 55;
  if (level === 10) return 30;
  return 60;
}

function levelAmbientGain(level) {
  if (level === 'red') return 0.6;
  if (level === 'dark' || level === 6) return 0.45;
  return 0.45;
}
