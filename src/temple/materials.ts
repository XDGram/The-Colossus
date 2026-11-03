import * as THREE from 'three';
import type { TextureSet } from '../core/assets';
import { MAT } from './kit';

/**
 * Upgrades the kit's flat materials to textured, weathered PBR (Poly Haven CC0 sets) in place, so every
 * mesh already built keeps working. World-space triplanar mapping (no UVs needed on procedural geometry)
 * plus a large-scale tint field so neighbouring buildings don't look identical.
 */
function triplanar(mat: THREE.MeshStandardMaterial, set: TextureSet, opts: { scale: number; desat?: number; lift?: number; vary?: number; key: string; roughMin?: number }) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.tTC = { value: set.color }; sh.uniforms.tTN = { value: set.normal }; sh.uniforms.tTA = { value: set.arh };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTWP; varying vec3 vTWN;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vec4 twp = vec4(transformed, 1.0);
        #ifdef USE_INSTANCING
          twp = instanceMatrix * twp;
        #endif
        vTWP = (modelMatrix * twp).xyz;
        vec3 twn = objectNormal;
        #ifdef USE_INSTANCING
          twn = mat3(instanceMatrix) * twn;
        #endif
        vTWN = normalize(mat3(modelMatrix) * twn);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTWP; varying vec3 vTWN; uniform sampler2D tTC, tTN, tTA;
        vec3 tNW; float tR; float tAO;
        float tHash(vec2 p) { return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5); }
        float tNoise(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
          return mix(mix(tHash(i), tHash(i + vec2(1, 0)), f.x), mix(tHash(i + vec2(0, 1)), tHash(i + vec2(1, 1)), f.x), f.y); }`)
      .replace('#include <map_fragment>', `
        {
          vec3 wn = normalize(vTWN);
          vec3 bw = pow(abs(wn), vec3(4.0)); bw /= dot(bw, vec3(1.0));
          vec3 p = vTWP * ${opts.scale.toFixed(4)};
          vec3 c = texture2D(tTC, p.zy).rgb * bw.x + texture2D(tTC, p.xz).rgb * bw.y + texture2D(tTC, p.xy).rgb * bw.z;
          vec3 a = texture2D(tTA, p.zy).rgb * bw.x + texture2D(tTA, p.xz).rgb * bw.y + texture2D(tTA, p.xy).rgb * bw.z;
          vec3 nx = texture2D(tTN, p.zy).xyz * 2.0 - 1.0, ny = texture2D(tTN, p.xz).xyz * 2.0 - 1.0, nz = texture2D(tTN, p.xy).xyz * 2.0 - 1.0;
          tNW = normalize(vec3(nx.xy + wn.zy, abs(nx.z) * wn.x).zyx * bw.x + vec3(ny.xy + wn.xz, abs(ny.z) * wn.y).xzy * bw.y + vec3(nz.xy + wn.xy, abs(nz.z) * wn.z) * bw.z);
          float l = dot(c, vec3(0.299, 0.587, 0.114));
          c = mix(c, vec3(l), ${(opts.desat ?? 0).toFixed(3)}) + ${(opts.lift ?? 0).toFixed(3)};
          // Large-scale variation: buildings and walls weather differently.
          float v = tNoise(vTWP.xz * 0.045) * 0.6 + tNoise(vTWP.xz * 0.21 + vTWP.y * 0.3) * 0.4;
          c *= 1.0 + (v - 0.5) * ${(opts.vary ?? 0.25).toFixed(3)};
          // Grime gathers low on walls.
          c *= mix(0.78, 1.0, smoothstep(0.0, 1.4, vTWP.y));
          diffuseColor.rgb *= c;
          tR = a.g; tAO = a.r;
        }`)
      .replace('#include <roughnessmap_fragment>', `float roughnessFactor = max(${(opts.roughMin ?? 0.45).toFixed(2)}, tR * roughness);`)
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(tNW, 0.0)).xyz);')
      .replace('#include <aomap_fragment>', `float ambientOcclusion = mix(1.0, tAO, 0.8);
        reflectedLight.indirectDiffuse *= ambientOcclusion; reflectedLight.indirectSpecular *= ambientOcclusion;`);
  };
  mat.customProgramCacheKey = () => `tri-${opts.key}`;
  mat.needsUpdate = true;
}

/**
 * Roof tiles: UVs are derived per fragment from the slope direction, so tile rows always run down
 * each face of a hip roof. Kawara are tinted to weathered blue-grey with lichen variation.
 */
function roofTiles(mat: THREE.MeshStandardMaterial, set: TextureSet) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.tTC = { value: set.color }; sh.uniforms.tTN = { value: set.normal }; sh.uniforms.tTA = { value: set.arh };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vTWP; varying vec3 vTWN;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vTWP = (modelMatrix * vec4(transformed, 1.0)).xyz; vTWN = normalize(mat3(modelMatrix) * objectNormal);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vTWP; varying vec3 vTWN; uniform sampler2D tTC, tTN, tTA; vec3 rNW; float rR; float rAO;`)
      .replace('#include <map_fragment>', `
        {
          vec3 wn = normalize(vTWN);
          vec2 down = length(wn.xz) > 1e-3 ? normalize(wn.xz) : vec2(0.0, 1.0);
          vec2 across = vec2(-down.y, down.x);
          // Tile coordinates: across the slope, and down it (rows of overlapping kawara).
          vec2 uv = vec2(dot(vTWP.xz, across) * 0.55, (dot(vTWP.xz, down) * 0.85 - vTWP.y * 0.55) * 0.55);
          vec3 c = texture2D(tTC, uv).rgb; vec3 a = texture2D(tTA, uv).rgb; vec3 n = texture2D(tTN, uv).xyz * 2.0 - 1.0;
          float l = dot(c, vec3(0.299, 0.587, 0.114));
          // Clay -> fired blue-grey kawara; keep a little warmth and the lichen.
          float lichen = smoothstep(0.02, 0.1, c.g - c.r);
          vec3 kawara = vec3(l) * vec3(0.62, 0.66, 0.74) * 0.95;
          c = mix(kawara, c * vec3(0.7, 0.8, 0.55), lichen * 0.6);
          diffuseColor.rgb *= c;
          vec3 t = vec3(across.x, 0.0, across.y), bt = normalize(cross(wn, t));
          rNW = normalize(t * n.x * 1.3 + bt * n.y * 1.3 + wn * n.z);
          rR = a.g; rAO = a.r;
        }`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp(rR * 0.9, 0.3, 1.0);')
      .replace('#include <normal_fragment_maps>', 'normal = normalize((viewMatrix * vec4(gl_FrontFacing ? rNW : -rNW, 0.0)).xyz);')
      .replace('#include <aomap_fragment>', `float ambientOcclusion = mix(1.0, rAO, 0.9);
        reflectedLight.indirectDiffuse *= ambientOcclusion; reflectedLight.indirectSpecular *= ambientOcclusion;`);
  };
  mat.customProgramCacheKey = () => 'roof-tiles';
  mat.needsUpdate = true;
}

export function applyTempleMaterials(tex: Record<string, TextureSet>) {
  const t = tex;
  MAT.timber.color.set(0x4a3a2c);
  triplanar(MAT.timber, t.wood_planks_grey, { scale: 0.9, desat: 0.2, vary: 0.35, key: 'timber', roughMin: 0.55 });
  MAT.eave.color.set(0x3b2c20);
  triplanar(MAT.eave, t.wood_planks_grey, { scale: 0.6, desat: 0.3, vary: 0.2, key: 'eave', roughMin: 0.6 });
  MAT.plaster.color.set(0xf2e6d0);
  triplanar(MAT.plaster, t.clay_plaster, { scale: 0.35, desat: 0.7, lift: 0.3, vary: 0.22, key: 'plaster', roughMin: 0.85 });
  MAT.stone.color.set(0xe2d6c0);
  triplanar(MAT.stone, t.cobblestone_floor_03, { scale: 0.45, desat: 0.45, lift: 0.04, vary: 0.3, key: 'stone', roughMin: 0.7 });
  MAT.cloth.color.set(0x39405a);
  MAT.floor.color.set(0xb08560);
  triplanar(MAT.floor, t.brown_planks_07, { scale: 0.5, desat: 0.1, vary: 0.25, key: 'floor', roughMin: 0.45 });
  roofTiles(MAT.roof, t.ceramic_roof_01);
}
