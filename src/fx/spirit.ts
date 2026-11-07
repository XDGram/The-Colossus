import * as THREE from 'three';

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
 * - Cracks: radial glowing cracks that race out from the blade and cool down; glyph ring; floating paving debris.
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
  float across = 1.0 - abs(vSide * 2.0 - 1.0);              // 0 at the edges, 1 at the centre line
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
  float taper = pow(sin(3.14159 * u), 0.75);          // thin, sharp tips
  float d = abs(v - 0.5) * 2.0 / max(taper, 0.02);  // 0 on the core line, 1 at the band edge
  if (d > 1.0) discard;
  float n = fbm(vec2(u * 9.0 + uTime * 3.0, v * 3.0 - uTime * 7.0));
  float core = exp(-d * d * 10.0);
  float body = pow(1.0 - d, 1.6);
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
    a = pow(1.0 - h, 2.2) * (0.5 + 0.8 * n); k = clamp((1.0 - h) * 0.9 + n * 0.3, 0.0, 1.0);
  } else {
    // Ring: a thin bright leading edge with a soft wake inside.
    float r = length(vUv - 0.5) * 2.0;
    float edge = exp(-pow((r - 0.96) * 26.0, 2.0)), wake = smoothstep(0.55, 0.96, r) * (1.0 - smoothstep(0.96, 1.0, r));
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
    this.ring.visible = true; this.wall.visible = wallH > 0;
  }
  update(dt: number) {
    if (!this.alive) return;
    this.age += dt;
    if (this.age >= this.life) { this.alive = false; this.ring.visible = this.wall.visible = false; return; }
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
function glyphTexture(size: number) {
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d')!; g.fillStyle = '#000'; g.fillRect(0, 0, size, size);
  const C = size / 2; let seed = 31; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.strokeStyle = '#fff'; g.lineCap = 'round';
  const circle = (r: number, w: number) => { g.lineWidth = w; g.beginPath(); g.arc(C, C, r, 0, Math.PI * 2); g.stroke(); };
  circle(size * 0.47, size * 0.008); circle(size * 0.42, size * 0.004); circle(size * 0.27, size * 0.005); circle(size * 0.235, size * 0.003);
  // Original angular glyphs between the outer rings, in the temple's carved-seal manner (not any real script).
  const n = 20;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    g.save(); g.translate(C + Math.cos(a) * size * 0.445, C + Math.sin(a) * size * 0.445); g.rotate(a + Math.PI / 2);
    g.lineWidth = size * 0.005; const s = size * 0.018;
    g.beginPath();
    const strokes = 2 + Math.floor(rnd() * 3);
    for (let k = 0; k < strokes; k++) {
      const x0 = (rnd() - 0.5) * 2 * s, y0 = (rnd() - 0.5) * 2 * s;
      g.moveTo(x0, y0); g.lineTo(x0 + (rnd() < 0.5 ? s * 1.2 : 0), y0 + (rnd() < 0.5 ? s * 1.2 : -s * 0.6));
    }
    g.stroke(); g.restore();
  }
  // Radial ticks and an inner eight-point star.
  for (let i = 0; i < 64; i++) { const a = (i / 64) * Math.PI * 2, r0 = size * (i % 4 ? 0.27 : 0.25), r1 = size * 0.30; g.lineWidth = size * (i % 4 ? 0.002 : 0.004); g.beginPath(); g.moveTo(C + Math.cos(a) * r0, C + Math.sin(a) * r0); g.lineTo(C + Math.cos(a) * r1, C + Math.sin(a) * r1); g.stroke(); }
  g.lineWidth = size * 0.004; g.beginPath();
  for (let i = 0; i <= 16; i++) { const a = (i / 16) * Math.PI * 2, r = size * (i % 2 ? 0.08 : 0.2); const x = C + Math.cos(a) * r, y = C + Math.sin(a) * r; if (i) g.lineTo(x, y); else g.moveTo(x, y); }
  g.stroke();
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.NoColorSpace;
  return t;
}
const CRACK_FRAG = /* glsl */`
uniform sampler2D uMap; uniform float uReveal; uniform float uHeat; uniform float uAlpha; uniform float uHot; uniform float uTime; uniform float uDark;
varying vec2 vUv;
${NOISE}${RAMP}
void main() {
  float m = texture2D(uMap, vUv).r;
  float r = length(vUv - 0.5) * 2.0;
  float vis = smoothstep(uReveal, uReveal - 0.08, r) * smoothstep(1.0, 0.85, r);
  if (uDark > 0.5) { float crater = smoothstep(0.35, 0.0, r) * 0.55; gl_FragColor = vec4(0.04, 0.035, 0.03, max(m * 0.9, crater) * vis * uAlpha); return; }
  float pulse = 0.85 + 0.3 * fbm(vec2(r * 6.0 - uTime * 2.0, 0.5));
  // Heat: 1 = white-hot spirit energy, cooling through cyan and deep blue to nothing.
  float k = clamp(uHeat * (0.92 - r * 0.45), 0.0, 0.9);
  vec3 col = spiritRamp(k, uHot) * (0.35 + 1.3 * uHeat);
  gl_FragColor = vec4(col * m * vis * uAlpha * pulse, 1.0);
  #include <colorspace_fragment>
}`;
const GLYPH_FRAG = /* glsl */`
uniform sampler2D uMap; uniform float uAlpha; uniform float uHot; uniform float uFlare;
varying vec2 vUv;
${RAMP}
void main() {
  float m = texture2D(uMap, vUv).r;
  float r = length(vUv - 0.5) * 2.0;
  vec3 col = spiritRamp(clamp(0.42 + uFlare * 0.4, 0.0, 1.0), uHot);
  gl_FragColor = vec4(col * m * uAlpha * (1.0 + uFlare * 1.5) + col * exp(-r * r * 8.0) * uFlare * 0.4, 1.0);
  #include <colorspace_fragment>
}`;
export class GroundMarks {
  private crack: THREE.Mesh; private dark: THREE.Mesh; private glyph: THREE.Mesh;
  get meshes() { return [this.crack, this.dark, this.glyph]; }
  get active() { return this.age >= 0; }
  private cm: THREE.ShaderMaterial; private dm: THREE.ShaderMaterial; private gm: THREE.ShaderMaterial;
  private age = -1; private size = 9;
  constructor(scene: THREE.Scene, quality: 'high' | 'low', hot: number) {
    const tex = crackTexture(quality === 'high' ? 1024 : 512), gt = glyphTexture(quality === 'high' ? 1024 : 512);
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const u = (map: THREE.Texture, dark: number) => ({ uMap: { value: map }, uReveal: { value: 0 }, uHeat: { value: 1 }, uAlpha: { value: 0 }, uHot: { value: hot }, uTime: { value: 0 }, uDark: { value: dark }, uFlare: { value: 0 } });
    const deco = { polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 };
    this.cm = new THREE.ShaderMaterial({ vertexShader: CRES_VERT, fragmentShader: CRACK_FRAG, ...additive, ...deco, uniforms: u(tex, 0) });
    this.dm = new THREE.ShaderMaterial({ vertexShader: CRES_VERT, fragmentShader: CRACK_FRAG, transparent: true, depthWrite: false, toneMapped: false, ...deco, uniforms: u(tex, 1) });
    this.gm = new THREE.ShaderMaterial({ vertexShader: CRES_VERT, fragmentShader: GLYPH_FRAG, ...additive, ...deco, uniforms: u(gt, 0) });
    this.crack = new THREE.Mesh(plane, this.cm); this.dark = new THREE.Mesh(plane, this.dm); this.glyph = new THREE.Mesh(plane, this.gm);
    this.dark.renderOrder = 8; this.crack.renderOrder = 9; this.glyph.renderOrder = 9;
    for (const m of [this.crack, this.dark, this.glyph]) { m.visible = false; m.frustumCulled = false; scene.add(m); }
  }
  /** Cracks race out from `c` (size: diameter, m); the glyph ring flares and turns. */
  start(c: THREE.Vector3, size: number, yaw: number) {
    this.age = 0; this.size = size;
    for (const m of [this.crack, this.dark]) { m.position.set(c.x, c.y + 0.07, c.z); m.scale.set(size, 1, size); m.rotation.y = yaw; m.visible = true; }
    this.glyph.position.set(c.x, c.y + 0.085, c.z); this.glyph.scale.set(size * 0.62, 1, size * 0.62); this.glyph.visible = true;
  }
  update(dt: number, t: number) {
    if (this.age < 0) return;
    this.age += dt;
    const a = this.age, LIFE = 3.2;
    if (a >= LIFE) { this.age = -1; this.crack.visible = this.dark.visible = this.glyph.visible = false; return; }
    const reveal = Math.min(1.05, a / 0.16);
    const heat = a < 0.15 ? 1 : Math.max(0, 1 - (a - 0.15) / 1.6);
    const fade = Math.min(1, (LIFE - a) / 1.0);
    this.cm.uniforms.uReveal.value = this.dm.uniforms.uReveal.value = reveal;
    this.cm.uniforms.uHeat.value = heat; this.cm.uniforms.uAlpha.value = fade; this.dm.uniforms.uAlpha.value = fade;
    this.cm.uniforms.uTime.value = t;
    const gin = Math.min(1, a / 0.1), gout = Math.max(0, 1 - Math.max(0, a - 1.1) / 0.8);
    this.gm.uniforms.uAlpha.value = gin * gout * 0.7; this.gm.uniforms.uFlare.value = Math.max(0, 1 - a / 0.35);
    this.glyph.rotation.y += dt * (0.4 + 3 * Math.max(0, 1 - a / 0.5));
  }
}

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
    const mat = new THREE.MeshStandardMaterial({ color: 0xa8a296, roughness: 0.9, map: map ?? undefined, normalMap: normal ?? undefined, emissive: new THREE.Color(0.08, 0.42, 0.75), emissiveIntensity: 0 });
    mat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance *= pow(clamp(-(inverse(viewMatrix) * vec4(normal, 0.0)).y, 0.0, 1.0), 3.0);`);
    };
    mat.customProgramCacheKey = () => 'spirit-debris';
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
        d.s = 0.16 + Math.random() * 0.3;
        return;
      }
      const a = (i / this.parts.length) * Math.PI * 2 + Math.random() * 0.5, rr = 1.0 + Math.random() * (radius - 1);
      d.p.set(c.x + Math.sin(a) * rr, 0, c.z + Math.cos(a) * rr); d.ground = height(d.p.x, d.p.z); d.p.y = d.ground;
      d.hover = d.ground + 0.6 + Math.random() * 1.5;
      d.v.set(0, 0, 0);
      d.spin.set((Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3, (Math.random() - 0.5) * 3);
      d.s = 0.24 + Math.random() * 0.3;
    });
    this.height = height;
    this.mesh.count = this.parts.length; this.mesh.visible = true;
  }
  private drop = 1;
  private height: (x: number, z: number) => number = () => 0;
  get active() { return this.age >= 0; }
  update(dt: number) {
    if (this.age < 0) return;
    this.age += dt;
    const a = this.age;
    const mat = this.mesh.material as THREE.MeshStandardMaterial;
    mat.emissiveIntensity = a < this.drop ? Math.min(1, a / 0.2) * 0.9 : Math.max(0, 0.9 - (a - this.drop) * 3);
    let alive = 0;
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
        } else if (a - d.rest > 1.6) { d.p.y -= dt * 0.25; if (a - d.rest > 2.6) d.live = false; }
      } else if (a < this.drop) {
        // Rise fast out of the ground, then hover, bobbing and turning slowly (suspended by the field).
        const k = Math.min(1, a / 0.25), e = 1 - Math.pow(1 - k, 3);
        d.p.y = THREE.MathUtils.lerp(d.ground - 0.1, d.hover, e) + Math.sin(a * 3 + i) * 0.05 * e;
        d.rot.x += d.spin.x * dt * 0.4; d.rot.y += d.spin.y * dt * 0.4; d.rot.z += d.spin.z * dt * 0.4;
      } else if (!d.landed) {
        d.v.y -= 22 * dt; d.p.y += d.v.y * dt;
        d.rot.x += d.spin.x * dt * 2; d.rot.z += d.spin.z * dt * 2;
        if (d.p.y <= d.ground + d.s * 0.25) { d.p.y = d.ground + d.s * 0.25; d.landed = true; this.onLand?.(d.p); }
      } else if (a > this.drop + 1.2) { d.p.y -= dt * 0.25; if (a > this.drop + 2.2) d.live = false; }
      this.q.setFromEuler(d.rot);
      this.m.compose(d.p, this.q, new THREE.Vector3(d.s, d.s, d.s));
      this.mesh.setMatrixAt(i, this.m);
      alive++;
    });
    this.mesh.instanceMatrix.needsUpdate = true;
    if (!alive) { this.age = -1; this.mesh.count = 0; }
  }
}

// ------------------------------------------------------------------------------------------------ blade aura
const AURA_FRAG = /* glsl */`
uniform float uAlpha; uniform float uTime; uniform float uHot;
varying vec2 vUv;
${NOISE}${RAMP}
void main() {
  float across = 1.0 - abs(vUv.x * 2.0 - 1.0);
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
  readonly marks: GroundMarks;
  readonly debris: Debris;
  readonly aura: BladeAura;
  /** High quality only: one cyan point light (always in the scene so the light count, and shaders, never change). */
  readonly light: THREE.PointLight | null;
  private lightT = 0; private lightPeak = 0; private lightDecay = 1;
  private t = 0;
  constructor(scene: THREE.Scene, model: THREE.Object3D, bladeMount: THREE.Object3D, quality: 'high' | 'low', stone: { map: THREE.Texture | null; normal: THREE.Texture | null }) {
    const hot = quality === 'high' ? 2.2 : 1.0;
    this.afterimages = new Afterimages(model, scene, quality === 'high' ? 4 : 2, hot);
    this.ribbon = new Ribbon(scene, 40, 0.3, 1.75, 0.42, hot);
    const cg = crescentGeometry();
    for (let i = 0; i < 2; i++) this.crescents.push(new Crescent(scene, cg, hot));
    for (let i = 0; i < 3; i++) this.shocks.push(new Shock(scene, hot));
    this.marks = new GroundMarks(scene, quality, hot);
    this.debris = new Debris(scene, quality === 'high' ? 18 : 9, stone.map, stone.normal, quality === 'high' ? 16 : 9);
    this.aura = new BladeAura(bladeMount, hot);
    this.light = quality === 'high' ? new THREE.PointLight(0x5fd8ff, 0, 9, 2) : null;
    if (this.light) scene.add(this.light);
  }
  /** Show every effect mesh (for shader compilation at load), then hide them again. */
  prewarm(on: boolean) {
    this.afterimages.build();
    if (on) { for (const o of this.objects()) o.visible = true; this.aura.set(1, 0); return; }
    // Hide again, but never an effect that is actually playing (an ability used while shaders were compiling).
    for (const c of this.crescents) c.group.visible = c.alive;
    for (const s of this.shocks) if (!s.alive) for (const m of s.meshes) m.visible = false;
    if (!this.marks.active) for (const m of this.marks.meshes) m.visible = false;
    if (!this.debris.active) this.debris.mesh.visible = false;
    this.afterimages.hideIdle();
    this.aura.set(0, 0);
  }
  private objects(): THREE.Object3D[] {
    return [this.ribbon.mesh, ...this.crescents.map((c) => c.group), ...this.shocks.flatMap((s) => s.meshes), ...this.marks.meshes, this.debris.mesh, ...this.afterimages.meshes];
  }
  crescent() { return this.crescents.find((c) => !c.alive) ?? this.crescents[0]; }
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
    this.marks.update(dt, this.t); this.debris.update(dt);
    if (this.light) { this.lightT += dt; this.light.intensity = this.lightPeak * Math.max(0, 1 - this.lightT / this.lightDecay); }
  }
  get time() { return this.t; }
}
