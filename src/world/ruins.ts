import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32, smoothstep } from '../core/noise';
import { SITES, pathX, streamX, terrainHeight, BRIDGE_Z, floorY } from './heightfield';
import { block, column, stoneMaterial } from './stone';
import { Colliders } from './colliders';
import type { TextureSet } from '../core/assets';

type Bucket = 'masonry' | 'carved';

/**
 * Procedural ruins of a lost civilisation along the old road. Everything is baked into two merged meshes
 * (masonry + carved stone) to keep draw calls minimal.
 */
export class Ruins {
  readonly group = new THREE.Group();
  /** Footprints used by vegetation scatter to keep plants out of solid stone. */
  readonly footprints: { x: number; z: number; r: number }[] = [];
  /** Columns and pillars that ivy can climb. */
  readonly vineAnchors: { x: number; z: number; base: number; top: number; r: number }[] = [];
  private parts: Record<Bucket, THREE.BufferGeometry[]> = { masonry: [], carved: [] };
  private rnd = mulberry32(4242);
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();

  constructor(private colliders: Colliders, tex: Record<string, TextureSet>) {
    this.gate();
    this.colonnade();
    this.terrace();
    this.bridge();
    this.shrine();
    this.ring();

    const masonry = stoneMaterial(tex.rock064, tex.ground037, { scale: 0.32, key: 'masonry', mossAmount: 0.9, tint: new THREE.Color(0.92, 0.92, 0.88) });
    const carved = stoneMaterial(tex.rock051, tex.ground037, { scale: 0.18, key: 'carved', mossAmount: 0.75, tint: new THREE.Color(0.82, 0.82, 0.8) });
    masonry.defines = { HAS_AO_ATTR: '' };
    carved.defines = { HAS_AO_ATTR: '' };
    for (const [k, mat] of [['masonry', masonry], ['carved', carved]] as const) {
      const g = mergeGeometries(this.parts[k], false);
      if (!g) continue;
      bakeGroundAO(g);
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  private r(a: number, b: number) { return a + (b - a) * this.rnd(); }

  /** Places geometry with a full transform; returns world-space bounds height for colliders. */
  private put(g: THREE.BufferGeometry, bucket: Bucket, x: number, y: number, z: number, ry = 0, rx = 0, rz = 0) {
    this.e.set(rx, ry, rz, 'YXZ');
    this.m.compose(new THREE.Vector3(x, y, z), this.q.setFromEuler(this.e), new THREE.Vector3(1, 1, 1));
    this.parts[bucket].push(g.applyMatrix4(this.m));
  }

  /** A block resting on the ground (or at baseY), with an optional collider. */
  private stone(w: number, h: number, d: number, x: number, z: number, ry: number, opts: { baseY?: number; bucket?: Bucket; tilt?: number; sink?: number; collide?: boolean } = {}) {
    const base = opts.baseY ?? terrainHeight(x, z) - (opts.sink ?? 0.15);
    const tilt = opts.tilt ?? 0;
    const g = block(w, h, d, { seed: this.rnd() * 100 });
    this.put(g, opts.bucket ?? 'masonry', x, base + h / 2, z, ry, this.r(-tilt, tilt), this.r(-tilt, tilt));
    if (opts.collide !== false && h > 0.35) this.colliders.addBox(x, z, w, d, -ry, base, base + h);
    return base + h;
  }

  /** Road frame at a site: forward along the road (toward the Colossus), x across. */
  private roadFrame(z: number) {
    const fx = pathX(z - 1) - pathX(z + 1), fz = -2;
    const ry = Math.atan2(fx, fz);
    const c = Math.cos(ry), s = Math.sin(ry);
    // local (lx, lz) -> world, matching Object3D rotation.y = ry
    const to = (cx: number, cz: number, lx: number, lz: number): [number, number] => [cx + lx * c + lz * s, cz - lx * s + lz * c];
    return { ry, to };
  }

  private wall(cx: number, cz: number, ry: number, lx0: number, lx1: number, lz: number, courses: number, seed: number) {
    const c = Math.cos(ry), s = Math.sin(ry);
    const len = lx1 - lx0;
    const n = Math.max(1, Math.round(Math.abs(len) / 1.35));
    const bw = len / n;
    for (let course = 0; course < courses; course++) {
      for (let i = 0; i < n; i++) {
        const t = (i + 0.5) / n;
        // Height profile falls off toward the broken end, with gaps.
        const keep = courses * (1 - t * 0.8) * (0.65 + 0.5 * Math.sin(seed + i * 1.7)) > course;
        if (!keep) continue;
        const lx = lx0 + bw * (i + 0.5) + (course % 2) * bw * 0.25;
        const x = cx + lx * c + lz * s, z = cz - lx * s + lz * c;
        const base = terrainHeight(x, z) - 0.25 + course * 0.82;
        this.stone(Math.abs(bw) * 0.97, 0.8, 0.95, x, z, ry + this.r(-0.03, 0.03), { baseY: base, tilt: 0.02 });
      }
    }
    this.footprints.push({ x: cx + ((lx0 + lx1) / 2) * c + lz * s, z: cz - ((lx0 + lx1) / 2) * s + lz * c, r: Math.abs(len) / 2 + 1 });
  }

  private rubble(cx: number, cz: number, radius: number, count: number) {
    for (let i = 0; i < count; i++) {
      const a = this.r(0, Math.PI * 2), d = Math.sqrt(this.rnd()) * radius;
      const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
      const s = this.r(0.25, 1.1);
      this.stone(s * this.r(0.8, 1.6), s * this.r(0.5, 0.9), s, x, z, this.r(0, 6.28), { tilt: 0.35, sink: s * 0.3, collide: s > 0.7 });
    }
  }

  private gate() {
    const S = SITES.gate;
    const { ry, to } = this.roadFrame(S.z);
    const y0 = terrainHeight(S.x, S.z) - 0.3;
    // Two pillars of stacked, slightly shifted blocks.
    for (const [side, courses] of [[-1, 7], [1, 5]] as const) {
      const [px, pz] = to(S.x, S.z, side * 3.4, 0);
      let y = y0;
      for (let i = 0; i < courses; i++) {
        const h = this.r(1.05, 1.3);
        const jx = this.r(-0.08, 0.08), jz = this.r(-0.08, 0.08);
        this.put(block(2.0, h, 2.0, { seed: i + side * 10 }), 'masonry', px + jx, y + h / 2, pz + jz, ry + this.r(-0.05, 0.05));
        y += h;
      }
      this.colliders.addBox(px, pz, 2.1, 2.1, -ry, y0, y);
      this.footprints.push({ x: px, z: pz, r: 2 });
      this.vineAnchors.push({ x: px, z: pz, base: y0 + 0.3, top: y, r: 1.15 });
      if (side === -1) {
        // Capital and a cantilevered stub of the broken lintel.
        this.put(block(2.5, 0.7, 2.5, { seed: 3 }), 'carved', px, y + 0.35, pz, ry);
        const [lx, lz] = to(S.x, S.z, side * 3.4 + 1.7, 0);
        this.put(block(3.6, 1.2, 1.7, { seed: 9 }), 'carved', lx, y + 1.3, lz, ry, 0, -0.05);
      }
    }
    // The fallen lintel, cracked in two on the ground.
    const [f1x, f1z] = to(S.x, S.z, 5.5, -3.5);
    this.stone(4.6, 1.2, 1.6, f1x, f1z, ry + 0.5, { bucket: 'carved', tilt: 0.12, sink: 0.35 });
    const [f2x, f2z] = to(S.x, S.z, 8.2, -6.0);
    this.stone(3.1, 1.1, 1.5, f2x, f2z, ry + 0.9, { bucket: 'carved', tilt: 0.2, sink: 0.4 });
    // Flanking walls.
    this.wall(S.x, S.z, ry, -4.8, -15, 0, 4, 1.0);
    this.wall(S.x, S.z, ry, 4.8, 13, 0.3, 3, 2.3);
    this.rubble(S.x, S.z, 12, 26);
  }

  private colonnade() {
    const S = SITES.colonnade;
    const heights = [6.8, 4.1, 6.8, 2.3, 5.4, 6.8, 3.2];
    for (let i = 0; i < 7; i++) {
      const z = S.z + 21 - i * 7;
      const { ry, to } = this.roadFrame(z);
      for (const side of [-1, 1]) {
        const k = (i + (side > 0 ? 3 : 0)) % heights.length;
        const fullH = 6.8;
        const broken = heights[k] < fullH ? heights[k] : undefined;
        if (side > 0 && i === 4) continue; // one missing entirely (fallen across the road below)
        const [x, zz] = to(pathX(z), z, side * 5.2, 0);
        const y = terrainHeight(x, zz) - 0.35;
        this.put(block(1.9, 0.55, 1.9, { seed: i * 3 + side }), 'carved', x, y + 0.27, zz, ry);
        this.put(column(0.55, fullH, { broken, seed: i * 7 + side, base: true, capital: !broken }), 'carved', x, y + 0.5, zz, ry + this.r(0, 1));
        if (!broken) this.put(block(1.7, 0.5, 1.7, { seed: i }), 'carved', x, y + 0.5 + fullH + 0.2, zz, ry);
        this.colliders.addCircle(x, zz, 0.75, y, y + (broken ?? fullH) + 0.5);
        this.vineAnchors.push({ x, z: zz, base: y + 0.3, top: y + (broken ?? fullH) + 0.4, r: 0.62 });
        this.footprints.push({ x, z: zz, r: 1.4 });
      }
      // Sunken paving slabs between the columns.
      for (let s = 0; s < 5; s++) {
        if (this.rnd() < 0.3) continue;
        const [x, zz] = to(pathX(z), z, this.r(-3.5, 3.5), this.r(-3, 3));
        this.stone(this.r(1.2, 1.8), 0.3, this.r(1.2, 1.8), x, zz, ry + this.r(-0.15, 0.15), { tilt: 0.05, sink: 0.22, collide: false });
      }
    }
    // A toppled column lying across the road as drums.
    const zf = S.z - 7;
    const { ry, to } = this.roadFrame(zf);
    for (let d = 0; d < 4; d++) {
      const [x, z] = to(pathX(zf), zf, 4.5 - d * 1.55, this.r(-0.3, 0.3) + d * 0.35);
      const y = terrainHeight(x, z);
      const g = column(0.52, 1.35, { seed: 40 + d }).translate(0, -0.67, 0);
      this.put(g, 'carved', x, y + 0.25, z, ry + Math.PI / 2 + this.r(-0.2, 0.2), 0, Math.PI / 2 + this.r(-0.1, 0.1));
      this.colliders.addCircle(x, z, 0.65, y - 0.3, y + 0.8);
    }
    this.rubble(pathX(S.z), S.z, 20, 30);
  }

  private terrace() {
    const S = SITES.terrace;
    const H = 2.1, W = 24, D = 17;
    const y0 = S.y - 0.4;
    // Platform body (masonry texture reads as fitted stone courses) plus a capping course of slabs.
    this.put(block(W, H + 0.4, D, { erosion: 0.12, seed: 2 }), 'masonry', S.x, y0 + (H + 0.4) / 2, S.z);
    this.colliders.addBox(S.x, S.z, W, D, 0, y0, y0 + H + 0.4);
    const top = y0 + H + 0.4;
    for (let ix = 0; ix < 8; ix++) for (let iz = 0; iz < 6; iz++) {
      if (this.rnd() < 0.18) continue;
      const x = S.x - W / 2 + 1.5 + ix * 3, z = S.z - D / 2 + 1.4 + iz * 2.85;
      this.put(block(2.9, 0.3, 2.75, { seed: ix * 9 + iz }), 'carved', x, top + 0.1 + this.r(-0.05, 0.03), z, this.r(-0.02, 0.02), this.r(-0.02, 0.02));
    }
    // Stairs down to the road on the west side.
    const steps = 7;
    for (let i = 0; i < steps; i++) {
      const h = ((i + 1) / steps) * (H + 0.4);
      const x = S.x - W / 2 - (steps - i) * 0.75 + 0.35;
      this.put(block(0.8, h, 6.5, { seed: 50 + i, round: 0.08 }), 'carved', x, y0 + h / 2, S.z + 1, 0);
      this.colliders.addBox(x, S.z + 1, 0.76, 6.5, 0, y0, y0 + h);
    }
    // Ruined hall walls on top, with a doorway facing the stairs.
    const wallY = top + 0.2;
    const courseWall = (x0: number, z0: number, x1: number, z1: number, courses: number, gap?: [number, number]) => {
      const len = Math.hypot(x1 - x0, z1 - z0), ry = Math.atan2(-(z1 - z0), x1 - x0);
      const n = Math.round(len / 1.4);
      for (let c = 0; c < courses; c++) for (let i = 0; i < n; i++) {
        const t = (i + 0.5 + (c % 2) * 0.25) / n;
        if (gap && t > gap[0] && t < gap[1]) continue;
        if (c > 1 && this.rnd() < 0.08 * c + t * 0.15) continue;
        const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
        this.put(block(1.36, 0.82, 1.0, { seed: c * 31 + i }), 'masonry', x, wallY + c * 0.84 + 0.41, z, ry + this.r(-0.02, 0.02));
      }
      this.colliders.addBox((x0 + x1) / 2, (z0 + z1) / 2, len, 1.0, -ry, wallY, wallY + courses * 0.84);
    };
    courseWall(S.x + 9, S.z - 6.5, S.x + 9, S.z + 6.5, 6);
    courseWall(S.x - 4, S.z - 6.5, S.x + 9, S.z - 6.5, 5);
    courseWall(S.x - 4, S.z + 6.5, S.x + 4, S.z + 6.5, 3);
    // Monolith with a weathered face and an altar before it.
    this.put(block(1.8, 6.2, 1.1, { erosion: 0.09, seed: 77 }), 'carved', S.x + 5.5, top + 3.0, S.z, 0.1, 0.04, 0.05);
    this.colliders.addBox(S.x + 5.5, S.z, 1.8, 1.1, -0.1, top, top + 6);
    this.put(block(2.6, 0.95, 1.5, { seed: 78 }), 'carved', S.x + 2.5, top + 0.55, S.z, 0.1);
    this.colliders.addBox(S.x + 2.5, S.z, 2.6, 1.5, -0.1, top, top + 1.0);
    this.footprints.push({ x: S.x, z: S.z, r: Math.hypot(W, D) / 2 + 1 });
    this.rubble(S.x - 10, S.z - 4, 9, 18);
  }

  private bridge() {
    const z = BRIDGE_Z;
    const sx = streamX(z);
    const half = 13;
    const base = floorY(z) + 0.15;
    const deckY = (lx: number) => base + 1.35 * (1 - (lx / half) ** 2);
    // Deck along X (the stream runs roughly along Z here).
    const segs = 13;
    for (let i = 0; i < segs; i++) {
      const lx = -half + (i + 0.5) * ((half * 2) / segs);
      const y = deckY(lx);
      const slope = Math.atan2(deckY(lx + 0.5) - deckY(lx - 0.5), 1);
      this.put(block(2.06, 0.75, 4.3, { seed: 90 + i, round: 0.1 }), 'carved', sx + lx, y - 0.35, z, 0, 0, slope);
      this.colliders.addBox(sx + lx, z, 2.0, 4.3, 0, y - 6, y + 0.02);
      // Parapets, partially collapsed.
      for (const side of [-1, 1]) {
        if (Math.sin(i * 2.3 + side) > 0.55) continue;
        this.put(block(1.9, 0.75, 0.45, { seed: 120 + i * side }), 'masonry', sx + lx, y + 0.38, z + side * 1.95, 0, 0, slope);
        this.colliders.addBox(sx + lx, z + side * 1.95, 1.9, 0.45, 0, y, y + 0.75);
      }
    }
    // Arch ring of voussoirs under the deck.
    const R = 6.2, cy = base - 2.4;
    const n = 15;
    for (let i = 0; i < n; i++) {
      const a = Math.PI * (i + 0.5) / n;
      const x = sx - Math.cos(a) * R, y = cy + Math.sin(a) * R;
      for (const zz of [-1.2, 1.2]) this.put(block(1.35, 0.75, 1.9, { seed: 200 + i, round: 0.08 }), 'carved', x, y, z + zz, 0, 0, a - Math.PI / 2);
    }
    // Spandrel fill + abutments.
    for (const side of [-1, 1]) {
      const ax = sx + side * 9;
      this.put(block(5.5, 3.2, 4.4, { seed: 300 + side }), 'masonry', ax, base - 1.6, z);
      this.put(block(3.2, 1.6, 4.3, { seed: 310 + side }), 'masonry', sx + side * 4.6, base - 0.2, z, 0, 0, side * 0.12);
    }
    this.footprints.push({ x: sx, z, r: 14 });
    this.rubble(sx + 12, z + 5, 5, 8);
  }

  private shrine() {
    const S = SITES.shrine;
    const n = 7;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + 0.3;
      const x = S.x + Math.cos(a) * 9, z = S.z + Math.sin(a) * 9;
      const h = this.r(4.2, 7.0);
      if (i === 2 || i === 5) {
        // Fallen monolith.
        const y = terrainHeight(x, z);
        this.put(block(1.4, h, 0.9, { seed: 400 + i, erosion: 0.08 }), 'carved', x + Math.cos(a) * 2, y + 0.3, z + Math.sin(a) * 2, -a, Math.PI / 2 - 0.05, 0);
        this.colliders.addBox(x + Math.cos(a) * 2, z + Math.sin(a) * 2, 1.4, h, a, y - 0.4, y + 0.9);
        continue;
      }
      const y = terrainHeight(x, z) - 0.6;
      this.put(block(1.5, h, 0.95, { seed: 400 + i, erosion: 0.09 }), 'carved', x, y + h / 2, z, -a + Math.PI / 2, this.r(-0.08, 0.08), this.r(-0.08, 0.08));
      this.colliders.addBox(x, z, 1.5, 0.95, a - Math.PI / 2, y, y + h);
      this.footprints.push({ x, z, r: 1.6 });
    }
    this.stone(2.6, 1.0, 1.6, S.x, S.z, 0.4, { bucket: 'carved' });
    this.rubble(S.x, S.z, 12, 14);
  }

  private ring() {
    const S = SITES.ring;
    const R = 24;
    // An arc of arches on the near side, framing the Colossus beyond.
    const a0 = 0.15 * Math.PI, a1 = 0.85 * Math.PI;
    const count = 8;
    const pillarTop: number[] = [];
    const pts: [number, number][] = [];
    for (let i = 0; i <= count; i++) {
      const a = a0 + ((a1 - a0) * i) / count;
      const x = S.x + Math.cos(a) * R, z = S.z + Math.sin(a) * R;
      pts.push([x, z]);
      const broken = i === 2 || i === 6 ? this.r(2.5, 5) : 9;
      const y0 = terrainHeight(x, z) - 0.4;
      let y = y0;
      while (y < y0 + broken) {
        const h = Math.min(this.r(1.0, 1.3), y0 + broken - y + 0.2);
        this.put(block(1.7, h, 1.7, { seed: i * 13 + y }), 'masonry', x + this.r(-0.06, 0.06), y + h / 2, z + this.r(-0.06, 0.06), -a);
        y += h;
      }
      pillarTop.push(y);
      this.colliders.addBox(x, z, 1.8, 1.8, a, y0, y);
      this.footprints.push({ x, z, r: 1.8 });
      this.vineAnchors.push({ x, z, base: y0 + 0.4, top: y, r: 1.0 });
    }
    // Arches between intact neighbouring pillars.
    for (let i = 0; i < count; i++) {
      if (pillarTop[i] < 8.5 || pillarTop[i + 1] < 8.5 || i === 4) continue;
      const [xA, zA] = pts[i], [xB, zB] = pts[i + 1];
      const cx = (xA + xB) / 2, cz = (zA + zB) / 2;
      const span = Math.hypot(xB - xA, zB - zA) / 2;
      const ry = Math.atan2(-(zB - zA), xB - xA);
      const yb = Math.min(pillarTop[i], pillarTop[i + 1]);
      const nv = 9;
      for (let k = 0; k < nv; k++) {
        const t = Math.PI * (k + 0.5) / nv;
        const lx = -Math.cos(t) * span, ly = Math.sin(t) * span * 0.8;
        const x = cx + lx * Math.cos(ry), z = cz - lx * Math.sin(ry);
        this.put(block(1.25, 0.9, 1.5, { seed: 600 + i * 10 + k, round: 0.08 }), 'carved', x, yb + ly, z, ry, 0, t - Math.PI / 2);
      }
    }
    // Central dais facing the Colossus.
    const yD = terrainHeight(S.x, S.z) - 0.3;
    this.put(column(6.5, 0.9, { seed: 700 }), 'masonry', S.x, yD, S.z);
    this.colliders.addCircle(S.x, S.z, 6.5, yD, yD + 0.9);
    this.put(column(4.0, 0.5, { seed: 701 }), 'carved', S.x, yD + 0.85, S.z);
    this.colliders.addCircle(S.x, S.z, 4.0, yD, yD + 1.35);
    this.footprints.push({ x: S.x, z: S.z, r: 7 });
    this.rubble(S.x, S.z + 8, 22, 40);
  }
}

/** Darkens geometry close to the ground for contact shadowing (no runtime cost). */
function bakeGroundAO(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const ao = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const h = y - terrainHeight(x, z);
    ao[i] = 0.45 + 0.55 * smoothstep(-0.1, 1.4, h);
  }
  g.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
}
