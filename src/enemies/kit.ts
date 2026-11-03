import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/noise';

/**
 * Shared building kit for the invaders: vertex-coloured geometry modelled in the bind pose (model space)
 * and re-parented to bones, so it follows every clip on the shared Quaternius skeleton.
 */

export const srgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
/** Faction palette: soot-dark armour, faded rust-red cloth, pale lacquered masks. */
export const F = {
  soot: srgb(0.075, 0.068, 0.062),
  soot2: srgb(0.13, 0.118, 0.11),
  lacquer: srgb(0.06, 0.052, 0.048),
  iron: srgb(0.2, 0.2, 0.205),
  iron2: srgb(0.29, 0.29, 0.3),
  ironHi: srgb(0.42, 0.42, 0.44),
  leather: srgb(0.2, 0.14, 0.1),
  leather2: srgb(0.28, 0.2, 0.14),
  rust: srgb(0.42, 0.17, 0.12),
  rust2: srgb(0.3, 0.12, 0.09),
  red: srgb(0.5, 0.11, 0.08),
  mask: srgb(0.8, 0.76, 0.68),
  maskShade: srgb(0.62, 0.58, 0.5),
  wrap: srgb(0.27, 0.25, 0.23),
  wrap2: srgb(0.18, 0.165, 0.15),
  skin: srgb(0.45, 0.31, 0.23),
  steel: srgb(0.7, 0.71, 0.73),
  wood: srgb(0.16, 0.11, 0.075),
  cord: srgb(0.55, 0.47, 0.34),
};

export type Rng = () => number;
export const rngFor = (seed: number) => mulberry32(seed);

export function paint(g: THREE.BufferGeometry, fn: (p: THREE.Vector3, i: number) => THREE.Color, rnd: Rng, jitter = 0.08) {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    const c = fn(v.fromBufferAttribute(p, i), i).clone().multiplyScalar(1 - jitter + rnd() * jitter * 2);
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}
export const flat = (c: THREE.Color) => () => c;

/** Sphere reshaped by a displacement function (centre c, radii r). */
export function blob(c: THREE.Vector3, r: THREE.Vector3, seg = 18, shape?: (p: THREE.Vector3, n: THREE.Vector3) => void) {
  const g = new THREE.SphereGeometry(1, seg, Math.max(8, Math.round(seg * 0.75)));
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const v = new THREE.Vector3(), n = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    n.fromBufferAttribute(p, i);
    v.set(n.x * r.x, n.y * r.y, n.z * r.z);
    shape?.(v, n);
    v.add(c);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  g.computeVertexNormals();
  return g;
}

/** Curved plate bent around the y axis (radius r), slightly dished; centred on the origin, facing +z. */
export function plate(w: number, h: number, t: number, r: number, segs = 12) {
  const g = new THREE.BoxGeometry(w, h, t, segs, 3, 1);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    let z = p.getZ(i);
    const v = y / h + 0.5;
    z += Math.sin(v * Math.PI) * h * 0.05;
    const a = x / r, rr = r + z;
    p.setXYZ(i, Math.sin(a) * rr, y, Math.cos(a) * rr - r);
  }
  g.computeVertexNormals();
  return g;
}

/** Ring band around an elliptical section (rx, rz), height h; open tube. */
export function band(rx: number, rz: number, h: number, seg = 28, flare = 0) {
  const g = new THREE.CylinderGeometry(1, 1, h, seg, 1, true);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), k = 1 + (0.5 - y / h - 0.5) * 0 + (y < 0 ? flare : 0);
    p.setXYZ(i, p.getX(i) * rx * k, y, p.getZ(i) * rz * k);
  }
  g.computeVertexNormals();
  return g;
}

/** Matrix whose x axis runs from `from` to `to` (bone-aligned parts). */
export function frame(from: THREE.Vector3, to: THREE.Vector3, up = new THREE.Vector3(0, 1, 0)) {
  const x = to.clone().sub(from).normalize();
  const z = new THREE.Vector3().crossVectors(x, up).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(from);
}

/** A cloth panel hanging down from its top edge; folds and a worn hem. */
export function panel(w: number, h: number, flare: number, folds: number, colour: THREE.Color, dark: THREE.Color, rnd: Rng) {
  const g = new THREE.PlaneGeometry(w, h, Math.max(6, Math.round(w / 0.02)), 8).translate(0, -h / 2, 0);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), t = -p.getY(i) / h;
    const fold = Math.sin((x / w) * Math.PI * folds + t * 0.8) * 0.016 + Math.sin((x / w) * Math.PI * folds * 2.3) * 0.005;
    p.setZ(i, fold * (0.3 + t) + t * t * flare);
    p.setX(i, x * (1 + t * 0.1));
    if (t > 0.98) p.setY(i, p.getY(i) + Math.sin(x * 41) * 0.012 + Math.sin(x * 97) * 0.005);
  }
  g.computeVertexNormals();
  return paint(g, (q) => (Math.sin((q.x / w) * Math.PI * folds) > 0.55 ? dark : colour), rnd, 0.05);
}

/** A tapering strip hanging from a point, curving back and down (sash and headcloth tails). */
export function tail(len: number, w0: number, w1: number, back: number, colour: THREE.Color, rnd: Rng) {
  const g = new THREE.PlaneGeometry(1, 1, 1, 10).translate(0, -0.5, 0);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const t = -p.getY(i), x = p.getX(i) * THREE.MathUtils.lerp(w0, w1, t);
    p.setXYZ(i, x + Math.sin(t * 5) * 0.01, -t * len, -Math.pow(t, 1.6) * back);
  }
  g.computeVertexNormals();
  return paint(g, flat(colour), rnd, 0.06);
}

export type MatKey = 'cloth' | 'hard' | 'metal' | 'skin' | 'mask' | 'wood';
export function makeMaterials(tag: string): Record<MatKey, THREE.MeshStandardMaterial> {
  return {
    cloth: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide, name: `${tag}-cloth` }),
    hard: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0.1, name: `${tag}-hard` }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.42, metalness: 0.75, name: `${tag}-metal` }),
    skin: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, name: `${tag}-skin` }),
    mask: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.38, metalness: 0.02, name: `${tag}-mask` }),
    wood: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.8, name: `${tag}-wood` }),
  };
}

/** Collects parts per (bone, material), merges them, and parents each merged mesh to its bone. */
export class Dresser {
  readonly bones: Record<string, THREE.Bone> = {};
  readonly inv: THREE.Matrix4;
  private groups = new Map<string, { bone: string; mat: MatKey; geos: THREE.BufferGeometry[] }>();
  constructor(readonly model: THREE.Object3D, readonly mats: Record<MatKey, THREE.MeshStandardMaterial>) {
    model.updateMatrixWorld(true);
    model.traverse((o) => { if ((o as THREE.Bone).isBone) this.bones[o.name] = o as THREE.Bone; });
    this.inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  }
  /** Bone position in model space (bind pose). */
  P(n: string) { return new THREE.Vector3().setFromMatrixPosition(this.bones[n].matrixWorld).applyMatrix4(this.inv); }
  add(bone: string, mat: MatKey, g: THREE.BufferGeometry, m?: THREE.Matrix4) {
    if (m) g.applyMatrix4(m);
    const k = `${bone}|${mat}`;
    (this.groups.get(k) ?? this.groups.set(k, { bone, mat, geos: [] }).get(k)!).geos.push(g);
  }
  /** Torso cross-section of a skinned mesh at model-space height y (bind pose). */
  section(mesh: THREE.SkinnedMesh, y: number, maxX = 0.3) {
    const pos = mesh.geometry.getAttribute('position');
    const v = new THREE.Vector3();
    let minX = Infinity, maxX2 = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld).applyMatrix4(this.inv);
      if (Math.abs(v.y - y) > 0.03 || Math.abs(v.x) > maxX) continue;
      minX = Math.min(minX, v.x); maxX2 = Math.max(maxX2, v.x); minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
    }
    if (!isFinite(minX)) return { cx: 0, cz: 0, rx: 0.15, rz: 0.11 };
    return { cx: (minX + maxX2) / 2, cz: (minZ + maxZ) / 2, rx: (maxX2 - minX) / 2, rz: (maxZ - minZ) / 2 };
  }
  assemble() {
    for (const { bone, mat, geos } of this.groups.values()) {
      const g = mergeGeometries(geos.map((x) => {
        if (!x.getAttribute('normal')) x.computeVertexNormals();
        for (const k of Object.keys(x.attributes)) if (!['position', 'normal', 'color'].includes(k)) x.deleteAttribute(k);
        return x.index ? x.toNonIndexed() : x;
      }), false)!;
      const mesh = new THREE.Mesh(g, this.mats[mat]);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.applyMatrix4(this.model.matrixWorld);
      this.bones[bone].attach(mesh);
    }
    this.groups.clear();
  }
}

/** Recolours a base Quaternius outfit in the shader by luminance (keeps its folds and normal detail). */
export function recolour(model: THREE.Object3D, tag: string, pick: (meshName: string, isSkin: boolean) => [number, number, number] | null) {
  model.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const isSkin = /Regular_Male/.test((m.material as THREE.Material).name);
    const tint = pick(m.name, isSkin);
    if (!tint) return;
    const mat = (m.material as THREE.MeshStandardMaterial).clone();
    const [r, g, b] = tint;
    mat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        { float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114)); diffuseColor.rgb = vec3(l) * vec3(${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)}); }`);
    };
    mat.customProgramCacheKey = () => `${tag}-${m.name}-${tint.join(',')}`;
    m.material = mat;
  });
}

/** A weapon mount at a hand: local +Y runs along the grip toward the business end (index side of the fist). */
export function handMount(d: Dresser, side: 'l' | 'r') {
  const b = d.bones;
  const wpos = (n: string) => new THREE.Vector3().setFromMatrixPosition(b[n].matrixWorld);
  const ix = wpos(`index_01_${side}`), pk = wpos(`pinky_01_${side}`), md = wpos(`middle_01_${side}`), w = wpos(`hand_${side}`);
  const axis = ix.clone().sub(pk).normalize();
  const grip = ix.clone().add(pk).multiplyScalar(0.5).lerp(md, 0.3).add(w.clone().sub(md).normalize().multiplyScalar(-0.02));
  const g = new THREE.Group();
  g.position.copy(grip);
  g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  d.model.parent ? d.model.parent.add(g) : d.model.add(g);
  g.updateMatrixWorld(true);
  b[`hand_${side}`].attach(g);
  // Weapons are modelled at true size whatever the body's scale.
  g.updateMatrixWorld(true);
  g.scale.multiplyScalar(1 / g.getWorldScale(new THREE.Vector3()).x);
  return g;
}
