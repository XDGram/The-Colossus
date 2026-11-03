import { fbm, ridged, smoothstep, lerp } from '../core/noise.ts';

// World layout (metres). The valley runs along -Z: the player starts near z=+400 and looks
// down the valley toward the Colossus resting in a wide basin around z=-780.
export const WORLD = { minX: -1000, maxX: 1000, minZ: -1500, maxZ: 800 };
export const PLAY = { minZ: -470, maxZ: 455, start: { x: 0, z: 410 } };
export const COLOSSUS_POS = { x: -25, z: -790 };

/** Gentle downhill along the valley so the stream visibly flows toward the Colossus. */
export const floorY = (z: number) => 0.028 * z;

export const valleyAxis = (z: number) => 32 * Math.sin(z * 0.0033) + 11 * Math.sin(z * 0.011 + 1.3);
export const streamX = (z: number) => valleyAxis(z) - 14 + 13 * Math.sin(z * 0.0155 + 0.5) + 4 * Math.sin(z * 0.047);

/** Which bank the old road follows: right of the stream before the bridge, left after it. */
export const BRIDGE_Z = -150;
const pathSide = (z: number) => smoothstep(BRIDGE_Z - 16, BRIDGE_Z + 16, z) * 2 - 1;
export const pathX = (z: number) => streamX(z) + pathSide(z) * (21 + 5 * Math.sin(z * 0.021 + 2.0));

export const WATER_DEPTH = 0.75;
/** The stream wells up from a spring among boulders just behind the start. */
export const STREAM_SOURCE_Z = 505;
/** The stream ends in a still pool in front of the Colossus. */
export const POOL = { x: streamX(-640), z: -640, r: 38 };
export const CHANNEL_DEPTH = 1.6;
export const waterY = (z: number) => floorY(z) - WATER_DEPTH;

export interface Site { x: number; z: number; r: number; y: number; blend: number }
/** Flattened areas for ruins. Their y is resolved from floor height at the site. */
export const SITES: Record<string, Site> = (() => {
  const mk = (x: number, z: number, r: number, blend = 12, dy = 0): Site => ({ x, z, r, y: floorY(z) + dy, blend });
  return {
    gate: mk(pathX(330), 330, 13),
    colonnade: mk(pathX(185), 185, 22, 14),
    terrace: mk(pathX(30) + 30, 30, 30, 16, 0.6),
    bridge: mk(streamX(BRIDGE_Z), BRIDGE_Z, 0, 0),
    shrine: mk(pathX(-300) - 26, -300, 18, 12, 0.4),
    ring: mk(pathX(-420) - 16, -420, 30, 18),
  };
})();

function valleyHalfWidth(z: number) {
  const basin = smoothstep(-500, -720, z) * 230;
  return 105 + 38 * fbm(z * 0.004, 3.3, 3) + basin;
}

/** Terrain height without ruin flattening (used for the far landscape too). */
function rawHeight(x: number, z: number): number {
  const ax = valleyAxis(z);
  const d = Math.abs(x - ax);
  const hw = valleyHalfWidth(z);
  const t = Math.max(0, d - hw) / 240;
  // Valley walls: a soft shoulder that rolls up into rounded, eroded hills, then steeper ranges.
  const wall = 105 * (1 - Math.exp(-t * t * 1.4)) + 42 * t;
  const hills = fbm(x * 0.0042 + 4.1, z * 0.0042 - 2.7, 5) * 70 + (ridged(x * 0.0021 + 9.1, z * 0.0021 + 3.3, 4) - 0.4) * 35;
  const ridge = hills * smoothstep(0, 0.8, t);

  // Back wall behind the start, and far mountains closing the valley beyond the Colossus.
  const back = Math.max(0, z - 470);
  const backWall = 380 * smoothstep(0, 760, back) + back * 0.05;
  const farWall = 520 * smoothstep(-1100, -1900, z);
  // Great ranges beyond the valley walls: large ridged silhouettes for the horizon.
  const reach = t + back / 240 + Math.max(0, -1100 - z) / 300;
  // Broad rounded massifs with a little ridge detail: reads as weathered mountains, not paper spikes.
  const mass = fbm(x * 0.0006 + 1.7, z * 0.0006 + 0.4, 5) * 0.5 + 0.5;
  const range = (Math.pow(mass, 1.5) * 1000 + (ridged(x * 0.0013, z * 0.0013, 4) - 0.35) * 160) * smoothstep(1.4, 5, reach);

  const sd = Math.abs(x - streamX(z));
  const nearStream = smoothstep(6, 34, sd);
  const pd = Math.abs(x - pathX(z));
  const onPath = 1 - smoothstep(2.5, 7, pd);

  // Floor undulation: broad swells + small lumps, calmer along stream and road.
  const swell = fbm(x * 0.0065, z * 0.0065, 4) * 5.5;
  const lumps = fbm(x * 0.045, z * 0.045, 3) * 0.9 * (1 - onPath * 0.85);
  let h = floorY(z) + wall + ridge + backWall + farWall + Math.max(0, range) + (swell * (0.35 + 0.65 * nearStream) + lumps) * nearStream;

  return h;
}

/** Stream channel + terminal pool depth to subtract (applied after all flattening). */
function carve(x: number, z: number): number {
  if (z < POOL.z) return poolCarve(x, z);
  const sd = Math.abs(x - streamX(z));
  const c = 1 - smoothstep(2.6, 8.5, sd);
  const source = smoothstep(STREAM_SOURCE_Z + 12, STREAM_SOURCE_Z - 6, z);
  return Math.max(c * c * (3 - 2 * c) * CHANNEL_DEPTH * source, poolCarve(x, z));
}
function poolCarve(x: number, z: number) {
  const d = Math.hypot(x - POOL.x, (z - POOL.z) * 0.85);
  const c = 1 - smoothstep(POOL.r * 0.5, POOL.r, d);
  return c * c * (3 - 2 * c) * (CHANNEL_DEPTH + 0.6);
}

export function terrainHeight(x: number, z: number): number {
  let h = rawHeight(x, z);
  for (const k in SITES) {
    const s = SITES[k];
    if (s.r <= 0) continue;
    const d = Math.hypot(x - s.x, z - s.z);
    if (d < s.r + s.blend) h = lerp(s.y, h, smoothstep(s.r, s.r + s.blend, d));
  }
  // The Colossus rests in a broad, shallow basin that follows the valley's slope.
  const cd = Math.hypot(x - COLOSSUS_POS.x, (z - COLOSSUS_POS.z) * 0.8);
  if (cd < 300) h = lerp(floorY(z) + 1.4 + (fbm(x * 0.01, z * 0.01, 3) * 0.5 + 0.5) * 2.2, h, smoothstep(170, 300, cd));
  return h - carve(x, z);
}

export function terrainNormal(x: number, z: number, e = 0.75): [number, number, number] {
  const hx = terrainHeight(x + e, z) - terrainHeight(x - e, z);
  const hz = terrainHeight(x, z + e) - terrainHeight(x, z - e);
  const nx = -hx, ny = 2 * e, nz = -hz;
  const l = Math.hypot(nx, ny, nz);
  return [nx / l, ny / l, nz / l];
}

/** Surface masks consumed by the terrain shader: x = road dirt, y = wet bank, z = macro moss/grass variation. */
export function terrainMask(x: number, z: number): [number, number, number] {
  const pd = Math.abs(x - pathX(z));
  const wear = 0.55 + 0.45 * fbm(x * 0.09, z * 0.09, 2);
  // The old road begins just ahead of the start and fades out into the grass behind it.
  let road = (1 - smoothstep(1.6, 4.2, pd)) * wear * smoothstep(PLAY.maxZ + 5, PLAY.maxZ - 45, z);
  for (const k of ['gate', 'colonnade', 'ring']) {
    const s = SITES[k];
    const d = Math.hypot(x - s.x, z - s.z);
    road = Math.max(road, (1 - smoothstep(s.r * 0.55, s.r * 0.95, d)) * 0.55 * wear);
  }
  const sd = Math.abs(x - streamX(z));
  const pd2 = Math.hypot(x - POOL.x, (z - POOL.z) * 0.85);
  const wet = Math.max(z < POOL.z ? 0 : 1 - smoothstep(4.5, 12, sd), 1 - smoothstep(POOL.r * 0.8, POOL.r * 1.25, pd2));
  const macro = fbm(x * 0.012 + 40, z * 0.012, 3) * 0.5 + 0.5;
  return [Math.min(1, road), wet, macro];
}
