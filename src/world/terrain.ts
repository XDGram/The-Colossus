import * as THREE from 'three';
import { WORLD, terrainHeight, terrainNormal, terrainMask } from './heightfield';
import type { TextureSet } from '../core/assets';

/**
 * Chunked terrain with distance-based LOD. Each chunk owns a skirt so LOD transitions never show cracks.
 * Normals are analytic (finite differences of the height function) so chunks shade seamlessly.
 */
const CHUNK = 200;
const LODS = [128, 64, 32, 16];
const LOD_DIST = [120, 380, 900];

interface Chunk { cx: number; cz: number; lod: number; mesh: THREE.Mesh; geoms: (THREE.BufferGeometry | null)[] }

export class Terrain {
  readonly group = new THREE.Group();
  readonly material: THREE.MeshStandardMaterial;
  private chunks: Chunk[] = [];
  private queue: Chunk[] = [];

  constructor(tex: Record<string, TextureSet>, quality: 'high' | 'low') {
    this.material = makeTerrainMaterial(tex, quality);
    for (let z = WORLD.minZ; z < WORLD.maxZ; z += CHUNK) for (let x = WORLD.minX; x < WORLD.maxX; x += CHUNK) {
      const mesh = new THREE.Mesh(undefined, this.material);
      mesh.receiveShadow = true;
      mesh.matrixAutoUpdate = false;
      this.chunks.push({ cx: x + CHUNK / 2, cz: z + CHUNK / 2, lod: -1, mesh, geoms: [null, null, null, null] });
    }
  }

  private lodFor(c: Chunk, px: number, pz: number) {
    const d = Math.max(0, Math.hypot(c.cx - px, c.cz - pz) - CHUNK * 0.71);
    let l = 0;
    while (l < LOD_DIST.length && d > LOD_DIST[l]) l++;
    return l;
  }

  /** Builds every chunk at the right LOD for a viewpoint. Call once before the first frame. */
  buildAll(px: number, pz: number) {
    for (const c of this.chunks) this.setLod(c, this.lodFor(c, px, pz));
  }

  /** buildAll in time slices (the valley realm builds while the game runs). */
  async buildAllAsync(px: number, pz: number, yieldFn: () => Promise<unknown>, sliceMs = 10) {
    let t0 = performance.now();
    for (const c of this.chunks) {
      this.setLod(c, this.lodFor(c, px, pz));
      if (performance.now() - t0 > sliceMs) { await yieldFn(); t0 = performance.now(); }
    }
  }

  /** Re-evaluates LODs, building at most one new chunk geometry per frame to avoid hitches. */
  update(px: number, pz: number) {
    if (this.queue.length === 0) {
      for (const c of this.chunks) if (this.lodFor(c, px, pz) !== c.lod) this.queue.push(c);
      this.queue.sort((a, b) => Math.hypot(a.cx - px, a.cz - pz) - Math.hypot(b.cx - px, b.cz - pz));
    }
    const c = this.queue.shift();
    if (c) this.setLod(c, this.lodFor(c, px, pz));
  }

  private setLod(c: Chunk, lod: number) {
    if (c.lod === lod) return;
    if (!c.geoms[lod]) c.geoms[lod] = buildChunkGeometry(c.cx - CHUNK / 2, c.cz - CHUNK / 2, CHUNK, LODS[lod]);
    c.mesh.geometry = c.geoms[lod]!;
    if (c.lod === -1) this.group.add(c.mesh);
    c.lod = lod;
  }
}

function buildChunkGeometry(x0: number, z0: number, size: number, res: number) {
  const n = res + 1;
  const ringCount = res * 4;
  const vcount = n * n + ringCount;
  const pos = new Float32Array(vcount * 3);
  const nor = new Float32Array(vcount * 3);
  const mask = new Float32Array(vcount * 3);
  const step = size / res;
  const e = Math.max(0.5, step * 0.5);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i;
    const x = x0 + i * step, z = z0 + j * step;
    const y = terrainHeight(x, z);
    pos.set([x, y, z], k * 3);
    nor.set(terrainNormal(x, z, e), k * 3);
    mask.set(terrainMask(x, z), k * 3);
  }
  const idx: number[] = [];
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const a = j * n + i, b = a + 1, c = a + n, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  // Skirt: walk the border clockwise, drop a copy of each vertex down, and stitch.
  const border: number[] = [];
  for (let i = 0; i < res; i++) border.push(i);
  for (let j = 0; j < res; j++) border.push(j * n + res);
  for (let i = res; i > 0; i--) border.push(res * n + i);
  for (let j = res; j > 0; j--) border.push(j * n);
  const skirtDrop = 2 + step * 0.6;
  border.forEach((b, s) => {
    const k = n * n + s;
    pos.set([pos[b * 3], pos[b * 3 + 1] - skirtDrop, pos[b * 3 + 2]], k * 3);
    nor.set(nor.subarray(b * 3, b * 3 + 3), k * 3);
    mask.set(mask.subarray(b * 3, b * 3 + 3), k * 3);
  });
  for (let s = 0; s < border.length; s++) {
    const a = border[s], b = border[(s + 1) % border.length];
    const sa = n * n + s, sb = n * n + ((s + 1) % border.length);
    idx.push(a, b, sa, b, sb, sa);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('aMask', new THREE.BufferAttribute(mask, 3));
  g.setIndex(vcount > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  g.computeBoundingSphere();
  g.computeBoundingBox();
  return g;
}

function makeTerrainMaterial(tex: Record<string, TextureSet>, quality: 'high' | 'low') {
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
  const sets = { Moss: tex.ground037, Grass: tex.grass004, Dirt: tex.ground067, Rock: tex.rock051 };
  const uniforms: Record<string, { value: unknown }> = {};
  for (const [k, s] of Object.entries(sets)) {
    uniforms[`t${k}C`] = { value: s.color };
    uniforms[`t${k}N`] = { value: s.normal };
    uniforms[`t${k}A`] = { value: s.arh };
  }
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    if (quality === 'high') sh.defines = { ...sh.defines, TERRAIN_HQ: '' };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aMask; varying vec3 vMask; varying vec3 vTWPos; varying vec3 vTWNormal;`)
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vMask = aMask; vTWPos = (modelMatrix * vec4(transformed, 1.0)).xyz; vTWNormal = normalize(mat3(modelMatrix) * objectNormal);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
        varying vec3 vMask; varying vec3 vTWPos; varying vec3 vTWNormal;
        uniform sampler2D tMossC, tMossN, tMossA, tGrassC, tGrassN, tGrassA, tDirtC, tDirtN, tDirtA, tRockC, tRockN, tRockA;
        vec3 nrm(sampler2D t, vec2 uv) { return texture2D(t, uv).xyz * 2.0 - 1.0; }
        // Height-aware blend: lets taller texture features (stones, tufts) poke through transitions.
        float hb(float w, float h) { return clamp((w * 1.6 - 0.3) + (h - 0.5) * 0.9, 0.0, 1.0); }
        // Cheap per-tile hash rotation to break up visible tiling on the large flat valley floor.
        vec2 hash2(vec2 p) { return fract(sin(vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)))) * 43758.5453); }
        vec3 tAlbedo; vec3 tNormalW; float tRough; float tAO;`)
      .replace('#include <map_fragment>', /* glsl */ `
        {
          vec3 wp = vTWPos; vec3 wn = normalize(vTWNormal);
          vec2 uvM = wp.xz * 0.21; vec2 uvG = wp.xz * 0.31 + 0.37; vec2 uvD = wp.xz * 0.27; vec2 uvF = wp.xz * 0.031;
          vec4 mA = texture2D(tMossA, uvM), gA = texture2D(tGrassA, uvG), dA = texture2D(tDirtA, uvD);
          vec3 mC = texture2D(tMossC, uvM).rgb, gC = texture2D(tGrassC, uvG).rgb, dC = texture2D(tDirtC, uvD).rgb;
          // Large-scale variation sampled at a much lower frequency to kill repetition.
          vec3 far = texture2D(tMossC, uvF).rgb;
          float macro = vMask.z;
          float grassW = hb(smoothstep(0.2, 0.6, macro), gA.b);
          vec3 col = mix(mC, gC * vec3(0.92, 0.95, 0.85), grassW);
          float rough = mix(mA.g, gA.g, grassW); float ao = mix(mA.r, gA.r, grassW);
          vec3 nT = mix(nrm(tMossN, uvM), nrm(tGrassN, uvG), grassW);
          // Wet stream banks: darker, smoother, more earth.
          float wet = vMask.y;
          float dirtW = max(hb(vMask.x, 1.0 - dA.b), wet * 0.65);
          col = mix(col, dC, dirtW); rough = mix(rough, dA.g, dirtW); ao = mix(ao, dA.r, dirtW);
          nT = mix(nT, nrm(tDirtN, uvD), dirtW);
          col *= mix(1.0, 0.68, wet);
          rough = mix(rough, 0.35, wet * 0.5);
          col *= mix(vec3(1.0), far * 2.0, 0.45);
          col *= vec3(0.78, 0.86, 0.6);
          // Steep slopes: triplanar layered rock.
          float slope = 1.0 - wn.y;
          float rockW = smoothstep(0.3, 0.5, slope + (texture2D(tRockA, wp.xz * 0.05).b - 0.5) * 0.18);
          if (rockW > 0.001) {
            vec3 bw = pow(abs(wn), vec3(4.0)); bw /= (bw.x + bw.y + bw.z);
            vec2 ux = wp.zy * 0.07, uz = wp.xy * 0.07, uy = wp.xz * 0.07;
            vec3 rC = texture2D(tRockC, ux).rgb * bw.x + texture2D(tRockC, uz).rgb * bw.z + texture2D(tRockC, uy).rgb * bw.y;
            // Large-scale layer fades in with distance so huge slopes don't show fine repetition.
            float farMix = smoothstep(60.0, 400.0, distance(wp, cameraPosition));
            vec3 rC2 = texture2D(tRockC, wp.zy * 0.009).rgb * bw.x + texture2D(tRockC, wp.xy * 0.009).rgb * bw.z + texture2D(tRockC, wp.xz * 0.009).rgb * bw.y;
            rC = mix(rC, rC2 * 0.85 + rC * 0.15, farMix) * (0.8 + 0.4 * texture2D(tMossC, wp.xz * 0.004).g);
            vec4 rA = texture2D(tRockA, ux) * bw.x + texture2D(tRockA, uz) * bw.z + texture2D(tRockA, uy) * bw.y;
            col = mix(col, rC * vec3(0.66, 0.64, 0.6), rockW); rough = mix(rough, rA.g, rockW); ao = mix(ao, rA.r, rockW);
            #ifdef TERRAIN_HQ
              // UDN triplanar normal blend.
              vec3 rnx = nrm(tRockN, ux), rnz = nrm(tRockN, uz);
              vec3 nX = vec3(rnx.xy + wn.zy, abs(rnx.z) * wn.x).zyx;
              vec3 nZ = vec3(rnz.xy + wn.xy, abs(rnz.z) * wn.z);
              vec3 rockNW = normalize(nX * bw.x + nZ * bw.z + wn * bw.y);
            #else
              vec3 rockNW = wn;
            #endif
            tNormalW = rockNW;
          } else { tNormalW = wn; }
          // Flat-ground tangent frame: u = +x, v = +z (GL normal map green = +v).
          vec3 flatN = normalize(wn + vec3(nT.x, 0.0, nT.y) * 0.85);
          tNormalW = normalize(mix(flatN, tNormalW, rockW));
          tAlbedo = col; tRough = rough; tAO = ao;
          diffuseColor.rgb = tAlbedo;
        }`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(tRough * 1.2, 0.9, 1.0);')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(tNormalW, 0.0)).xyz);')
      .replace('#include <aomap_fragment>', /* glsl */ `
        float ambientOcclusion = mix(1.0, tAO, 0.85);
        reflectedLight.indirectDiffuse *= ambientOcclusion;
        reflectedLight.indirectSpecular *= ambientOcclusion;`);
  };
  m.customProgramCacheKey = () => `terrain-${quality}`;
  return m;
}

/**
 * One coarse mesh for the distant landscape outside the detailed chunk area. It overlaps the chunk area
 * by one cell, dropped a few metres, so the seam is always hidden beneath the detailed terrain.
 */
export function buildFarTerrain(material: THREE.Material) {
  const size = 9000, cell = 60;
  const cx = 0, cz = (WORLD.minZ + WORLD.maxZ) / 2;
  const n = Math.round(size / cell);
  const x0 = cx - size / 2, z0 = cz - size / 2;
  const inside = (x: number, z: number, pad: number) =>
    x > WORLD.minX + pad && x < WORLD.maxX - pad && z > WORLD.minZ + pad && z < WORLD.maxZ - pad;
  const pos: number[] = [], nor: number[] = [], mask: number[] = [], idx: number[] = [];
  const vid = new Int32Array((n + 1) * (n + 1)).fill(-1);
  const vertex = (i: number, j: number) => {
    const k = j * (n + 1) + i;
    if (vid[k] >= 0) return vid[k];
    const x = x0 + i * cell, z = z0 + j * cell;
    const drop = inside(x, z, -1) ? 6 : 0;
    pos.push(x, terrainHeight(x, z) - drop, z);
    nor.push(...terrainNormal(x, z, cell * 0.5));
    const m = terrainMask(x, z);
    mask.push(0, 0, m[2]);
    vid[k] = pos.length / 3 - 1;
    return vid[k];
  };
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = x0 + i * cell, z = z0 + j * cell;
    // Skip cells fully inside the detailed area (keeping a one-cell overlap ring).
    if (inside(x, z, cell) && inside(x + cell, z + cell, cell)) continue;
    const a = vertex(i, j), b = vertex(i + 1, j), c = vertex(i, j + 1), d = vertex(i + 1, j + 1);
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aMask', new THREE.Float32BufferAttribute(mask, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  const mesh = new THREE.Mesh(g, material);
  mesh.matrixAutoUpdate = false;
  return mesh;
}
