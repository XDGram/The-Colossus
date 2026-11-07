import * as THREE from 'three';
import { mulberry32 } from '../core/noise';

/**
 * The realm transition (docs/boss.md): the last frame of the old world is frozen onto a sheet of glass shards over
 * the screen. Cracks run out from the impact point, then the shards break away — spinning, tumbling toward the
 * camera and falling — revealing the new world rendered live underneath. Drawn after the post chain, in screen space.
 */
const VERT = /* glsl */`
attribute vec2 aCenter; attribute vec3 aRand; attribute vec3 aBary; attribute float aDist;
uniform float uFall; uniform float uCrack; uniform vec2 uImpact;
varying vec2 vUv; varying vec3 vBary; varying float vDist; varying float vA; varying float vShade;
void main() {
  vec2 p = position.xy;
  vUv = p * 0.5 + 0.5;
  vBary = aBary; vDist = aDist;
  // Shards near the impact go first.
  float t = clamp((uFall - aDist * 0.32) / 0.68, 0.0, 1.0);
  float te = t * t;
  vec2 local = p - aCenter;
  // Cracked but still in place: each shard sits a hair out of line.
  float cracked = step(aDist, uCrack * 1.7);
  vec2 jog = (aRand.xy - 0.5) * 0.006 * cracked;
  float ang = t * (aRand.x - 0.5) * 7.0;
  float c = cos(ang), s = sin(ang);
  local = vec2(c * local.x - s * local.y, s * local.x + c * local.y);
  float tumble = cos(t * (2.0 + aRand.y * 7.0));
  local.x *= tumble;
  float scale = 1.0 + te * (0.6 + aRand.z * 1.6);
  vec2 dir = normalize(aCenter - uImpact + vec2(1e-4));
  vec2 q = aCenter + jog + local * scale + dir * t * (0.25 + aRand.z * 0.5) + vec2(0.0, -2.2 * te);
  vShade = tumble;
  vA = 1.0 - smoothstep(0.65, 1.0, t);
  gl_Position = vec4(q, 0.0, 1.0);
}`;
const FRAG = /* glsl */`
uniform sampler2D tFrame; uniform float uCrack;
varying vec2 vUv; varying vec3 vBary; varying float vDist; varying float vA; varying float vShade;
void main() {
  vec3 col = texture2D(tFrame, vUv).rgb;
  float e = min(min(vBary.x, 1.0 - vBary.x), min(vBary.y, 1.0 - vBary.y));
  float w = fwidth(e) * 1.1;
  float on = smoothstep(vDist - 0.15, vDist, uCrack * 1.7);
  float line = (1.0 - smoothstep(0.0, w, e)) * on;
  float glow = (1.0 - smoothstep(0.0, w * 5.0, e)) * on;
  col = mix(col, vec3(1.0, 0.98, 0.94), line * 0.7);
  col += vec3(0.55, 0.6, 0.75) * glow * 0.18;
  // Glass catching the light as it turns.
  col *= 0.6 + 0.4 * abs(vShade);
  col += vec3(0.25) * pow(1.0 - abs(vShade), 6.0);
  gl_FragColor = vec4(col, vA);
}`;

export class Shatter {
  readonly scene = new THREE.Scene();
  private cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private mat: THREE.ShaderMaterial;
  private mesh: THREE.Mesh;
  private tex: THREE.FramebufferTexture | null = null;
  private want: [number, number] | null = null;
  visible = false;

  constructor() {
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
      uniforms: { tFrame: { value: null }, uFall: { value: 0 }, uCrack: { value: 0 }, uImpact: { value: new THREE.Vector2() } },
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }
  /** Freeze the next rendered frame onto new glass, cracking out from `impact` (screen, -1..1). */
  capture(impact: [number, number], aspect: number) {
    this.want = impact;
    this.build(impact, aspect);
    this.mat.uniforms.uImpact.value.set(impact[0], impact[1]);
    this.mat.uniforms.uCrack.value = 0; this.mat.uniforms.uFall.value = 0;
  }
  set crack(v: number) { this.mat.uniforms.uCrack.value = v; }
  set fall(v: number) { this.mat.uniforms.uFall.value = v; }
  hide() { this.visible = false; }

  /** Called by the post chain right after the frame reached the screen. */
  afterFrame(renderer: THREE.WebGLRenderer) {
    if (this.want) {
      const size = renderer.getDrawingBufferSize(new THREE.Vector2());
      if (!this.tex || this.tex.image.width !== size.x || this.tex.image.height !== size.y) {
        this.tex?.dispose(); this.tex = new THREE.FramebufferTexture(size.x, size.y);
      }
      renderer.copyFramebufferToTexture(this.tex);
      this.mat.uniforms.tFrame.value = this.tex;
      this.want = null; this.visible = true;
    }
    if (!this.visible) return;
    const auto = renderer.autoClear; renderer.autoClear = false;
    renderer.render(this.scene, this.cam);
    renderer.autoClear = auto;
  }
  /**
   * Shards: a jittered polar grid around the impact (rings x sectors, shared jittered corners, so the pieces tile the
   * screen exactly), aspect-corrected so the rings read round. Each cell is one quad shard.
   */
  private build(impact: [number, number], aspect: number) {
    const rnd = mulberry32(Math.floor(Math.random() * 1e6));
    const radii = [0, 0.06, 0.15, 0.27, 0.42, 0.6, 0.82, 1.08, 1.4, 1.8, 2.4, 3.2];
    const N = 22, off = rnd() * 6.28;
    const V: [number, number][][] = radii.map((r, k) => Array.from({ length: N }, (_, i) => {
      if (k === 0) return [impact[0], impact[1]] as [number, number];
      const a = off + (i + (rnd() - 0.5) * 0.9) / N * Math.PI * 2, rr = r * (0.78 + rnd() * 0.44);
      return [impact[0] + Math.cos(a) * rr / aspect, impact[1] + Math.sin(a) * rr] as [number, number];
    }));
    const quads: { c: [number, number][]; d: number }[] = [];
    for (let k = 0; k < radii.length - 1; k++) for (let i = 0; i < N; i++) {
      const j = (i + 1) % N;
      quads.push({ c: [V[k][i], V[k][j], V[k + 1][j], V[k + 1][i]], d: (radii[k] + radii[k + 1]) / 2 });
    }
    // Two triangles per quad; (u, v) across the quad gives the crack lines along its four edges only.
    const uv: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]], order = [0, 1, 2, 0, 2, 3];
    const n = quads.length * 6;
    const pos = new Float32Array(n * 3), cen = new Float32Array(n * 2), ran = new Float32Array(n * 3), bar = new Float32Array(n * 3), dist = new Float32Array(n);
    quads.forEach((q, k) => {
      const cx = q.c.reduce((s2, p) => s2 + p[0], 0) / 4, cy = q.c.reduce((s2, p) => s2 + p[1], 0) / 4;
      const r = [rnd(), rnd(), rnd()];
      order.forEach((o, v) => {
        const i = k * 6 + v;
        pos.set([q.c[o][0], q.c[o][1], 0], i * 3); cen.set([cx, cy], i * 2); ran.set(r, i * 3);
        bar.set([uv[o][0], uv[o][1], 0], i * 3); dist[i] = q.d;
      });
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aCenter', new THREE.BufferAttribute(cen, 2));
    g.setAttribute('aRand', new THREE.BufferAttribute(ran, 3));
    g.setAttribute('aBary', new THREE.BufferAttribute(bar, 3));
    g.setAttribute('aDist', new THREE.BufferAttribute(dist, 1));
    this.mesh.geometry.dispose(); this.mesh.geometry = g;
  }
}
