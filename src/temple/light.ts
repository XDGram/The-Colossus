import * as THREE from 'three';
import { mulberry32 } from '../core/noise';

/**
 * Hand-placed volumetric sun beams: soft additive cylinders aligned to the sun, passing through gaps
 * between trees and buildings. Brightest along their core, fading toward the ground (no hard intersection)
 * and toward the sky, with drifting dust. Strongest when the camera looks toward the sun, as real
 * in-scattering is. One draw call for all beams.
 */
export class SunBeams {
  readonly mesh: THREE.Mesh;
  private uTime = { value: 0 };
  constructor(sunDir: THREE.Vector3, anchors: { x: number; y: number; z: number; r: number }[], colour = new THREE.Color(1.0, 0.82, 0.5)) {
    const parts: THREE.BufferGeometry[] = [];
    const rnd = mulberry32(31);
    const up = new THREE.Vector3(0, 1, 0);
    const q = new THREE.Quaternion().setFromUnitVectors(up, sunDir.clone().normalize());
    for (const a of anchors) {
      const len = 70;
      const g = new THREE.CylinderGeometry(a.r, a.r * 1.15, len, 16, 12, true);
      // Store the along-beam parameter (0 at ground, 1 in the sky) and a per-beam seed in uv.
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      const seed = rnd();
      for (let i = 0; i < uv.count; i++) uv.setXY(i, seed, uv.getY(i));
      g.translate(0, len / 2, 0).applyQuaternion(q).translate(a.x, a.y, a.z);
      parts.push(g.toNonIndexed());
    }
    const geo = new THREE.BufferGeometry();
    const merged = parts.length ? parts : [new THREE.BufferGeometry()];
    let n = 0; for (const p of merged) n += p.getAttribute('position')?.count ?? 0;
    const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), uvs = new Float32Array(n * 2);
    let o = 0;
    for (const p of parts) {
      pos.set(p.getAttribute('position').array as Float32Array, o * 3);
      nor.set(p.getAttribute('normal').array as Float32Array, o * 3);
      uvs.set(p.getAttribute('uv').array as Float32Array, o * 2);
      o += p.getAttribute('position').count;
    }
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.computeBoundingSphere();
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uTime: this.uTime, uCol: { value: colour }, uSun: { value: sunDir.clone().normalize() } },
      vertexShader: /* glsl */ `
        varying vec2 vUv; varying vec3 vN; varying vec3 vW;
        void main() { vUv = uv; vN = normalize(mat3(modelMatrix) * normal); vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
      fragmentShader: /* glsl */ `
        uniform float uTime; uniform vec3 uCol; uniform vec3 uSun;
        varying vec2 vUv; varying vec3 vN; varying vec3 vW;
        float h(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
        float n2(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
        void main() {
          vec3 v = normalize(cameraPosition - vW);
          // Soft core: bright where the view grazes through the beam's centre, nothing at its silhouette.
          float core = pow(clamp(abs(dot(normalize(vN), v)), 0.0, 1.0), 2.2);
          float t = vUv.y;
          float along = smoothstep(0.0, 0.18, t) * (1.0 - smoothstep(0.45, 1.0, t));
          float dust = 0.65 + 0.35 * n2(vec2(t * 40.0 - uTime * 0.25, vUv.x * 50.0 + uTime * 0.05));
          // Forward scattering: beams glow when looking toward the sun, fade when the sun is behind you.
          float fwd = 0.25 + 0.75 * pow(max(dot(-v, uSun), 0.0), 3.0);
          float fade = 1.0 - smoothstep(60.0, 140.0, distance(cameraPosition, vW));
          gl_FragColor = vec4(uCol * core * along * dust * fwd * fade * 0.07, 1.0);
        }`,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
  }
  update(t: number) { this.uTime.value = t; }
}
