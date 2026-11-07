import * as THREE from 'three';

/**
 * Lightweight game audio (approved for the boss and abilities): one shared Web Audio context, unlocked on the first
 * user input (required on mobile browsers); sounds decoded once at load; a per-sound voice cap and minimum gap so
 * repeated hits don't stack; simple distance falloff and stereo pan from the camera. Scope: combat sound effects
 * only. Files: public/assets/audio (CC0, see ASSET_CREDITS.md).
 */
export type SoundName = 'tell' | 'whoosh' | 'vanish' | 'appear' | 'fireCharge' | 'fireWave' | 'fireball' | 'flame'
  | 'stormCall' | 'stormMark' | 'thunder' | 'roar'
  // Player abilities (docs/abilities.md).
  | 'spiritDash' | 'spiritAppear' | 'spiritCut' | 'riftCharge' | 'riftRelease' | 'riftHit' | 'ruptureCharge' | 'ruptureBoom' | 'ruptureQuake' | 'debris'
  // Enemy battle cries (attack warnings from off screen) and the realm transition (storm wind, rising rumble).
  | 'cry' | 'cry2' | 'wind' | 'riser'
  // The Temple Warden's voice lines (synthesised from the CC0 "Joe" Piper voice, deepened; see ASSET_CREDITS.md).
  | VoiceLine;
export type VoiceLine = 'w_intro' | 'w_finish' | 'w_raid1' | 'w_raid2' | 'w_raid3' | 'w_final' | 'w_burn' | 'w_storm';
export const VOICE: VoiceLine[] = ['w_intro', 'w_finish', 'w_raid1', 'w_raid2', 'w_raid3', 'w_final', 'w_burn', 'w_storm'];
const FILES: SoundName[] = [...VOICE, 'cry', 'cry2', 'wind', 'riser', 'tell', 'whoosh', 'vanish', 'appear', 'fireCharge', 'fireWave', 'fireball', 'flame', 'stormCall', 'stormMark', 'thunder', 'roar',
  'spiritDash', 'spiritAppear', 'spiritCut', 'riftCharge', 'riftRelease', 'riftHit', 'ruptureCharge', 'ruptureBoom', 'ruptureQuake', 'debris'];
/** Per-sound mix level and overlap limits. */
const MIX: Partial<Record<SoundName, { gain?: number; max?: number; gap?: number }>> = {
  tell: { gain: 0.55, max: 2, gap: 0.12 }, whoosh: { gain: 0.6 }, stormMark: { gain: 0.6, max: 3 },
  flame: { gain: 0.5, max: 2, gap: 0.3 }, fireball: { gain: 0.7, max: 3 }, thunder: { gain: 0.95, max: 3 }, roar: { gain: 0.9 },
  spiritDash: { gain: 1.0 }, spiritAppear: { gain: 0.8 }, spiritCut: { gain: 0.85, max: 4, gap: 0.03 }, riftCharge: { gain: 0.75 }, riftRelease: { gain: 0.95 },
  riftHit: { gain: 0.8, max: 4, gap: 0.04 }, ruptureCharge: { gain: 0.8 }, ruptureBoom: { gain: 1.0 }, ruptureQuake: { gain: 0.7 }, debris: { gain: 0.5, max: 3, gap: 0.08 },
  cry: { gain: 0.75, max: 2, gap: 0.25 }, cry2: { gain: 0.75, max: 2, gap: 0.25 }, wind: { gain: 1.0, max: 1 }, riser: { gain: 0.6, max: 1 },
  // The Warden's voice sits clearly above the music and effects (the music also dips while he speaks).
  ...Object.fromEntries(VOICE.map((v) => [v, { gain: 1.6, max: 1, gap: 0.5 }])),
};

export class GameAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private buffers = new Map<SoundName, AudioBuffer>();
  private playing = new Map<SoundName, { at: number; n: number }>();
  private raw = new Map<SoundName, ArrayBuffer>();
  volume = 0.8;
  constructor(private camera: THREE.Camera) {}

  /** Fetches the files (decoding waits for the context, which needs a user gesture on some browsers). */
  async load(base: string) {
    await Promise.all(FILES.map(async (n) => {
      try { const r = await fetch(`${base}assets/audio/${n}.mp3`); if (r.ok) this.raw.set(n, await r.arrayBuffer()); } catch { /* sound is optional */ }
    }));
    const unlock = () => { this.unlock(); removeEventListener('pointerdown', unlock); removeEventListener('keydown', unlock); removeEventListener('touchstart', unlock); };
    addEventListener('pointerdown', unlock); addEventListener('keydown', unlock); addEventListener('touchstart', unlock);
  }
  private unlock() {
    if (this.ctx) { void this.ctx.resume(); return; }
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC(); this.master = this.ctx.createGain(); this.master.gain.value = this.volume;
    // A gentle limiter on the mix, so a loud voice line over effects never distorts.
    const lim = this.ctx.createDynamicsCompressor();
    lim.threshold.value = -6; lim.knee.value = 6; lim.ratio.value = 12; lim.attack.value = 0.003; lim.release.value = 0.15;
    this.master.connect(lim).connect(this.ctx.destination);
    this.routeMusic();
    // Phones suspend audio after interruptions (calls, app switches): resume on the next touch or key.
    const resume = () => { if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume(); };
    for (const ev of ['pointerdown', 'touchstart', 'keydown']) addEventListener(ev, resume, { passive: true });
    for (const [n, data] of this.raw) this.ctx.decodeAudioData(data.slice(0)).then((b) => this.buffers.set(n, b)).catch(() => {});
  }

  /**
   * Route a music track through the mixer so its volume can be set everywhere (iPhone Safari ignores the volume of
   * an audio element). `setVolume` then drives a gain node; before the context exists it falls back to the element.
   */
  private musicGains = new Map<HTMLAudioElement, GainNode>();
  private musicWanted: HTMLAudioElement[] = [];
  attachMusic(el: HTMLAudioElement) { this.musicWanted.push(el); if (this.ctx) this.routeMusic(); }
  private routeMusic() {
    const ctx = this.ctx!;
    for (const el of this.musicWanted.splice(0)) {
      try {
        const src = ctx.createMediaElementSource(el), g = ctx.createGain();
        g.gain.value = el.volume; el.volume = 1;
        src.connect(g).connect(ctx.destination);
        this.musicGains.set(el, g);
      } catch { /* not supported: the element's own volume is used */ }
    }
  }
  setVolume(el: HTMLAudioElement, v: number) {
    const g = this.musicGains.get(el);
    if (g) g.gain.value = v; else { try { el.volume = v; } catch { /* fixed */ } }
  }
  /** Length of a sound in seconds (0 until it is decoded). */
  duration(name: SoundName) { return this.buffers.get(name)?.duration ?? 0; }
  /** Play a sound, optionally positioned in the world (falloff and pan relative to the camera). */
  play(name: SoundName, at?: THREE.Vector3) {
    const ctx = this.ctx, buf = this.buffers.get(name);
    if (!ctx || !buf || !this.master || ctx.state !== 'running') return;
    const mix = MIX[name] ?? {}, now = ctx.currentTime, st = this.playing.get(name) ?? { at: -99, n: 0 };
    if (now - st.at < (mix.gap ?? 0.06) || st.n >= (mix.max ?? 4)) return;
    st.at = now; st.n++; this.playing.set(name, st);
    let gain = mix.gain ?? 0.8, pan = 0;
    if (at) {
      const cam = this.camera.getWorldPosition(new THREE.Vector3()), d = cam.distanceTo(at);
      gain *= 1 / (1 + Math.max(0, d - 4) * 0.08);
      const rel = at.clone().applyMatrix4(this.camera.matrixWorldInverse);
      pan = THREE.MathUtils.clamp(rel.x / Math.max(2, Math.abs(rel.z)), -0.8, 0.8);
    }
    const src = ctx.createBufferSource(); src.buffer = buf;
    src.playbackRate.value = name.startsWith('w_') ? 1 : 0.96 + Math.random() * 0.08;  // slight variation on repeats (not speech)
    const g = ctx.createGain(); g.gain.value = gain;
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
    if (p) { p.pan.value = pan; src.connect(g).connect(p).connect(this.master); } else src.connect(g).connect(this.master);
    src.onended = () => { const s = this.playing.get(name); if (s) s.n = Math.max(0, s.n - 1); };
    src.start();
  }
}
