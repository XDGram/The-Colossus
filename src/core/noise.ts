// 2D simplex noise (Gustavson) with seeded permutation, plus fBm helpers.
const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GRAD = [1, 1, -1, 1, 1, -1, -1, -1, 1, 0, -1, 0, 0, 1, 0, -1];

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const perm = new Uint8Array(512);
{
  const r = mulberry32(1337);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
}

export function simplex2(x: number, y: number): number {
  const s = (x + y) * F2;
  const i = Math.floor(x + s);
  const j = Math.floor(y + s);
  const t = (i + j) * G2;
  const x0 = x - (i - t);
  const y0 = y - (j - t);
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = 1 - i1;
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;
  const ii = i & 255;
  const jj = j & 255;
  let n = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) {
    const g = (perm[ii + perm[jj]] & 7) * 2;
    t0 *= t0;
    n += t0 * t0 * (GRAD[g] * x0 + GRAD[g + 1] * y0);
  }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) {
    const g = (perm[ii + i1 + perm[jj + j1]] & 7) * 2;
    t1 *= t1;
    n += t1 * t1 * (GRAD[g] * x1 + GRAD[g + 1] * y1);
  }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) {
    const g = (perm[ii + 1 + perm[jj + 1]] & 7) * 2;
    t2 *= t2;
    n += t2 * t2 * (GRAD[g] * x2 + GRAD[g + 1] * y2);
  }
  return 70 * n;
}

export function fbm(x: number, y: number, octaves = 5, lacunarity = 2.03, gain = 0.5): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += simplex2(x, y) * amp;
    norm += amp;
    amp *= gain;
    x = x * lacunarity + 17.3;
    y = y * lacunarity - 9.1;
  }
  return sum / norm;
}

/** Ridged multifractal, 0..1, sharp crests. Good for mountain silhouettes. */
export function ridged(x: number, y: number, octaves = 6): number {
  let sum = 0;
  let amp = 0.5;
  let prev = 1;
  for (let o = 0; o < octaves; o++) {
    let n = 1 - Math.abs(simplex2(x, y));
    n *= n;
    sum += n * amp * prev;
    prev = n;
    amp *= 0.5;
    x = x * 2.01 + 5.2;
    y = y * 2.01 - 3.7;
  }
  return sum;
}

export const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
