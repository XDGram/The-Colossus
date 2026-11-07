import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Custom effects for the player's supernatural abilities (docs/abilities.md §2, §4): spirit energy is a white core
 * graded through ice and cyan to deep blue. Everything here is procedural (shaders, generated geometry and canvas
 * textures), created once at load and reused; nothing is allocated per frame. Effects carry their own glow so they
 * read on Low quality (no bloom); on High their cores go above 1.0 so the bloom catches them.
 *
 * - Afterimages: frozen copies of the player's pose (the whole armoured body merged into ONE skinned mesh at load,
 *   so each afterimage is a single draw call), fresnel cyan, fading.
 * - Ribbon: a vertical energy ribbon along the body's path (Phantom Step).
 * - Crescent: the Colossus Rift wave (a curved, tapered energy ribbon with two trailing echoes).
 * - Shock: an expanding ground ring plus a translucent wall (Gravity Rupture).
 * - Crater: the paving heaves up into broken slabs around a sunken centre over dark fractures, with debris thrown
 *   out and lifted; both stay (the last four craters are kept). Nothing tints the ground.
 * - Blade aura: a glow along the katana while the Rift charges.
 */
export const SPIRIT = {
  core: new THREE.Color(0.9, 0.98, 1.0), ice: new THREE.Color(0.78, 0.96, 1.0), cyan: new THREE.Color(0.31, 0.85, 1.0), deep: new THREE.Color(0.12, 0.36, 1.0),
};

const NOISE = /* glsl */`
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y); }
float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * vnoise(p); p *= 2.03; a *= 0.5; } return s; }
`;
/** Spirit palette ramp: k = 0 deep blue edge … 1 white core. `hot` lifts the core above 1.0 (bloom on High). */
const RAMP = /* glsl */`
vec3 spiritRamp(float k, float hot) {
  vec3 deep = vec3(0.12, 0.36, 1.0), cyan = vec3(0.31, 0.85, 1.0), ice = vec3(0.78, 0.96, 1.0), core = vec3(0.92, 0.99, 1.0);
  vec3 c = k < 0.4 ? mix(deep, cyan, k / 0.4) : k < 0.75 ? mix(cyan, ice, (k - 0.4) / 0.35) : mix(ice, core * hot, (k - 0.75) / 0.25);
  return c;
}
`;
const additive = { transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, side: THREE.DoubleSide } as const;

// ------------------------------------------------------------------------------------------------ afterimages
/**
 * Builds one skinned geometry for the whole character: the skinned body parts keep their weights; rigid armour
 * pieces and the drawn katana are bound rigidly to the bone they hang from. A frozen copy of the skeleton's world
 * matrices then poses it.
 */
function mergeCharacter(model: THREE.Object3D) {
  model.updateMatrixWorld(true);
  let skel: THREE.Skeleton | null = null;
  model.traverse((o) => { const m = o as THREE.SkinnedMesh; if (!skel && m.isSkinnedMesh) skel = m.skeleton; });
  const skeleton = skel as unknown as THREE.Skeleton;
  const index = new Map(skeleton.bones.map((b, i) => [b.name, i]));
  const pos: number[] = [], nor: number[] = [], si: number[] = [], sw: number[] = [];
  const p = new THREE.Vector3(), n = new THREE.Vector3(), m4 = new THREE.Matrix4(), n3 = new THREE.Matrix3();
  const skip = (o: THREE.Object3D) => { for (let q: THREE.Object3D | null = o; q; q = q.parent) if (q.name === 'katana-hilt') return true; return false; };
  model.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || skip(mesh)) return;
    const g = mesh.geometry, P = g.getAttribute('position'), N = g.getAttribute('normal');
    const idx = g.index;
    const count = idx ? idx.count : P.count;
    const read = (k: number) => (idx ? idx.getX(k) : k);
    if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) {
      const sm = mesh as THREE.SkinnedMesh, SI = g.getAttribute('skinIndex'), SW = g.getAttribute('skinWeight');
      const remap = sm.skeleton.bones.map((b) => index.get(b.name) ?? 0);
      n3.getNormalMatrix(sm.bindMatrix);
      for (let k = 0; k < count; k++) {
        const v = read(k);
        p.fromBufferAttribute(P, v).applyMatrix4(sm.bindMatrix); pos.push(p.x, p.y, p.z);
        n.fromBufferAttribute(N, v).applyMatrix3(n3).normalize(); nor.push(n.x, n.y, n.z);
        for (let j = 0; j < 4; j++) { si.push(remap[SI.getComponent(v, j)]); sw.push(SW.getComponent(v, j)); }
      }
    } else {
      // Rigid part: bind to the nearest ancestor bone. bind-space = inverse(boneInverse) * (bone-local of the vertex).
      let bone: THREE.Object3D | null = mesh.parent;
      while (bone && !index.has(bone.name)) bone = bone.parent;
      if (!bone) return;
      const bi = index.get(bone.name)!;
      m4.copy(bone.matrixWorld).invert().multiply(mesh.matrixWorld);
      m4.premultiply(new THREE.Matrix4().copy(skeleton.boneInverses[bi]).invert());
      n3.getNormalMatrix(m4);
      for (let k = 0; k < count; k++) {
        const v = read(k);
        p.fromBufferAttribute(P, v).applyMatrix4(m4); pos.push(p.x, p.y, p.z);
        n.fromBufferAttribute(N, v).applyMatrix3(n3).normalize(); nor.push(n.x, n.y, n.z);
        si.push(bi, 0, 0, 0); sw.push(1, 0, 0, 0);
      }
    }
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
  geo.computeBoundingSphere();
  return { geo, skeleton };
}

const GHOST_VERT = /* glsl */`
#include <common>
#include <skinning_pars_vertex>
varying vec3 vN; varying vec3 vV; varying float vH;
void main() {
  #include <beginnormal_vertex>
  #include <skinbase_vertex>
  #include <skinnormal_vertex>
  #include <defaultnormal_vertex>
  #include <begin_vertex>
  #include <skinning_vertex>
  #include <project_vertex>
  vN = normalize(transformedNormal); vV = normalize(-mvPosition.xyz);
  vH = (modelMatrix * vec4(transformed, 1.0)).y;
}`;
const GHOST_FRAG = /* glsl */`
uniform float uAlpha; uniform float uBase; uniform float uHot; uniform float uTime;
varying vec3 vN; varying vec3 vV; varying float vH;
${NOISE}${RAMP}
void main() {
  float f = 1.0 - abs(dot(normalize(vN), vV));
  float rim = pow(f, 2.2);
  // Energy flowing up through the silhouette; dissolves at the bottom as it fades.
  float flow = fbm(vec2(vH * 3.0 - uTime * 4.0, f * 3.0));
  float k = clamp(rim * 1.15 + flow * 0.25, 0.0, 1.0);
  float a = (uBase + rim * 1.4) * uAlpha * (0.75 + 0.5 * flow);
  gl_FragColor = vec4(spiritRamp(k, uHot) * a, 1.0);
  #include <colorspace_fragment>
}`;

export class Afterimages {
  private geo: THREE.BufferGeometry | null = null;
  private srcBones: THREE.Bone[] = [];
  private slots: { mesh: THREE.SkinnedMesh; mat: THREE.ShaderMaterial; bones: THREE.Bone[]; age: number; life: number; a0: number }[] = [];
  private next = 0;
  constructor(private model: THREE.Object3D, private scene: THREE.Scene, private count: number, private hot: number) {}
  get meshes() { return this.slots.map((s) => s.mesh); }
  /** Hide afterimages that aren't fading out right now. */
  hideIdle() { for (const s of this.slots) if (s.age >= s.life || s.mat.uniforms.uAlpha.value <= 0) s.mesh.visible = false; }
  /** Merge the body and create the pooled ghosts (call once the katana mesh exists; cheap afterwards). */
  build() {
    if (this.geo) return;
    const { geo, skeleton } = mergeCharacter(this.model);
    this.geo = geo; this.srcBones = skeleton.bones;
    for (let i = 0; i < this.count; i++) {
      const bones = skeleton.bones.map(() => { const b = new THREE.Bone(); b.matrixAutoUpdate = false; b.matrixWorldAutoUpdate = false; return b; });
      const mat = new THREE.ShaderMaterial({ vertexShader: GHOST_VERT, fragmentShader: GHOST_FRAG, ...additive, side: THREE.FrontSide,
        uniforms: { uAlpha: { value: 0 }, uBase: { value: 0.12 }, uHot: { value: this.hot }, uTime: { value: 0 } } });
      const mesh = new THREE.SkinnedMesh(geo, mat);
      mesh.bind(new THREE.Skeleton(bones, skeleton.boneInverses), new THREE.Matrix4());
      mesh.frustumCulled = false; mesh.visible = false; mesh.renderOrder = 8; mesh.matrixAutoUpdate = false;
      this.scene.add(mesh);
      this.slots.push({ mesh, mat, bones, age: 0, life: 1, a0: 1 });
    }
  }
  /** Freeze the current pose as an afterimage. */
  capture(life = 0.32, alpha = 1, base = 0.12) {
    this.build();
    const s = this.slots[this.next++ % this.slots.length];
    this.model.updateMatrixWorld(true);
    for (let i = 0; i < s.bones.length; i++) s.bones[i].matrixWorld.copy(this.srcBones[i].matrixWorld);
    s.age = 0; s.life = life; s.a0 = alpha; s.mat.uniforms.uBase.value = base; s.mesh.visible = true;
  }
  update(dt: number, t: number) {
    for (const s of this.slots) {
      if (!s.mesh.visible) continue;
      s.age += dt;
      if (s.age >= s.life) { s.mesh.visible = false; continue; }
      const k = s.age / s.life;
      s.mat.uniforms.uAlpha.value = s.a0 * (1 - k) * (1 - k);
      s.mat.uniforms.uTime.value = t;
    }
  }
}

// ------------------------------------------------------------------------------------------------ ribbon trail
const RIBBON_VERT = /* glsl */`
attribute float aAge; attribute float aSide; varying float vAge; varying float vSide; varying float vU;
uniform float uLen;
void main() { vAge = aAge; vSide = aSide; vU = position.x * 0.0; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); vU = aAge; }`;
const RIBBON_FRAG = /* glsl */`
uniform float uLife; uniform float uTime; uniform float uHot; uniform float uAlpha;
varying float vAge; varying float vSide; varying float vU;
${NOISE}${RAMP}
void main() {
  float age = clamp(vAge / uLife, 0.0, 1.0);
  float across = clamp(1.0 - abs(vSide * 2.0 - 1.0), 0.0, 1.0);  // 0 at the edges, 1 at the centre line
  float streak = fbm(vec2(vAge * 18.0 - uTime * 6.0, vSide * 5.0));
  float core = pow(across, 3.0);
  float k = clamp(core * 1.1 + streak * 0.3 - age * 0.5, 0.0, 1.0);
  float a = (pow(across, 1.2) * 0.8 + core) * (1.0 - age) * (1.0 - age) * (0.6 + 0.6 * streak) * uAlpha;
  gl_FragColor = vec4(spiritRamp(k, uHot) * a, 1.0);
  #include <colorspace_fragment>
}`;
/** A vertical energy ribbon along a moving path (points are added as the body travels; they age and fade). */
export class Ribbon {
  readonly mesh: THREE.Mesh;
  private n: number;
  private pts: { p: THREE.Vector3; t: number }[] = [];
  private pos: Float32Array; private age: Float32Array;
  private geo = new THREE.BufferGeometry();
  private mat: THREE.ShaderMaterial;
  private time = 0;
  constructor(scene: THREE.Scene, max = 40, private bottom = 0.35, private top = 1.75, readonly life = 0.45, hot = 1.6) {
    this.n = max;
    this.pos = new Float32Array(max * 2 * 3); this.age = new Float32Array(max * 2);
    const side = new Float32Array(max * 2); for (let i = 0; i < max; i++) { side[i * 2] = 0; side[i * 2 + 1] = 1; }
    const idx: number[] = []; for (let i = 0; i < max - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    this.geo.setIndex(idx);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aAge', new THREE.BufferAttribute(this.age, 1).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    this.mat = new THREE.ShaderMaterial({ vertexShader: RIBBON_VERT, fragmentShader: RIBBON_FRAG, ...additive,
      uniforms: { uLife: { value: life }, uTime: { value: 0 }, uHot: { value: hot }, uAlpha: { value: 1 }, uLen: { value: 1 } } });
    this.mesh = new THREE.Mesh(this.geo, this.mat); this.mesh.frustumCulled = false; this.mesh.visible = false; this.mesh.renderOrder = 11;
    scene.add(this.mesh);
  }
  clear() { this.pts.length = 0; this.mesh.visible = false; }
  push(p: THREE.Vector3) {
    const last = this.pts[this.pts.length - 1];
    if (last && last.p.distanceToSquared(p) < 0.0225) { last.t = this.time; return; }
    const e = this.pts.length >= this.n ? this.pts.shift()! : { p: new THREE.Vector3(), t: 0 };
    e.p.copy(p); e.t = this.time; this.pts.push(e);
  }
  update(dt: number) {
    this.time += dt;
    while (this.pts.length && this.time - this.pts[0].t > this.life) this.pts.shift();
    const m = this.pts.length;
    this.mesh.visible = m >= 2;
    if (m < 2) return;
    for (let i = 0; i < this.n; i++) {
      const q = this.pts[Math.min(i, m - 1)];
      const o = i * 6;
      this.pos[o] = q.p.x; this.pos[o + 1] = q.p.y + this.bottom; this.pos[o + 2] = q.p.z;
      this.pos[o + 3] = q.p.x; this.pos[o + 4] = q.p.y + this.top; this.pos[o + 5] = q.p.z;
      const a = this.time - q.t; this.age[i * 2] = a; this.age[i * 2 + 1] = a;
    }
    this.geo.setDrawRange(0, (m - 1) * 6);
    this.geo.attributes.position.needsUpdate = true; this.geo.attributes.aAge.needsUpdate = true;
    this.mat.uniforms.uTime.value = this.time;
  }
}

// ------------------------------------------------------------------------------------------------ crescent wave
const CRES_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const CRES_FRAG = /* glsl */`
uniform float uAlpha; uniform float uTime; uniform float uHot;
varying vec2 vUv;
${NOISE}${RAMP}
void main() {
  float u = vUv.x, v = vUv.y;                       // u along the arc (0..1), v across the band (0..1)
  float taper = pow(max(sin(3.14159 * u), 0.0), 0.75); // thin, sharp tips (pow of a negative is NaN on some GPUs)
  float d = abs(v - 0.5) * 2.0 / max(taper, 0.02);  // 0 on the core line, 1 at the band edge
  if (d > 1.0) discard;
  float n = fbm(vec2(u * 9.0 + uTime * 3.0, v * 3.0 - uTime * 7.0));
  float core = exp(-d * d * 10.0);
  float body = pow(max(1.0 - d, 0.0), 1.6);
  float k = clamp(core + body * 0.45 + (n - 0.5) * 0.35, 0.0, 1.0);
  float a = (core * 1.6 + body * (0.75 + 0.9 * n)) * uAlpha * smoothstep(0.0, 0.06, u) * smoothstep(1.0, 0.94, u);
  gl_FragColor = vec4(spiritRamp(k, uHot) * a, 1.0);
  #include <colorspace_fragment>
}`;
/**
 * Crescent (unit size, travelling toward +Z): a moon-shaped band whose arc curves in the X-Y plane (so it reads as a
 * crescent from behind, where the camera is), bowing forward at its centre with the tips trailing back, plus a second
 * band across the depth so it keeps its body when seen from the side.
 */
function crescentGeometry() {
  const seg = 48, pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const span = THREE.MathUtils.degToRad(62), R = 0.5 / Math.sin(span);   // tips at x = ±0.5
  const band = (depth: boolean) => {
    const base = pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const u = i / seg, a = -span + 2 * span * u;
      const x = Math.sin(a) * R, y = (Math.cos(a) - 1) * R * 0.55, z = (Math.cos(a) - 1) * R * 0.6;   // arched, tips back and down
      const h = 0.13 * Math.pow(Math.sin(Math.PI * u), 0.8);    // band half-width (crescent thickness), tapering to points
      const nx = Math.sin(a), ny = Math.cos(a) * 0.55;          // outward normal of the arc in X-Y
      const nl = Math.hypot(nx, ny);
      for (const s of [-1, 1]) {
        if (!depth) pos.push(x + (nx / nl) * s * h, y + (ny / nl) * s * h, z);
        else pos.push(x, y, z + s * h * 2.2);
        uv.push(u, s < 0 ? 0 : 1);
      }
    }
    for (let i = 0; i < seg; i++) { const a = base + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  };
  band(false); band(true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2)); g.setIndex(idx);
  return g;
}
export class Crescent {
  readonly group = new THREE.Group();
  private mats: THREE.ShaderMaterial[] = [];
  alive = false; private age = 0; private fade = 0;
  constructor(scene: THREE.Scene, geo: THREE.BufferGeometry, hot: number) {
    // The main wave and two fainter echoes trailing behind it.
    [[0, 1, 1], [-0.75, 0.86, 0.5], [-1.45, 0.72, 0.25]].forEach(([dz, s, a]) => {
      const mat = new THREE.ShaderMaterial({ vertexShader: CRES_VERT, fragmentShader: CRES_FRAG, ...additive, uniforms: { uAlpha: { value: 0 }, uTime: { value: 0 }, uHot: { value: hot } } });
      mat.userData.k = a;
      const m = new THREE.Mesh(geo, mat); m.position.z = dz; m.scale.setScalar(s); m.renderOrder = 11; m.frustumCulled = false;
      this.group.add(m); this.mats.push(mat);
    });
    this.group.visible = false; scene.add(this.group);
  }
  /** Width (tip to tip), thickness scale of the band, roll (tilt of the cut). */
  start(pos: THREE.Vector3, yaw: number, width: number, height: number, roll: number) {
    this.alive = true; this.age = 0; this.fade = 0;
    this.group.position.copy(pos); this.group.rotation.set(0, yaw, roll, 'YXZ'); this.group.scale.set(width, width * height, width);
    this.group.visible = true;
  }
  /** Begin fading out (range reached, wall). */
  dissipate() { if (this.fade === 0) this.fade = 0.0001; }
  update(dt: number, alpha = 1) {
    if (!this.alive) return;
    this.age += dt;
    let a = Math.min(1, this.age / 0.05) * alpha;
    if (this.fade > 0) { this.fade += dt; a *= Math.max(0, 1 - this.fade / 0.18); this.group.scale.multiplyScalar(1 + dt * 1.5); if (this.fade >= 0.18) { this.alive = false; this.group.visible = false; } }
    for (const m of this.mats) { m.uniforms.uAlpha.value = a * m.userData.k; m.uniforms.uTime.value = this.age; }
  }
}

// ------------------------------------------------------------------------------------------------ shockwave
const SHOCK_FRAG = /* glsl */`
uniform float uAlpha; uniform float uTime; uniform float uHot; uniform float uWall;
varying vec2 vUv;
${NOISE}${RAMP}
void main() {
  float a, k;
  if (uWall > 0.5) {
    // Wall: bright at the ground, fading upward, with rising streaks.
    float h = vUv.y, n = fbm(vec2(vUv.x * 40.0, h * 3.0 - uTime * 5.0));
    // Fades out at the ground (the wave is in the air; the ground itself is never tinted).
    a = smoothstep(0.0, 0.3, h) * pow(clamp(1.0 - h, 0.0, 1.0), 1.6) * (0.5 + 0.8 * n); k = clamp((1.0 - h) * 0.9 + n * 0.3, 0.0, 1.0);
  } else {
    // Ring: a thin bright leading edge with a soft wake inside.
    float r = length(vUv - 0.5) * 2.0;
    float e0 = (r - 0.96) * 26.0;
    float edge = exp(-e0 * e0), wake = smoothstep(0.55, 0.96, r) * (1.0 - smoothstep(0.96, 1.0, r));
    float n = fbm(vec2(atan(vUv.y - 0.5, vUv.x - 0.5) * 6.0, r * 4.0 - uTime * 3.0));
    a = edge * 1.4 + wake * 0.35 * n; k = clamp(edge + n * 0.25, 0.0, 1.0);
  }
  gl_FragColor = vec4(spiritRamp(k, uHot) * a * uAlpha, 1.0);
  #include <colorspace_fragment>
}`;
export class Shock {
  private ring: THREE.Mesh; private wall: THREE.Mesh;
  get meshes() { return [this.ring, this.wall]; }
  private rm: THREE.ShaderMaterial; private wm: THREE.ShaderMaterial;
  alive = false; private age = 0;
  private r0 = 0; private r1 = 1; private dur = 0.3; private life = 0.5; private wallH = 1.4;
  constructor(scene: THREE.Scene, hot: number) {
    const u = () => ({ uAlpha: { value: 0 }, uTime: { value: 0 }, uHot: { value: hot }, uWall: { value: 0 } });
    this.rm = new THREE.ShaderMaterial({ vertexShader: CRES_VERT, fragmentShader: SHOCK_FRAG, ...additive, uniforms: u() });
    this.wm = new THREE.ShaderMaterial({ vertexShader: CRES_VERT, fragmentShader: SHOCK_FRAG, ...additive, uniforms: { ...u(), uWall: { value: 1 } } });
    this.ring = new THREE.Mesh(new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2), this.rm);
    this.wall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 64, 1, true).translate(0, 0.5, 0), this.wm);
    for (const m of [this.ring, this.wall]) { m.visible = false; m.renderOrder = 11; m.frustumCulled = false; scene.add(m); }
  }
  start(c: THREE.Vector3, r0: number, r1: number, dur: number, life: number, wallH: number) {
    this.alive = true; this.age = 0; this.r0 = r0; this.r1 = r1; this.dur = dur; this.life = life; this.wallH = wallH;
    this.ring.position.set(c.x, c.y + 0.1, c.z); this.wall.position.set(c.x, c.y, c.z);
    this.ring.visible = false; this.wall.visible = wallH > 0;   // no glowing ring on the ground
  }
  update(dt: number) {
    if (!this.alive) return;
    this.age += dt;
    if (this.age >= this.life) { this.alive = false; this.ring.visible = this.wall.visible = false; return; }
    this.ring.visible = false;
    const k = Math.min(1, this.age / this.dur), e = 1 - Math.pow(1 - k, 3), r = THREE.MathUtils.lerp(this.r0, this.r1, e);
    const fade = 1 - Math.max(0, (this.age - this.dur * 0.6) / (this.life - this.dur * 0.6));
    this.ring.scale.set(r, 1, r); this.wall.scale.set(r, this.wallH * (1 - 0.5 * k), r);
    this.rm.uniforms.uAlpha.value = fade; this.wm.uniforms.uAlpha.value = fade * 0.75 * (1 - k * 0.6);
    this.rm.uniforms.uTime.value = this.wm.uniforms.uTime.value = this.age;
  }
}

// ------------------------------------------------------------------------------------------------ ground cracks + glyph ring
function crackTexture(size: number) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d')!; g.fillStyle = '#000'; g.fillRect(0, 0, size, size);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const C = size / 2;
  const branch = (x: number, y: number, a: number, len: number, w: number, depth: number) => {
    let px = x, py = y;
    const steps = Math.max(3, Math.round(len / (size * 0.03)));
    for (let i = 0; i < steps; i++) {
      a += (rnd() - 0.5) * 0.55;
      const nx = px + Math.cos(a) * len / steps, ny = py + Math.sin(a) * len / steps;
      const ww = w * (1 - i / steps * 0.7);
      g.strokeStyle = `rgba(255,255,255,${0.95 - depth * 0.15})`; g.lineWidth = ww; g.lineCap = 'round';
      g.beginPath(); g.moveTo(px, py); g.lineTo(nx, ny); g.stroke();
      if (depth < 3 && rnd() < 0.25) branch(nx, ny, a + (rnd() < 0.5 ? -1 : 1) * (0.4 + rnd() * 0.6), len * (0.35 + rnd() * 0.3), ww * 0.75, depth + 1);
      px = nx; py = ny;
    }
  };
  for (let i = 0; i < 12; i++) { const a = (i / 12) * Math.PI * 2 + rnd() * 0.4; branch(C + Math.cos(a) * size * 0.03, C + Math.sin(a) * size * 0.03, a, size * (0.3 + rnd() * 0.17), size * 0.02, 0); }
  // Soft glow along the cracks (blurred copy underneath).
  const blur = document.createElement('canvas'); blur.width = blur.height = size; const bg = blur.getContext('2d')!;
  bg.filter = `blur(${Math.round(size * 0.006)}px)`; bg.drawImage(c, 0, 0); g.globalCompositeOperation = 'lighter'; g.globalAlpha = 0.9; g.drawImage(blur, 0, 0); g.globalAlpha = 1; g.globalCompositeOperation = 'source-over';
  // Impact crater: a ring of short fractures and a bright centre.
  for (let i = 0; i < 26; i++) { const a = rnd() * Math.PI * 2, r = size * (0.05 + rnd() * 0.04); branch(C + Math.cos(a) * r, C + Math.sin(a) * r, a + (rnd() - 0.5), size * 0.05, size * 0.006, 2); }
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace;
  return t;
}
/**
 * A persistent impact crater (Gravity Rupture): the paving around the blade heaves up into broken slabs, tilted with
 * their outer edges lifted around a sunken centre, over dark fractures. Built at the impact (one merged mesh in the
 * courtyard's own stone material), it stays: the scene keeps the last few craters.
 */
function craterGeometry(R: number, rnd: () => number) {
  const parts: THREE.BufferGeometry[] = [];
  const rings: [number, number, number, number][] = [[0.14, 0.4, 7, 0.32], [0.4, 0.7, 11, 0.2], [0.7, 1.0, 15, 0.08]];
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  for (const [r0, r1, n, heave] of rings) {
    const off = rnd() * Math.PI * 2;
    for (let i = 0; i < n; i++) {
      const a0 = off + (i / n) * Math.PI * 2 + 0.035, a1 = off + ((i + 1) / n) * Math.PI * 2 - 0.035;
      const ri = (r0 + 0.02) * R, ro = (r1 - 0.02) * R * (0.92 + rnd() * 0.1), th = 0.1 + rnd() * 0.06;
      const P = (r: number, a: number, y: number) => v(Math.cos(a) * r, y, Math.sin(a) * r);
      const top = [P(ri, a0, th), P(ri, a1, th), P(ro, a1, th), P(ro, a0, th)], bot = top.map((q) => q.clone().setY(0));
      const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => [a, b, c, a, c, d];
      const tris = [...quad(top[0], top[3], top[2], top[1]), ...quad(bot[0], bot[1], bot[2], bot[3]),
        ...quad(bot[0], top[0], top[1], bot[1]), ...quad(bot[1], top[1], top[2], bot[2]), ...quad(bot[2], top[2], top[3], bot[3]), ...quad(bot[3], top[3], top[0], bot[0])];
      const g = new THREE.BufferGeometry().setFromPoints(tris);
      // Heave: pivot on the inner edge, lifting the outer edge (the slabs ride up around the impact), plus some roll.
      const am = (a0 + a1) / 2, d = v(Math.cos(am), 0, Math.sin(am)), t = v(-Math.sin(am), 0, Math.cos(am));
      const pivot = d.clone().multiplyScalar(ri);
      const lift = heave * (0.6 + rnd() * 0.8);
      const m = new THREE.Matrix4().makeTranslation(pivot.x, 0, pivot.z)
        .multiply(new THREE.Matrix4().makeRotationAxis(t, lift))
        .multiply(new THREE.Matrix4().makeRotationAxis(d, (rnd() - 0.5) * 0.25))
        .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -0.02 - rnd() * 0.03, -pivot.z));
      g.applyMatrix4(m);
      parts.push(g);
    }
  }
  const g = mergeGeometries(parts, false)!;
  g.computeVertexNormals();
  return g;
}
export class Crater {
  readonly group = new THREE.Group();
  private slabs: THREE.Mesh;
  private dark: THREE.Mesh;
  readonly debris: Debris;
  used = -1;
  constructor(scene: THREE.Scene, stoneMat: THREE.Material, crackTex: THREE.Texture, debris: Debris) {
    this.slabs = new THREE.Mesh(new THREE.BufferGeometry(), stoneMat);
    this.slabs.castShadow = true; this.slabs.receiveShadow = true;
    // Dark fractures and the sunken centre under the slabs (alpha-blended, no glow).
    const mat = new THREE.ShaderMaterial({ vertexShader: CRES_VERT, fragmentShader: CRATER_FRAG, transparent: true, depthWrite: false, toneMapped: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, uniforms: { uMap: { value: crackTex } } });
    this.dark = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat);
    this.dark.renderOrder = 7;
    this.group.add(this.dark, this.slabs); this.group.visible = false;
    this.debris = debris;
    scene.add(this.group);
  }
  /** Break the ground at `c` (radius R m) and throw/lift its debris. */
  start(c: THREE.Vector3, R: number, yaw: number, height: (x: number, z: number) => number, drop: number) {
    let seed = Math.floor(Math.random() * 1e6) + 1; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    this.slabs.geometry.dispose();
    this.slabs.geometry = craterGeometry(R, rnd);
    this.group.position.set(c.x, c.y + 0.01, c.z); this.group.rotation.y = yaw;
    this.dark.position.y = 0.05; this.dark.scale.set(R * 3.6, 1, R * 3.6);
    this.group.visible = this.slabs.visible = this.dark.visible = true;
    this.debris.lift(c, R * 1.4, height, drop);
  }
  clear() { this.group.visible = false; this.debris.clear(); }
  get meshes() { return [this.dark, this.slabs]; }
}
const CRATER_FRAG = /* glsl */`
uniform sampler2D uMap;
varying vec2 vUv;
void main() {
  float m = texture2D(uMap, vUv).r;
  float r = length(vUv - 0.5) * 2.0;
  float pit = smoothstep(0.32, 0.0, r);            // the sunken centre
  float cracks = m * smoothstep(1.0, 0.75, r);
  float a = clamp(max(pit * 0.85, cracks * 0.8), 0.0, 0.92);
  gl_FragColor = vec4(vec3(0.035, 0.03, 0.026), a);
  #include <colorspace_fragment>
}`;

// ------------------------------------------------------------------------------------------------ floating debris
export class Debris {
  readonly mesh: THREE.InstancedMesh;
  private parts: { p: THREE.Vector3; v: THREE.Vector3; rot: THREE.Euler; spin: THREE.Vector3; s: number; hover: number; ground: number; landed: boolean; live: boolean; erupt: boolean; bounces: number; rest: number }[] = [];
  /** How many of the pool are thrown out by the shattering ground (the rest rise and hover in the field). */
  private eruptN: number;
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion();
  private age = -1;
  onLand: ((p: THREE.Vector3) => void) | null = null;
  constructor(scene: THREE.Scene, count: number, map: THREE.Texture | null, normal: THREE.Texture | null, erupt = 0) {
    this.eruptN = erupt; count += erupt;
    // Broken paving chunks: a jittered low-poly stone, one instanced mesh (one draw call).
    const g = new THREE.DodecahedronGeometry(0.5, 0);
    const P = g.getAttribute('position'); let s = 3;
    const r = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const seen = new Map<string, number>();
    for (let i = 0; i < P.count; i++) {
      const k = `${P.getX(i).toFixed(3)},${P.getY(i).toFixed(3)},${P.getZ(i).toFixed(3)}`;
      if (!seen.has(k)) seen.set(k, 0.75 + r() * 0.45);
      const f = seen.get(k)!; P.setXYZ(i, P.getX(i) * f, P.getY(i) * f * 0.55, P.getZ(i) * f);
    }
    g.computeVertexNormals();
    // Broken paving: plain stone (no glow), the courtyard's cobblestone texture.
    const mat = new THREE.MeshStandardMaterial({ color: 0xc9c2b4, roughness: 0.92, map: map ?? undefined, normalMap: normal ?? undefined });
    this.mesh = new THREE.InstancedMesh(g, mat, count);
    this.mesh.castShadow = true; this.mesh.frustumCulled = false; this.mesh.count = 0;
    for (let i = 0; i < count; i++) this.parts.push({ p: new THREE.Vector3(), v: new THREE.Vector3(), rot: new THREE.Euler(), spin: new THREE.Vector3(), s: 1, hover: 0, ground: 0, landed: false, live: false, erupt: i < erupt, bounces: 0, rest: 0 });
    scene.add(this.mesh);
  }
  /** Lift chunks around `c` (radius 1–`radius`), hover until `drop` seconds, then fall. */
  lift(c: THREE.Vector3, radius: number, height: (x: number, z: number) => number, drop: number) {
    this.age = 0; this.drop = drop;
    this.parts.forEach((d, i) => {
      d.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      d.landed = false; d.live = true; d.bounces = 0; d.rest = 0;
      if (d.erupt) {
        // Shattered paving: slabs burst out of the impact, flung outward and up; they bounce and settle.
        const a = (i / this.eruptN) * Math.PI * 2 + Math.random() * 0.4, rr = 0.4 + Math.random() * 1.6, out = 2.5 + Math.random() * 4;
        d.p.set(c.x + Math.sin(a) * rr, 0, c.z + Math.cos(a) * rr); d.ground = height(d.p.x, d.p.z); d.p.y = d.ground + 0.05;
        d.v.set(Math.sin(a) * out, 4.5 + Math.random() * 4.5, Math.cos(a) * out);
        d.spin.set((Math.random() - 0.5) * 14, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 14);
        d.s = 0.26 + Math.random() * 0.36;
        return;
      }
      const a = (i / this.parts.length) * Math.PI * 2 + Math.random() * 0.5, rr = 1.0 + Math.random() * (radius - 1);
      d.p.set(c.x + Math.sin(a) * rr, 0, c.z + Math.cos(a) * rr); d.ground = height(d.p.x, d.p.z); d.p.y = d.ground;
      d.hover = d.ground + 0.6 + Math.random() * 1.5;
      d.v.set(0, 0, 0);
      d.spin.set((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3);
      d.s = 0.3 + Math.random() * 0.34;
    });
    this.height = height;
    this.mesh.count = this.parts.length; this.mesh.visible = true;
  }
  private drop = 1;
  private height: (x: number, z: number) => number = () => 0;
  get active() { return this.age >= 0; }
  clear() { this.age = -1; this.mesh.count = 0; this.mesh.visible = false; }
  update(dt: number) {
    if (this.age < 0) return;
    this.age += dt;
    const a = this.age;
    let moving = 0;
    this.parts.forEach((d, i) => {
      if (!d.live) return;
      if (d.erupt) {
        if (!d.landed) {
          d.v.y -= 22 * dt; d.p.addScaledVector(d.v, dt);
          d.rot.x += d.spin.x * dt; d.rot.y += d.spin.y * dt; d.rot.z += d.spin.z * dt;
          const g = this.height(d.p.x, d.p.z) + d.s * 0.25;
          if (d.p.y <= g && d.v.y < 0) {
            d.p.y = g;
            if (d.bounces++ < 1) { d.v.set(d.v.x * 0.45, -d.v.y * 0.3, d.v.z * 0.45); d.spin.multiplyScalar(0.4); this.onLand?.(d.p); }
            else { d.landed = true; d.rest = a; }
          }
        }
      } else if (a < this.drop) {
        // Rise fast out of the ground, then hover, bobbing and turning slowly (suspended by the field).
        const k = Math.min(1, a / 0.25), e = 1 - Math.pow(1 - k, 3);
        d.p.y = THREE.MathUtils.lerp(d.ground - 0.1, d.hover, e) + Math.sin(a * 3 + i) * 0.05 * e;
        d.rot.x += d.spin.x * dt * 0.4; d.rot.y += d.spin.y * dt * 0.4; d.rot.z += d.spin.z * dt * 0.4;
      } else if (!d.landed) {
        d.v.y -= 22 * dt; d.p.y += d.v.y * dt;
        d.rot.x += d.spin.x * dt * 2; d.rot.z += d.spin.z * dt * 2;
        if (d.p.y <= d.ground + d.s * 0.25) { d.p.y = d.ground + d.s * 0.25; d.landed = true; this.onLand?.(d.p); }
      }
      this.q.setFromEuler(d.rot);
      this.m.compose(d.p, this.q, new THREE.Vector3(d.s, d.s, d.s));
      this.mesh.setMatrixAt(i, this.m);
      if (!d.landed || a < this.drop) moving++;
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    // Everything has settled: the debris stays where it fell (no more updates).
    if (!moving) this.age = -1;
  }
}

// ------------------------------------------------------------------------------------------------ blade aura
const AURA_FRAG = /* glsl */`
uniform float uAlpha; uniform float uTime; uniform float uHot;
varying vec2 vUv;
${NOISE}${RAMP}
void main() {
  float across = clamp(1.0 - abs(vUv.x * 2.0 - 1.0), 0.0, 1.0);
  float n = fbm(vec2(vUv.x * 3.0, vUv.y * 6.0 - uTime * 5.0));
  float core = pow(across, 8.0), glow = pow(across, 1.8);
  float tipFade = smoothstep(0.0, 0.08, vUv.y) * smoothstep(1.0, 0.85, vUv.y);
  float a = (core * 2.2 + glow * (0.55 + 0.8 * n)) * tipFade * uAlpha;
  gl_FragColor = vec4(spiritRamp(clamp(core + glow * 0.4 + n * 0.2, 0.0, 1.0), uHot) * a, 1.0);
  #include <colorspace_fragment>
}`;
/** Two crossed glow planes along the blade (reads from any angle). */
export class BladeAura {
  private mat: THREE.ShaderMaterial;
  private group = new THREE.Group();
  constructor(mount: THREE.Object3D, hot: number) {
    this.mat = new THREE.ShaderMaterial({ vertexShader: CRES_VERT, fragmentShader: AURA_FRAG, ...additive, uniforms: { uAlpha: { value: 0 }, uTime: { value: 0 }, uHot: { value: hot } } });
    const g = new THREE.PlaneGeometry(0.32, 0.86).translate(0, 0.07 + 0.38, 0);
    for (const r of [0, Math.PI / 2]) { const m = new THREE.Mesh(g, this.mat); m.rotation.y = r; m.renderOrder = 12; m.frustumCulled = false; this.group.add(m); }
    this.group.visible = false; mount.add(this.group);
  }
  set(intensity: number, t: number, width = 1) {
    this.group.visible = intensity > 0.01;
    this.mat.uniforms.uAlpha.value = intensity; this.mat.uniforms.uTime.value = t;
    this.group.scale.set(width, 1, width);
  }
}

/** All spirit effects for one player, plus the shared crescent geometry and an optional cyan light (High). */
export class SpiritFx {
  readonly afterimages: Afterimages;
  readonly ribbon: Ribbon;
  readonly crescents: Crescent[] = [];
  readonly shocks: Shock[] = [];
  /** The last few Gravity Rupture craters stay in the courtyard. */
  readonly craters: Crater[] = [];
  private craterNext = 0;
  /** Debris landing hook (dust and a knock). */
  set onDebrisLand(fn: ((p: THREE.Vector3) => void) | null) { for (const c of this.craters) c.debris.onLand = fn; }
  readonly aura: BladeAura;
  /** High quality only: one cyan point light (always in the scene so the light count, and shaders, never change). */
  readonly light: THREE.PointLight | null;
  private lightT = 0; private lightPeak = 0; private lightDecay = 1;
  private t = 0;
  constructor(scene: THREE.Scene, model: THREE.Object3D, bladeMount: THREE.Object3D, quality: 'high' | 'low', stone: { map: THREE.Texture | null; normal: THREE.Texture | null; material?: THREE.Material }) {
    const hot = quality === 'high' ? 2.2 : 1.0;
    this.afterimages = new Afterimages(model, scene, quality === 'high' ? 4 : 2, hot);
    this.ribbon = new Ribbon(scene, 40, 0.3, 1.75, 0.42, hot);
    const cg = crescentGeometry();
    for (let i = 0; i < 2; i++) this.crescents.push(new Crescent(scene, cg, hot));
    for (let i = 0; i < 3; i++) this.shocks.push(new Shock(scene, hot));
    const crackTex = crackTexture(quality === 'high' ? 1024 : 512);
    for (let i = 0; i < 4; i++) this.craters.push(new Crater(scene, stone.material ?? new THREE.MeshStandardMaterial({ color: 0x8a8378, roughness: 0.9, map: stone.map ?? undefined }), crackTex,
      new Debris(scene, quality === 'high' ? 10 : 6, stone.map, stone.normal, quality === 'high' ? 12 : 7)));
    this.aura = new BladeAura(bladeMount, hot);
    // No coloured light: spirit energy glows in the air and on the body, never tints the ground.
    this.light = null;
  }
  /** Show every effect mesh (for shader compilation at load), then hide them again. */
  prewarm(on: boolean) {
    this.afterimages.build();
    if (on) { for (const o of this.objects()) o.visible = true; this.aura.set(1, 0); return; }
    // Hide again, but never an effect that is actually playing (an ability used while shaders were compiling).
    for (const c of this.crescents) c.group.visible = c.alive;
    for (const s of this.shocks) if (!s.alive) for (const m of s.meshes) m.visible = false;
    for (const c of this.craters) if (c.used < 0) { for (const m of c.meshes) m.visible = false; c.group.visible = false; c.debris.mesh.visible = false; }
    this.afterimages.hideIdle();
    this.aura.set(0, 0);
  }
  private objects(): THREE.Object3D[] {
    return [this.ribbon.mesh, ...this.crescents.map((c) => c.group), ...this.shocks.flatMap((s) => s.meshes), ...this.craters.flatMap((c) => [c.group, ...c.meshes, c.debris.mesh]), ...this.afterimages.meshes];
  }
  crescent() { return this.crescents.find((c) => !c.alive) ?? this.crescents[0]; }
  /** Break the ground at `c` (persistent; the oldest of the last four craters is reused). */
  crater(c: THREE.Vector3, R: number, height: (x: number, z: number) => number, drop: number) {
    const k = this.craters[this.craterNext++ % this.craters.length];
    k.used = this.t; k.start(c, R, Math.random() * Math.PI * 2, height, drop);
  }
  clearCraters() { for (const c of this.craters) { c.clear(); c.used = -1; } }
  shock() { return this.shocks.find((s) => !s.alive) ?? this.shocks[0]; }
  /** Flash the cyan light at a point (decays over `decay` s). */
  flash(p: THREE.Vector3, intensity: number, decay: number) {
    if (!this.light) return;
    this.light.position.copy(p); this.lightPeak = intensity; this.lightT = 0; this.lightDecay = decay;
  }
  /** Hold the light at a point at an intensity (charging glow). */
  glow(p: THREE.Vector3, intensity: number) { if (this.light) { this.light.position.copy(p); this.lightPeak = intensity; this.lightT = 0; this.lightDecay = 0.08; } }
  update(dt: number) {
    this.t += dt;
    this.afterimages.update(dt, this.t); this.ribbon.update(dt);
    for (const c of this.crescents) c.update(dt);
    for (const s of this.shocks) s.update(dt);
    for (const c of this.craters) c.debris.update(dt);
    if (this.light) { this.lightT += dt; this.light.intensity = this.lightPeak * Math.max(0, 1 - this.lightT / this.lightDecay); }
  }
  get time() { return this.t; }
}
