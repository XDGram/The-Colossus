import * as THREE from 'three';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';

/**
 * Sky, sun and atmospheric height fog.
 * The fog replaces three.js' distance fog with an analytic exponential height fog plus a thin
 * aerial-perspective haze, tinted toward the sun. It must be installed before any material compiles.
 */

// Where we want the sun in world space: from the right, slightly toward the Colossus, so the giant
// is side-lit and long shadows rake across the valley floor.
const TARGET_SUN_AZIMUTH = Math.atan2(-0.32, 0.95);

export interface Atmosphere {
  sunDir: THREE.Vector3;
  sunColor: THREE.Color;
  fogColor: THREE.Color;
  sunFogColor: THREE.Color;
  envMap: THREE.Texture;
  background: THREE.Texture;
  backgroundRotationY: number;
}

export const FOG = {
  density: 0.0011,
  base: -30,
  falloff: 1 / 60,
  haze: 0.00007,
};

export function installFogChunks(sunDir: THREE.Vector3, sunFogColor: THREE.Color, hazeColor: THREE.Color) {
  const v3 = (v: { x: number; y: number; z: number }) => `vec3(${v.x.toFixed(5)}, ${v.y.toFixed(5)}, ${v.z.toFixed(5)})`;
  const c3 = (c: THREE.Color) => `vec3(${c.r.toFixed(5)}, ${c.g.toFixed(5)}, ${c.b.toFixed(5)})`;

  THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vFogWorldPos;
#endif`;

  THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
#ifndef CUSTOM_FOG_WPOS
  vec4 fogWP = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    fogWP = batchingMatrix * fogWP;
  #endif
  #ifdef USE_INSTANCING
    fogWP = instanceMatrix * fogWP;
  #endif
  vFogWorldPos = ( modelMatrix * fogWP ).xyz;
#endif
#endif`;

  THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying vec3 vFogWorldPos;
  // The scene uses a linear THREE.Fog purely as a uniform carrier refreshed every frame for every
  // material: fogNear = height-fog density, fogFar = elapsed time (drives the drifting cloud shadows).
  uniform float fogNear;
  uniform float fogFar;
  #define ATMO_SUN_DIR ${v3(sunDir)}
  float cloudHash( vec2 p ) { return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453 ); }
  float cloudNoise( vec2 p ) {
    vec2 i = floor( p ), f = fract( p ); f = f * f * ( 3.0 - 2.0 * f );
    return mix( mix( cloudHash( i ), cloudHash( i + vec2( 1, 0 ) ), f.x ), mix( cloudHash( i + vec2( 0, 1 ) ), cloudHash( i + vec2( 1, 1 ) ), f.x ), f.y );
  }
  /** Sunlight let through by slow-drifting broken clouds: golden patches and naturally shaded areas. */
  float cloudLight( vec3 wpos ) {
    // Project along the sun direction onto the cloud layer so shadows land where the sun puts them.
    vec2 p = ( wpos.xz - ATMO_SUN_DIR.xz / max( ATMO_SUN_DIR.y, 0.2 ) * ( 260.0 - wpos.y ) ) * 0.0042;
    p += vec2( 0.82, 0.57 ) * fogFar * 0.0065 + vec2( 3.7, 1.3 );
    float n = cloudNoise( p ) * 0.62 + cloudNoise( p * 2.7 + 3.1 ) * 0.28 + cloudNoise( p * 7.3 - 1.7 ) * 0.1;
    return mix( 0.58, 1.0, smoothstep( 0.3, 0.52, n ) );
  }
  vec3 applyAtmosphere( vec3 col, vec3 wpos ) {
    vec3 ray = wpos - cameraPosition;
    float dist = length( ray );
    vec3 dir = ray / max( dist, 1e-4 );
    float density = fogNear;
    const float falloff = ${FOG.falloff.toFixed(6)};
    float camH = cameraPosition.y - (${FOG.base.toFixed(2)});
    float rayY = dir.y * dist * falloff;
    float heightTerm = abs( rayY ) > 1e-3 ? ( 1.0 - exp( -rayY ) ) / rayY : 1.0;
    float optical = density * exp( -falloff * camH ) * dist * heightTerm + dist * ${FOG.haze.toFixed(6)};
    float f = 1.0 - exp( -optical );
    float sunAmt = pow( max( dot( dir, ${v3(sunDir)} ), 0.0 ), 8.0 );
    vec3 fc = mix( fogColor, ${c3(sunFogColor)}, sunAmt * 0.35 );
    return mix( col, fc, f );
  }
#endif`;

  // Cloud shadows modulate the sun (first directional light) for every lit material.
  THREE.ShaderChunk.lights_fragment_begin = THREE.ShaderChunk.lights_fragment_begin.replace(
    'getDirectionalLightInfo( directionalLight, directLight );',
    `getDirectionalLightInfo( directionalLight, directLight );
    #if defined( USE_FOG ) && UNROLLED_LOOP_INDEX == 0
      directLight.color *= cloudLight( vFogWorldPos );
    #endif`,
  );

  THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  gl_FragColor.rgb = applyAtmosphere( gl_FragColor.rgb, vFogWorldPos );
#endif`;

  // Blend the bottom of the sky dome into the fog colour so distant terrain meets the horizon cleanly.
  const bg = THREE.ShaderLib.backgroundCube;
  bg.fragmentShader = bg.fragmentShader.replace(
    'gl_FragColor = texColor;',
    /* glsl */ `gl_FragColor = texColor;
    {
      vec3 d = normalize( vWorldDirection );
      float haze = 1.0 - smoothstep( -0.02, 0.22, d.y );
      float sunAmt = pow( max( dot( d, ${v3(sunDir)} ), 0.0 ), 5.0 );
      vec3 hc = mix( ${c3(hazeColor)}, ${c3(sunFogColor)}, sunAmt * 0.85 );
      gl_FragColor.rgb = mix( gl_FragColor.rgb, hc, haze * 0.8 );
    }`,
  );
}

function luminance(r: number, g: number, b: number) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Equirect pixel (column, row-from-top) -> world direction, matching three.js' equirect lookup. */
function pixelDir(c: number, r: number, w: number, h: number) {
  const u = (c + 0.5) / w;
  const v = 1 - (r + 0.5) / h;
  const az = (u - 0.5) * Math.PI * 2;
  const el = (v - 0.5) * Math.PI;
  return new THREE.Vector3(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az));
}

export async function loadAtmosphere(renderer: THREE.WebGLRenderer, url: string, onProgress?: (p: number) => void, elevationDeg?: number, azimuth?: number): Promise<Atmosphere> {
  const AZ = azimuth ?? TARGET_SUN_AZIMUTH;
  const loader = new RGBELoader().setDataType(THREE.FloatType);
  const tex = await loader.loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total));
  const { width: w, height: h, data } = tex.image as unknown as { width: number; height: number; data: Float32Array };

  // Find the sun: brightest region of the upper hemisphere (weighted centroid of the top luminance pixels).
  let maxL = 0;
  for (let r = 0; r < h / 2; r++) for (let c = 0; c < w; c++) {
    const i = (r * w + c) * 4;
    maxL = Math.max(maxL, luminance(data[i], data[i + 1], data[i + 2]));
  }
  const sunDirH = new THREE.Vector3();
  const sunCol = new THREE.Color(0, 0, 0);
  let wsum = 0;
  for (let r = 0; r < h / 2; r++) for (let c = 0; c < w; c++) {
    const i = (r * w + c) * 4;
    const L = luminance(data[i], data[i + 1], data[i + 2]);
    if (L < maxL * 0.5) continue;
    sunDirH.addScaledVector(pixelDir(c, r, w, h), L);
    sunCol.r += data[i] * L; sunCol.g += data[i + 1] * L; sunCol.b += data[i + 2] * L;
    wsum += L;
  }
  sunDirH.normalize();
  sunCol.multiplyScalar(1 / wsum);

  // Rotate the sky so the HDRI's sun sits at our art-directed azimuth.
  const azH = Math.atan2(sunDirH.z, sunDirH.x);
  const rotY = AZ - azH;
  const el = Math.asin(THREE.MathUtils.clamp(sunDirH.y, -1, 1));
  // Clamp elevation into a cinematic range (long but not grazing shadows).
  // Golden-hour elevation: long shadows, and the sun sits in frame when looking toward it (god rays).
  const elC = elevationDeg !== undefined ? THREE.MathUtils.degToRad(elevationDeg) : THREE.MathUtils.clamp(el, THREE.MathUtils.degToRad(21), THREE.MathUtils.degToRad(23));
  const sunDir = new THREE.Vector3(Math.cos(elC) * Math.cos(AZ), Math.sin(elC), Math.cos(elC) * Math.sin(AZ));

  // Horizon colour away from the sun drives the fog; horizon colour toward the sun drives in-scatter.
  const fogColor = new THREE.Color(0, 0, 0);
  const sunFog = new THREE.Color(0, 0, 0);
  let nf = 0, ns = 0;
  const r0 = Math.floor(h * 0.47), r1 = Math.floor(h * 0.5);
  for (let r = r0; r < r1; r++) for (let c = 0; c < w; c += 2) {
    const i = (r * w + c) * 4;
    const d = pixelDir(c, r, w, h);
    const align = d.x * sunDirH.x + d.z * sunDirH.z;
    if (align < 0.2) { fogColor.r += data[i]; fogColor.g += data[i + 1]; fogColor.b += data[i + 2]; nf++; }
    else if (align > 0.8) { sunFog.r += data[i]; sunFog.g += data[i + 1]; sunFog.b += data[i + 2]; ns++; }
  }
  fogColor.multiplyScalar(1 / Math.max(1, nf));
  sunFog.multiplyScalar(1 / Math.max(1, ns));

  // Clamp the sun disk: raw clear-sky HDRIs exceed half-float range during PMREM filtering (Inf -> NaN).
  // The direct sun is supplied by the DirectionalLight, so nothing is lost.
  for (let i = 0; i < data.length; i += 4) {
    const L = luminance(data[i], data[i + 1], data[i + 2]);
    if (L > 60) { const k = 60 / L; data[i] *= k; data[i + 1] *= k; data[i + 2] *= k; }
  }
  tex.needsUpdate = true;
  tex.mapping = THREE.EquirectangularReflectionMapping;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(tex).texture;
  pmrem.dispose();

  // Normalise the sun's chromaticity; intensity is set on the light itself.
  const m = Math.max(sunCol.r, sunCol.g, sunCol.b);
  sunCol.multiplyScalar(1 / m);

  return { sunDir, sunColor: sunCol, fogColor, sunFogColor: sunFog, envMap: env, background: tex, backgroundRotationY: rotY };
}
