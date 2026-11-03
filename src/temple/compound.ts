import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm, mulberry32, smoothstep } from '../core/noise';
import type { Colliders } from '../world/colliders';
import { ground } from '../world/ground';
import { buildBuilding, MAT, type Builder, type Building, type BuildingSpec } from './kit';
import { dressCompound, leafLitter, FallingLeaves, noren, leafCarpets } from './dressing';

/**
 * The opening level: a temple compound. Layout (metres, +z = south toward the main gate, the player
 * starts at the gate looking north up the main axis to the hall):
 *
 *   z -92 ........ north wall; pagoda (NE) and shrine (NW) behind the hall
 *   z -48          main hall on a 1.9 m platform, stairs down to the courtyard
 *   z -36 .. +44   central courtyard, ~60 x 80 m of paving (combat space)
 *   x +-40         covered corridors (kairo) lining the courtyard, open to it
 *   x +-54         houses, kitchen, storehouse, monks' quarters behind the corridors
 *   z +50          main gate (sanmon); side gates in the east/west walls; a breach in the NE wall
 */
export const TEMPLE = {
  bounds: { minX: -63, maxX: 63, minZ: -90, maxZ: 58 },
  start: { x: 0, z: 56 },
  wall: { minX: -64, maxX: 64, minZ: -92, maxZ: 51 },
};

export function templeHeight(x: number, z: number) {
  const w = TEMPLE.wall;
  // Distance outside the compound wall: hills rise beyond it, the settlement sits on the lower slopes.
  const dx = Math.max(0, w.minX - x, x - w.maxX), dz = Math.max(0, w.minZ - z, z - w.maxZ - 30);
  const out = Math.hypot(dx, dz);
  const hills = smoothstep(10, 260, out) * (40 + fbm(x * 0.004, z * 0.004, 4) * 30) + smoothstep(250, 900, out) * 260;
  const lumps = fbm(x * 0.02, z * 0.02, 3) * 0.6 * smoothstep(4, 30, out);
  return hills + lumps;
}

function templeNormal(x: number, z: number, e = 0.75): [number, number, number] {
  const hx = templeHeight(x + e, z) - templeHeight(x - e, z), hz = templeHeight(x, z + e) - templeHeight(x, z - e);
  const n = new THREE.Vector3(-hx, 2 * e, -hz).normalize();
  return [n.x, n.y, n.z];
}

export interface Temple {
  group: THREE.Group;
  buildings: Building[];
  treeSpots: THREE.Matrix4[];
  treeGold: boolean[];
  falling: FallingLeaves;
  start: { x: number; z: number };
  startYaw: number;
  update(cam: THREE.Vector3, player: THREE.Vector3): void;
}

// ---------- furnishing helpers (local coordinates of the building) ----------
const table = (b: Builder, x: number, z: number, w = 1.6, d = 0.8, rot = 0) => {
  const y = b.floorY;
  const [sx, sz] = rot ? [d, w] : [w, d];
  b.box('floor', x, y + 0.36, z, sx, 0.06, sz, true, 'detail');
  for (const [ox, oz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) b.box('timber', x + ox * (sx / 2 - 0.08), y + 0.17, z + oz * (sz / 2 - 0.08), 0.07, 0.34, 0.07, false, 'detail');
};
const shelf = (b: Builder, x: number, z: number, w = 1.8, along: 'x' | 'z' = 'x') => {
  const y = b.floorY, d = 0.42, h = 1.8;
  const [sx, sz] = along === 'x' ? [w, d] : [d, w];
  b.box('timber', x, y + h / 2, z, sx, h, sz, true, 'detail');
  for (let k = 0; k < 4; k++) {
    const yy = y + 0.3 + k * 0.42;
    b.box('lacquer', x, yy + 0.1, z, sx * 0.9 * (0.6 + ((k * 37) % 5) * 0.08), 0.16, sz * 0.7, false, 'detail');
  }
};
const cushion = (b: Builder, x: number, z: number) => b.box('cloth', x, b.floorY + 0.06, z, 0.6, 0.1, 0.6, false, 'detail');
const tatami = (b: Builder, x0: number, z0: number, x1: number, z1: number) => {
  const y = b.floorY + 0.06;
  for (let x = x0; x < x1 - 0.5; x += 1.82) for (let z = z0; z < z1 - 0.5; z += 0.91) {
    b.box('tatami', x + 0.91, y, z + 0.455, 1.78, 0.04, 0.87, false, 'detail');
    // Dark cloth edging (heri) along the long sides.
    for (const e of [-0.42, 0.42]) b.box('cloth', x + 0.91, y + 0.022, z + 0.455 + e, 1.78, 0.012, 0.04, false, 'detail');
  }
};
/** Seated figure on a gilded lotus with a halo. */
const statue = (b: Builder, x: number, z: number, s = 1) => {
  const y = b.floorY;
  const lotus = new THREE.LatheGeometry([0, 0.75, 0.9, 0.82, 0.95, 0.7, 0.5].map((r, i) => new THREE.Vector2(r * s, i * 0.12 * s)), 20);
  b.geo(lotus.translate(x, y + 0.9 * s, z), 'gold', 'detail');
  b.geo(new THREE.SphereGeometry(0.62 * s, 16, 12).scale(1.15, 0.55, 0.85).translate(x, y + 1.85 * s, z + 0.1 * s), 'gold', 'detail');
  b.geo(new THREE.SphereGeometry(0.42 * s, 16, 12).scale(1, 1.35, 0.8).translate(x, y + 2.45 * s, z), 'gold', 'detail');
  b.geo(new THREE.SphereGeometry(0.27 * s, 14, 12).translate(x, y + 3.15 * s, z + 0.05 * s), 'gold', 'detail');
  b.geo(new THREE.SphereGeometry(0.12 * s, 10, 8).translate(x, y + 3.45 * s, z), 'gold', 'detail');
  b.geo(new THREE.TorusGeometry(0.85 * s, 0.06 * s, 8, 32).translate(x, y + 3.0 * s, z - 0.45 * s), 'gold', 'detail');
  b.geo(new THREE.CircleGeometry(0.82 * s, 32).translate(x, y + 3.0 * s, z - 0.47 * s), 'lacquer', 'detail');
};
const candles = (b: Builder, x: number, z: number, n = 5, spread = 1.4) => {
  for (let i = 0; i < n; i++) {
    const cx = x - spread / 2 + (spread * i) / Math.max(1, n - 1);
    b.cyl('timber', cx, b.floorY + 0.95, z, 0.05, 0.12, false);
    b.cyl('cloth', cx, b.floorY + 1.1, z, 0.03, 0.2, false);
    b.cyl('glow', cx, b.floorY + 1.24, z, 0.018, 0.06, false);
  }
};
/** Folding screen (byobu): zig-zag panels. */
const byobu = (b: Builder, x: number, z: number, panels = 6, along: 'x' | 'z' = 'x') => {
  const pw = 0.55;
  for (let i = 0; i < panels; i++) {
    const off = (i - (panels - 1) / 2) * pw * 0.94, zig = (i % 2 ? 0.12 : -0.12);
    if (along === 'x') { b.box('shoji', x + off, b.floorY + 0.85, z + zig, pw, 1.6, 0.03, false, 'detail'); b.box('gold', x + off, b.floorY + 1.66, z + zig, pw, 0.05, 0.05, false, 'detail'); }
    else { b.box('shoji', x + zig, b.floorY + 0.85, z + off, 0.03, 1.6, pw, false, 'detail'); b.box('gold', x + zig, b.floorY + 1.66, z + off, 0.05, 0.05, pw, false, 'detail'); }
  }
};
/** Stepped storage chest (tansu) with drawer fronts. */
const tansu = (b: Builder, x: number, z: number, along: 'x' | 'z' = 'x') => {
  const y = b.floorY, [sx, sz] = along === 'x' ? [1.4, 0.5] : [0.5, 1.4];
  b.box('lacquer', x, y + 0.6, z, sx, 1.2, sz, true, 'detail');
  for (let r = 0; r < 4; r++) for (let c = 0; c < 2; c++) {
    const yy = y + 0.17 + r * 0.29, oc = (c - 0.5) * 0.66;
    if (along === 'x') b.box('gold', x + oc, yy, z + sz / 2 + 0.01, 0.08, 0.03, 0.02, false, 'detail');
    else b.box('gold', x + sz / 2 + 0.01, yy, z + oc, 0.02, 0.03, 0.08, false, 'detail');
  }
};
/** Tokonoma alcove: raised dais, hanging scroll and a vase. */
const alcove = (b: Builder, x: number, z: number, along: 'x' | 'z' = 'x') => {
  const y = b.floorY;
  if (along === 'x') { b.box('timber', x, y + 0.1, z, 1.8, 0.2, 0.7, false, 'detail'); b.box('shoji', x, y + 1.5, z - 0.32, 0.55, 1.4, 0.02, false, 'detail'); b.box('cloth', x, y + 1.5, z - 0.31, 0.4, 1.1, 0.01, false, 'detail'); }
  else { b.box('timber', x, y + 0.1, z, 0.7, 0.2, 1.8, false, 'detail'); b.box('shoji', x - 0.32, y + 1.5, z, 0.02, 1.4, 0.55, false, 'detail'); b.box('cloth', x - 0.31, y + 1.5, z, 0.01, 1.1, 0.4, false, 'detail'); }
  b.geo(new THREE.LatheGeometry([0.05, 0.1, 0.13, 0.1, 0.05, 0.06].map((r, i) => new THREE.Vector2(r, i * 0.07)), 10).translate(x + 0.5, y + 0.2, z), 'lacquer', 'detail');
};
const standLantern = (b: Builder, x: number, z: number) => {
  const y = b.floorY;
  b.box('timber', x, y + 0.6, z, 0.06, 1.2, 0.06, false, 'detail');
  b.box('glow', x, y + 1.35, z, 0.32, 0.42, 0.32, false, 'detail');
  b.box('timber', x, y + 1.6, z, 0.4, 0.05, 0.4, false, 'detail');
};
const hearth = (b: Builder, x: number, z: number) => {
  b.box('stone', x, b.floorY + 0.06, z, 1.2, 0.12, 1.2, false, 'detail');
  b.box('glow', x, b.floorY + 0.14, z, 0.5, 0.06, 0.5, false, 'detail');
  b.cyl('timber', x, b.floorY + 1.2, z, 0.03, 2.1, false);
  b.cyl('lacquer', x, b.floorY + 0.4, z, 0.22, 0.3, false);
};

// ---------- the compound ----------
export function buildTemple(colliders: Colliders, quality: 'high' | 'low'): Temple {
  ground.height = templeHeight;
  ground.normal = templeNormal;
  ground.water = () => -1e6;
  ground.clamp = (x, z) => [THREE.MathUtils.clamp(x, TEMPLE.bounds.minX, TEMPLE.bounds.maxX), THREE.MathUtils.clamp(z, TEMPLE.bounds.minZ, TEMPLE.bounds.maxZ)];
  ground.solid = (x, y, z) => colliders.blocks(x, y, z);

  const group = new THREE.Group();
  const buildings: Building[] = [];
  const add = (s: BuildingSpec) => { const bl = buildBuilding(s, colliders, 0); buildings.push(bl); group.add(bl.group); return bl; };
  const rnd = mulberry32(88);

  // ---- Ground: grass outside, raked gravel inside the wall, stone paving on the courtyard and paths ----
  {
    const size = 1800, seg = quality === 'high' ? 220 : 140;
    const g = new THREE.PlaneGeometry(size, size, seg, seg).rotateX(-Math.PI / 2);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const col = new Float32Array(p.count * 3);
    const w = TEMPLE.wall;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      p.setY(i, templeHeight(x, z));
      const insideWall = x > w.minX && x < w.maxX && z > w.minZ && z < w.maxZ;
      const n = fbm(x * 0.05, z * 0.05, 3) * 0.5 + 0.5;
      let c = insideWall ? new THREE.Color(0.42, 0.4, 0.34).multiplyScalar(0.85 + n * 0.25) : new THREE.Color(0.2, 0.26, 0.1).lerp(new THREE.Color(0.32, 0.3, 0.14), n);
      if (!insideWall) {
        const nrm = templeNormal(x, z, 4);
        const wood = smoothstep(0.1, 0.35, fbm(x * 0.008 + 3, z * 0.008, 3));
        c.lerp(new THREE.Color(0.09, 0.13, 0.06), wood * 0.8);
        c.lerp(new THREE.Color(0.36, 0.34, 0.3), smoothstep(0.82, 0.62, nrm[1]));
      }
      col.set([c.r, c.g, c.b], i * 3);
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
    mesh.receiveShadow = true;
    group.add(mesh);

    // Paving: irregular flagstones in staggered courses of varying length, set slightly proud of the
    // gravel with uneven tops; a dressed-stone kerb frames the courtyard.
    const slabs: THREE.BufferGeometry[] = [];
    const pave = (x0: number, z0: number, x1: number, z1: number) => {
      let z = z0;
      while (z < z1) {
        const depth = 0.55 + rnd() * 0.75;
        let x = x0 + (rnd() - 0.5) * 0.6;
        while (x < x1) {
          const len = 0.7 + rnd() * 1.6;
          const sx = Math.min(len, x1 - x) - 0.05, sz = depth - 0.05;
          if (sx > 0.2) {
            const g = new THREE.BoxGeometry(sx, 0.12, sz, 2, 1, 2);
            const gp = g.getAttribute('position') as THREE.BufferAttribute;
            for (let i = 0; i < gp.count; i++) if (gp.getY(i) > 0) gp.setY(i, gp.getY(i) + (rnd() - 0.5) * 0.02);
            g.rotateY((rnd() - 0.5) * 0.04).translate(x + sx / 2, 0.03 + rnd() * 0.015, z + sz / 2);
            slabs.push(g.toNonIndexed());
          }
          x += len;
        }
        z += depth;
      }
    };
    pave(-30, -36, 30, 44);           // central courtyard
    pave(-3, 44, 3, 64);              // through the main gate
    pave(30, -2, 66, 2);              // east side-gate path
    pave(-66, -2, -30, 2);            // west side-gate path
    pave(-3, -88, 3, -60);            // behind the hall
    for (const [x0, z0, x1, z1] of [[-30.3, -36.3, 30.3, -36], [-30.3, 44, 30.3, 44.3], [-30.3, -36, -30, 44], [30, -36, 30.3, 44]]) slabs.push(new THREE.BoxGeometry(x1 - x0, 0.2, z1 - z0).translate((x0 + x1) / 2, 0.08, (z0 + z1) / 2).toNonIndexed());
    const pg = mergeGeometries(slabs, false)!;
    pg.computeVertexNormals();
    const pm = new THREE.Mesh(pg, MAT.stone);
    pm.receiveShadow = true;
    group.add(pm);
  }

  // ---- Perimeter wall (tsuiji): plaster on a stone footing with a tiled cap; gaps for gates ----
  {
    const parts: THREE.BufferGeometry[] = [], caps: THREE.BufferGeometry[] = [], feet: THREE.BufferGeometry[] = [];
    const H = 3.2, T = 1.0;
    const run = (x0: number, z0: number, x1: number, z1: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0), cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, ang = Math.atan2(z1 - z0, x1 - x0);
      const m = new THREE.Matrix4().makeRotationY(-ang).setPosition(cx, 0, cz);
      parts.push(new THREE.BoxGeometry(len, H, T * 0.8).translate(0, H / 2 + 0.6, 0).applyMatrix4(m));
      feet.push(new THREE.BoxGeometry(len, 0.7, T * 1.1).translate(0, 0.35, 0).applyMatrix4(m));
      const cap = new THREE.BoxGeometry(len + 0.4, 0.3, T * 1.6).translate(0, H + 0.75, 0);
      cap.applyMatrix4(m);
      caps.push(cap);
      colliders.addBox(cx, cz, len, T, ang, 0, H + 1);
    };
    const w = TEMPLE.wall;
    run(w.minX, w.maxZ, -7, w.maxZ); run(7, w.maxZ, w.maxX, w.maxZ);              // south, main gate gap
    run(w.minX, w.minZ, 36, w.minZ); run(46, w.minZ, w.maxX, w.minZ);             // north, breach NE
    run(w.minX, w.minZ, w.minX, -3); run(w.minX, 3, w.minX, w.maxZ);              // west, side gate
    run(w.maxX, w.minZ, w.maxX, -3); run(w.maxX, 3, w.maxX, w.maxZ);              // east, side gate
    const mk = (list: THREE.BufferGeometry[], mat: THREE.Material) => {
      const m = new THREE.Mesh(mergeGeometries(list.map((g) => g.toNonIndexed()), false)!, mat);
      m.castShadow = true; m.receiveShadow = true; group.add(m);
    };
    mk(parts, MAT.plaster); mk(caps, MAT.roof); mk(feet, MAT.stone);
    // Rubble at the breach.
    for (let i = 0; i < 9; i++) {
      const s = 0.4 + rnd() * 0.8;
      const m = new THREE.Mesh(new THREE.BoxGeometry(s * 1.4, s * 0.6, s), MAT.plaster);
      m.position.set(37 + rnd() * 8, s * 0.25, w.minZ + (rnd() - 0.3) * 4);
      m.rotation.set(rnd(), rnd() * 3, rnd() * 0.5);
      m.castShadow = true;
      group.add(m);
    }
  }

  // ---- Main hall (hondo): two-tier roof, raised platform, worship hall + three rear rooms ----
  add({
    name: 'main-hall', walls: 'timber', x: 0, z: -50, rot: 0, w: 28, d: 18, base: 1.9, wallH: 5.2, veranda: 2.6,
    roof: { kind: 'hip2', height: 8.5, overhang: 2.2 },
    stairs: [{ side: 'front', at: 0, width: 12 }, { side: 'left', at: 4, width: 3 }, { side: 'right', at: 4, width: 3 }],
    front: [{ at: 0, width: 6, screen: 'open' }, { at: -9, width: 3.2, screen: 'half' }, { at: 9, width: 3.2, screen: 'half' }],
    back: [{ at: 0, width: 2.4, screen: 'closed' }, { at: -9, width: 2.2, bottom: 1, top: 2.2 }, { at: 9, width: 2.2, bottom: 1, top: 2.2 }],
    left: [{ at: 4, width: 2.4, screen: 'open' }, { at: -5, width: 2, bottom: 1, top: 2.2 }],
    right: [{ at: 4, width: 2.4, screen: 'half' }, { at: -5, width: 2, bottom: 1, top: 2.2 }],
    partZ: [{ z: -3, openings: [{ at: -9.5, width: 2, screen: 'open' }, { at: 0, width: 3.6, screen: 'half' }, { at: 9.5, width: 2, screen: 'open' }] }],
    partX: [{ x: -4.6, from: -9, to: -3, openings: [{ at: -6, width: 1.8, screen: 'open' }] }, { x: 4.6, from: -9, to: -3, openings: [{ at: -6, width: 1.8, screen: 'closed' }] }],
    light: true,
    furnish: (b) => {
      // Four great columns, altar dais with an offering table, drum, cushions in rows, lanterns.
      for (const x of [-6, 6]) for (const z of [1, 6]) b.cyl('lacquer', x, b.floorY + 2.6, z, 0.32, 5.2, true, 'shell', 14);
      b.box('lacquer', 0, b.floorY + 0.35, -1.8, 9, 0.7, 2, true, 'detail');
      b.box('gold', 0, b.floorY + 0.72, -0.82, 9, 0.06, 0.06, false, 'detail');
      statue(b, 0, -2.0, 1.15);
      for (const x of [-2.6, 2.6]) { statue(b, x, -1.6, 0.55); }
      table(b, 0, -0.3, 3, 0.7); candles(b, 0, -0.3, 7, 2.4);
      b.cyl('gold', 0, b.floorY + 0.55, 0.6, 0.32, 0.35, false); b.cyl('glow', 0, b.floorY + 0.74, 0.6, 0.26, 0.02, false);
      // Hanging banners and a canopy above the altar.
      for (const x of [-4.2, 4.2]) b.box('cloth', x, b.floorY + 3.2, -0.9, 0.8, 3.0, 0.02, false, 'detail');
      b.box('gold', 0, b.floorY + 4.6, -1.6, 5.5, 0.12, 2.4, false, 'detail');
      for (let k = -5; k <= 5; k++) b.box('gold', k * 0.5, b.floorY + 4.3, -0.42, 0.04, 0.55, 0.04, false, 'detail');
      for (const x of [-3.2, 3.2]) standLantern(b, x, -0.6);
      b.cyl('lacquer', -9.5, b.floorY + 0.7, 3, 0.55, 0.9, true);
      for (let r = 0; r < 3; r++) for (let c = -3; c <= 3; c++) cushion(b, c * 1.2, 2.5 + r * 1.3);
      for (const x of [-11.5, 11.5]) for (const z of [-1.5, 6.5]) standLantern(b, x, z);
      // Rear rooms: scroll room (left), sutra library (centre), storeroom (right).
      tatami(b, -14, -9, -4.6, -3);
      table(b, -9, -6, 1.4, 0.7); cushion(b, -9, -5); alcove(b, -12.6, -6, 'z'); byobu(b, -7, -8.4, 5);
      shelf(b, 0, -8.6, 7); shelf(b, -2.6, -4.6, 1.6, 'z'); table(b, 0, -5.6, 2, 0.8);
      for (let i = 0; i < 4; i++) b.cyl('timber', 9 + (i % 2) * 1.2, b.floorY + 0.4, -7.8 + Math.floor(i / 2) * 1.1, 0.35, 0.8, true);
      shelf(b, 13, -6, 4, 'z'); tansu(b, 6, -8.5);
    },
  });

  // ---- Main gate (sanmon): open central passage, guard rooms either side ----
  add({
    name: 'main-gate', wainscot: 0.9, walls: 'timber', balcony: true, x: 0, z: 51, rot: 0, w: 15, d: 7, base: 0.3, wallH: 5.4,
    roof: { kind: 'hip2', height: 6.5, overhang: 1.6 },
    front: [{ at: 0, width: 5.5, top: 5, screen: 'none' }],
    back: [{ at: 0, width: 5.5, top: 5, screen: 'none' }],
    partX: [{ x: -2.9, openings: [{ at: 1.2, width: 1.6, screen: 'open' }] }, { x: 2.9, openings: [{ at: 1.2, width: 1.6, screen: 'half' }] }],
    left: [{ at: 0, width: 1.4, bottom: 1.2, top: 2.2 }],
    right: [{ at: 0, width: 1.4, bottom: 1.2, top: 2.2 }],
    light: true,
    furnish: (b) => {
      table(b, -5.3, -1.6, 1.2, 0.7); cushion(b, -5.3, -0.7); standLantern(b, -6.6, 2.4);
      shelf(b, 5.3, -3, 2.6); b.cyl('timber', 6.4, b.floorY + 0.45, 2.2, 0.38, 0.9, true);
    },
  });

  // ---- Covered corridors (kairo) along the courtyard: open toward it, closed behind with doors through ----
  for (const side of [-1, 1]) {
    add({
      name: `corridor-${side}`, wainscot: 0.9, x: side * 40, z: 2, rot: side < 0 ? Math.PI / 2 : -Math.PI / 2, w: 76, d: 5.5, base: 0.5, wallH: 3.6,
      roof: { kind: 'hip', height: 2.6, overhang: 1.1 },
      front: [{ at: 0, width: 75.8, top: 3.3, screen: 'none' }],
      back: [{ at: 22, width: 2, screen: 'open' }, { at: -13, width: 2, screen: 'half' }, { at: 0, width: 4, top: 3.2, screen: 'none' }, { at: 10, width: 1.6, bottom: 1.1, top: 2.1 }, { at: -25, width: 1.6, bottom: 1.1, top: 2.1 }],
      left: [{ at: 0, width: 4, top: 3.2, screen: 'none' }],
      right: [{ at: 0, width: 4, top: 3.2, screen: 'none' }],
      postSpacing: 3.8,
      furnish: (b) => {
        for (const x of [-30, -18, -6, 6, 18, 30]) { b.box('glow', x, b.floorY + 3.0, 1.6, 0.36, 0.5, 0.36, false, 'detail'); b.box('timber', x, b.floorY + 3.35, 1.6, 0.04, 0.2, 0.04, false, 'detail'); }
        for (const x of [-34, -21, 15, 27]) b.box('timber', x, b.floorY + 0.25, -2.1, 2.4, 0.5, 0.5, true, 'detail');
      },
    });
  }

  // ---- West: monks' quarters (3 rooms) and a family house (2 rooms) ----
  add({
    name: 'monks-quarters', wainscot: 0.9, balcony: true, x: -54, z: -22, rot: Math.PI / 2, w: 14, d: 9, base: 0.55, wallH: 3.2, veranda: 1.4,
    roof: { kind: 'hip2', height: 4.2, overhang: 1.1 },
    front: [{ at: -4.6, width: 1.8, screen: 'open' }, { at: 0.2, width: 1.8, screen: 'half' }, { at: 4.8, width: 1.8, screen: 'closed' }],
    back: [{ at: -4.6, width: 1.6, bottom: 1, top: 2 }, { at: 4.6, width: 1.6, bottom: 1, top: 2 }],
    left: [{ at: 1, width: 1.6, screen: 'open' }],
    partX: [{ x: -2.3, openings: [{ at: 2, width: 1.6, screen: 'open' }] }, { x: 2.4, openings: [{ at: 2, width: 1.6, screen: 'half' }] }],
    light: true,
    furnish: (b) => {
      tatami(b, -7, -4.5, -2.3, 4.5); tatami(b, -2.3, -4.5, 2.4, 4.5); tatami(b, 2.4, -4.5, 7, 4.5);
      for (const x of [-4.6, 0, 4.7]) { b.box('cloth', x, b.floorY + 0.1, -2.6, 1, 0.12, 2, false, 'detail'); table(b, x + 1.1, 1.6, 0.9, 0.6); standLantern(b, x - 1.6, -3.6); }
      shelf(b, -6.5, 0, 2.2, 'z'); alcove(b, 0, -3.9); tansu(b, 6.3, -3.2, 'z');
    },
  });
  add({
    name: 'family-house', wainscot: 0.9, x: -54, z: 20, rot: Math.PI / 2, w: 11, d: 8, base: 0.45, wallH: 3, veranda: 1.2,
    roof: { kind: 'hip', height: 3.4, overhang: 1 },
    front: [{ at: -2.5, width: 2, screen: 'open' }, { at: 2.5, width: 1.6, bottom: 0.9, top: 2 }],
    back: [{ at: 2.5, width: 1.6, screen: 'half' }],
    right: [{ at: -1, width: 1.5, bottom: 1, top: 2 }],
    partX: [{ x: 0.5, openings: [{ at: -0.5, width: 1.6, screen: 'open' }] }],
    light: true,
    furnish: (b) => {
      // Earthen-floor kitchen side with a hearth; raised tatami living room.
      hearth(b, -3, -1); shelf(b, -4.9, 1.5, 2, 'z'); b.cyl('lacquer', -3.8, b.floorY + 0.3, 2.8, 0.3, 0.6, true);
      tatami(b, 0.5, -4, 5.5, 4); table(b, 3, 0, 1.6, 0.9); for (const [x, z] of [[2.2, -0.8], [3.8, -0.8], [2.2, 0.8], [3.8, 0.8]]) cushion(b, x, z);
      standLantern(b, 5, -3.2); alcove(b, 4.9, 2.6, 'z'); byobu(b, 1.6, -3.6, 4); tansu(b, -1, -3.6);
    },
  });

  // ---- East: kitchen (2 rooms) and storehouse (kura) ----
  add({
    name: 'kitchen', wainscot: 0.9, walls: 'timber', x: 54, z: -22, rot: -Math.PI / 2, w: 13, d: 9, base: 0.4, wallH: 3.3, veranda: 1.2,
    roof: { kind: 'hip', height: 3.8, overhang: 1.1 },
    front: [{ at: -3.5, width: 2.4, screen: 'open' }, { at: 3.5, width: 1.8, screen: 'half' }],
    back: [{ at: 0, width: 1.8, bottom: 1.1, top: 2.1 }],
    right: [{ at: 0, width: 1.6, screen: 'open' }],
    partX: [{ x: 1.5, openings: [{ at: 1.5, width: 1.6, screen: 'open' }] }],
    light: true,
    furnish: (b) => {
      hearth(b, -3, -1.5); hearth(b, -1, -3);
      for (let i = 0; i < 5; i++) b.cyl('lacquer', -5.6 + (i % 3) * 0.75, b.floorY + 0.35, 3.4 - Math.floor(i / 3) * 0.75, 0.3, 0.7, true);
      table(b, -2.2, 1.6, 2.2, 0.8); shelf(b, -6, -2.5, 2.4, 'z');
      tatami(b, 1.5, -4.5, 6.5, 4.5); table(b, 4, 0, 1.8, 0.9); standLantern(b, 6, 3.6);
    },
  });
  add({
    name: 'storehouse', wainscot: 0.9, x: 54, z: 20, rot: -Math.PI / 2, w: 9, d: 7, base: 0.6, wallH: 4.2,
    roof: { kind: 'hip2', height: 3.6, overhang: 0.7 },
    front: [{ at: 0, width: 1.8, screen: 'half' }],
    left: [{ at: 0, width: 0.9, bottom: 2.6, top: 3.4 }],
    right: [{ at: 0, width: 0.9, bottom: 2.6, top: 3.4 }],
    light: true,
    furnish: (b) => {
      for (let i = 0; i < 8; i++) b.cyl('timber', -3.4 + (i % 4) * 1.1, b.floorY + 0.45, -2.4 + Math.floor(i / 4) * 1.1, 0.4, 0.9, true);
      shelf(b, 3.9, 0, 5, 'z'); shelf(b, -2, 3, 2.4);
      for (let i = 0; i < 6; i++) b.box('cloth', -3.6 + i * 0.5, b.floorY + 0.25, 2, 0.4, 0.5, 0.7, false, 'detail');
    },
  });

  // ---- Open pavilions: bell tower and well house ----
  add({
    name: 'bell-pavilion', x: 22, z: 22, rot: 0, w: 5.5, d: 5.5, base: 0.9, wallH: 4.2, open: true,
    roof: { kind: 'hip', height: 3.4, overhang: 1.3 }, stairs: [{ side: 'front', at: 0, width: 2.2 }], postSpacing: 5.5,
    furnish: (b) => { b.cyl('gold', 0, b.floorY + 2.6, 0, 0.75, 1.6, false, 'detail', 18); b.box('timber', 0, b.floorY + 3.6, 0, 0.12, 0.6, 0.12, false, 'detail'); b.box('timber', 0, b.floorY + 1.8, 1.3, 0.16, 0.16, 2.2, false, 'detail'); },
  });
  add({
    name: 'well-house', x: -22, z: 24, rot: 0, w: 4, d: 4, base: 0.15, wallH: 3, open: true,
    roof: { kind: 'hip', height: 2.2, overhang: 0.9 }, postSpacing: 4,
    furnish: (b) => { b.cyl('stone', 0, 0.55, 0, 0.9, 0.8, true, 'detail', 16); b.cyl('timber', 0, 0.97, 0, 0.75, 0.05, false, 'detail', 16); b.box('timber', 0, 2.4, 0, 2.4, 0.12, 0.12, false, 'detail'); b.cyl('timber', 0.4, 0.6, 0.9, 0.22, 0.4, false); },
  });

  // ---- Behind the hall: shrine (NW) and three-storey pagoda (NE), both enterable at ground level ----
  add({
    name: 'shrine', x: -32, z: -76, rot: 0, w: 7, d: 6, base: 1.1, wallH: 3.2, veranda: 1.2,
    roof: { kind: 'hip', height: 3.6, overhang: 1.2 }, stairs: [{ side: 'front', at: 0, width: 2.6 }],
    front: [{ at: 0, width: 2.8, screen: 'open' }],
    left: [{ at: 0, width: 1.4, bottom: 1, top: 2 }],
    light: true,
    furnish: (b) => { b.box('lacquer', 0, b.floorY + 0.5, -2, 3.4, 1, 1.2, true, 'detail'); b.box('gold', 0, b.floorY + 1.4, -2.2, 0.8, 0.9, 0.6, false, 'detail'); standLantern(b, -2.6, -1.8); standLantern(b, 2.6, -1.8); cushion(b, 0, 0.6); },
  });
  const pagoda = add({
    name: 'pagoda', x: 34, z: -76, rot: 0, w: 7, d: 7, base: 1.2, wallH: 3.6, veranda: 1.2,
    roof: { kind: 'hip', height: 1.6, overhang: 2.1 }, stairs: [{ side: 'front', at: 0, width: 2.4 }],
    front: [{ at: 0, width: 2.2, screen: 'open' }],
    light: true,
    furnish: (b) => { b.cyl('lacquer', 0, b.floorY + 2, 0, 0.45, 4, true, 'shell', 12); b.box('gold', 0, b.floorY + 0.7, -2.4, 1.2, 1.4, 0.8, false, 'detail'); standLantern(b, -2.2, 2); },
  });
  // Upper storeys of the pagoda (not enterable: a solid tower above the ground-floor sanctuary).
  {
    let y = pagoda.spec.base + pagoda.spec.wallH + 1.3;
    for (let k = 0; k < 2; k++) {
      const s = 6.2 - k * 1.1;
      const st = buildBuilding({ name: `pagoda-${k}`, x: 34, z: -76, rot: 0, w: s, d: s, base: 0, wallH: 2.6, roof: { kind: 'hip', height: k === 1 ? 3.4 : 1.4, overhang: 2 }, back: [], front: [{ at: 0, width: 1.4, bottom: 0.8, top: 2, screen: 'closed' }] }, colliders, y);
      group.add(st.group);
      buildings.push(st);
      y += 2.6 + 1.3;
    }
    const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.14, 6, 8), MAT.gold);
    spire.position.set(34, y + 3, -76);
    group.add(spire);
  }

  // ---- Courtyard dressing: stone lanterns on the axis, incense burner, banners, barrels, pottery ----
  {
    const stoneParts: THREE.BufferGeometry[] = [], glowParts: THREE.BufferGeometry[] = [];
    const lantern = (x: number, z: number, s = 1) => {
      stoneParts.push(new THREE.BoxGeometry(0.9 * s, 0.3 * s, 0.9 * s).translate(x, 0.15 * s, z));
      stoneParts.push(new THREE.CylinderGeometry(0.16 * s, 0.2 * s, 1.1 * s, 8).translate(x, 0.85 * s, z));
      stoneParts.push(new THREE.BoxGeometry(0.75 * s, 0.14 * s, 0.75 * s).translate(x, 1.45 * s, z));
      glowParts.push(new THREE.BoxGeometry(0.42 * s, 0.42 * s, 0.42 * s).translate(x, 1.73 * s, z));
      stoneParts.push(new THREE.ConeGeometry(0.75 * s, 0.45 * s, 4).rotateY(Math.PI / 4).translate(x, 2.17 * s, z));
      colliders.addCircle(x, z, 0.5 * s, 0, 2.4 * s);
    };
    for (const z of [36, 22, 8, -6, -20]) for (const x of [-6.5, 6.5]) lantern(x, z, 1.1);
    for (const x of [-12, 12]) lantern(x, -34, 1.4);
    // Incense burner.
    stoneParts.push(new THREE.CylinderGeometry(1.2, 1.4, 0.5, 12).translate(0, 0.25, -26));
    stoneParts.push(new THREE.CylinderGeometry(1.0, 0.7, 0.8, 12).translate(0, 0.9, -26));
    glowParts.push(new THREE.CylinderGeometry(0.85, 0.85, 0.05, 12).translate(0, 1.32, -26));
    colliders.addCircle(0, -26, 1.4, 0, 1.4);
    const m1 = new THREE.Mesh(mergeGeometries(stoneParts.map((g) => g.toNonIndexed()), false)!, MAT.stone);
    m1.castShadow = true; m1.receiveShadow = true;
    const m2 = new THREE.Mesh(mergeGeometries(glowParts.map((g) => g.toNonIndexed()), false)!, MAT.glow);
    group.add(m1, m2);

  }

  dressCompound(group, colliders, templeHeight);

  // ---- The wider settlement: houses with curved hip roofs on the slopes outside the walls (beyond reach) ----
  {
    const roofs: THREE.BufferGeometry[] = [], walls: THREE.BufferGeometry[] = [], timber: THREE.BufferGeometry[] = [];
    const hipGeo = (W: number, D: number, H: number) => {
      const g = new THREE.PlaneGeometry(W, D, 10, 8).rotateX(-Math.PI / 2);
      const p = g.getAttribute('position') as THREE.BufferAttribute;
      const k = Math.min(W, D) / Math.max(W, D);
      for (let i = 0; i < p.count; i++) {
        const u = Math.abs(p.getX(i)) / (W / 2), v = Math.abs(p.getZ(i)) / (D / 2);
        const f = W >= D ? Math.min(1 - v, (1 - u) / k) : Math.min(1 - u, (1 - v) / k);
        p.setY(i, Math.pow(Math.max(0, f), 1.45) * H + Math.pow(u * v, 3) * H * 0.25);
      }
      return g;
    };
    for (let i = 0; i < 270; i++) {
      // Clustered hamlets rather than an even scatter.
      const hub = Math.floor(rnd() * 9), ha = hub * 0.7 + 0.3, hr = 110 + (hub % 4) * 70;
      const a = ha + (rnd() - 0.5) * 0.45, r = hr + (rnd() - 0.5) * 70;
      const x = Math.cos(a) * r * 1.2, z = -20 + Math.sin(a) * r;
      if (z > 70 && Math.abs(x) < 30) continue; // keep the approach open
      const y = templeHeight(x, z) - 0.3;
      const w = 6 + rnd() * 9, d = 5 + rnd() * 5, h = 2.6 + rnd() * 1.6, rot = Math.round(a / (Math.PI / 2)) * (Math.PI / 2) + (rnd() - 0.5) * 0.3;
      const m = new THREE.Matrix4().makeRotationY(rot).setPosition(x, y, z);
      walls.push(new THREE.BoxGeometry(w, h, d).translate(0, h / 2, 0).applyMatrix4(m).toNonIndexed());
      timber.push(new THREE.BoxGeometry(w + 0.1, 0.9, d + 0.1).translate(0, 0.45, 0).applyMatrix4(m).toNonIndexed());
      roofs.push(hipGeo(w + 2.4, d + 2.4, 2.2 + rnd() * 1.4).translate(0, h, 0).applyMatrix4(m).toNonIndexed());
      if (rnd() < 0.2) roofs.push(hipGeo(w * 0.6, d * 0.6, 1.8).translate(0, h + 2.2, 0).applyMatrix4(m).toNonIndexed());
    }
    const mk = (list: THREE.BufferGeometry[], mat: THREE.Material) => {
      const g = mergeGeometries(list, false)!; g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, mat); mesh.receiveShadow = true; mesh.castShadow = true; group.add(mesh);
    };
    mk(walls, MAT.plaster); mk(timber, MAT.timber); mk(roofs, MAT.roof);
  }

  // ---- A hilltop temple with a two-storey tower, visible beyond the compound ----
  for (const [hx, hz, rot] of [[-150, -210, 0.4], [190, -120, -0.6]] as const) {
    const hy = templeHeight(hx, hz);
    const t = buildBuilding({ name: 'hill-temple', x: hx, z: hz, rot, w: 16, d: 11, base: 1.2, wallH: 4.6, veranda: 1.6, walls: 'timber', balcony: true,
      roof: { kind: 'hip2', height: 6.5, overhang: 1.8 }, front: [{ at: 0, width: 3, screen: 'closed' }] }, colliders, hy);
    group.add(t.group);
  }

  // ---- Golden ginkgo trees placed to frame the architecture (rendered by the shared tree system) ----
  const treeSpots: THREE.Matrix4[] = [];
  const treeGold: boolean[] = [];
  const tree = (x: number, z: number, s: number) => {
    treeSpots.push(new THREE.Matrix4().compose(new THREE.Vector3(x, templeHeight(x, z) - 0.2, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6), new THREE.Vector3(s, s, s)));
    colliders.addCircle(x, z, 0.6 * s * 0.4, 0, 6);
    treeGold.push(Math.abs(x) < 70 && z > -100 && z < 60 ? true : rnd() < 0.35);
  };
  for (const [x, z, s] of [[-24, -34, 5.2], [24, -36, 5.0], [-26, 40, 4.6], [28, 38, 4.8], [16, -78, 5.4], [-14, -84, 4.8], [-48, -66, 5], [50, -56, 4.6], [-50, 44, 4.4], [52, 40, 4.6], [-27, 6, 4.2], [-56, -46, 4.8], [56, 2, 4.6], [-20, -66, 4.4], [46, -82, 4.8], [-58, 36, 4.2]] as const) tree(x, z, s);
  for (let i = 0; i < 320; i++) {
    const a = rnd() * Math.PI * 2, r = 80 + rnd() * 320;
    const x = Math.cos(a) * r * 1.2, z = -20 + Math.sin(a) * r;
    if (z > 60 && Math.abs(x) < 25) continue;
    tree(x, z, 3 + rnd() * 1.6);
  }

  const treePos = treeSpots.map((m) => new THREE.Vector3().setFromMatrixPosition(m)).filter((p) => Math.abs(p.x) < 70 && p.z > -100 && p.z < 60);
  group.add(leafLitter(treePos, templeHeight, { minX: -62, maxX: 62, minZ: -90, maxZ: 50 }, quality === 'high' ? 90000 : 35000));
  // Dense carpets: under every tree inside the walls, at the foot of the hall stairs, along the corridor
  // fronts and banked around the gate; paving stays visible between them.
  const carpetSpots = [
    ...treePos.filter((p) => Math.abs(p.x) < 64 && p.z > -92 && p.z < 52).map((p) => ({ x: p.x, z: p.z, r: 11 })),
    { x: 0, z: -37, r: 9 }, { x: -12, z: -34, r: 6 }, { x: 13, z: -33, r: 6 },
    { x: -34, z: -18, r: 7 }, { x: -34, z: 14, r: 6 }, { x: 34, z: -4, r: 7 }, { x: 34, z: 26, r: 6 },
    { x: -10, z: 42, r: 6 }, { x: 9, z: 41, r: 6 }, { x: -20, z: 8, r: 5 }, { x: 18, z: -12, r: 5 },
  ];
  group.add(leafCarpets(carpetSpots, templeHeight));
  const falling = new FallingLeaves(quality === 'high' ? 260 : 120);
  group.add(falling.mesh);
  // Noren curtains in the doorways of the lived-in houses.
  noren(group, -54 + 4.6 + 0.02, 0.45 + 2.25, 20 + 2.5, Math.PI / 2, 2);
  noren(group, 54 - 4.5 - 0.02, 0.4 + 2.25, -22 + 3.5, -Math.PI / 2, 2.4);

  return {
    group, buildings, treeSpots, treeGold, falling,
    start: TEMPLE.start,
    startYaw: 0,
    update(cam, player) {
      // Roof cut-away for the building the player is in; interior detail and lights only near the camera.
      let lit = 0;
      for (const bl of buildings) {
        const inside = bl.contains(player.x, player.z, 0.4);
        bl.roof.visible = !inside;
        const dist = Math.hypot(cam.x - bl.centre.x, cam.z - bl.centre.z);
        bl.detail.visible = dist < 70;
        if (bl.light) {
          const on = (inside || dist < 18) && lit < 3;
          bl.light.visible = on;
          bl.light.intensity = on ? 22 : 0;
          if (on) lit++;
        }
      }
    },
  };
}
