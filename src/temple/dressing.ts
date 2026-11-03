import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32, fbm } from '../core/noise';
import type { Colliders } from '../world/colliders';
import { MAT } from './kit';

/** A ginkgo leaf (fan-shaped) drawn into a canvas, used for litter and falling leaves. */
function leafTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.translate(32, 54);
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(0, 0);
  g.bezierCurveTo(-30, -14, -28, -44, -6, -46);
  g.quadraticCurveTo(0, -40, 6, -46);
  g.bezierCurveTo(28, -44, 30, -14, 0, 0);
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.18)';
  g.lineWidth = 1;
  for (let a = -0.9; a <= 0.9; a += 0.18) { g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.sin(a) * 40, -Math.cos(a) * 42); g.stroke(); }
  g.fillRect(-1, 0, 2, 9);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const LEAF_COLS = [new THREE.Color(0.95, 0.66, 0.08), new THREE.Color(0.98, 0.76, 0.14), new THREE.Color(0.85, 0.5, 0.06), new THREE.Color(0.7, 0.42, 0.08), new THREE.Color(1.0, 0.82, 0.25)];

/**
 * Ginkgo leaf litter: dense drifts under the trees, banked against walls and buildings, and a lighter
 * scatter across the courtyard. One instanced draw.
 */
export function leafLitter(trees: THREE.Vector3[], height: (x: number, z: number) => number, area: { minX: number; maxX: number; minZ: number; maxZ: number }, count: number) {
  const tex = leafTexture();
  const mat = new THREE.MeshStandardMaterial({ map: tex, alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.85 });
  const geo = new THREE.PlaneGeometry(0.22, 0.22).rotateX(-Math.PI / 2);
  const mesh = new THREE.InstancedMesh(geo, mat, count);
  const rnd = mulberry32(123);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
  let n = 0;
  while (n < count) {
    let x: number, z: number;
    const r = rnd();
    if (r < 0.55 && trees.length) {
      // Under a canopy, densest near the trunk.
      const t = trees[Math.floor(rnd() * trees.length)];
      const a = rnd() * Math.PI * 2, d = Math.pow(rnd(), 0.7) * 13;
      x = t.x + Math.cos(a) * d; z = t.z + Math.sin(a) * d;
    } else {
      x = area.minX + rnd() * (area.maxX - area.minX); z = area.minZ + rnd() * (area.maxZ - area.minZ);
      // Wind-blown drifts: keep leaves where a drift field is high.
      if (fbm(x * 0.06, z * 0.06, 3) < -0.25 + rnd() * 0.3) continue;
    }
    // Rest on top of the flagstones (slab tops sit ~0.1 m above the ground).
    p.set(x, height(x, z) + 0.125 + rnd() * 0.02, z);
    e.set((rnd() - 0.5) * 0.4, rnd() * Math.PI * 2, (rnd() - 0.5) * 0.4);
    const k = 0.7 + rnd() * 0.7;
    m.compose(p, q.setFromEuler(e), s.set(k, 1, k));
    mesh.setMatrixAt(n, m);
    mesh.setColorAt(n, LEAF_COLS[Math.floor(rnd() * LEAF_COLS.length)]);
    n++;
  }
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}

/** Leaves spiralling down around the player from above. */
export class FallingLeaves {
  readonly mesh: THREE.InstancedMesh;
  private data: { x: number; y: number; z: number; vy: number; ph: number; spin: number }[] = [];
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private e = new THREE.Euler(); private p = new THREE.Vector3(); private s = new THREE.Vector3(1, 1, 1);
  constructor(count = 220) {
    const mat = new THREE.MeshStandardMaterial({ map: leafTexture(), alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.8 });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(0.15, 0.15), mat, count);
    this.mesh.frustumCulled = false;
    const rnd = mulberry32(9);
    for (let i = 0; i < count; i++) {
      this.data.push({ x: rnd() * 60 - 30, y: rnd() * 14, z: rnd() * 60 - 30, vy: 0.5 + rnd() * 0.6, ph: rnd() * 10, spin: 1 + rnd() * 3 });
      this.mesh.setColorAt(i, LEAF_COLS[i % LEAF_COLS.length]);
    }
  }
  update(dt: number, t: number, centre: THREE.Vector3, ground: (x: number, z: number) => number) {
    this.data.forEach((l, i) => {
      l.y -= l.vy * dt;
      l.x += (Math.sin(t * 0.8 + l.ph) * 0.6 + 0.5) * dt;
      l.z += Math.cos(t * 0.6 + l.ph * 1.3) * 0.4 * dt;
      if (l.x - centre.x > 30) l.x -= 60; else if (l.x - centre.x < -30) l.x += 60;
      if (l.z - centre.z > 30) l.z -= 60; else if (l.z - centre.z < -30) l.z += 60;
      const gy = ground(l.x, l.z);
      if (l.y < gy + 0.05) l.y = gy + 10 + (l.ph % 1) * 6;
      this.e.set(t * l.spin + l.ph, t * 0.7 + l.ph, Math.sin(t * l.spin) * 0.8);
      this.mesh.setMatrixAt(i, this.m.compose(this.p.set(l.x, l.y, l.z), this.q.setFromEuler(this.e), this.s));
    });
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** Indigo banner cloth with a white circular crest, drawn into a canvas. */
function bannerTexture(variant: number) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 192;
  const g = c.getContext('2d')!;
  g.fillStyle = ['#1f2a3a', '#e8e0cc', '#3a1c16'][variant % 3];
  g.fillRect(0, 0, 64, 192);
  g.fillStyle = variant % 3 === 1 ? '#1f2a3a' : '#e8e0cc';
  g.beginPath(); g.arc(32, 60, 22, 0, Math.PI * 2); g.fill();
  g.fillStyle = ['#1f2a3a', '#e8e0cc', '#3a1c16'][variant % 3];
  g.beginPath(); g.arc(32, 60, 15, 0, Math.PI * 2); g.fill();
  g.fillStyle = variant % 3 === 1 ? '#1f2a3a' : '#e8e0cc';
  for (let k = 0; k < 3; k++) { g.beginPath(); g.ellipse(32 + Math.cos(k * 2.09) * 7, 60 + Math.sin(k * 2.09) * 7, 6, 3.5, k * 2.09, 0, Math.PI * 2); g.fill(); }
  for (let y = 100; y < 180; y += 16) g.fillRect(28, y, 8, 9);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** Props and dressing for the courtyard and around the buildings. */
export function dressCompound(group: THREE.Group, colliders: Colliders, height: (x: number, z: number) => number) {
  const rnd = mulberry32(2024);
  const lists = new Map<THREE.Material, THREE.BufferGeometry[]>();
  const push = (mat: THREE.Material, g: THREE.BufferGeometry) => { (lists.get(mat) ?? lists.set(mat, []).get(mat)!).push(g.index ? g.toNonIndexed() : g); };
  const at = (g: THREE.BufferGeometry, x: number, z: number, y = 0, ry = 0) => g.rotateY(ry).translate(x, height(x, z) + y, z);

  // Banners on tall poles with cross-bars: hall stairs, gate, corridor ends.
  const bannerMats = [0, 1, 2].map((v) => new THREE.MeshStandardMaterial({ map: bannerTexture(v), side: THREE.DoubleSide, roughness: 1 }));
  for (const [x, z, v] of [[-8.5, -36, 0], [8.5, -36, 0], [-4.8, 45, 2], [4.8, 45, 2], [-33, -30, 1], [33, -30, 1], [-33, 34, 0], [33, 34, 0]] as const) {
    push(MAT.timber, at(new THREE.CylinderGeometry(0.07, 0.08, 6.8, 6), x, z, 3.4));
    push(MAT.timber, at(new THREE.BoxGeometry(1.3, 0.06, 0.06), x + 0.6, z, 6.3));
    const cloth = new THREE.PlaneGeometry(1.1, 3.4, 1, 8);
    const cp = cloth.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < cp.count; i++) cp.setZ(i, Math.sin((cp.getY(i) + 1.7) * 2.2) * 0.06);
    cloth.computeVertexNormals();
    const mesh = new THREE.Mesh(at(cloth, x + 0.62, z, 4.55), bannerMats[v]);
    mesh.castShadow = true;
    group.add(mesh);
    colliders.addCircle(x, z, 0.2, 0, 6);
  }

  // Handcarts.
  for (const [x, z, ry] of [[-28, 30, 0.6], [27, -14, -1.2], [-48, 2, 1.7]] as const) {
    const g: THREE.BufferGeometry[] = [];
    g.push(new THREE.BoxGeometry(1.4, 0.12, 2.4).translate(0, 0.75, 0));
    for (const s of [-1, 1]) g.push(new THREE.BoxGeometry(0.08, 0.35, 2.4).translate(s * 0.68, 0.95, 0));
    for (const s of [-1, 1]) g.push(new THREE.BoxGeometry(0.09, 0.09, 1.8).translate(s * 0.5, 0.7, 2.0));
    const body = mergeGeometries(g.map((x) => x.toNonIndexed()), false)!;
    body.rotateY(ry).translate(x, height(x, z), z);
    push(MAT.floor, body);
    for (const s of [-1, 1]) {
      const wheel = new THREE.CylinderGeometry(0.62, 0.62, 0.1, 16).rotateZ(Math.PI / 2).translate(s * 0.85, 0.62, -0.3);
      push(MAT.timber, wheel.rotateY(ry).translate(x, height(x, z), z));
    }
    for (let k = 0; k < 3; k++) push(MAT.lacquer, at(new THREE.CylinderGeometry(0.22, 0.25, 0.4, 10).translate((k - 1) * 0.42, 1.0, 0.3), x, z, 0, ry));
    colliders.addBox(x, z, 1.6, 2.8, -ry, 0, 1.3);
  }

  // Stacked sake barrels, crates, pottery and firewood by the corridors, kitchen and houses.
  const barrel = () => { const g = new THREE.CylinderGeometry(0.4, 0.4, 0.85, 14); return g; };
  const pot = () => new THREE.LatheGeometry([0, 0.18, 0.3, 0.34, 0.3, 0.2, 0.18, 0.22].map((r, i) => new THREE.Vector2(r, i * 0.09)), 12);
  const clusters: [number, number][] = [[-35, -10], [35, 8], [-35, 20], [35, -24], [-46, -32], [47, -10], [46, 30], [-46, 12], [-12, 46], [12, 46]];
  for (const [cx, cz] of clusters) {
    const n = 3 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const x = cx + (rnd() - 0.5) * 2.4, z = cz + (rnd() - 0.5) * 2.4, k = rnd();
      if (k < 0.4) { push(MAT.timber, at(barrel(), x, z, 0.43)); if (rnd() < 0.4) push(MAT.timber, at(barrel(), x, z, 1.28)); }
      else if (k < 0.7) push(MAT.lacquer, at(pot(), x, z, 0, rnd() * 3));
      else push(MAT.floor, at(new THREE.BoxGeometry(0.8, 0.6, 0.8), x, z, 0.3, rnd() * 3));
      colliders.addCircle(x, z, 0.42, 0, 1.6);
    }
  }
  for (const [x, z, ry] of [[-50, -14, 0], [50, -30, 1.57], [-48, 26, 0]] as const) {
    for (let r = 0; r < 4; r++) for (let c = 0; c < 6; c++) push(MAT.timber, at(new THREE.CylinderGeometry(0.09, 0.09, 1.1, 6).rotateX(Math.PI / 2).translate((c - 2.5) * 0.2 + (r % 2) * 0.1, 0.1 + r * 0.17, 0), x, z, 0, ry));
    colliders.addBox(x, z, 1.4, 1.2, -ry, 0, 0.8);
  }

  // Hanging paper lanterns under the eaves of the hall and along the corridors.
  const lanternGeo = () => new THREE.LatheGeometry([0.02, 0.16, 0.24, 0.27, 0.24, 0.16, 0.02].map((r, i) => new THREE.Vector2(r, i * 0.1)), 12);
  const hang = (x: number, y: number, z: number) => {
    push(MAT.glow, lanternGeo().translate(x, y - 0.6, z));
    push(MAT.timber, new THREE.CylinderGeometry(0.012, 0.012, 0.5, 4).translate(x, y - 0.05, z));
  };
  for (let x = -15; x <= 15; x += 5) hang(x, 1.9 + 5.2 + 0.3, -50 + 9 + 2.4);
  for (const side of [-1, 1]) for (let z = -32; z <= 36; z += 8) hang(side * 37.6, 0.5 + 3.4, z);
  for (const [x, z] of [[-3.2, 47.4], [3.2, 47.4], [-3.2, 54.6], [3.2, 54.6]] as const) hang(x, 0.3 + 5.2, z);

  for (const [mat, list] of lists) {
    const g = mergeGeometries(list, false)!;
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = mat !== MAT.glow;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
}

/** Noren: split cloth curtains hung in a doorway (world position, facing yaw). */
export function noren(group: THREE.Group, x: number, y: number, z: number, yaw: number, width = 1.6) {
  const mat = new THREE.MeshStandardMaterial({ map: bannerTexture(0), side: THREE.DoubleSide, roughness: 1 });
  const parts: THREE.BufferGeometry[] = [];
  const n = 3;
  for (let i = 0; i < n; i++) {
    const w = width / n - 0.03;
    const g = new THREE.PlaneGeometry(w, 0.75, 1, 3).translate(-width / 2 + (i + 0.5) * (width / n), -0.38, 0);
    parts.push(g);
  }
  const g = mergeGeometries(parts, false)!;
  const mesh = new THREE.Mesh(g, mat);
  mesh.position.set(x, y, z);
  mesh.rotation.y = yaw;
  group.add(mesh);
}

/** A dense mat of overlapping ginkgo leaves with ragged, blotchy edges, drawn into a canvas. */
function carpetTexture(seed: number) {
  const S = 512;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(seed);
  const cols = ['#e8a417', '#f2bd2a', '#d68a12', '#b9700f', '#f7cf4a', '#c98a1c'];
  const leaf = (x: number, y: number, r: number, a: number) => {
    g.save(); g.translate(x, y); g.rotate(a); g.scale(r / 46, r / 46);
    g.beginPath(); g.moveTo(0, 0); g.bezierCurveTo(-30, -14, -28, -44, -6, -46); g.quadraticCurveTo(0, -40, 6, -46); g.bezierCurveTo(28, -44, 30, -14, 0, 0); g.fill();
    g.restore();
  };
  for (let i = 0; i < 2600; i++) {
    const x = rnd() * S, y = rnd() * S;
    // Density falls off toward a blotchy edge so patches blend into the paving.
    const dx = (x - S / 2) / (S / 2), dy = (y - S / 2) / (S / 2);
    const edge = Math.hypot(dx, dy) + (Math.sin(x * 0.03 + seed) + Math.cos(y * 0.027 - seed)) * 0.18;
    if (edge > 0.95 || rnd() < edge * edge * 0.9) continue;
    g.fillStyle = cols[Math.floor(rnd() * cols.length)];
    g.globalAlpha = 1;
    leaf(x, y, 9 + rnd() * 10, rnd() * Math.PI * 2);
    if (rnd() < 0.25) { g.fillStyle = 'rgba(60,35,10,0.35)'; leaf(x + 2, y + 2, 8 + rnd() * 6, rnd() * 6); }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** Irregular leaf-carpet patches laid on the ground at drift points (around trees, stairs and walls). */
export function leafCarpets(spots: { x: number; z: number; r: number }[], height: (x: number, z: number) => number) {
  const group = new THREE.Group();
  const mats = [1, 2, 3].map((s) => new THREE.MeshStandardMaterial({ map: carpetTexture(s), alphaTest: 0.45, roughness: 0.88 }));
  const rnd = mulberry32(77);
  const lists: THREE.BufferGeometry[][] = [[], [], []];
  for (const sp of spots) {
    const n = 2 + Math.floor(rnd() * 3);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, d = rnd() * sp.r * 0.6;
      const x = sp.x + Math.cos(a) * d, z = sp.z + Math.sin(a) * d;
      const s = sp.r * (0.55 + rnd() * 0.6);
      const g = new THREE.PlaneGeometry(s * (0.8 + rnd() * 0.5), s, 1, 1).rotateX(-Math.PI / 2).rotateY(rnd() * Math.PI * 2);
      g.translate(x, height(x, z) + 0.135 + i * 0.004, z);
      lists[Math.floor(rnd() * 3)].push(g);
    }
  }
  lists.forEach((l, k) => {
    if (!l.length) return;
    const m = new THREE.Mesh(mergeGeometries(l, false)!, mats[k]);
    m.receiveShadow = true;
    group.add(m);
  });
  return group;
}
