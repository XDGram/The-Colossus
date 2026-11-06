import * as THREE from 'three';

/**
 * Pooled combat effects (Temple Warden boss): additive sprite particles, flat ground decals (telegraph markers,
 * scorch), and a few composite helpers (fire ring, burning strip, fireball, lightning bolt, teleport puff).
 * Sprites are Kenney's Particle Pack (CC0, see ASSET_CREDITS.md), tinted in code. Everything is created once and
 * reused; nothing is allocated per frame during a fight. Effects are bright by themselves so they read on Low
 * quality, where there is no bloom.
 */
export type FxTex = 'circle_03' | 'circle_05' | 'light_01' | 'flame_02' | 'flame_04' | 'fire_01' | 'fire_02' | 'smoke_04' | 'smoke_07'
  | 'spark_01' | 'spark_04' | 'spark_06' | 'scorch_02' | 'star_06' | 'trace_04' | 'twirl_02';
const NAMES: FxTex[] = ['circle_03', 'circle_05', 'light_01', 'flame_02', 'flame_04', 'fire_01', 'fire_02', 'smoke_04', 'smoke_07', 'spark_01', 'spark_04', 'spark_06', 'scorch_02', 'star_06', 'trace_04', 'twirl_02'];

export const FX_COLORS = {
  fire: new THREE.Color(1.0, 0.36, 0.05), fireCore: new THREE.Color(1.0, 0.78, 0.35), ember: new THREE.Color(0.85, 0.16, 0.02),
  storm: new THREE.Color(0.62, 0.42, 1.0), stormCore: new THREE.Color(0.93, 0.88, 1.0), smoke: new THREE.Color(0.1, 0.08, 0.12),
};

interface Particle {
  s: THREE.Sprite; m: THREE.SpriteMaterial; alive: boolean;
  vel: THREE.Vector3; grav: number; age: number; life: number;
  size0: number; size1: number; a0: number; a1: number; spin: number; stretch: number; follow: (() => THREE.Vector3) | null;
}
interface Decal { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; alive: boolean; age: number; life: number; fadeIn: number; fadeOut: number; alpha: number }

export class Vfx {
  readonly group = new THREE.Group();
  private tex = new Map<FxTex, THREE.Texture>();
  private parts: Particle[] = [];
  private decals: Decal[] = [];
  private plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private budget: number;
  /** Quality scales particle counts (Low: about half). */
  constructor(scene: THREE.Scene, tex: Map<FxTex, THREE.Texture>, readonly quality: 'high' | 'low') {
    this.tex = tex;
    this.budget = quality === 'high' ? 260 : 140;
    for (let i = 0; i < this.budget; i++) {
      // Not tone-mapped: the filmic curve would wash saturated fire/lightning out to dull tan / white.
      const m = new THREE.SpriteMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, toneMapped: false });
      const s = new THREE.Sprite(m); s.visible = false; s.renderOrder = 10; this.group.add(s);
      this.parts.push({ s, m, alive: false, vel: new THREE.Vector3(), grav: 0, age: 0, life: 1, size0: 1, size1: 1, a0: 1, a1: 0, spin: 0, stretch: 1, follow: null });
    }
    for (let i = 0; i < 40; i++) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, fog: false, toneMapped: false });
      const mesh = new THREE.Mesh(this.plane, mat); mesh.visible = false; mesh.renderOrder = 9; this.group.add(mesh);
      this.decals.push({ mesh, mat, alive: false, age: 0, life: 1, fadeIn: 0, fadeOut: 0, alpha: 1 });
    }
    scene.add(this.group);
  }
  static async load(base: string, scene: THREE.Scene, quality: 'high' | 'low') {
    const tl = new THREE.TextureLoader(), tex = new Map<FxTex, THREE.Texture>();
    await Promise.all(NAMES.map(async (n) => { const t = await tl.loadAsync(`${base}assets/fx/${n}.webp`); t.colorSpace = THREE.SRGBColorSpace; tex.set(n, t); }));
    return new Vfx(scene, tex, quality);
  }
  private n(count: number) { return Math.max(1, Math.round(this.quality === 'high' ? count : count * 0.55)); }

  // ------------------------------------------------------------------ primitives
  /** One sprite particle. Returns it (or null when the pool is exhausted). */
  spawn(tex: FxTex, pos: THREE.Vector3, o: { color: THREE.Color; life: number; size: number; size1?: number; alpha?: number; alpha1?: number;
    vel?: THREE.Vector3; grav?: number; spin?: number; stretch?: number; follow?: () => THREE.Vector3; rot?: number }) {
    const p = this.parts.find((x) => !x.alive); if (!p) return null;
    p.alive = true; p.age = 0; p.life = o.life; p.size0 = o.size; p.size1 = o.size1 ?? o.size; p.a0 = o.alpha ?? 1; p.a1 = o.alpha1 ?? 0;
    p.vel.copy(o.vel ?? new THREE.Vector3()); p.grav = o.grav ?? 0; p.spin = o.spin ?? 0; p.stretch = o.stretch ?? 1; p.follow = o.follow ?? null;
    p.m.map = this.tex.get(tex)!; p.m.color.copy(o.color); p.m.rotation = o.rot ?? Math.random() * Math.PI * 2; p.m.needsUpdate = true;
    p.s.position.copy(pos); p.s.visible = true;
    return p;
  }
  /** A burst of particles from a point. */
  burst(tex: FxTex, pos: THREE.Vector3, o: { count: number; color: THREE.Color; life: number; size: number; size1?: number; speed: number; up?: number; spread?: number; grav?: number; alpha?: number }) {
    for (let i = 0; i < this.n(o.count); i++) {
      const a = Math.random() * Math.PI * 2, e = (Math.random() - 0.3) * (o.spread ?? 1);
      const v = new THREE.Vector3(Math.cos(a), e, Math.sin(a)).normalize().multiplyScalar(o.speed * (0.4 + Math.random() * 0.6));
      v.y += o.up ?? 0;
      this.spawn(tex, pos.clone().addScaledVector(v, 0.05), { color: o.color, life: o.life * (0.7 + Math.random() * 0.6), size: o.size, size1: o.size1, vel: v, grav: o.grav, alpha: o.alpha, spin: (Math.random() - 0.5) * 3 });
    }
  }
  /** A flat ground decal. `life` < 0 keeps it until killed. */
  decal(tex: FxTex, pos: THREE.Vector3, o: { color: THREE.Color; size: number; life: number; fadeIn?: number; fadeOut?: number; alpha?: number; yaw?: number; length?: number }) {
    const d = this.decals.find((x) => !x.alive); if (!d) return null;
    d.alive = true; d.age = 0; d.life = o.life; d.fadeIn = o.fadeIn ?? 0.08; d.fadeOut = o.fadeOut ?? 0.25; d.alpha = o.alpha ?? 1;
    d.mat.map = this.tex.get(tex)!; d.mat.color.copy(o.color); d.mat.opacity = 0; d.mat.needsUpdate = true;
    d.mesh.position.set(pos.x, pos.y + 0.035, pos.z); d.mesh.rotation.set(0, o.yaw ?? 0, 0);
    d.mesh.scale.set(o.size, 1, o.length ?? o.size); d.mesh.visible = true;
    return d;
  }
  kill(d: Decal | null) { if (d && d.alive) { d.life = d.age + d.fadeOut; } }

  update(dt: number) {
    for (const p of this.parts) {
      if (!p.alive) continue;
      p.age += dt;
      if (p.age >= p.life) { p.alive = false; p.s.visible = false; continue; }
      const k = p.age / p.life;
      if (p.follow) p.s.position.copy(p.follow());
      else { p.vel.y -= p.grav * dt; p.s.position.addScaledVector(p.vel, dt); }
      const sz = THREE.MathUtils.lerp(p.size0, p.size1, k);
      p.s.scale.set(sz, sz * p.stretch, 1);
      p.m.rotation += p.spin * dt;
      p.m.opacity = THREE.MathUtils.lerp(p.a0, p.a1, k) * Math.min(1, p.age / 0.04);
    }
    for (const d of this.decals) {
      if (!d.alive) continue;
      d.age += dt;
      if (d.life >= 0 && d.age >= d.life) { d.alive = false; d.mesh.visible = false; continue; }
      const fin = Math.min(1, d.age / Math.max(1e-3, d.fadeIn));
      const fout = d.life >= 0 ? Math.min(1, (d.life - d.age) / Math.max(1e-3, d.fadeOut)) : 1;
      d.mat.opacity = d.alpha * fin * fout;
    }
  }

  // ------------------------------------------------------------------ composites
  /** Flickering flame sprites at a point (call every frame for a sustained fire). */
  flame(pos: THREE.Vector3, size: number, intensity = 1) {
    const core = Math.random() < 0.3;
    this.spawn(core ? 'fire_01' : Math.random() < 0.5 ? 'flame_02' : 'flame_04', pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.2, 0, (Math.random() - 0.5) * 0.2)),
      { color: (core ? FX_COLORS.fireCore : FX_COLORS.fire).clone().multiplyScalar(intensity), life: 0.3, size: size * (core ? 0.5 : 0.7), size1: size * 0.25, vel: new THREE.Vector3(0, 1.8, 0), alpha: 0.85, stretch: 1.6 });
  }
  /** A fireball's glow at `pos` this frame plus a short trail. */
  orb(pos: THREE.Vector3) {
    this.spawn('circle_05', pos, { color: FX_COLORS.fireCore, life: 0.05, size: 0.9, alpha: 1, alpha1: 1 });
    this.spawn('fire_01', pos, { color: FX_COLORS.fire, life: 0.18, size: 0.55, size1: 0.2, alpha: 1, spin: 6 });
  }
  /** Lightning strike: a tall flickering bolt, a white flash, sparks and a lingering scorch. */
  bolt(ground: THREE.Vector3, height = 9) {
    const mid = ground.clone().setY(ground.y + height / 2);
    // Narrow jagged bolt (Kenney spark_06 is a vertical lightning streak): a violet outer bolt and a white core.
    this.spawn('spark_06', mid, { color: FX_COLORS.storm, life: 0.3, size: 0.9, stretch: height / 0.9, alpha: 1, alpha1: 0, rot: 0 });
    this.spawn('spark_06', mid.clone().add(new THREE.Vector3(0.05, 0, 0)), { color: FX_COLORS.stormCore, life: 0.18, size: 0.45, stretch: height / 0.45, alpha: 1, alpha1: 0, rot: Math.PI });
    this.spawn('circle_05', ground.clone().setY(ground.y + 0.4), { color: FX_COLORS.storm, life: 0.25, size: 2.6, size1: 1.2, alpha: 0.9 });
    this.burst('spark_04', ground.clone().setY(ground.y + 0.2), { count: 14, color: FX_COLORS.storm, life: 0.35, size: 0.5, size1: 0.1, speed: 6, up: 2, grav: 9 });
    this.decal('scorch_02', ground, { color: FX_COLORS.storm.clone().multiplyScalar(0.6), size: 2.6, life: 1.6, fadeIn: 0.02, fadeOut: 1.0 });
  }
  /** Teleport: dark smoke and violet sparks where he vanishes or reappears, with a bright flash on arrival. */
  puff(pos: THREE.Vector3, arrive: boolean) {
    const c = pos.clone().setY(pos.y + 1.0);
    this.burst('smoke_07', c, { count: 9, color: FX_COLORS.smoke, life: 0.7, size: 1.2, size1: 2.2, speed: 1.4, up: 0.6, alpha: 0.9 });
    this.burst('spark_01', c, { count: 12, color: FX_COLORS.storm, life: 0.45, size: 0.35, size1: 0.05, speed: 4, up: 1 });
    if (arrive) this.spawn('star_06', c, { color: FX_COLORS.stormCore, life: 0.25, size: 2.6, size1: 0.8, alpha: 1 });
  }
}
