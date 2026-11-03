import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32, fbm } from '../core/noise';

/**
 * The mentor: an old master warrior built on the Quaternius Peasant body (same 65-bone skeleton and
 * animation library as the protagonist). Everything here is modelled in the bind pose in model space and
 * re-parented to bones, so it follows any clip from the shared library.
 *
 * Call on a freshly loaded/cloned model BEFORE any animation is applied (bones must be at rest).
 * Not yet used by the game: preview only (tools/mentor).
 */

const srgb = (r: number, g: number, b: number) => new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace);
const C = {
  robe: srgb(0.17, 0.2, 0.28),        // faded indigo haori
  robeDark: srgb(0.1, 0.12, 0.17),
  inner: srgb(0.66, 0.6, 0.5),        // undyed oat inner robe
  hakama: srgb(0.33, 0.33, 0.33),     // ash grey
  lacquer: srgb(0.1, 0.08, 0.07),
  lacing: srgb(0.42, 0.16, 0.12),     // faded red cord
  iron: srgb(0.22, 0.21, 0.2),
  rope: srgb(0.42, 0.32, 0.18),
  straw: srgb(0.56, 0.48, 0.34),
  strawDark: srgb(0.36, 0.3, 0.2),
  skin: srgb(0.62, 0.45, 0.35),
  hair: srgb(0.68, 0.66, 0.63),
  hairDark: srgb(0.45, 0.44, 0.42),
  saya: srgb(0.1, 0.08, 0.07),
  wood: srgb(0.28, 0.2, 0.13),
  eye: srgb(0.78, 0.74, 0.68),
  iris: srgb(0.14, 0.09, 0.06),
  steel: srgb(0.72, 0.72, 0.74),
};

const rnd = mulberry32(4071);

function paint(g: THREE.BufferGeometry, fn: (p: THREE.Vector3, i: number) => THREE.Color, jitter = 0.08) {
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
const flat = (c: THREE.Color) => () => c;

/** Sphere reshaped by a displacement function (centre c, radii r). */
function blob(c: THREE.Vector3, r: THREE.Vector3, seg = 18, shape?: (p: THREE.Vector3, n: THREE.Vector3) => void) {
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

/** Curved plate (lame) bent around the y axis; uv.y runs up the plate. */
function lame(w: number, h: number, t: number, r: number, segs = 10, laceEvery = 0.05) {
  const g = new THREE.BoxGeometry(w, h, t, segs, 4, 1);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i);
    let z = p.getZ(i);
    const v = y / h + 0.5;
    z += Math.sin(v * Math.PI) * h * 0.06 + (0.5 - v) * h * 0.25;
    const a = x / r, rr = r + z;
    p.setXYZ(i, Math.sin(a) * rr, y, Math.cos(a) * rr - r);
  }
  g.computeVertexNormals();
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  return paint(g, (_p, i) => {
    const u = uv.getX(i), v = uv.getY(i);
    if (v > 0.85) return C.iron;
    const across = (u * w) / laceEvery;
    return Math.abs(across - Math.round(across)) < 0.08 && v > 0.2 ? C.lacing : C.lacquer;
  });
}

function frame(from: THREE.Vector3, to: THREE.Vector3, up = new THREE.Vector3(0, 1, 0)) {
  const x = to.clone().sub(from).normalize();
  const z = new THREE.Vector3().crossVectors(x, up).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(from);
}

/** A cloth panel hanging straight down from a top edge; sways outward toward the bottom. */
function panel(w: number, h: number, flare: number, folds: number, colour: THREE.Color, dark: THREE.Color) {
  const g = new THREE.PlaneGeometry(w, h, Math.max(6, Math.round(w / 0.02)), 8).translate(0, -h / 2, 0);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), t = -p.getY(i) / h;
    const fold = Math.sin((x / w) * Math.PI * folds + t * 0.8) * 0.018 + Math.sin((x / w) * Math.PI * folds * 2.3) * 0.006;
    p.setZ(i, fold * (0.3 + t) + t * t * flare);
    p.setX(i, x * (1 + t * 0.12));
    // Uneven, worn hem.
    if (t > 0.98) p.setY(i, p.getY(i) + Math.sin(x * 41) * 0.012 + Math.sin(x * 97) * 0.005);
  }
  g.computeVertexNormals();
  return paint(g, (q) => (Math.sin((q.x / w) * Math.PI * folds) > 0.55 ? dark : colour), 0.05);
}

export interface MentorRig {
  /** Draw or sheathe the katana (shows the blade in the right hand). */
  setDrawn(drawn: boolean): void;
  /** Two-handed chudan guard layered over the current animation; call after the mixer updates. */
  applyGuard(): void;
  /** Older, heavier posture layered over any animation; call after the mixer updates. */
  applyPosture(): void;
}

/** A scanned head (geometry in its own units, Y up, facing +Z) and its material. */
export interface HeadScan { geometry: THREE.BufferGeometry; material: THREE.Material }

export function dressMentor(model: THREE.Object3D, scan?: HeadScan): MentorRig {
  model.updateMatrixWorld(true);
  const bones: Record<string, THREE.Bone> = {};
  let body: THREE.SkinnedMesh | null = null;
  model.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones[o.name] = o as THREE.Bone;
    if (/Peasant_Body$/.test(o.name)) body = o as THREE.SkinnedMesh;
  });
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const P = (n: string) => new THREE.Vector3().setFromMatrixPosition(bones[n].matrixWorld).applyMatrix4(inv);

  const torso = (y: number) => {
    const b = body as unknown as THREE.SkinnedMesh;
    const pos = b.geometry.getAttribute('position');
    const v = new THREE.Vector3();
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(b.matrixWorld).applyMatrix4(inv);
      if (Math.abs(v.y - y) > 0.03 || Math.abs(v.x) > 0.3) continue;
      minX = Math.min(minX, v.x); maxX = Math.max(maxX, v.x); minZ = Math.min(minZ, v.z); maxZ = Math.max(maxZ, v.z);
    }
    if (!isFinite(minX)) return { cx: 0, cz: 0, rx: 0.15, rz: 0.11 };
    return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, rx: (maxX - minX) / 2, rz: (maxZ - minZ) / 2 };
  };

  /** Plaited straw: concentric courses of short angled strands, alternating direction like a woven sedge hat. */
  const strawTex = (() => {
    const S = 1024, cv = document.createElement('canvas'); cv.width = cv.height = S;
    const g2 = cv.getContext('2d')!;
    g2.fillStyle = '#6e5a3a'; g2.fillRect(0, 0, S, S);
    const rr = mulberry32(55);
    for (let r = 6; r < S / 2; r += 7) {
      const n = Math.floor((2 * Math.PI * r) / 7), dir = (Math.floor(r / 7) % 2 ? 1 : -1);
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 + rr() * 0.01, x = S / 2 + Math.cos(a) * r, y = S / 2 + Math.sin(a) * r;
        const t = 140 + rr() * 70;
        g2.strokeStyle = `rgb(${t | 0},${(t * 0.82) | 0},${(t * 0.55) | 0})`; g2.lineWidth = 3.2 + rr() * 1.2;
        g2.beginPath(); g2.moveTo(x - Math.sin(a) * 4 * dir - Math.cos(a) * 3, y + Math.cos(a) * 4 * dir - Math.sin(a) * 3);
        g2.lineTo(x + Math.sin(a) * 4 * dir + Math.cos(a) * 3, y - Math.cos(a) * 4 * dir + Math.sin(a) * 3); g2.stroke();
      }
      g2.strokeStyle = 'rgba(40,28,14,0.35)'; g2.lineWidth = 1; g2.beginPath(); g2.arc(S / 2, S / 2, r + 3.5, 0, Math.PI * 2); g2.stroke();
    }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
    return t;
  })();
  const mats = {
    cloth: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide, name: 'mentor-cloth' }),
    hard: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.15, name: 'mentor-hard' }),
    metal: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.4, metalness: 0.8, name: 'mentor-metal' }),
    skin: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.68, name: 'mentor-skin' }),
    hair: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, name: 'mentor-hair' }),
    straw: new THREE.MeshStandardMaterial({ vertexColors: true, map: strawTex, roughness: 0.92, side: THREE.DoubleSide, name: 'mentor-straw' }),
  };
  type M = keyof typeof mats;
  const groups = new Map<string, { bone: string; mat: M; geos: THREE.BufferGeometry[] }>();
  const add = (bone: string, mat: M, g: THREE.BufferGeometry, m?: THREE.Matrix4) => {
    if (m) g.applyMatrix4(m);
    const k = `${bone}|${mat}`;
    (groups.get(k) ?? groups.set(k, { bone, mat, geos: [] }).get(k)!).geos.push(g);
  };

  const pelvis = P('pelvis'), neck = P('neck_01'), head = P('Head');
  const waist = pelvis.y + 0.06, chestTop = neck.y - 0.08;

  // ---------------- Inner robe collar (crossed, visible at the opening) and chest guard ----------------
  {
    for (let i = 0; i < 5; i++) {
      const t = i / 4, y = chestTop - 0.05 - t * (chestTop - waist - 0.1);
      const s = torso(y);
      // Lacquered plates across the chest, visible in the robe's opening.
      const g = lame(0.3, 0.075, 0.012, 0.22, 16, 0.05);
      g.translate(s.cx, y, s.cz + Math.min(s.rz, 0.13) + 0.025);
      add(t < 0.5 ? 'spine_03' : 'spine_02', 'hard', g);
    }
  }

  // ---------------- Haori: torso shell open at the front, wide sleeves, skirt to the knee ----------------
  {
    const rows = 9, cols = 34, gap = 0.42;
    const pos: number[] = [], idx: number[] = [];
    for (let r = 0; r <= rows; r++) {
      const t = r / rows, y = chestTop + 0.03 - t * (chestTop + 0.03 - waist);
      const s = torso(Math.min(y, chestTop - 0.12));
      const shoulder = Math.min(1, t / 0.22);
      for (let c = 0; c <= cols; c++) {
        const a = -Math.PI + gap + (c / cols) * (Math.PI * 2 - 2 * gap) + Math.PI;
        const rx = THREE.MathUtils.lerp(0.1, Math.min(s.rx, 0.17) + 0.06, shoulder) + 0.008 * Math.sin(c * 1.7);
        const rz = THREE.MathUtils.lerp(0.085, Math.min(s.rz, 0.13) + 0.05, shoulder);
        pos.push(s.cx + Math.sin(a) * rx, y, s.cz + Math.cos(a) * rz);
      }
    }
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const a = r * (cols + 1) + c; idx.push(a, a + cols + 1, a + 1, a + 1, a + cols + 1, a + cols + 2); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx); g.computeVertexNormals();
    add('spine_02', 'cloth', paint(g.toNonIndexed(), (q) => (Math.sin(q.x * 90) > 0.7 ? C.robeDark : C.robe), 0.06));
    // Front lapels (eri): darker band down each edge of the opening.
    for (const sgn of [-1, 1]) {
      const s0 = torso(chestTop - 0.15); const s = { cx: s0.cx, cz: s0.cz, rx: Math.min(s0.rx, 0.17) + 0.01, rz: Math.min(s0.rz, 0.13) + 0.005 };
      const lap = new THREE.BoxGeometry(0.045, chestTop - waist + 0.06, 0.014).translate(0, -(chestTop - waist) / 2, 0);
      lap.rotateZ(sgn * 0.12).translate(s.cx + sgn * Math.sin(gap) * (s.rx + 0.05), chestTop + 0.03, s.cz + Math.cos(gap) * (s.rz + 0.045) + 0.004);
      add('spine_02', 'cloth', paint(lap, flat(C.robeDark)));
    }
  }
  // Skirt of the haori: continuous curved fabric. The back half hangs from the pelvis; each front half
  // rides its thigh and overlaps the back at the sides, so there are no gaps or loose panel edges.
  {
    const s0 = torso(waist);
    const rx = Math.min(s0.rx, 0.17) + 0.065, rz = Math.min(s0.rz, 0.13) + 0.065, cx = s0.cx, cz = s0.cz;
    const H = 0.54;
    const sector = (a0: number, a1: number, seed: number) => {
      const cols = Math.max(12, Math.round((a1 - a0) * 26)), rows = 10;
      const pos: number[] = [], idx: number[] = [], cs: number[] = [];
      for (let r = 0; r <= rows; r++) {
        const t = r / rows;
        for (let c = 0; c <= cols; c++) {
          const a = a0 + ((a1 - a0) * c) / cols;
          // Folds deepen toward the hem and drift; the hem dips unevenly.
          const fold = Math.sin(a * 9 + seed + t * 1.2) * 0.012 * (0.3 + t) + Math.sin(a * 23 + seed) * 0.004 * t;
          const flare = 1 + t * t * 0.22;
          const rr = 1 + fold / Math.max(rx, rz);
          const y = waist + 0.02 - t * H + (r === rows ? Math.sin(a * 7 + seed) * 0.018 + Math.sin(a * 19) * 0.006 : 0);
          pos.push(cx + Math.sin(a) * rx * flare * rr, y, cz + Math.cos(a) * rz * flare * rr);
          const shade = Math.sin(a * 9 + seed + t * 1.2) > 0.5 ? 0.62 : 1;
          const col = C.robe.clone().multiplyScalar(shade * (0.92 + 0.12 * Math.sin(seed + c)));
          cs.push(col.r, col.g, col.b);
        }
      }
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const k = r * (cols + 1) + c; idx.push(k, k + cols + 1, k + 1, k + 1, k + cols + 1, k + cols + 2); }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setAttribute('color', new THREE.Float32BufferAttribute(cs, 3));
      g.setIndex(idx); g.computeVertexNormals();
      return g;
    };
    add('pelvis', 'cloth', sector(Math.PI * 0.42, Math.PI * 1.58, 1));       // back, wrapping round the sides
    add('thigh_l', 'cloth', sector(Math.PI * 0.08, Math.PI * 0.55, 2));      // his left front (+x)
    add('thigh_r', 'cloth', sector(-Math.PI * 0.55, -Math.PI * 0.08, 3));    // his right front
  }
  // Hakama front apron: a pleated layer across both legs from the waist to mid-thigh, hiding the leg seams.
  {
    const s0 = torso(waist - 0.02);
    const rx = Math.min(s0.rx, 0.17) + 0.05, rz = Math.min(s0.rz, 0.13) + 0.05;
    const g = new THREE.CylinderGeometry(1, 1.18, 0.34, 48, 3, true, -Math.PI * 0.42, Math.PI * 0.84);
    const gp = g.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < gp.count; i++) { const a = Math.atan2(gp.getX(i), gp.getZ(i)); const k = 1 + Math.max(0, Math.sin(a * 10)) * 0.05; gp.setX(i, gp.getX(i) * k); gp.setZ(i, gp.getZ(i) * k); }
    g.scale(rx, 1, rz).translate(s0.cx, waist - 0.2, s0.cz);
    g.computeVertexNormals();
    add('pelvis', 'cloth', paint(g, (q) => (Math.sin(Math.atan2(q.x - s0.cx, q.z - s0.cz) * 10) > 0.55 ? C.hakama.clone().multiplyScalar(0.68) : C.hakama), 0.04));
  }
  // Wide sleeves, tied back for combat: a flared shell from shoulder to just past the elbow.
  for (const side of ['l', 'r']) {
    const a0 = P(`upperarm_${side}`), a1 = P(`lowerarm_${side}`);
    const len = a0.distanceTo(a1);
    const F = frame(a0, a1);
    const sleeve = new THREE.CylinderGeometry(0.1, 0.075, len * 1.05, 16, 3, true).rotateZ(-Math.PI / 2).translate(len * 0.5, -0.012, 0);
    const sp = sleeve.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < sp.count; i++) if (sp.getY(i) < -0.04) sp.setY(i, sp.getY(i) - 0.04 * (sp.getX(i) / len)); // hangs slightly
    sleeve.computeVertexNormals();
    add(`upperarm_${side}`, 'cloth', paint(sleeve, (q) => (Math.sin(q.z * 120) > 0.6 ? C.robeDark : C.robe)), F);
    // Tasuki cord binding the sleeve.
    const tie = new THREE.TorusGeometry(0.09, 0.008, 6, 16).rotateY(Math.PI / 2).translate(len * 0.72, -0.01, 0);
    add(`upperarm_${side}`, 'cloth', paint(tie, flat(C.lacing)), F);
    // Forearm: grey cloth wraps; leather bracer on the right only.
    const e = P(`lowerarm_${side}`), w = P(`hand_${side}`);
    const fl = e.distanceTo(w);
    const Fl = frame(e, w);
    for (let k = 0; k < 8; k++) {
      // Wraps run from mid-forearm over the wrist bone, tapering, so skin meets cloth without a hard edge.
      const rr = 0.044 - Math.max(0, k - 5) * 0.003;
      const band = new THREE.CylinderGeometry(rr, rr + 0.002, 0.04, 12, 1, true).rotateZ(-Math.PI / 2).rotateX(0.25 * (k % 2 ? 1 : -1)).translate(fl * (0.25 + k * 0.105), 0, 0);
      add(`lowerarm_${side}`, 'cloth', paint(band, flat(C.hakama)), Fl);
    }
    if (side === 'r') {
      const br = new THREE.CylinderGeometry(0.05, 0.047, fl * 0.5, 14, 1, true, -Math.PI * 1.1, Math.PI * 1.2).rotateZ(-Math.PI / 2).translate(fl * 0.55, 0, 0);
      add('lowerarm_r', 'hard', paint(br, flat(C.lacquer)), Fl);
    }
  }

  // ---------------- Single shoulder guard (sword arm, right) ----------------
  {
    const a0 = P('upperarm_r'), a1 = P('lowerarm_r');
    const F = frame(a0, a1);
    const len = a0.distanceTo(a1);
    for (let j = 0; j < 3; j++) {
      const g = lame(0.24 + j * 0.02, 0.085, 0.015, 0.1 + j * 0.008, 16, 0.05);
      const m = new THREE.Matrix4().makeRotationZ(Math.PI / 2).premultiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
      const local = new THREE.Matrix4().makeTranslation(-0.03 + j * len * 0.17, 0.12 + j * 0.004, 0).multiply(m);
      add('upperarm_r', 'hard', g, F.clone().multiply(new THREE.Matrix4().makeRotationZ(-0.1)).multiply(local));
    }
  }

  // ---------------- Hakama: wide pleated trouser-skirt, one flared shell per leg ----------------
  for (const side of ['l', 'r']) {
    const hip = P(`thigh_${side}`), knee = P(`calf_${side}`), ankle = P(`foot_${side}`);
    const up = new THREE.CylinderGeometry(0.13, 0.18, hip.distanceTo(knee) * 1.25, 72, 4, true);
    // Knife pleats: each pleat ramps outward then folds back under the next, so the cloth overlaps in
    // layers with a shadowed fold line, rather than reading as a smooth tube. Pleats loosen toward the hem.
    const NP = 9;
    const phaseOf = (a: number) => { const f = ((a / (Math.PI * 2)) * NP + 10) % 1; return f; };
    const pleat = (g: THREE.BufferGeometry) => {
      const p = g.getAttribute('position') as THREE.BufferAttribute;
      const y0 = g.boundingBox ? 0 : 0;
      void y0;
      for (let i = 0; i < p.count; i++) {
        const a = Math.atan2(p.getZ(i), p.getX(i)), f = phaseOf(a), t = THREE.MathUtils.clamp(0.5 - p.getY(i) * 2, 0, 1);
        const k = 1 + f * (0.09 + 0.05 * t) + Math.sin(a * 3 + 1) * 0.02;
        p.setX(i, p.getX(i) * k); p.setZ(i, p.getZ(i) * k);
      }
      g.computeVertexNormals();
      return paint(g, (q) => { const f = phaseOf(Math.atan2(q.z, q.x)); return C.hakama.clone().multiplyScalar(f > 0.86 ? 0.5 : 0.78 + f * 0.3); }, 0.03);
    };
    const Fu = frame(hip, knee, new THREE.Vector3(0, 0, 1));
    add(`thigh_${side}`, 'cloth', pleat(up.rotateZ(Math.PI / 2).translate(hip.distanceTo(knee) * 0.6, 0, 0)), Fu);
    const lo = new THREE.CylinderGeometry(0.19, 0.22, knee.distanceTo(ankle) * 1.0, 72, 4, true);
    const Fl = frame(knee, ankle, new THREE.Vector3(0, 0, 1));
    add(`calf_${side}`, 'cloth', pleat(lo.rotateZ(Math.PI / 2).translate(knee.distanceTo(ankle) * 0.42, 0, 0)), Fl);
  }

  // ---------------- Rope sash, prayer beads and a temple charm ----------------
  {
    const s0 = torso(waist + 0.02); const s = { ...s0, rx: Math.min(s0.rx, 0.17), rz: Math.min(s0.rz, 0.13) };
    for (let k = 0; k < 3; k++) {
      const t = new THREE.TorusGeometry(1, 0.016, 6, 40).rotateX(Math.PI / 2).scale(s.rx + 0.075, 1, s.rz + 0.075).translate(s.cx, waist + 0.03 - k * 0.025, s.cz);
      add('pelvis', 'cloth', paint(t, flat(C.rope)));
    }
    const knot = blob(new THREE.Vector3(s.cx - 0.08, waist + 0.0, s.cz + s.rz + 0.08), new THREE.Vector3(0.035, 0.03, 0.025), 10);
    add('pelvis', 'cloth', paint(knot, flat(C.rope)));
    const bx = s.cx + s.rx + 0.08, bz = s.cz + 0.05;
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2;
      add('pelvis', 'hard', paint(new THREE.SphereGeometry(0.009, 6, 4).translate(bx, waist - 0.07 + Math.cos(a) * 0.06, bz + Math.sin(a) * 0.02), flat(C.wood)));
    }
    add('pelvis', 'hard', paint(new THREE.BoxGeometry(0.035, 0.06, 0.01).translate(bx + 0.005, waist - 0.16, bz), flat(C.wood)));
  }

  // ---------------- Katana in a weathered scabbard, left hip, edge down and slanting back ----------------
  const saya = new THREE.Group();
  {
    const s0 = torso(waist); const s = { ...s0, rx: Math.min(s0.rx, 0.17) };
    const hip = new THREE.Vector3(s.cx + s.rx + 0.07, waist + 0.0, s.cz + 0.06);
    const dir = new THREE.Vector3(0.12, -0.55, -0.83).normalize();
    const F = frame(hip, hip.clone().add(dir));
    const sc = new THREE.CylinderGeometry(0.018, 0.015, 0.72, 10, 10).rotateZ(-Math.PI / 2).translate(0.36, 0, 0);
    const sp = sc.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < sp.count; i++) { const x = sp.getX(i); sp.setY(i, sp.getY(i) - (x / 0.72) ** 2 * 0.04); }
    sc.computeVertexNormals();
    // Weathering: scuffs toward the tip and along the edge.
    add('pelvis', 'hard', paint(sc, (q) => (q.x > 0.68 ? C.iron : fbm(q.x * 40, q.y * 80, 2) > 0.25 ? C.saya.clone().multiplyScalar(2.2) : C.saya), 0.1), F);
    add('pelvis', 'metal', paint(new THREE.CylinderGeometry(0.04, 0.04, 0.007, 14).rotateZ(-Math.PI / 2).translate(-0.02, 0, 0), flat(C.iron)), F);
    const hilt = new THREE.CylinderGeometry(0.016, 0.017, 0.26, 8, 12).rotateZ(-Math.PI / 2).translate(-0.155, 0, 0);
    add('pelvis', 'cloth', paint(hilt, (q) => (Math.abs(((q.x * 26) % 1 + 1) % 1 - 0.5) < 0.14 ? C.rope.clone().multiplyScalar(0.55) : C.lacquer), 0.15), F);
    void saya;
  }

  /**
   * Fits the scanned head: scale from crown-to-nose-tip, nose tip placed on the face target, the bust below
   * the jaw trimmed so the neck disappears into the collar, then attached rigidly to the Head bone.
   */
  const fitScan = (sc: HeadScan) => {
    const g = sc.geometry.clone();
    g.computeBoundingBox();
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    let tip = 0;
    for (let i = 0; i < pos.count; i++) if (pos.getZ(i) > pos.getZ(tip)) tip = i;
    const crown = g.boundingBox!.max.y;
    const tipV = new THREE.Vector3().fromBufferAttribute(pos, tip);
    const s = 0.128 / (crown - tipV.y);           // crown to nose tip ~12.8 cm on a 1.8 m man
    // Open the eyes. The scan was captured with closed lids; eye centres (scan units, found from the
    // lash lines in the colour map) are carved into an almond opening with a heavy upper lid, and eyeballs
    // are set behind it. Calm and watchful: the opening is ~60% of a full eye, pupils level and forward.
    const eyeC = [new THREE.Vector3(-0.86, 1.67, 1.75), new THREE.Vector3(0.64, 1.66, 1.78)];
    const eyeGeos: THREE.BufferGeometry[] = [];
    for (const e of eyeC) {
      const a = 0.22, bUp = 0.05, bDn = 0.058;
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i) - e.x, y = pos.getY(i) - e.y, z = pos.getZ(i);
        if (z < e.z - 0.35) continue;
        const ny = y > 0 ? y / bUp : y / bDn;
        const r2 = (x / a) ** 2 + ny ** 2;
        // Almond shape: corners pinch; inside, the lid surface recedes behind the eyeball.
        if (r2 < 1) pos.setZ(i, Math.min(z, e.z - 0.3 - 0.06 * (1 - r2)));
        else if (r2 < 2.2) {
          const k = (r2 - 1) / 1.2;
          // Lid rims: a slight swell for the upper lid fold and lower lid edge.
          pos.setZ(i, z + (1 - k) * (y > 0 ? 0.035 : 0.015));
        }
      }
      const R = 0.29;
      const eye = new THREE.SphereGeometry(R, 32, 24).rotateX(Math.PI / 2);
      const ep = eye.getAttribute('position') as THREE.BufferAttribute;
      const col = new Float32Array(ep.count * 3);
      for (let i = 0; i < ep.count; i++) {
        const z = ep.getZ(i) / R; // 1 = straight ahead
        const ang = Math.acos(Math.min(1, Math.max(-1, z)));
        const c = ang < 0.26 ? srgb(0.02, 0.018, 0.015) : ang < 0.62 ? srgb(0.22, 0.16, 0.11).lerp(srgb(0.1, 0.08, 0.06), (ang - 0.26) / 0.36) : srgb(0.5, 0.45, 0.4).lerp(srgb(0.3, 0.22, 0.19), Math.min(1, Math.max(0, ang - 0.75) * 1.2));
        if (ang > 0.6 && ang < 0.66) c.multiplyScalar(0.5); // limbal ring
        col.set([c.r, c.g, c.b], i * 3);
      }
      eye.setAttribute('color', new THREE.BufferAttribute(col, 3));
      // Front of the eyeball sits just behind the lid rims (no bulge); centred so the iris looks straight ahead.
      eye.translate(e.x, e.y - 0.004, e.z - 0.085 - R);
      eyeGeos.push(eye);
    }
    g.computeVertexNormals();
    const target = head.clone().add(new THREE.Vector3(0, 0.085 - 0.02, 0.015 + 0.103));
    g.translate(-tipV.x, -tipV.y, -tipV.z).scale(s, s, s).translate(target.x, target.y, target.z);
    // Trim the bust: drop triangles below the neck top.
    const cut = neck.y + 0.0;
    const idx = g.index!;
    const keep: number[] = [];
    for (let i = 0; i < idx.count; i += 3) {
      const a = idx.getX(i), b = idx.getX(i + 1), c = idx.getX(i + 2);
      if (Math.max(pos.getY(a), pos.getY(b), pos.getY(c)) > cut) keep.push(a, b, c);
    }
    g.setIndex(keep);
    const mesh = new THREE.Mesh(g, sc.material);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.applyMatrix4(model.matrixWorld);
    bones['Head'].attach(mesh);
    // Eyeballs share the head's transform; wet, glossy surface so they catch the light.
    const eyeMat = new THREE.MeshPhysicalMaterial({ vertexColors: true, roughness: 0.35, clearcoat: 0.35, clearcoatRoughness: 0.25 });
    const eg = mergeGeometries(eyeGeos.map((x) => x.toNonIndexed()), false)!;
    eg.translate(-tipV.x, -tipV.y, -tipV.z).scale(s, s, s).translate(target.x, target.y, target.z);
    const eyes = new THREE.Mesh(eg, eyeMat);
    eyes.applyMatrix4(model.matrixWorld);
    bones['Head'].attach(eyes);
  };

  // ---------------- Head: weathered face, calm hooded eyes, grey beard and hair ----------------
  {
    const hc = head.clone().add(new THREE.Vector3(0, 0.085, 0.015));
    const n3 = (v: THREE.Vector3) => fbm(v.x * 60, v.y * 60 + v.z * 30, 2);
    const eyesAt = [-1, 1].map((s) => hc.clone().add(new THREE.Vector3(s * 0.032, 0.012, 0.079)));
    if (!scan) {
    // Skull and face with a strong brow, cheekbones, jaw and nose.
    const skull = blob(hc, new THREE.Vector3(0.078, 0.1, 0.092), 32, (p, n) => {
      if (n.z > 0.35 && n.y > 0.05 && n.y < 0.4) p.z += 0.012 * Math.exp(-((n.y - 0.25) ** 2) * 60);        // brow ridge
      if (n.z > 0.3 && Math.abs(n.x) > 0.25 && Math.abs(n.x) < 0.65 && n.y < 0.05 && n.y > -0.4) p.z += 0.006; // cheekbones
      if (n.y < -0.3) { p.x *= 0.9; p.z += 0.01 * Math.max(0, n.z); }                                        // jaw forward
    });
    add('Head', 'skin', paint(skull, (q) => {
      let c = C.skin.clone();
      // Sockets and temples in shadow, forehead lines, weathered ruddiness on cheeks and nose.
      const dEye = Math.min(...eyesAt.map((e) => e.distanceTo(q)));
      c.multiplyScalar(0.75 + 0.25 * Math.min(1, dEye / 0.026));
      if (q.y > hc.y + 0.035 && q.z > hc.z + 0.04) c.multiplyScalar(Math.sin((q.y - hc.y) * 520) > 0.75 ? 0.82 : 1);
      if (q.z > hc.z + 0.06 && q.y < hc.y && q.y > hc.y - 0.04) c.lerp(srgb(0.66, 0.38, 0.3), 0.25);
      return c.multiplyScalar(0.92 + n3(q) * 0.12);
    }, 0.04));
    // Nose: straight, slightly hooked.
    const nose = blob(hc.clone().add(new THREE.Vector3(0, -0.01, 0.09)), new THREE.Vector3(0.0085, 0.024, 0.012), 16, (p) => { p.z += Math.max(0, -p.y) * 0.2; });
    add('Head', 'skin', paint(nose, flat(C.skin.clone().multiplyScalar(0.95))));
    // Ears.
    for (const s of [-1, 1]) add('Head', 'skin', paint(blob(hc.clone().add(new THREE.Vector3(s * 0.079, 0.0, 0.005)), new THREE.Vector3(0.008, 0.024, 0.015), 10), flat(C.skin.clone().multiplyScalar(0.85))));
    // Eyes: whites, dark iris, and heavy upper lids half-closed for a calm, steady gaze.
    for (const e of eyesAt) {
      add('Head', 'skin', paint(new THREE.SphereGeometry(0.0115, 14, 10).translate(e.x, e.y, e.z - 0.003), flat(C.eye)));
      add('Head', 'skin', paint(new THREE.SphereGeometry(0.0068, 12, 8).scale(1, 1, 0.45).translate(e.x, e.y - 0.0005, e.z + 0.0072), flat(C.iris)));
      const lid = new THREE.SphereGeometry(0.0128, 14, 8, 0, Math.PI * 2, 0, Math.PI * 0.5).rotateX(0.95).translate(e.x, e.y + 0.001, e.z - 0.003);
      add('Head', 'skin', paint(lid, flat(C.skin.clone().multiplyScalar(0.8))));
    }
    }
    if (scan) fitScan(scan);
    if (!scan) for (const e of eyesAt) {
      // Bushy grey brow.
      add('Head', 'hair', paint(blob(e.clone().add(new THREE.Vector3(Math.sign(e.x - hc.x) * 0.003, 0.019, 0.004)), new THREE.Vector3(0.016, 0.0038, 0.006), 10, (p) => { p.y -= Math.abs(p.x) * 0.25; }), flat(C.hair)));
    }
    // Beard: full, squared, ending in a short point; strands from noise.
    const beard = blob(hc.clone().add(scan ? new THREE.Vector3(0, -0.082, 0.05) : new THREE.Vector3(0, -0.075, 0.058)), scan ? new THREE.Vector3(0.05, 0.058, 0.04) : new THREE.Vector3(0.064, 0.072, 0.05), 28, (p, n) => {
      if (n.y < 0) p.y -= Math.pow(-n.y, 1.5) * 0.04 * (1 - Math.abs(n.x));
      p.multiplyScalar(1 + fbm(n.x * 18, n.y * 3, 2) * 0.06);
    });
    add('Head', 'hair', paint(beard, (q) => (Math.sin(q.x * 900 + q.y * 120) > 0.3 ? C.hair : C.hairDark), 0.06));
    // Moustache drooping into the beard.
    for (const s of [-1, 1]) {
      const m = blob(hc.clone().add(new THREE.Vector3(s * 0.018, -0.04, 0.09)), new THREE.Vector3(0.022, 0.009, 0.012), 12, (p) => { p.y -= Math.abs(p.x) * 0.6; });
      add('Head', 'hair', paint(m, flat(C.hair)));
    }
    // Hair: grey at the sides and back, gathered into a rope down the back of the neck.
    const hair = blob(hc.clone().add(new THREE.Vector3(0, 0.006, -0.008)), new THREE.Vector3(0.083, 0.098, 0.093), 26, (p, n) => { if (n.z > 0.25 && n.y < 0.7) p.multiplyScalar(0.94); });
    const hp = hair.getAttribute('position') as THREE.BufferAttribute;
    // Keep only the back/sides/top so the face is clear.
    const keep: number[] = [];
    const hi = hair.index!;
    for (let i = 0; i < hi.count; i += 3) {
      const a = hi.getX(i), b = hi.getX(i + 1), c = hi.getX(i + 2);
      const zc = (hp.getZ(a) + hp.getZ(b) + hp.getZ(c)) / 3 - hc.z, yc = (hp.getY(a) + hp.getY(b) + hp.getY(c)) / 3 - hc.y;
      if (zc < 0.045 || yc > 0.07) keep.push(a, b, c);
    }
    hair.setIndex(keep);
    if (!scan) add('Head', 'hair', paint(hair.toNonIndexed(), (q) => (Math.sin(q.y * 700 + q.x * 90) > 0.2 ? C.hair : C.hairDark), 0.05));
    const tail = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([hc.clone().add(new THREE.Vector3(0, 0.05, -0.085)), hc.clone().add(new THREE.Vector3(0, -0.04, -0.105)), hc.clone().add(new THREE.Vector3(0.005, -0.15, -0.09))]), 12, 0.017, 8);
    add('Head', 'hair', paint(tail, (q) => (Math.sin(q.y * 400) > 0 ? C.hair : C.hairDark), 0.05));

    // ---------------- Sandogasa: wide, shallow straw hat, battered and frayed ----------------
    const R = 0.34, H = 0.1, top = hc.clone().add(new THREE.Vector3(0, 0.1, 0.012));
    const hat = new THREE.RingGeometry(0.0001, R, 200, 48);
    const hpz = hat.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < hpz.count; i++) {
      const x = hpz.getX(i), y = hpz.getY(i), r = Math.hypot(x, y), a = Math.atan2(y, x);
      // Shallow cone that droops at the rim; a dent and a worn, frayed edge.
      let h = H * (1 - r / R) - Math.pow(r / R, 3) * 0.035;
      h -= Math.exp(-((a - 2.3) ** 2) * 6) * Math.max(0, r / R - 0.4) * 0.03;
      const fray = r > R * 0.98 ? (fbm(a * 9, 3, 2) * 0.012) : 0;
      hpz.setXYZ(i, x * (1 + fray / R), h, -y * (1 + fray / R));
    }
    // A small tear in the brim.
    const hiIdx = hat.index!;
    const keepH: number[] = [];
    for (let i = 0; i < hiIdx.count; i += 3) {
      const a = hiIdx.getX(i);
      const ang = Math.atan2(-hpz.getZ(a), hpz.getX(a)), rr = Math.hypot(hpz.getX(a), hpz.getZ(a));
      if (!(Math.abs(ang - 0.9) < 0.07 && rr > R * 0.82)) keepH.push(hiIdx.getX(i), hiIdx.getX(i + 1), hiIdx.getX(i + 2));
    }
    hat.setIndex(keepH);
    hat.computeVertexNormals();
    hat.rotateX(-0.12).translate(top.x, top.y, top.z);
    add('Head', 'straw', paint(hat.toNonIndexed(), (q) => {
      const r = Math.hypot(q.x - top.x, q.z - top.z), a = Math.atan2(q.z - top.z, q.x - top.x);
      // Hand-plaited straw: rings wander, spokes vary in width, strands differ in tone.
      const warp = fbm(q.x * 40, q.z * 40, 2) * 0.012;
      const ring = Math.sin((r + warp) * 380 + fbm(a * 3, r * 20, 2) * 2.5);
      const spoke = Math.sin(a * (100 + 20 * Math.sin(r * 30)) + fbm(r * 50, a, 2) * 3);
      const strand = 0.8 + 0.4 * fbm(Math.floor(r * 140) * 0.37, Math.floor(a * 30) * 0.21, 1);
      void ring; void spoke;
      let c = new THREE.Color(1, 1, 1).multiplyScalar(0.85 * strand);
      c.multiplyScalar(0.8 + fbm(q.x * 30, q.z * 30, 2) * 0.35);              // grime and rain stains
      c.lerp(srgb(0.66, 0.62, 0.52), 0.35 * Math.max(0, 1 - r / (R * 0.7)));   // sun-bleached crown
      const da = ((a - 2.3 + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
      const worn = Math.exp(-(da * da) * 3) * Math.max(0, r / R - 0.45);
      c.lerp(srgb(0.2, 0.15, 0.1), Math.min(0.75, worn * 1.6));               // darkened, worn patch where the brim is gripped
      if (r > R * 0.9) c.multiplyScalar(0.7);
      return c;
    }, 0.06));
    const crown = new THREE.CylinderGeometry(0.075, 0.085, 0.03, 18, 1, true).translate(top.x, top.y - 0.005, top.z);
    add('Head', 'straw', paint(crown, flat(C.strawDark)));
    // Chin cord.
    for (const s of [-1, 1]) {
      const cord = new THREE.TubeGeometry(new THREE.CatmullRomCurve3([top.clone().add(new THREE.Vector3(s * 0.075, -0.01, 0)), hc.clone().add(new THREE.Vector3(s * 0.07, -0.06, 0.02)), hc.clone().add(new THREE.Vector3(0, -0.13, 0.05))]), 10, 0.003, 4);
      add('Head', 'cloth', paint(cord, flat(C.rope.clone().multiplyScalar(0.6))));
    }
  }

  // Neck: skin bridging the collar and the head, then a gathered cloth scarf (kubimaki) wound twice
  // around it that hides the scan's trim line and the top of the robe.
  add('neck_01', 'skin', paint(new THREE.CylinderGeometry(0.052, 0.058, 0.12, 14, 1, true).translate(neck.x, neck.y + 0.04, neck.z + 0.008), flat(C.skin.clone().multiplyScalar(0.8))));
  for (let k = 0; k < 3; k++) {
    const t = new THREE.TorusGeometry(0.064 + k * 0.006, 0.02 - k * 0.003, 10, 28).rotateX(Math.PI / 2);
    const tp = t.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < tp.count; i++) { const a = Math.atan2(tp.getZ(i), tp.getX(i)); tp.setY(i, tp.getY(i) + Math.sin(a * 6 + k) * 0.004 + Math.sin(a) * 0.012 * (k - 1)); }
    t.computeVertexNormals();
    t.translate(neck.x, neck.y + 0.065 - k * 0.022, neck.z + 0.004);
    add(k === 0 ? 'neck_01' : 'spine_03', 'cloth', paint(t, (q) => (Math.sin(Math.atan2(q.z - neck.z, q.x) * 10) > 0.4 ? C.robeDark : srgb(0.22, 0.24, 0.29)), 0.05));
  }

  // ---------------- Drawn blade (hidden until drawn), held in the right hand ----------------
  const blade = new THREE.Group();
  {
    const h = P('hand_r'), lw = P('lowerarm_r'), ix = P('index_01_r'), pk = P('pinky_01_r');
    const along = h.clone().sub(lw).normalize();
    // A fist closes around the grip across the knuckles; the blade leaves on the thumb (index) side.
    const bx = pk.clone().sub(ix).normalize();
    const by = new THREE.Vector3().crossVectors(along, bx).normalize();
    const bz = new THREE.Vector3().crossVectors(bx, by).normalize();
    const F = new THREE.Matrix4().makeBasis(bx, by, bz).setPosition(ix.clone().add(pk).multiplyScalar(0.5).addScaledVector(along, 0.03));
    const parts: [THREE.BufferGeometry, M][] = [];
    const grip = new THREE.CylinderGeometry(0.016, 0.017, 0.27, 8, 10).rotateZ(-Math.PI / 2).translate(-0.04, 0, 0);
    parts.push([paint(grip, (q) => (Math.abs(((q.x * 26) % 1 + 1) % 1 - 0.5) < 0.14 ? C.rope.clone().multiplyScalar(0.55) : C.lacquer), 0.15), 'cloth']);
    parts.push([paint(new THREE.CylinderGeometry(0.04, 0.04, 0.007, 14).rotateZ(-Math.PI / 2).translate(0.1, 0, 0), flat(C.iron)), 'metal']);
    const bl = new THREE.BoxGeometry(0.7, 0.03, 0.007, 20, 1, 1).translate(0.455, 0, 0);
    const bp = bl.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < bp.count; i++) { const x = bp.getX(i) - 0.1; bp.setY(i, bp.getY(i) + (x / 0.7) ** 2 * 0.03 - (x > 0.66 ? (x - 0.66) * 0.6 * Math.sign(bp.getY(i) + 1e-6) * 0 : 0)); }
    bl.computeVertexNormals();
    parts.push([paint(bl, flat(C.steel), 0.03), 'metal']);
    for (const [g, m] of parts) { g.applyMatrix4(F); const mesh = new THREE.Mesh(g, mats[m]); mesh.castShadow = true; blade.add(mesh); }
    blade.visible = false;
    blade.applyMatrix4(model.matrixWorld);
    bones['hand_r'].attach(blade);
  }

  // ---------------- Assemble ----------------
  for (const { bone, mat, geos } of groups.values()) {
    // Each part carries its own smooth normals; merging non-indexed copies keeps them (no re-faceting).
    const keepAttr = mat === 'straw' ? ['position', 'normal', 'color', 'uv'] : ['position', 'normal', 'color'];
    const g = mergeGeometries(geos.map((x) => { if (!x.getAttribute('normal')) x.computeVertexNormals(); for (const k of Object.keys(x.attributes)) if (!keepAttr.includes(k)) x.deleteAttribute(k); return x.index ? x.toNonIndexed() : x; }), false)!;
    const mesh = new THREE.Mesh(g, mats[mat]);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.applyMatrix4(model.matrixWorld);
    bones[bone].attach(mesh);
  }

  // Base outfit: tunic to oat under the robe, boots darkened; broader, heavier build.
  model.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    const mat = (m.material as THREE.MeshStandardMaterial).clone();
    const feet = /Feet/.test(m.name);
    const isSkin = /Regular_Male/.test((m.material as THREE.Material).name);
    mat.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
        { float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          ${feet ? 'diffuseColor.rgb = vec3(l) * vec3(0.42, 0.38, 0.34);' : isSkin ? 'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(l) * vec3(1.1, 0.82, 0.64), 0.55) * vec3(0.74, 0.62, 0.52);' : 'diffuseColor.rgb = vec3(l) * vec3(0.3, 0.33, 0.42);'} }`);
    };
    mat.customProgramCacheKey = () => `mentor-base-${feet}-${isSkin}`;
    m.material = mat;
  });
  model.scale.multiply(new THREE.Vector3(1.07, 1.02, 1.07));

  const sb = bones['spine_02'], nb = bones['neck_01'], cl = bones['clavicle_l'], cr = bones['clavicle_r'];

  // ---------- Pose helpers (world-space aiming on top of the animated pose) ----------
  const tmpQ = new THREE.Quaternion(), tmpV = new THREE.Vector3(), tmpW = new THREE.Vector3();
  const worldPos = (b: THREE.Object3D) => new THREE.Vector3().setFromMatrixPosition(b.matrixWorld);
  /** Rotates `bone` so the direction to `child` points at `target` (world). */
  const aim = (bone: THREE.Bone, child: THREE.Object3D, target: THREE.Vector3) => {
    bone.updateMatrixWorld(true);
    const o = worldPos(bone), cur = worldPos(child).sub(o).normalize(), want = target.clone().sub(o).normalize();
    const delta = tmpQ.setFromUnitVectors(cur, want);
    const parentQ = bone.parent!.getWorldQuaternion(new THREE.Quaternion());
    const worldQ = bone.getWorldQuaternion(new THREE.Quaternion()).premultiply(delta);
    bone.quaternion.copy(parentQ.invert().multiply(worldQ));
    bone.updateMatrixWorld(true);
  };
  /** Rotates `bone` so a bone-local axis points along `want` (world). */
  const aimAxis = (bone: THREE.Bone, axisLocal: THREE.Vector3, want: THREE.Vector3) => {
    bone.updateMatrixWorld(true);
    const wq = bone.getWorldQuaternion(new THREE.Quaternion());
    const cur = axisLocal.clone().applyQuaternion(wq);
    const worldQ = wq.premultiply(tmpQ.setFromUnitVectors(cur.normalize(), want.clone().normalize()));
    bone.quaternion.copy(bone.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(worldQ));
    bone.updateMatrixWorld(true);
  };
  /** Two-bone arm IK: shoulder-elbow-hand, with the elbow pushed toward `pole`. */
  const arm = (side: 'l' | 'r', hand: THREE.Vector3, pole: THREE.Vector3) => {
    const ua = bones[`upperarm_${side}`], la = bones[`lowerarm_${side}`], hd = bones[`hand_${side}`];
    model.updateMatrixWorld(true);
    const S = worldPos(ua), L1 = S.distanceTo(worldPos(la)), L2 = worldPos(la).distanceTo(worldPos(hd));
    const toH = hand.clone().sub(S);
    const d = Math.min(toH.length(), L1 + L2 - 1e-3);
    const dir = toH.normalize();
    const a = (L1 * L1 + d * d - L2 * L2) / (2 * d);
    const h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
    const pv = pole.clone().sub(S); pv.sub(dir.clone().multiplyScalar(pv.dot(dir))).normalize();
    const elbow = S.clone().addScaledVector(dir, a).addScaledVector(pv, h);
    aim(ua, la, elbow);
    aim(la, hd, S.clone().addScaledVector(dir, d));
  };
  // Blade axis in hand-bone space, captured at rest.
  bones['hand_r'].updateMatrixWorld(true);
  const bladeLocal = (() => {
    const ix = P('index_01_r'), pk = P('pinky_01_r');
    const wDir = pk.clone().sub(ix).normalize().transformDirection(model.matrixWorld);
    return wDir.applyQuaternion(bones['hand_r'].getWorldQuaternion(new THREE.Quaternion()).invert());
  })();
  /** Per hand, in hand-bone space at rest: grip axis (along the hilt), finger direction, grip point offset. */
  const gripInfo = (side: 'l' | 'r') => {
    const hb = bones[`hand_${side}`];
    hb.updateMatrixWorld(true);
    const qi = hb.getWorldQuaternion(new THREE.Quaternion()).invert();
    const W = P(`hand_${side}`), L = P(`lowerarm_${side}`), ix = P(`index_01_${side}`), pk = P(`pinky_01_${side}`), md = P(`middle_02_${side}`);
    const toW = (v: THREE.Vector3) => v.clone().transformDirection(model.matrixWorld).applyQuaternion(qi);
    const axis = toW(pk.clone().sub(ix).normalize());
    const fingers = toW(md.clone().sub(W).normalize());
    fingers.sub(axis.clone().multiplyScalar(fingers.dot(axis))).normalize();
    // The hilt sits in the curled fingers: past the knuckles, toward the palm.
    const palm = new THREE.Vector3().crossVectors(axis, fingers).multiplyScalar(side === 'r' ? 1 : -1);
    const gp = ix.clone().add(pk).multiplyScalar(0.5).add(L.clone().sub(W).normalize().multiplyScalar(-0.025));
    const off = gp.clone().sub(W).applyMatrix4(new THREE.Matrix4().copy(model.matrixWorld).setPosition(0, 0, 0)).applyQuaternion(qi);
    void palm;
    return { axis, fingers, off };
  };
  const grips = { l: gripInfo('l'), r: gripInfo('r') };
  /** Sets a hand's world rotation so its grip axis runs along `dir` and its fingers wrap toward `wrap`. */
  const orientHand = (side: 'l' | 'r', dir: THREE.Vector3, wrap: THREE.Vector3) => {
    const hb = bones[`hand_${side}`], gi = grips[side];
    const A = dir.clone().normalize(), F = wrap.clone().sub(A.clone().multiplyScalar(wrap.dot(A))).normalize();
    const Bl = new THREE.Matrix4().makeBasis(gi.axis, gi.fingers, new THREE.Vector3().crossVectors(gi.axis, gi.fingers));
    const Bw = new THREE.Matrix4().makeBasis(A, F, new THREE.Vector3().crossVectors(A, F));
    const worldQ = new THREE.Quaternion().setFromRotationMatrix(Bw.multiply(Bl.invert()));
    hb.quaternion.copy(hb.parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(worldQ));
    hb.updateMatrixWorld(true);
    return worldQ;
  };
  void tmpV; void tmpW;
  const cfg = globalThis as { __curl?: number; __curlAxis?: [number, number, number] };
  const curl = cfg.__curl ?? 1.1;
  const curlAxis = new THREE.Vector3(...(cfg.__curlAxis ?? [0, 0, 1]));

  return {
    setDrawn(d) { blade.visible = d; },
    applyGuard() {
      // Chudan-no-kamae: hilt held centred just below the navel, right hand forward of the left,
      // blade rising forward toward the opponent's throat. Elbows close, shoulders settled.
      const M = model.matrixWorld;
      const pt = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).applyMatrix4(M);
      sb.rotateX(0.1);
      model.updateMatrixWorld(true);
      const rIsNegX = worldPos(bones['upperarm_r']).clone().applyMatrix4(M.clone().invert()).x < 0;
      const sx = rIsNegX ? -1 : 1;
      const fwd = new THREE.Vector3(0, 0.62, 1).transformDirection(M).normalize();
      // Fingers wrap down and back around the hilt (the hilt lies across the palms, edge forward).
      const wrap = new THREE.Vector3(0, -1, -0.35).transformDirection(M);
      // Grip points on the hilt: right hand just behind the guard, left hand a fist-width behind at the pommel end.
      const hiltR = pt(0, 1.08, 0.36), hiltL = hiltR.clone().addScaledVector(fwd, -0.105);
      const ms = new THREE.Vector3(); M.decompose(new THREE.Vector3(), new THREE.Quaternion(), ms);
      for (let pass = 0; pass < 3; pass++) for (const side of ['r', 'l'] as const) {
        const target = side === 'r' ? hiltR : hiltL;
        const q = orientHand(side, fwd, wrap);
        const wrist = target.clone().sub(grips[side].off.clone().multiply(ms).applyQuaternion(q));
        arm(side, wrist, pt(side === 'r' ? sx * 0.55 : -sx * 0.55, 0.85, 0.05));
        orientHand(side, fwd, wrap);
      }
      // Close the fingers around the hilt.
      for (const side of ['l', 'r']) for (const f of ['index', 'middle', 'ring', 'pinky']) for (const k of ['01', '02', '03']) bones[`${f}_${k}_${side}`]?.rotateOnAxis(curlAxis, curl * (k === '01' ? 0.8 : 1.15));
      for (const side of ['l', 'r']) { bones[`thumb_02_${side}`]?.rotateOnAxis(curlAxis, curl * 0.6); bones[`thumb_03_${side}`]?.rotateOnAxis(curlAxis, curl * 0.6); }
      blade.visible = true;
    },
    applyPosture() {
      // Weight settled forward, shoulders broad and slightly rounded, head held level.
      sb.rotateX(0.07);
      nb.rotateX(-0.08);
      cl.rotateZ(0.05); cr.rotateZ(-0.05);
    },
  };
}
