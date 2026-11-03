import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mulberry32, fbm, smoothstep } from '../core/noise';
import { terrainHeight, terrainNormal, terrainMask, streamX, POOL, STREAM_SOURCE_Z } from './heightfield';

/**
 * Card-based ground foliage around the camera: textured grass clumps (crossed alpha cards from a
 * Poly Haven grass atlas) and wildflowers. Cells of 8m are generated deterministically and cached;
 * the instance buffer is refilled only when the camera crosses a cell.
 */
const CELL = 8;
const foliageTime = { value: 0 };
export function setFoliageTime(t: number) { foliageTime.value = t; }

export interface CardInstance { x: number; y: number; z: number; yaw: number; w: number; h: number; slot: number; tint: [number, number, number]; lift?: number }
type Generator = (x: number, z: number, rnd: () => number) => CardInstance | null;

export class CardField {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private aOffset: THREE.InstancedBufferAttribute;
  private aShape: THREE.InstancedBufferAttribute;
  private aTint: THREE.InstancedBufferAttribute;
  private cache = new Map<string, Float32Array[]>();
  private lastCell = '';
  private capacity: number;

  constructor(base: THREE.BufferGeometry, private opts: {
    map: THREE.Texture; slots: number; radius: number; density: number; gen: Generator; key: string;
    sunDir: THREE.Vector3; sunColor: THREE.Color; wind: number; alphaToCoverage: boolean; stems?: boolean;
  }) {
    this.capacity = Math.ceil(Math.PI * (opts.radius + CELL * 1.5) ** 2 * opts.density) + 64;
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index;
    for (const k of Object.keys(base.attributes)) this.geo.setAttribute(k, base.getAttribute(k));
    this.aOffset = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aShape = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    this.aTint = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('aOffset', this.aOffset);
    this.geo.setAttribute('aShape', this.aShape);
    this.geo.setAttribute('aTint', this.aTint);
    this.geo.instanceCount = 0;

    const mat = new THREE.MeshStandardMaterial({
      map: opts.map, alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.82, metalness: 0,
      alphaToCoverage: opts.alphaToCoverage,
    });
    const sd = opts.sunDir, sc = opts.sunColor;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = foliageTime;
      sh.uniforms.uRadius = { value: opts.radius };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', /* glsl */ `#include <common>
          attribute vec4 aOffset; attribute vec4 aShape; attribute vec3 aTint; attribute float aStem;
          uniform float uTime; uniform float uRadius; varying vec3 vTint; varying float vT; varying float vStem;`)
        .replace('#include <uv_vertex>', /* glsl */ `#include <uv_vertex>
          vMapUv = vec2((aShape.z + clamp(uv.x, 0.0, 1.0)) / ${opts.slots.toFixed(1)}, uv.y);`)
        .replace('#include <beginnormal_vertex>', /* glsl */ `
          float cy = cos(aOffset.w), sy = sin(aOffset.w);
          vec3 objectNormal = normalize(vec3(0.0, 1.0, 0.0) + vec3(sy, 0.0, cy) * 0.25 * (position.z + position.x));`)
        .replace('#include <begin_vertex>', /* glsl */ `
          float dCam = distance(aOffset.xz, cameraPosition.xz);
          float fade = 1.0 - smoothstep(uRadius * 0.72, uRadius, dCam);
          vec3 p = position;
          vStem = aStem;
          vT = clamp(p.y, 0.0, 1.0);
          p.xz *= aShape.x;
          p.y = p.y * aShape.y * fade + aShape.w * fade;
          // Wind: big travelling gusts that roll across the valley, plus flutter.
          float gust = sin(dot(aOffset.xz, vec2(0.055, 0.031)) - uTime * 1.25);
          gust = gust * 0.5 + 0.5; gust *= gust;
          float flutter = sin(uTime * 3.4 + aOffset.x * 1.7 + aOffset.z * 1.3) * 0.15;
          float bend = (gust * ${opts.wind.toFixed(3)} + flutter * ${(opts.wind * 0.5).toFixed(3)}) * vT * vT * aShape.y;
          vec3 transformed = vec3(p.x * cy + p.z * sy, p.y, -p.x * sy + p.z * cy);
          transformed.xz += vec2(0.82, 0.57) * bend;
          transformed.y -= bend * bend * 0.25;
          transformed += aOffset.xyz;
          vTint = aTint;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vTint; varying float vT; varying float vStem;')
        .replace('#include <map_fragment>', /* glsl */ `
          #ifdef USE_MAP
            vec4 sampledDiffuseColor = texture2D( map, vMapUv );
            if (vStem > 0.5) sampledDiffuseColor = vec4(0.16, 0.22, 0.07, 1.0);
            diffuseColor *= sampledDiffuseColor;
          #endif
          diffuseColor.rgb *= vTint * mix(0.55, 1.05, vT);`)
        .replace('#include <normal_fragment_begin>', 'float faceDirection = 1.0; vec3 normal = normalize(vNormal); vec3 nonPerturbedNormal = normal;')
        // Sun through thin blades: warm translucency when looking toward the sun.
        .replace('#include <emissivemap_fragment>', /* glsl */ `#include <emissivemap_fragment>
          {
            vec3 viewW = normalize(vViewPosition);
            vec3 sunV = normalize((viewMatrix * vec4(${sd.x.toFixed(4)}, ${sd.y.toFixed(4)}, ${sd.z.toFixed(4)}, 0.0)).xyz);
            float back = pow(max(dot(-viewW, sunV), 0.0), 4.0);
            #ifdef USE_FOG
              back *= cloudLight(vFogWorldPos);
            #endif
            totalEmissiveRadiance += diffuseColor.rgb * vec3(${sc.r.toFixed(3)}, ${sc.g.toFixed(3)}, ${sc.b.toFixed(3)}) * back * vT * 1.6;
          }`);
    };
    mat.customProgramCacheKey = () => `cards-${opts.key}`;
    this.mesh = new THREE.Mesh(this.geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
  }

  private cell(cx: number, cz: number) {
    const key = `${cx},${cz}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const rnd = mulberry32((cx * 73856093) ^ (cz * 19349663) ^ this.opts.key.length * 7919);
    const n = Math.round(CELL * CELL * this.opts.density);
    const o: number[] = [], s: number[] = [], t: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = (cx + rnd()) * CELL, z = (cz + rnd()) * CELL;
      const c = this.opts.gen(x, z, rnd);
      if (!c) continue;
      o.push(c.x, c.y, c.z, c.yaw);
      s.push(c.w, c.h, c.slot, c.lift ?? 0);
      t.push(...c.tint);
    }
    const entry = [new Float32Array(o), new Float32Array(s), new Float32Array(t)];
    this.cache.set(key, entry);
    if (this.cache.size > 1200) this.cache.delete(this.cache.keys().next().value!);
    return entry;
  }

  update(cam: THREE.Vector3) {
    const ccx = Math.floor(cam.x / CELL), ccz = Math.floor(cam.z / CELL);
    const key = `${ccx},${ccz}`;
    if (key === this.lastCell) return;
    this.lastCell = key;
    const rc = Math.ceil(this.opts.radius / CELL) + 1;
    const O = this.aOffset.array as Float32Array, S = this.aShape.array as Float32Array, T = this.aTint.array as Float32Array;
    let count = 0;
    for (let dz = -rc; dz <= rc; dz++) for (let dx = -rc; dx <= rc; dx++) {
      if ((dx * dx + dz * dz) * CELL * CELL > (this.opts.radius + CELL * 1.5) ** 2) continue;
      const [o, s, t] = this.cell(ccx + dx, ccz + dz);
      const m = o.length / 4;
      if (count + m > this.capacity) break;
      O.set(o, count * 4); S.set(s, count * 4); T.set(t, count * 3);
      count += m;
    }
    this.geo.instanceCount = count;
    this.aOffset.needsUpdate = this.aShape.needsUpdate = this.aTint.needsUpdate = true;
  }
}

/** n vertical quads crossed around the Y axis; x in [-0.5,0.5], y in [0,1]. */
export function crossedCards(n: number) {
  const pos: number[] = [], uv: number[] = [], nor: number[] = [], stem: number[] = [], idx: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI;
    const c = Math.cos(a) * 0.5, s = Math.sin(a) * 0.5;
    const b = pos.length / 3;
    pos.push(-c, 0, -s, c, 0, s, c, 1, s, -c, 1, -s);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let i = 0; i < 4; i++) { nor.push(0, 1, 0); stem.push(0); }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aStem', new THREE.Float32BufferAttribute(stem, 1));
  g.setIndex(idx);
  return g;
}

/** A flower: a head card tilted toward the sky on top of a thin stem. y in [0,1] spans the head only; the stem uses aShape.w lift. */
export function flowerCard() {
  const pos: number[] = [], uv: number[] = [], nor: number[] = [], stem: number[] = [], idx: number[] = [];
  // Head: two cards tilted up ~55deg, crossed.
  for (let k = 0; k < 2; k++) {
    const a = (k / 2) * Math.PI;
    const cx = Math.cos(a) * 0.5, sx = Math.sin(a) * 0.5;
    const tilt = 0.4; // horizontal offset of the top edge (leans the card back toward the sky)
    const b = pos.length / 3;
    const nx = -Math.sin(a) * tilt, nz = Math.cos(a) * tilt;
    pos.push(-cx, 0, -sx, cx, 0, sx, cx + nx, 0.8, sx + nz, -cx + nx, 0.8, -sx + nz);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    for (let i = 0; i < 4; i++) { nor.push(0, 1, 0); stem.push(0); }
    idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  // Stem: a thin quad from the ground (y = -lift handled by placing y=-1 scaled... ) — uses y in [-4, 0] relative to the head.
  const b = pos.length / 3;
  pos.push(-0.04, -3.5, 0, 0.04, -3.5, 0, 0.04, 0.1, 0, -0.04, 0.1, 0);
  uv.push(0, 0, 0, 0, 0, 0, 0, 0);
  for (let i = 0; i < 4; i++) { nor.push(0, 1, 0); stem.push(1); }
  idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aStem', new THREE.Float32BufferAttribute(stem, 1));
  g.setIndex(idx);
  return g;
}

const near = (blockers: { x: number; z: number; r: number }[], x: number, z: number, pad = 0) =>
  blockers.some((b) => (x - b.x) ** 2 + (z - b.z) ** 2 < (b.r + pad) ** 2);

function inWater(x: number, z: number) {
  if (Math.hypot(x - POOL.x, (z - POOL.z) * 0.85) < POOL.r * 0.85) return true;
  return z > POOL.z && z < STREAM_SOURCE_Z && Math.abs(x - streamX(z)) < 4.2;
}

/** Grass: lush meadow, waist-high golden tall-grass fields, worn road. */
export function grassGenerator(blockers: { x: number; z: number; r: number }[]): Generator {
  return (x, z, rnd) => {
    const [road, wet, macro] = terrainMask(x, z);
    if (inWater(x, z)) return null;
    if (rnd() < road * 0.93) return null;
    if (near(blockers, x, z)) return null;
    const n = terrainNormal(x, z, 0.8);
    if (n[1] < 0.78) return null;
    // Meadow structure: tall-grass fields where a low-frequency field is high.
    const field = smoothstep(0.1, 0.45, fbm(x * 0.011 + 31, z * 0.011 - 7, 3) + (macro - 0.5) * 0.3);
    const patch = fbm(x * 0.07, z * 0.07, 2) * 0.5 + 0.5;
    if (rnd() > 0.55 + 0.45 * Math.max(field, patch)) return null;
    const tall = field * (0.75 + rnd() * 0.5);
    const h = 0.32 + patch * 0.2 + tall * 0.42 + rnd() * 0.12;
    const w = h * (1.8 + rnd() * 0.5);
    // Colour: fresh green -> warm yellow-green -> sun-dried gold in the tall fields; lusher by the water.
    const g: [number, number, number] = [0.92, 1.0, 0.78];
    const gold: [number, number, number] = [1.28, 1.1, 0.62];
    const k = Math.min(1, tall * 0.85 + rnd() * 0.15) * (1 - wet * 0.7);
    const v = 0.85 + rnd() * 0.3;
    const tint: [number, number, number] = [(g[0] + (gold[0] - g[0]) * k) * v, (g[1] + (gold[1] - g[1]) * k) * v, (g[2] + (gold[2] - g[2]) * k) * v];
    return { x, y: terrainHeight(x, z) - 0.05, z, yaw: rnd() * Math.PI * 2, w, h, slot: Math.floor(rnd() * 4), tint };
  };
}

/** Wildflowers in drifts along the stream and meadow edges. */
export function flowerGenerator(blockers: { x: number; z: number; r: number }[]): Generator {
  return (x, z, rnd) => {
    const drift = fbm(x * 0.03 + 11, z * 0.03 + 5, 3);
    const [road, wet] = terrainMask(x, z);
    const want = smoothstep(0.15, 0.45, drift) + wet * 0.35;
    if (rnd() > want || road > 0.3 || inWater(x, z) || near(blockers, x, z)) return null;
    if (terrainNormal(x, z, 0.8)[1] < 0.85) return null;
    // White drifts and yellow drifts don't mix much.
    const white = fbm(x * 0.02 - 9, z * 0.02 + 2, 2) > 0.05;
    const slot = white ? 0 : 1 + Math.floor(rnd() * 3);
    const s = 0.14 + rnd() * 0.12;
    const lift = 0.22 + rnd() * 0.25;
    const v = 0.9 + rnd() * 0.2;
    return { x, y: terrainHeight(x, z) - 0.02, z, yaw: rnd() * Math.PI * 2, w: s, h: s, slot, tint: [v, v, v], lift };
  };
}

/**
 * Builds a bush from the real tree's leaf cards: leaf quads are redistributed over a rounded dome and
 * given spherical normals so the bush shades as a soft mass.
 */
export function bushGeometry(tree: GLTF, quads: number, seed: number) {
  let leaves: THREE.Mesh | null = null;
  tree.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && /leaves/i.test((m.material as THREE.Material).name)) leaves = m;
  });
  const lm = leaves as unknown as THREE.Mesh;
  tree.scene.updateMatrixWorld(true);
  const src = lm.geometry;
  const P = src.getAttribute('position'), U = src.getAttribute('uv'), I = src.index!;
  // Leaf cards = connected islands (the mesh is vertex-cache optimised, so triangles aren't in card order).
  const n = P.count;
  const par = new Int32Array(n).map((_, i) => i);
  const f = (x: number): number => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  for (let i = 0; i < I.count; i += 3) { const r = f(I.getX(i)); par[f(I.getX(i + 1))] = r; par[f(I.getX(i + 2))] = r; }
  const cards = new Map<number, number[]>();
  for (let i = 0; i < I.count; i += 3) { const r = f(I.getX(i)); (cards.get(r) ?? cards.set(r, []).get(r)!).push(i); }
  const list = [...cards.values()];
  const rnd = mulberry32(seed);
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const v = new THREE.Vector3(), c = new THREE.Vector3();
  for (let q = 0; q < quads; q++) {
    const tris = list[Math.floor(rnd() * list.length)];
    const verts = [...new Set(tris.flatMap((t) => [I.getX(t), I.getX(t + 1), I.getX(t + 2)]))];
    c.set(0, 0, 0);
    for (const i of verts) c.add(v.fromBufferAttribute(P, i).applyMatrix4(lm.matrixWorld));
    c.multiplyScalar(1 / verts.length);
    const th = rnd() * Math.PI * 2, ph = Math.acos(1 - rnd() * 1.15);
    const r = 0.55 + 0.45 * Math.sqrt(rnd());
    const t = new THREE.Vector3(Math.sin(ph) * Math.cos(th) * r, Math.cos(ph) * r * 0.85 + 0.35, Math.sin(ph) * Math.sin(th) * r);
    const nn = t.clone().sub(new THREE.Vector3(0, 0.15, 0)).normalize();
    const base = pos.length / 3;
    const remap = new Map<number, number>();
    verts.forEach((i, k) => {
      remap.set(i, base + k);
      v.fromBufferAttribute(P, i).applyMatrix4(lm.matrixWorld).sub(c).multiplyScalar(1.7).add(t);
      pos.push(v.x, v.y, v.z);
      nor.push(nn.x, nn.y, nn.z);
      uv.push(U.getX(i), U.getY(i));
    });
    for (const tr of tris) idx.push(remap.get(I.getX(tr))!, remap.get(I.getX(tr + 1))!, remap.get(I.getX(tr + 2))!);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

/** A small flock circling high over the valley: one instanced draw, wings flap in the vertex shader. */
export class Birds {
  readonly mesh: THREE.InstancedMesh;
  private data: { cx: number; cz: number; r: number; y: number; speed: number; phase: number }[] = [];
  private m = new THREE.Matrix4();
  constructor(centers: { x: number; z: number; y: number }[], count = 16) {
    const pos = [0, 0, 0.35, 0, 0, -0.3, -0.95, 0.05, -0.15, 0, 0, 0.35, 0.95, 0.05, -0.15, 0, 0, -0.3];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ color: 0x1d1a17, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = foliageTime;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float flap = sin(uTime * 7.0 + float(gl_InstanceID) * 1.9);
          transformed.y += flap * abs(transformed.x) * 0.55;`);
    };
    this.mesh = new THREE.InstancedMesh(g, mat, count);
    this.mesh.frustumCulled = false;
    const rnd = mulberry32(77);
    for (let i = 0; i < count; i++) {
      const c = centers[i % centers.length];
      this.data.push({ cx: c.x + rnd() * 40 - 20, cz: c.z + rnd() * 40 - 20, r: 45 + rnd() * 70, y: c.y + rnd() * 35, speed: (0.08 + rnd() * 0.07) * (rnd() < 0.5 ? -1 : 1), phase: rnd() * 6.28 });
    }
  }
  update(t: number) {
    const q = new THREE.Quaternion(), s = new THREE.Vector3(1.5, 1.5, 1.5), p = new THREE.Vector3();
    this.data.forEach((b, i) => {
      const a = b.phase + t * b.speed;
      p.set(b.cx + Math.cos(a) * b.r, b.y + Math.sin(t * 0.3 + b.phase) * 4, b.cz + Math.sin(a) * b.r);
      // Face along the direction of travel, banking into the turn.
      const yaw = Math.atan2(-Math.sin(a) * Math.sign(b.speed), Math.cos(a) * Math.sign(b.speed));
      q.setFromEuler(new THREE.Euler(0, yaw, -0.35 * Math.sign(b.speed)));
      this.mesh.setMatrixAt(i, this.m.compose(p, q, s));
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** World-space leaf cards (vertex positions + UVs per card) extracted once from the tree model. */
function leafCards(tree: GLTF) {
  let lm: THREE.Mesh | null = null;
  tree.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && /leaves/i.test((m.material as THREE.Material).name)) lm = m; });
  const mesh = lm as unknown as THREE.Mesh;
  tree.scene.updateMatrixWorld(true);
  const P = mesh.geometry.getAttribute('position'), U = mesh.geometry.getAttribute('uv'), I = mesh.geometry.index!;
  const par = new Int32Array(P.count).map((_, i) => i);
  const f = (x: number): number => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  for (let i = 0; i < I.count; i += 3) { const r = f(I.getX(i)); par[f(I.getX(i + 1))] = r; par[f(I.getX(i + 2))] = r; }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < I.count; i += 3) { const r = f(I.getX(i)); (groups.get(r) ?? groups.set(r, []).get(r)!).push(i); }
  const v = new THREE.Vector3();
  return [...groups.values()].map((tris) => {
    const verts = [...new Set(tris.flatMap((t) => [I.getX(t), I.getX(t + 1), I.getX(t + 2)]))];
    const pos = verts.map((i) => v.fromBufferAttribute(P, i).applyMatrix4(mesh.matrixWorld).clone());
    const c = pos.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / pos.length);
    const local = new Map(verts.map((vi, k) => [vi, k]));
    return { pos: pos.map((p) => p.sub(c)), uv: verts.map((i) => [U.getX(i), U.getY(i)]), tris: tris.map((t) => [local.get(I.getX(t))!, local.get(I.getX(t + 1))!, local.get(I.getX(t + 2))!]) };
  });
}

/**
 * Ivy on the ruins: leaf cards spiralling up columns and pillars (thinning toward the top) with a few
 * strands trailing down. One merged mesh, alpha-tested with the tree's leaf texture.
 */
export function vineGeometry(tree: GLTF, anchors: { x: number; z: number; base: number; top: number; r: number }[], seed = 3) {
  const cards = leafCards(tree);
  const rnd = mulberry32(seed);
  const pos: number[] = [], nor: number[] = [], uv: number[] = [], idx: number[] = [];
  const q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
  const addLeaf = (at: THREE.Vector3, out: THREE.Vector3, size: number) => {
    const card = cards[Math.floor(rnd() * cards.length)];
    // Orient the card to face outward from the stone with some randomness.
    const n = out.clone().add(new THREE.Vector3(rnd() - 0.5, rnd() * 0.6, rnd() - 0.5).multiplyScalar(0.8)).normalize();
    q.setFromUnitVectors(up, n).multiply(new THREE.Quaternion().setFromAxisAngle(up, rnd() * 6.28));
    const b = pos.length / 3;
    card.pos.forEach((p, k) => {
      const w = p.clone().multiplyScalar(size).applyQuaternion(q).add(at);
      pos.push(w.x, w.y, w.z);
      nor.push(out.x * 0.7, 0.7, out.z * 0.7);
      uv.push(card.uv[k][0], card.uv[k][1]);
    });
    for (const t of card.tris) idx.push(b + t[0], b + t[1], b + t[2]);
  };
  for (const a of anchors) {
    if (rnd() > 0.85) continue;
    const reach = a.base + (a.top - a.base) * (0.45 + rnd() * 0.55);
    const strands = 1 + Math.floor(rnd() * 2);
    for (let s = 0; s < strands; s++) {
      let ang = rnd() * Math.PI * 2;
      const turn = (rnd() < 0.5 ? -1 : 1) * (0.5 + rnd() * 0.6);
      for (let y = a.base; y < reach; y += 0.05) {
        const t = (y - a.base) / Math.max(0.1, reach - a.base);
        ang += turn * 0.05;
        const density = 1 - t * 0.7;
        for (let k = 0; k < 4; k++) {
          if (rnd() > density) continue;
          const spread = (rnd() - 0.5) * 1.6;
          const out = new THREE.Vector3(Math.cos(ang + spread), 0, Math.sin(ang + spread));
          addLeaf(new THREE.Vector3(a.x, y + (rnd() - 0.5) * 0.1, a.z).addScaledVector(out, a.r + 0.03 + rnd() * 0.05), out, 2.6 + rnd() * 1.2);
        }
      }
      // A trailing strand hanging from the top of the growth.
      const out = new THREE.Vector3(Math.cos(ang), 0, Math.sin(ang));
      for (let y = reach; y > reach - 1.2 - rnd(); y -= 0.11) addLeaf(new THREE.Vector3(a.x, y, a.z).addScaledVector(out, a.r + 0.06), out, 1.5);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  g.computeBoundingSphere();
  return g;
}
