import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { fbm, mulberry32, smoothstep } from '../core/noise';
import { n3, block, stoneMaterial } from './stone';
import { COLOSSUS_POS, terrainHeight, PLAY, SITES, POOL } from './heightfield';
import type { Colliders } from './colliders';
import type { TextureSet } from '../core/assets';

/**
 * The Colossus: an original, procedurally-sculpted ancient creature of stone hide, root sinew and
 * moss, resting on four pillar-like limbs. Built from displaced ellipsoids and swept tubes, then
 * dressed with carapace plates, hanging roots and a small forest on its back.
 *
 * Only authored idle motion here (breathing, slow head drift, eye glow); no simulation.
 */
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

interface Ellipsoid { c: THREE.Vector3; r: THREE.Vector3 }

export class Colossus {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly head = new THREE.Group();
  /** World-space spots on its back where trees grow (consumed by the vegetation impostor layer). */
  readonly backTreeSpots: THREE.Matrix4[] = [];
  private eyeMat: THREE.MeshStandardMaterial;
  private rnd = mulberry32(911);
  private skin: THREE.BufferGeometry[] = [];
  private plates: THREE.BufferGeometry[] = [];
  private roots: THREE.BufferGeometry[] = [];
  private headSkin: THREE.BufferGeometry[] = [];
  private headRoots: THREE.BufferGeometry[] = [];
  private legSkin: THREE.BufferGeometry[] = [];
  private legRoots: THREE.BufferGeometry[] = [];
  private torsoParts: Ellipsoid[] = [];
  readonly headPivot = V(0, 150, 95);
  private rootMat!: THREE.Material;

  constructor(tex: Record<string, TextureSet>) {
    const gy = terrainHeight(COLOSSUS_POS.x, COLOSSUS_POS.z);
    this.root.position.set(COLOSSUS_POS.x, gy - 3, COLOSSUS_POS.z);
    this.root.rotation.y = -0.38;
    this.root.scale.setScalar(1.2);
    this.root.add(this.body);
    this.body.add(this.head);
    this.head.position.copy(this.headPivot);

    this.sculptBody();
    this.sculptHead();
    this.sculptLegs();
    this.dressPlates();
    this.dressRoots();

    const skinMat = stoneMaterial(tex.rock030, tex.ground037, { scale: 0.05, key: 'col-skin', mossAmount: 1.1, tint: new THREE.Color(0.5, 0.49, 0.46) });
    const plateMat = stoneMaterial(tex.rock051, tex.ground037, { scale: 0.035, key: 'col-plate', mossAmount: 0.95, tint: new THREE.Color(0.46, 0.45, 0.42) });
    const rootMat = stoneMaterial(tex.bark014, tex.ground037, { scale: 0.22, key: 'col-root', mossAmount: 0.6, tint: new THREE.Color(0.32, 0.29, 0.25) });
    for (const m of [skinMat, plateMat, rootMat]) m.defines = { HAS_AO_ATTR: '' };

    const add = (parent: THREE.Object3D, list: THREE.BufferGeometry[], mat: THREE.Material) => {
      if (!list.length) return;
      const g = mergeGeometries(list, false)!;
      bakeAO(g);
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, mat);
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      parent.add(mesh);
    };
    add(this.body, this.skin, skinMat);
    add(this.body, this.plates, plateMat);
    add(this.body, this.roots, rootMat);
    add(this.root, this.legSkin, skinMat);
    add(this.root, this.legRoots, rootMat);
    add(this.head, this.headSkin, skinMat);
    add(this.head, this.headRoots, rootMat);
    this.rootMat = rootMat;

    // Eyes: deep-set, faintly glowing amber embers. Subtle, they should read as "alive", not as lamps.
    this.eyeMat = new THREE.MeshStandardMaterial({ color: 0x1a1208, emissive: new THREE.Color(1.0, 0.62, 0.28), emissiveIntensity: 2.2, roughness: 0.4 });
    for (const s of [-1, 1]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(3.2, 16, 12), this.eyeMat);
      eye.scale.set(1, 0.55, 0.8);
      eye.position.set(s * 16, 177 - this.headPivot.y, 205 - this.headPivot.z);
      this.head.add(eye);
    }

    this.root.updateMatrixWorld(true);
    this.collectBackTrees();
  }

  // ---------- sculpting helpers ----------

  private ellipsoid(e: Ellipsoid, detail: number, amp: number, seed: number, shape?: (p: THREE.Vector3, n: THREE.Vector3) => void) {
    const g = new THREE.IcosahedronGeometry(1, detail);
    const p = g.getAttribute('position') as THREE.BufferAttribute;
    const v = V(0, 0, 0), n = V(0, 0, 0);
    for (let i = 0; i < p.count; i++) {
      n.fromBufferAttribute(p, i).normalize();
      v.set(n.x * e.r.x, n.y * e.r.y, n.z * e.r.z).add(e.c);
      shape?.(v, n);
      const w = displacement(v, seed) * amp;
      v.addScaledVector(n, w);
      p.setXYZ(i, v.x, v.y, v.z);
    }
    return finish(g);
  }

  /** Swept tube along a smooth curve with a radius profile; capped with spheres. */
  private limb(points: THREE.Vector3[], radii: number[], amp: number, seed: number, radial = 20) {
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    const len = curve.getLength();
    const segs = Math.max(8, Math.ceil(len / 3));
    const frames = curve.computeFrenetFrames(segs, false);
    const pos: number[] = [];
    const idx: number[] = [];
    const radiusAt = (t: number) => {
      const f = t * (radii.length - 1);
      const i = Math.min(radii.length - 2, Math.floor(f));
      return THREE.MathUtils.lerp(radii[i], radii[i + 1], f - i);
    };
    const pt = V(0, 0, 0), d = V(0, 0, 0);
    for (let s = 0; s <= segs; s++) {
      const t = s / segs;
      curve.getPointAt(t, pt);
      const r = radiusAt(t);
      for (let k = 0; k <= radial; k++) {
        const a = (k / radial) * Math.PI * 2;
        d.copy(frames.normals[s]).multiplyScalar(Math.cos(a)).addScaledVector(frames.binormals[s], Math.sin(a));
        const q = pt.clone().addScaledVector(d, r);
        q.addScaledVector(d, displacement(q, seed) * amp * Math.min(1, r / 10));
        pos.push(q.x, q.y, q.z);
      }
    }
    for (let s = 0; s < segs; s++) for (let k = 0; k < radial; k++) {
      const a = s * (radial + 1) + k, b = a + radial + 1;
      idx.push(a, b, a + 1, a + 1, b, b + 1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    const parts = [g, ...[0, 1].map((e) => {
      const c = curve.getPointAt(e);
      return new THREE.IcosahedronGeometry(radiusAt(e) * 0.98, 3).translate(c.x, c.y, c.z);
    })].map((x) => {
      for (const k of Object.keys(x.attributes)) if (k !== 'position') x.deleteAttribute(k);
      return x.index ? x.toNonIndexed() : x;
    });
    const merged = mergeGeometries(parts, false)!;
    return finish(merged);
  }

  // ---------- anatomy ----------

  private sculptBody() {
    const torso: Ellipsoid = { c: V(0, 120, -45), r: V(62, 50, 108) };
    const chest: Ellipsoid = { c: V(0, 128, 42), r: V(78, 62, 60) };
    const hips: Ellipsoid = { c: V(0, 112, -128), r: V(60, 47, 52) };
    const belly: Ellipsoid = { c: V(0, 96, -30), r: V(52, 32, 82) };
    this.torsoParts.push(torso, chest, hips);
    // A spine hump: raise the top-centre of the torso into a ridge.
    const hump = (p: THREE.Vector3, n: THREE.Vector3) => {
      const k = Math.max(0, n.y) ** 2 * Math.exp(-((p.x / 22) ** 2));
      p.y += k * 14;
    };
    this.skin.push(this.ellipsoid(torso, 40, 6, 1, hump));
    this.skin.push(this.ellipsoid(chest, 36, 6, 2, hump));
    this.skin.push(this.ellipsoid(hips, 30, 5, 3, hump));
    this.skin.push(this.ellipsoid(belly, 26, 4, 4));
    // Neck, rising from between the shoulders.
    this.skin.push(this.limb([V(0, 128, 52), V(0, 142, 84), V(0, 154, 118), V(0, 162, 150)], [44, 36, 30, 27], 4, 5, 26));
    // Tail of stone and root, trailing back onto the ground.
    this.skin.push(this.limb([V(0, 115, -165), V(0, 92, -228), V(14, 52, -285), V(40, 18, -330), V(70, 6, -360)], [34, 26, 17, 10, 6], 3, 6, 22));
  }

  private sculptHead() {
    const hp = this.headPivot;
    const loc = (x: number, y: number, z: number) => V(x - hp.x, y - hp.y, z - hp.z);
    // Long, heavy skull with a brow shelf and lowered jaw; reads as a creature at a glance.
    this.headSkin.push(this.ellipsoid({ c: loc(0, 168, 182), r: V(27, 24, 38) }, 26, 3, 10, (p, n) => {
      // Flatten the crown slightly and push the snout forward.
      if (n.z > 0.3) p.z += (n.z - 0.3) * 10;
    }));
    this.headSkin.push(this.ellipsoid({ c: loc(0, 183, 197), r: V(31, 9, 19) }, 18, 2, 11));
    this.headSkin.push(this.ellipsoid({ c: loc(0, 152, 190), r: V(20, 10, 30) }, 18, 2, 12));
    this.headSkin.push(this.ellipsoid({ c: loc(0, 160, 218), r: V(15, 13, 12) }, 16, 1.5, 13));
    // Antler-like crown of roots sweeping back from the skull.
    for (const s of [-1, 1]) {
      this.headRoots.push(this.limb([loc(s * 14, 186, 178), loc(s * 26, 204, 156), loc(s * 34, 214, 120), loc(s * 30, 210, 92)], [5.5, 4, 2.6, 1.2], 1.2, 20 + s, 12));
      this.headRoots.push(this.limb([loc(s * 22, 180, 170), loc(s * 40, 190, 158), loc(s * 54, 186, 140)], [3.5, 2.4, 1.0], 0.8, 24 + s, 10));
      this.headRoots.push(this.limb([loc(s * 8, 190, 172), loc(s * 12, 210, 150), loc(s * 10, 222, 128)], [3.8, 2.6, 1.0], 0.8, 28 + s, 10));
    }
    // Plates along the top of the skull and neck.
    for (let i = 0; i < 9; i++) {
      const z = 186 - i * 11;
      const p = loc(this.r(-4, 4), 190 - i * 2.8 + (i > 4 ? -6 : 0), z);
      const g = block(this.r(16, 24), this.r(4, 6), this.r(11, 15), { seed: 800 + i, erosion: 1.0, segSize: 2.5 });
      g.rotateX(this.r(-0.25, -0.1)).rotateY(this.r(-0.2, 0.2)).translate(p.x, p.y, p.z);
      this.headSkin.push(g);
    }
  }

  private sculptLegs() {
    for (const s of [-1, 1]) {
      // Fore limbs: massive pillars, slightly splayed, with a forward elbow.
      this.legSkin.push(this.limb([V(s * 60, 128, 52), V(s * 74, 92, 70), V(s * 76, 60, 80), V(s * 72, 30, 100), V(s * 70, 8, 112)], [36, 30, 25, 21, 19], 4, 30 + s, 24));
      this.legSkin.push(this.ellipsoid({ c: V(s * 70, 7, 124), r: V(24, 10, 30) }, 16, 2.5, 34 + s));
      for (let f = 0; f < 4; f++) {
        const fx = s * 70 + (f - 1.5) * 11;
        this.legSkin.push(this.limb([V(fx, 8, 138), V(fx + (f - 1.5) * 3, 5, 152), V(fx + (f - 1.5) * 5, 1, 160)], [6, 4.5, 2.6], 0.8, 40 + f + s, 10));
      }
      // Hind limbs.
      this.legSkin.push(this.limb([V(s * 50, 118, -128), V(s * 66, 82, -100), V(s * 68, 62, -112), V(s * 66, 32, -148), V(s * 64, 8, -142)], [38, 30, 23, 19, 17], 4, 50 + s, 24));
      this.legSkin.push(this.ellipsoid({ c: V(s * 64, 7, -128), r: V(21, 9, 28) }, 16, 2, 54 + s));
      // Root sinews running down each limb with a gentle quarter twist.
      for (let k = 0; k < 5; k++) {
        const pts: THREE.Vector3[] = [];
        const fore = k < 3;
        const a0 = (k / (fore ? 3 : 2)) * Math.PI * 2 + s;
        for (let i = 0; i <= 6; i++) {
          const t = i / 6;
          const base = fore ? V(s * (62 + 10 * t), 122 - t * 116, 56 + t * 58) : V(s * (52 + 12 * t), 112 - t * 106, -126 - t * 14);
          const rr = (fore ? 24 : 27) * (1 - t * 0.35) + 1.5;
          const a = a0 + t * 1.3;
          pts.push(base.add(V(Math.cos(a) * rr, 0, Math.sin(a) * rr)));
        }
        this.legRoots.push(this.limb(pts, [4.2, 3.2, 2.6, 3.4], 0.8, 60 + k + s, 10));
      }
    }
  }

  /** Carapace plates follow the upper body surface. */
  private dressPlates() {
    const surf = (e: Ellipsoid, n: THREE.Vector3) => V(n.x * e.r.x, n.y * e.r.y, n.z * e.r.z).add(e.c);
    const normalOn = (e: Ellipsoid, n: THREE.Vector3) => V(n.x / e.r.x, n.y / e.r.y, n.z / e.r.z).normalize();
    const up = V(0, 1, 0);
    const placePlate = (pos: THREE.Vector3, nrm: THREE.Vector3, w: number, t: number, d: number, seed: number, yaw: number) => {
      const g = block(w, t, d, { seed, erosion: Math.min(w, d) * 0.05, round: t * 0.4, segSize: 3 });
      const q = new THREE.Quaternion().setFromUnitVectors(up, nrm);
      const qy = new THREE.Quaternion().setFromAxisAngle(up, yaw);
      g.applyQuaternion(qy).applyQuaternion(q).translate(pos.x, pos.y, pos.z);
      this.plates.push(g);
    };
    let seed = 1000;
    for (const e of this.torsoParts) {
      const count = Math.round((e.r.x * e.r.z) / 180);
      for (let i = 0; i < count; i++) {
        // Sample the upper/side region of each ellipsoid.
        const a = this.r(0, Math.PI * 2);
        const el = this.r(-0.15, 1.0);
        const n = V(Math.cos(a) * Math.sqrt(1 - el * el), el, Math.sin(a) * Math.sqrt(1 - el * el));
        const p = surf(e, n);
        const nn = normalOn(e, n);
        p.addScaledVector(nn, this.r(2, 5));
        const s = this.r(16, 30) * (0.7 + 0.3 * el);
        placePlate(p, nn, s * this.r(0.9, 1.4), this.r(3, 6), s, seed++, Math.atan2(nn.x, nn.z) + this.r(-0.4, 0.4));
      }
    }
    // Spine ridge: tall, overlapping blades from neck to tail.
    for (let i = 0; i < 18; i++) {
      const t = i / 17;
      const z = 90 - t * 270;
      const y = 186 - Math.abs(t - 0.35) * 70 - (t > 0.85 ? (t - 0.85) * 160 : 0);
      const h = 26 - Math.abs(t - 0.35) * 26;
      const g = block(this.r(5, 7), h, this.r(16, 22), { seed: 1500 + i, erosion: 1.2, round: 2, segSize: 2.5 });
      g.rotateX(-0.35).translate(this.r(-2, 2), y - 8, z);
      this.plates.push(g);
    }
  }

  /** Roots hanging from the belly and flanks, draping to the ground in uneven, knotted curves. */
  private dressRoots() {
    for (let i = 0; i < 24; i++) {
      // Concentrated along the belly's midline and flanks, clear of the legs.
      const side = this.rnd() < 0.5 ? -1 : 1;
      const x = side * this.r(8, 48), z = this.r(-120, 40);
      const topY = 86 + this.r(-4, 12);
      const endX = x + side * this.r(4, 30), endZ = z + this.r(-30, 30);
      const pts: THREE.Vector3[] = [];
      for (let k = 0; k <= 7; k++) {
        const t = k / 7;
        const wob = (this.rnd() - 0.5) * 6 * Math.sin(t * Math.PI);
        pts.push(V(THREE.MathUtils.lerp(x, endX, t) + wob, THREE.MathUtils.lerp(topY, 1.5, Math.pow(t, 0.85)), THREE.MathUtils.lerp(z, endZ, t) + wob * 0.7));
      }
      const r0 = this.r(2.2, 4.8);
      this.roots.push(this.limb(pts, [r0, r0 * 0.7, r0 * 0.5, r0 * 0.45, r0 * 0.7], 0.9, 2000 + i, 9));
    }
    // Thick roots draping off the sides of the back, splaying into the ground like buttresses.
    for (let i = 0; i < 16; i++) {
      const s = i % 2 ? 1 : -1;
      const z = this.r(-150, 50);
      const pts = [V(s * this.r(10, 30), 170, z), V(s * 60, 150, z + this.r(-10, 10)), V(s * 76, 100, z + this.r(-15, 15)), V(s * this.r(80, 95), 40, z + this.r(-20, 20)), V(s * this.r(95, 125), 1, z + this.r(-30, 30))];
      const r0 = this.r(3, 6);
      this.roots.push(this.limb(pts, [r0, r0 * 0.9, r0 * 0.75, r0 * 0.7, r0 * 1.1], 1.0, 2100 + i, 11));
    }
  }

  private collectBackTrees() {
    const m = new THREE.Matrix4();
    const up = V(0, 1, 0);
    for (let i = 0; i < 60; i++) {
      const e = this.torsoParts[i % 3];
      const a = this.r(0, Math.PI * 2), el = this.r(0.72, 0.98);
      const n = V(Math.cos(a) * Math.sqrt(1 - el * el), el, Math.sin(a) * Math.sqrt(1 - el * el));
      const p = V(n.x * e.r.x, n.y * e.r.y, n.z * e.r.z).add(e.c);
      p.y += Math.max(0, n.y) ** 2 * Math.exp(-((p.x / 22) ** 2)) * 14 - 2;
      if (Math.abs(p.x) < 9) continue; // keep clear of the spine ridge
      const s = this.r(2.6, 4.2);
      m.compose(p, new THREE.Quaternion().setFromAxisAngle(up, this.r(0, 6.28)), V(s, s, s));
      this.backTreeSpots.push(this.body.matrixWorld.clone().multiply(m));
    }
  }

  private r(a: number, b: number) { return a + (b - a) * this.rnd(); }

  /**
   * Giant roots reaching out from the Colossus across the valley floor toward the ruins: half-buried,
   * surfacing in arches, thinning as they go. World-space mesh plus colliders inside the play area.
   */
  buildLandRoots(colliders: Colliders) {
    const parts: THREE.BufferGeometry[] = [];
    const rnd = mulberry32(4711);
    const m = this.root.matrixWorld;
    const starts = [V(-70, 4, 140), V(70, 4, 140), V(-64, 4, -130), V(64, 4, -130), V(0, 10, 60)].map((v) => v.applyMatrix4(m));
    for (let i = 0; i < 9; i++) {
      const s0 = starts[i % starts.length];
      // Reach toward (and partly past) the ring of arches, fanning out across the basin.
      const tx = SITES.ring.x + (rnd() - 0.5) * 220, tz = SITES.ring.z + 40 - rnd() * 120;
      const n = 9;
      const pts: THREE.Vector3[] = [];
      const radii: number[] = [];
      const r0 = 3.2 + rnd() * 2.4;
      for (let k = 0; k <= n; k++) {
        const t = k / n;
        const x = THREE.MathUtils.lerp(s0.x, tx, t) + Math.sin(t * 5 + i) * 18 * t;
        const z = THREE.MathUtils.lerp(s0.z, tz, t) + Math.cos(t * 4 + i * 2) * 14 * t;
        const r = r0 * (1 - t * 0.72);
        // Mostly buried; surfaces in a couple of arches along its length.
        const surface = Math.max(0, Math.sin(t * Math.PI * (2 + (i % 2)) + i)) * r * 0.9;
        const inPool = Math.hypot(x - POOL.x, (z - POOL.z) * 0.85) < POOL.r + 4;
        const y = terrainHeight(x, z) - r * 0.55 + surface - (inPool ? 1.5 : 0);
        pts.push(V(x, y, z));
        radii.push(r);
      }
      parts.push(this.limb(pts, radii, 0.5, 3000 + i, 12));
      // Colliders where the root is inside the explorable area and stands proud of the ground.
      const curve = new THREE.CatmullRomCurve3(pts);
      for (let k = 0; k <= 60; k++) {
        const t = k / 60;
        const p = curve.getPointAt(t);
        if (p.z < PLAY.minZ - 5) continue;
        const r = THREE.MathUtils.lerp(radii[0], radii[radii.length - 1], t);
        const g = terrainHeight(p.x, p.z);
        if (p.y + r > g + 0.6) colliders.addCircle(p.x, p.z, r * 0.9, g - 1, p.y + r);
      }
    }
    const geo = mergeGeometries(parts, false)!;
    bakeAO(geo);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.rootMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  update(t: number) {
    // Slow breathing (~11s cycle) lifts the chest and back; the head drifts and settles.
    const breath = Math.sin((t * Math.PI * 2) / 11);
    const b = 0.5 + 0.5 * breath;
    this.body.scale.set(1 + 0.004 * b, 1 + 0.011 * b, 1 + 0.003 * b);
    this.head.rotation.x = -0.02 * b + 0.015 * Math.sin(t * 0.13);
    this.head.rotation.y = 0.06 * Math.sin(t * 0.045) + 0.02 * Math.sin(t * 0.11);
    this.eyeMat.emissiveIntensity = 1.6 + 0.9 * b;
  }
}

/** Multi-scale lumpy displacement giving a weathered, organic stone hide. */
function displacement(p: THREE.Vector3, seed: number) {
  const s = seed * 7.13;
  // Large masses dominate; mid-scale is subdued so the hide reads as weathered stone, not lumps.
  const big = n3(p.x / 60 + s, p.y / 55, p.z / 60) * 1.2;
  const mid = n3(p.x / 18, p.y / 18 + s, p.z / 18) * 0.22;
  const fine = fbm(p.x / 5 + p.z / 7, p.y / 5 + s, 2) * 0.08;
  // Deep ridged creases: folds and fissures in the hide.
  const crease = (1 - Math.abs(n3(p.x / 28, p.y / 34, p.z / 28 + s))) ** 4 * -1.1;
  return big + mid + fine + crease;
}

function finish(g: THREE.BufferGeometry) {
  for (const k of Object.keys(g.attributes)) if (k !== 'position') g.deleteAttribute(k);
  const m = mergeVertices(g, 1e-3);
  m.computeVertexNormals();
  return m;
}

/** Underside and lower parts in shade; crevices (concave noise) darker. */
function bakeAO(g: THREE.BufferGeometry) {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const n = g.getAttribute('normal') as THREE.BufferAttribute;
  const ao = new Float32Array(p.count);
  for (let i = 0; i < p.count; i++) {
    const ny = n.getY(i), y = p.getY(i);
    const under = smoothstep(-0.75, 0.45, ny);
    const low = smoothstep(-5, 60, y);
    ao[i] = (0.32 + 0.68 * under) * (0.55 + 0.45 * low);
  }
  g.setAttribute('aAO', new THREE.BufferAttribute(ao, 1));
}
