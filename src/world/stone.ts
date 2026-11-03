import * as THREE from 'three';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { simplex2 } from '../core/noise';
import type { TextureSet } from '../core/assets';

/** Position-only 3D-ish noise built from two simplex planes; identical for coincident vertices (no cracks). */
export function n3(x: number, y: number, z: number) {
  return simplex2(x + z * 0.71, y - z * 0.37) * 0.6 + simplex2(y * 0.83 + 3.1, z * 1.1 - x * 0.29) * 0.4;
}

/** Erodes a geometry: rounds edges toward an inner box (optional) and adds multi-scale noise displacement. */
export function erode(g: THREE.BufferGeometry, amp: number, freq: number, seed = 0) {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const s = seed * 13.7;
    const f2 = freq * 3.1;
    const dx = n3(x * freq + s, y * freq, z * freq) + n3(x * f2, y * f2 + s, z * f2) * 0.35;
    const dy = n3(x * freq + 11 + s, y * freq, z * freq + 5) + n3(x * f2 + 7, y * f2, z * f2 + s) * 0.35;
    const dz = n3(x * freq - 7, y * freq + 3 + s, z * freq) + n3(x * f2, y * f2 - 2, z * f2 + s) * 0.35;
    p.setXYZ(i, x + dx * amp, y + dy * amp, z + dz * amp);
  }
  return g;
}

function finish(g: THREE.BufferGeometry) {
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const m = mergeVertices(g, 1e-4);
  m.computeVertexNormals();
  return m;
}

/** A weathered stone block with rounded, chipped edges. */
export function block(w: number, h: number, d: number, opts: { round?: number; erosion?: number; seed?: number; segSize?: number } = {}) {
  const round = opts.round ?? Math.min(w, h, d) * 0.12;
  const seg = (v: number) => Math.min(24, Math.max(2, Math.ceil(v / (opts.segSize ?? 0.45))));
  const g = new THREE.BoxGeometry(w, h, d, seg(w), seg(h), seg(d));
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const hx = w / 2 - round, hy = h / 2 - round, hz = d / 2 - round;
  const v = new THREE.Vector3(), q = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    q.set(THREE.MathUtils.clamp(v.x, -hx, hx), THREE.MathUtils.clamp(v.y, -hy, hy), THREE.MathUtils.clamp(v.z, -hz, hz));
    const dir = v.clone().sub(q);
    if (dir.lengthSq() > 1e-8) v.copy(q).addScaledVector(dir.normalize(), round);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  erode(g, opts.erosion ?? Math.min(w, h, d) * 0.06, 1.3 / Math.max(0.6, Math.min(w, h, d)), opts.seed ?? 0);
  return finish(g);
}

/** A fluted column drum/shaft with optional broken top. */
export function column(radius: number, height: number, opts: { broken?: number; seed?: number; base?: boolean; capital?: boolean } = {}) {
  const seed = opts.seed ?? 0;
  const radial = 22;
  const rows = Math.max(4, Math.ceil(height / 0.4));
  const pts: THREE.Vector2[] = [];
  const baseH = opts.base ? 0.6 : 0;
  const capH = opts.capital ? 0.7 : 0;
  for (let r = 0; r <= rows; r++) {
    const t = r / rows;
    const y = t * height;
    let rad = radius * (1.0 - 0.1 * t + 0.05 * Math.sin(t * Math.PI));
    if (opts.base && y < baseH) rad = radius * (y < baseH * 0.5 ? 1.32 : 1.18);
    if (opts.capital && y > height - capH) rad = radius * (y > height - capH * 0.45 ? 1.38 : 1.12);
    pts.push(new THREE.Vector2(rad, y));
  }
  const g = new THREE.LatheGeometry(pts, radial);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const breakAt = opts.broken ?? Infinity;
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const a = Math.atan2(z, x);
    const inShaft = y > baseH && y < height - capH;
    if (inShaft) {
      const flute = 1 - 0.045 * Math.max(0, Math.cos(a * 16));
      x *= flute; z *= flute;
    }
    if (breakAt < height) {
      // Jagged fracture plane, tilted, collapsing everything above it.
      const cut = breakAt + Math.cos(a + seed) * radius * 0.45 + n3(x * 2.3, seed, z * 2.3) * radius * 0.35;
      if (y > cut) {
        const k = 0.25 + 0.75 * Math.abs(n3(x * 4 + seed, y, z * 4));
        y = cut; x *= k; z *= k;
      }
    }
    p.setXYZ(i, x, y, z);
  }
  // Close the top with a cap so broken shafts aren't hollow.
  const top = new THREE.CircleGeometry(radius * 0.98, radial).rotateX(-Math.PI / 2).translate(0, Math.min(height, breakAt) - 0.02, 0);
  if (breakAt < height) erode(top, radius * 0.18, 2.5, seed);
  const merged = mergeGeometriesSafe([g, top]);
  erode(merged, radius * 0.05, 1.6, seed);
  return finish(merged);
}

export function mergeGeometriesSafe(list: THREE.BufferGeometry[]) {
  const out: THREE.BufferGeometry[] = list.map((g) => {
    const n = g.index ? g.toNonIndexed() : g.clone();
    for (const k of Object.keys(n.attributes)) if (k !== 'position') n.deleteAttribute(k);
    return n;
  });
  let count = 0;
  for (const g of out) count += g.getAttribute('position').count;
  const pos = new Float32Array(count * 3);
  let o = 0;
  for (const g of out) { pos.set(g.getAttribute('position').array as Float32Array, o); o += g.getAttribute('position').count * 3; }
  const r = new THREE.BufferGeometry();
  r.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  return r;
}

/**
 * Triplanar stone material with procedural moss on upward faces and in crevices.
 * World-space triplanar avoids UV seams on eroded/procedural geometry.
 */
export function stoneMaterial(stone: TextureSet, moss: TextureSet, opts: { scale: number; tint?: THREE.Color; mossAmount?: number; key: string }) {
  const m = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0, color: opts.tint ?? new THREE.Color(1, 1, 1) });
  m.onBeforeCompile = (sh) => {
    sh.uniforms.tSC = { value: stone.color }; sh.uniforms.tSN = { value: stone.normal }; sh.uniforms.tSA = { value: stone.arh };
    sh.uniforms.tMC = { value: moss.color }; sh.uniforms.tMN = { value: moss.normal };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSWPos; varying vec3 vSWNormal;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 swp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          swp = instanceMatrix * swp;
        #endif
        vSWPos = (modelMatrix * swp).xyz;
        vec3 swn = objectNormal;
        #ifdef USE_INSTANCING
          swn = mat3(instanceMatrix) * swn;
        #endif
        vSWNormal = normalize(mat3(modelMatrix) * swn);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', /* glsl */ `#include <common>
        varying vec3 vSWPos; varying vec3 vSWNormal;
        uniform sampler2D tSC, tSN, tSA, tMC, tMN;
        vec3 sNormalW; float sRough; float sAO;
        vec3 tri3(sampler2D t, vec3 p, vec3 w) { return texture2D(t, p.zy).rgb * w.x + texture2D(t, p.xz).rgb * w.y + texture2D(t, p.xy).rgb * w.z; }`)
      .replace('#include <map_fragment>', /* glsl */ `
        {
          vec3 wn = normalize(vSWNormal);
          vec3 bw = pow(abs(wn), vec3(4.0)); bw /= dot(bw, vec3(1.0));
          vec3 p = vSWPos * ${opts.scale.toFixed(4)};
          vec3 sc = tri3(tSC, p, bw);
          vec3 sa = tri3(tSA, p, bw);
          vec3 nx = texture2D(tSN, p.zy).xyz * 2.0 - 1.0, ny = texture2D(tSN, p.xz).xyz * 2.0 - 1.0, nz = texture2D(tSN, p.xy).xyz * 2.0 - 1.0;
          vec3 wnx = vec3(nx.xy + wn.zy, abs(nx.z) * wn.x).zyx;
          vec3 wny = vec3(ny.xy + wn.xz, abs(ny.z) * wn.y).xzy;
          vec3 wnz = vec3(nz.xy + wn.xy, abs(nz.z) * wn.z);
          vec3 nW = normalize(wnx * bw.x + wny * bw.y + wnz * bw.z);
          // Moss: on upward faces and in low (cavity) areas of the stone height map, broken up by noise.
          vec3 mp = vSWPos * 0.35;
          float mossN = texture2D(tMC, vSWPos.xz * 0.013).g;
          float up = smoothstep(0.25, 0.85, wn.y);
          float mossW = clamp(up * ${(opts.mossAmount ?? 0.8).toFixed(3)} * (0.55 + mossN * 1.3) + (0.5 - sa.b) * 0.9 - 0.25, 0.0, 1.0);
          mossW *= smoothstep(-0.3, 0.2, wn.y);
          vec3 mc = tri3(tMC, mp, bw) * vec3(0.85, 0.9, 0.75);
          vec3 mnY = texture2D(tMN, mp.xz).xyz * 2.0 - 1.0;
          vec3 mossNW = normalize(vec3(mnY.xy + wn.xz, abs(mnY.z) * wn.y).xzy * bw.y + nW * (1.0 - bw.y));
          diffuseColor.rgb *= mix(sc, mc, mossW);
          sNormalW = normalize(mix(nW, mossNW, mossW));
          sRough = mix(sa.g, 0.95, mossW);
          sAO = sa.r;
        }`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(sRough, 0.35, 1.0);')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(sNormalW, 0.0)).xyz);')
      .replace('#include <aomap_fragment>', /* glsl */ `
        float ambientOcclusion = mix(1.0, sAO, 0.9) * vStoneAO;
        reflectedLight.indirectDiffuse *= ambientOcclusion;
        reflectedLight.indirectSpecular *= ambientOcclusion;
        reflectedLight.directDiffuse *= mix(1.0, vStoneAO, 0.5);`);
    // Optional per-vertex baked AO (attribute 'aAO'); defaults to 1.
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nvarying float vStoneAO;\n#ifdef HAS_AO_ATTR\nattribute float aAO;\n#endif')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\n#ifdef HAS_AO_ATTR\nvStoneAO = aAO;\n#else\nvStoneAO = 1.0;\n#endif');
    sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vStoneAO;');
  };
  m.customProgramCacheKey = () => `stone-${opts.key}`;
  return m;
}
