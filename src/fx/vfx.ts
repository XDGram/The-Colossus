import * as THREE from 'three';

/**
 * Pooled combat effects (Temple Warden boss, player abilities): camera-facing particles, flat ground decals
 * (telegraph markers, scorch), and a few composite helpers (fire ring, burning strip, fireball, lightning bolt,
 * teleport puff). Sprites are Kenney's Particle Pack (CC0, see ASSET_CREDITS.md), tinted in code.
 *
 * Performance: every particle is drawn by ONE instanced mesh per blend mode (additive glow, alpha-blended dust),
 * all sprites packed into one atlas, so a screen full of effects costs two draw calls instead of one per particle.
 * Everything is created once and reused: nothing is allocated per frame during a fight. Effects are bright by
 * themselves so they read on Low quality, where there is no bloom.
 */
export type FxTex = 'circle_03' | 'circle_05' | 'light_01' | 'flame_02' | 'flame_04' | 'fire_01' | 'fire_02' | 'smoke_04' | 'smoke_07'
  | 'spark_01' | 'spark_04' | 'spark_06' | 'scorch_02' | 'star_06' | 'trace_04' | 'twirl_02';
const NAMES: FxTex[] = ['circle_03', 'circle_05', 'light_01', 'flame_02', 'flame_04', 'fire_01', 'fire_02', 'smoke_04', 'smoke_07', 'spark_01', 'spark_04', 'spark_06', 'scorch_02', 'star_06', 'trace_04', 'twirl_02'];
const GRID = 4, CELL = 256;

export const FX_COLORS = {
  fire: new THREE.Color(1.0, 0.36, 0.05), fireCore: new THREE.Color(1.0, 0.78, 0.35), ember: new THREE.Color(0.85, 0.16, 0.02),
  storm: new THREE.Color(0.62, 0.42, 1.0), stormCore: new THREE.Color(0.93, 0.88, 1.0), smoke: new THREE.Color(0.1, 0.08, 0.12),
  // Player spirit energy (docs/abilities.md): white core graded through ice and cyan to deep blue. Never cream or red.
  spirit: new THREE.Color(0.31, 0.85, 1.0), spiritCore: new THREE.Color(0.86, 0.97, 1.0), spiritDeep: new THREE.Color(0.12, 0.36, 1.0),
  dust: new THREE.Color(0.55, 0.5, 0.44),
};

export interface Particle {
  alive: boolean; normal: boolean; cell: number; color: THREE.Color; pos: THREE.Vector3; rot: number;
  vel: THREE.Vector3; grav: number; drag: number; age: number; life: number;
  size0: number; size1: number; a0: number; a1: number; spin: number; stretch: number; follow: (() => THREE.Vector3) | null;
}
interface Decal { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; alive: boolean; age: number; life: number; fadeIn: number; fadeOut: number; alpha: number; spin: number; grow: number; size: number }
export type SpawnOpts = { color: THREE.Color; life: number; size: number; size1?: number; alpha?: number; alpha1?: number;
  vel?: THREE.Vector3; grav?: number; drag?: number; spin?: number; stretch?: number; follow?: () => THREE.Vector3; rot?: number;
  /** Alpha-blended (dust, smoke that should darken) instead of additive glow. */
  normal?: boolean };

const VERT = /* glsl */`
attribute vec3 iPos; attribute vec3 iSize; attribute vec4 iColor; attribute float iCell;
varying vec2 vUv; varying vec4 vColor;
uniform float uGrid;
void main() {
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  vec2 q = position.xy * vec2(iSize.x, iSize.x * iSize.y);   // scale (width, stretched height), then rotate
  float c = cos(iSize.z), s = sin(iSize.z);
  mv.xy += vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  gl_Position = projectionMatrix * mv;
  vec2 cell = vec2(mod(iCell, uGrid), floor(iCell / uGrid));
  vUv = (cell + uv) / uGrid;
  vColor = iColor;
}`;
const FRAG = /* glsl */`
uniform sampler2D uMap; uniform float uNormal;
varying vec2 vUv; varying vec4 vColor;
void main() {
  float l = pow(texture2D(uMap, vUv).r, 2.2);   // the sprites are sRGB-encoded greyscale
  // Additive: tint * luminance * alpha. Alpha-blended: the sprite's luminance is its coverage.
  gl_FragColor = uNormal > 0.5 ? vec4(vColor.rgb, l * vColor.a) : vec4(vColor.rgb * l * vColor.a, 1.0);
  #include <colorspace_fragment>
}`;

/** One instanced quad batch for a blend mode. */
class Batch {
  readonly mesh: THREE.Mesh;
  private geo = new THREE.InstancedBufferGeometry();
  private pos: Float32Array; private size: Float32Array; private col: Float32Array; private cell: Float32Array;
  private attrs: THREE.InstancedBufferAttribute[];
  constructor(max: number, atlas: THREE.Texture, normal: boolean) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo.index = quad.index; this.geo.setAttribute('position', quad.getAttribute('position')); this.geo.setAttribute('uv', quad.getAttribute('uv'));
    const mk = (n: number) => { const a = new THREE.InstancedBufferAttribute(new Float32Array(max * n), n); a.setUsage(THREE.DynamicDrawUsage); return a; };
    const aPos = mk(3), aSize = mk(3), aCol = mk(4), aCell = mk(1);
    this.geo.setAttribute('iPos', aPos); this.geo.setAttribute('iSize', aSize); this.geo.setAttribute('iColor', aCol); this.geo.setAttribute('iCell', aCell);
    this.pos = aPos.array as Float32Array; this.size = aSize.array as Float32Array; this.col = aCol.array as Float32Array; this.cell = aCell.array as Float32Array;
    this.attrs = [aPos, aSize, aCol, aCell];
    this.geo.instanceCount = 0;
    const mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthWrite: false, toneMapped: false,
      blending: normal ? THREE.NormalBlending : THREE.CustomBlending,
      // Additive glow: src*1 + dst*1 (premultiplied in the shader).
      ...(normal ? {} : { blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendEquation: THREE.AddEquation }),
      uniforms: { uMap: { value: atlas }, uGrid: { value: GRID }, uNormal: { value: normal ? 1 : 0 } },
    });
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = normal ? 9 : 10;
  }
  write(list: Particle[], n: number) {
    for (let i = 0; i < n; i++) {
      const p = list[i], k = p.age / p.life, sz = p.size0 + (p.size1 - p.size0) * k;
      const a = (p.a0 + (p.a1 - p.a0) * k) * Math.min(1, p.age / 0.04);
      this.pos[i * 3] = p.pos.x; this.pos[i * 3 + 1] = p.pos.y; this.pos[i * 3 + 2] = p.pos.z;
      this.size[i * 3] = sz; this.size[i * 3 + 1] = p.stretch; this.size[i * 3 + 2] = p.rot;
      this.col[i * 4] = p.color.r; this.col[i * 4 + 1] = p.color.g; this.col[i * 4 + 2] = p.color.b; this.col[i * 4 + 3] = a;
      this.cell[i] = p.cell;
    }
    this.geo.instanceCount = n;
    if (n) for (const at of this.attrs) { at.clearUpdateRanges(); at.addUpdateRange(0, n * at.itemSize); at.needsUpdate = true; }
  }
}

export class Vfx {
  readonly group = new THREE.Group();
  private tex = new Map<FxTex, THREE.Texture>();
  private parts: Particle[] = [];
  private free: Particle[] = [];
  private live: Particle[] = [];
  private bufAdd: Particle[] = []; private bufNorm: Particle[] = [];
  private add: Batch; private norm: Batch;
  private decals: Decal[] = [];
  private plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  private budget: number;
  private tmp = new THREE.Vector3();
  /** Quality scales particle counts (Low: about half). */
  constructor(scene: THREE.Scene, tex: Map<FxTex, THREE.Texture>, atlas: THREE.Texture, readonly quality: 'high' | 'low') {
    this.tex = tex;
    this.budget = quality === 'high' ? 600 : 320;
    for (let i = 0; i < this.budget; i++) {
      const p: Particle = { alive: false, normal: false, cell: 0, color: new THREE.Color(), pos: new THREE.Vector3(), rot: 0, vel: new THREE.Vector3(), grav: 0, drag: 0, age: 0, life: 1, size0: 1, size1: 1, a0: 1, a1: 0, spin: 0, stretch: 1, follow: null };
      this.parts.push(p); this.free.push(p);
    }
    this.add = new Batch(this.budget, atlas, false); this.norm = new Batch(this.budget, atlas, true);
    this.group.add(this.norm.mesh, this.add.mesh);
    for (let i = 0; i < 48; i++) {
      const mat = new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, polygonOffset: true, polygonOffsetFactor: -4, fog: false, toneMapped: false });
      const mesh = new THREE.Mesh(this.plane, mat); mesh.visible = false; mesh.renderOrder = 9; this.group.add(mesh);
      this.decals.push({ mesh, mat, alive: false, age: 0, life: 1, fadeIn: 0, fadeOut: 0, alpha: 1, spin: 0, grow: 0, size: 1 });
    }
    scene.add(this.group);
  }
  static async load(base: string, scene: THREE.Scene, quality: 'high' | 'low') {
    const tex = new Map<FxTex, THREE.Texture>();
    // One atlas for the batched particles; the individual textures stay for ground decals.
    const cv = document.createElement('canvas'); cv.width = cv.height = GRID * CELL;
    const c2 = cv.getContext('2d')!; c2.fillStyle = '#000'; c2.fillRect(0, 0, cv.width, cv.height);
    await Promise.all(NAMES.map(async (n, i) => {
      const img = new Image(); img.src = `${base}assets/fx/${n}.webp`; await img.decode();
      // Atlas rows run bottom-up in UV space (flipY): cell i sits at column i%GRID, row i/GRID from the bottom.
      c2.drawImage(img, (i % GRID) * CELL, (GRID - 1 - Math.floor(i / GRID)) * CELL, CELL, CELL);
      const t = new THREE.Texture(img); t.colorSpace = THREE.SRGBColorSpace; t.needsUpdate = true; tex.set(n, t);
    }));
    const atlas = new THREE.CanvasTexture(cv); atlas.colorSpace = THREE.NoColorSpace; atlas.anisotropy = 1;
    return new Vfx(scene, tex, atlas, quality);
  }
  private n(count: number) { return Math.max(1, Math.round(this.quality === 'high' ? count : count * 0.55)); }

  // ------------------------------------------------------------------ primitives
  /** One particle. Returns it (or null when the pool is exhausted). */
  spawn(tex: FxTex, pos: THREE.Vector3, o: SpawnOpts) {
    const p = this.free.pop(); if (!p) return null;
    p.alive = true; p.age = 0; p.life = o.life; p.size0 = o.size; p.size1 = o.size1 ?? o.size; p.a0 = o.alpha ?? 1; p.a1 = o.alpha1 ?? 0;
    p.vel.copy(o.vel ?? this.tmp.set(0, 0, 0)); p.grav = o.grav ?? 0; p.drag = o.drag ?? 0; p.spin = o.spin ?? 0; p.stretch = o.stretch ?? 1; p.follow = o.follow ?? null;
    p.cell = NAMES.indexOf(tex); p.color.copy(o.color); p.rot = o.rot ?? Math.random() * Math.PI * 2; p.normal = !!o.normal;
    p.pos.copy(pos);
    this.live.push(p);
    return p;
  }
  /** A burst of particles from a point. */
  burst(tex: FxTex, pos: THREE.Vector3, o: { count: number; color: THREE.Color; life: number; size: number; size1?: number; speed: number; up?: number; spread?: number; grav?: number; alpha?: number; drag?: number; normal?: boolean; flat?: boolean }) {
    for (let i = 0; i < this.n(o.count); i++) {
      const a = Math.random() * Math.PI * 2, e = o.flat ? 0 : (Math.random() - 0.3) * (o.spread ?? 1);
      const v = new THREE.Vector3(Math.cos(a), e, Math.sin(a)).normalize().multiplyScalar(o.speed * (0.4 + Math.random() * 0.6));
      v.y += o.up ?? 0;
      this.spawn(tex, pos.clone().addScaledVector(v, 0.05), { color: o.color, life: o.life * (0.7 + Math.random() * 0.6), size: o.size, size1: o.size1, vel: v, grav: o.grav, alpha: o.alpha, spin: (Math.random() - 0.5) * 3, drag: o.drag, normal: o.normal });
    }
  }
  /** A flat ground decal. `life` < 0 keeps it until killed. `spin` (rad/s) rotates it, `grow` (m/s) widens it. */
  decal(tex: FxTex, pos: THREE.Vector3, o: { color: THREE.Color; size: number; life: number; fadeIn?: number; fadeOut?: number; alpha?: number; yaw?: number; length?: number; spin?: number; grow?: number }) {
    const d = this.decals.find((x) => !x.alive); if (!d) return null;
    d.alive = true; d.age = 0; d.life = o.life; d.fadeIn = o.fadeIn ?? 0.08; d.fadeOut = o.fadeOut ?? 0.25; d.alpha = o.alpha ?? 1; d.spin = o.spin ?? 0; d.grow = o.grow ?? 0; d.size = o.size;
    if (d.mat.map !== this.tex.get(tex)) { d.mat.map = this.tex.get(tex)!; d.mat.needsUpdate = true; }
    d.mat.color.copy(o.color); d.mat.opacity = 0;
    d.mesh.position.set(pos.x, pos.y + 0.06, pos.z); d.mesh.rotation.set(0, o.yaw ?? 0, 0);
    d.mesh.scale.set(o.size, 1, o.length ?? o.size); d.mesh.visible = true;
    return d;
  }
  kill(d: Decal | null) { if (d && d.alive) { d.life = d.age + d.fadeOut; } }

  update(dt: number) {
    let na = 0, nn = 0;
    for (let i = this.live.length - 1; i >= 0; i--) {
      const p = this.live[i];
      p.age += dt;
      if (p.age >= p.life) {
        p.alive = false; p.follow = null; this.free.push(p);
        this.live[i] = this.live[this.live.length - 1]; this.live.pop();
        continue;
      }
      if (p.follow) p.pos.copy(p.follow());
      else {
        if (p.drag) p.vel.multiplyScalar(Math.exp(-p.drag * dt));
        p.vel.y -= p.grav * dt; p.pos.addScaledVector(p.vel, dt);
      }
      p.rot += p.spin * dt;
      if (p.normal) this.bufNorm[nn++] = p; else this.bufAdd[na++] = p;
    }
    this.add.write(this.bufAdd, na); this.norm.write(this.bufNorm, nn);
    for (const d of this.decals) {
      if (!d.alive) continue;
      d.age += dt;
      if (d.life >= 0 && d.age >= d.life) { d.alive = false; d.mesh.visible = false; continue; }
      const fin = Math.min(1, d.age / Math.max(1e-3, d.fadeIn));
      const fout = d.life >= 0 ? Math.min(1, (d.life - d.age) / Math.max(1e-3, d.fadeOut)) : 1;
      d.mat.opacity = d.alpha * fin * fout;
      if (d.spin) d.mesh.rotation.y += d.spin * dt;
      if (d.grow) { const s = d.size + d.grow * d.age; d.mesh.scale.set(s, 1, s); }
    }
  }
  /** Show every pooled mesh (for shader compilation at load), then hide them again. */
  prewarm(on: boolean) {
    for (const d of this.decals) if (!d.alive) d.mesh.visible = on;
    this.add.mesh.visible = this.norm.mesh.visible = true;
  }
  /** Live particle count (tests / profiling). */
  get liveCount() { return this.live.length; }

  // ------------------------------------------------------------------ composites
  /** Flickering flame sprites at a point (call every frame for a sustained fire). */
  flame(pos: THREE.Vector3, size: number, intensity = 1) {
    const core = Math.random() < 0.3;
    this.spawn(core ? 'fire_01' : Math.random() < 0.5 ? 'flame_02' : 'flame_04', this.tmp.set(pos.x + (Math.random() - 0.5) * 0.2, pos.y, pos.z + (Math.random() - 0.5) * 0.2),
      { color: (core ? FX_COLORS.fireCore : FX_COLORS.fire).clone().multiplyScalar(intensity), life: 0.3, size: size * (core ? 0.5 : 0.7), size1: size * 0.25, vel: new THREE.Vector3(0, 1.8, 0), alpha: 0.85, stretch: 1.6 });
  }
  /** A fireball's glow at `pos` this frame plus a short trail. */
  orb(pos: THREE.Vector3) {
    this.spawn('circle_05', pos, { color: FX_COLORS.fireCore, life: 0.05, size: 0.9, alpha: 1, alpha1: 1 });
    this.spawn('fire_01', pos, { color: FX_COLORS.fire, life: 0.18, size: 0.55, size1: 0.2, alpha: 1, spin: 6 });
  }
  /** Lightning strike: a tall flickering bolt, a white flash, sparks and a lingering scorch. */
  bolt(ground: THREE.Vector3, height = 9, scale = 1) {
    const mid = ground.clone().setY(ground.y + height / 2), w = scale;
    // Narrow jagged bolt (Kenney spark_06 is a vertical lightning streak): a violet outer bolt and a white core.
    this.spawn('spark_06', mid, { color: FX_COLORS.storm, life: 0.3, size: 0.9 * w, stretch: height / (0.9 * w), alpha: 1, alpha1: 0, rot: 0 });
    this.spawn('spark_06', mid.clone().add(new THREE.Vector3(0.05, 0, 0)), { color: FX_COLORS.stormCore, life: 0.18, size: 0.45 * w, stretch: height / (0.45 * w), alpha: 1, alpha1: 0, rot: Math.PI });
    this.spawn('circle_05', ground.clone().setY(ground.y + 0.4), { color: FX_COLORS.storm, life: 0.25, size: 2.6 * w, size1: 1.2 * w, alpha: 0.9 });
    this.burst('spark_04', ground.clone().setY(ground.y + 0.2), { count: Math.round(14 * w), color: FX_COLORS.storm, life: 0.35, size: 0.5 * w, size1: 0.1, speed: 6 * w, up: 2, grav: 9 });
    this.decal('scorch_02', ground, { color: FX_COLORS.storm.clone().multiplyScalar(0.6), size: 2.6 * w, life: 1.6 * w, fadeIn: 0.02, fadeOut: 1.0 });
  }
  /** Teleport: dark smoke and violet sparks where he vanishes or reappears, with a bright flash on arrival. */
  puff(pos: THREE.Vector3, arrive: boolean) {
    const c = pos.clone().setY(pos.y + 1.0);
    this.burst('smoke_07', c, { count: 9, color: FX_COLORS.smoke, life: 0.7, size: 1.2, size1: 2.2, speed: 1.4, up: 0.6, alpha: 0.9 });
    this.burst('spark_01', c, { count: 12, color: FX_COLORS.storm, life: 0.45, size: 0.35, size1: 0.05, speed: 4, up: 1 });
    if (arrive) this.spawn('star_06', c, { color: FX_COLORS.stormCore, life: 0.25, size: 2.6, size1: 0.8, alpha: 1 });
  }
}
