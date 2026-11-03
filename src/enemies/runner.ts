import * as THREE from 'three';
import { Dresser, F, blob, band, flat, frame, handMount, makeMaterials, paint, panel, plate, recolour, rngFor, tail } from './kit';

/**
 * Ash Runner: lean skirmisher on the Quaternius Peasant body. Lacquered leather chest plate, rust sash and
 * headcloth with trailing tails, pale half-mask, bound forearms and shins, two short curved blades.
 * Call on a fresh clone at rest (before any animation).
 */
export interface RunnerParts { blades: { l: THREE.Object3D; r: THREE.Object3D }; tips: { l: THREE.Object3D; r: THREE.Object3D } }

export function dressRunner(model: THREE.Object3D): RunnerParts {
  const rnd = rngFor(9021);
  const d = new Dresser(model, makeMaterials('runner'));
  let body: THREE.SkinnedMesh | null = null;
  model.traverse((o) => { if (/Peasant_Body$/.test(o.name)) body = o as THREE.SkinnedMesh; });
  const P = (n: string) => d.P(n);
  const sx = P('upperarm_r').x < 0 ? -1 : 1; // model-space x sign of the character's right side
  const pelvis = P('pelvis'), neck = P('neck_01'), head = P('Head');
  const waist = pelvis.y + 0.07, chestTop = neck.y - 0.07;
  const sec = (y: number) => { const s = d.section(body!, y); return { ...s, rx: Math.min(s.rx, 0.17), rz: Math.min(s.rz, 0.12) }; };

  // ---- Head (the Peasant body is headless): skull, headcloth, half-mask, mouth cloth ----
  {
    const hc = head.clone().add(new THREE.Vector3(0, 0.085, 0.012));
    d.add('Head', 'skin', paint(blob(hc, new THREE.Vector3(0.082, 0.105, 0.095), 22), flat(F.skin), rnd));
    d.add('neck_01', 'skin', paint(new THREE.CylinderGeometry(0.052, 0.058, 0.12, 14).translate(neck.x, neck.y + 0.03, neck.z + 0.005), flat(F.skin), rnd));
    // Headcloth: wrapped over the crown and down the back of the skull, knotted behind.
    const cloth = new THREE.SphereGeometry(1, 26, 16, 0, Math.PI * 2, 0, Math.PI * 0.56);
    const cp = cloth.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < cp.count; i++) {
      const x = cp.getX(i), y = cp.getY(i), z = cp.getZ(i);
      const backDrop = z < 0 ? -z * 0.45 : 0; // covers more of the back of the head
      cp.setXYZ(i, hc.x + x * 0.092, hc.y + 0.006 + (y - backDrop) * 0.115 + Math.sin(Math.atan2(z, x) * 9) * 0.003, hc.z + z * 0.104);
    }
    cloth.computeVertexNormals();
    d.add('Head', 'cloth', paint(cloth, (q) => (Math.sin((q.y - hc.y) * 160) > 0.6 ? F.rust2 : F.rust), rnd, 0.05));
    d.add('Head', 'cloth', paint(blob(hc.clone().add(new THREE.Vector3(0, -0.01, -0.1)), new THREE.Vector3(0.03, 0.026, 0.024), 12), flat(F.rust2), rnd));
    for (const [w, k] of [[1, 0], [-1, 1]] as const) {
      const t = tail(0.34 + k * 0.06, 0.045, 0.02, 0.16, k ? F.rust2 : F.rust, rnd);
      t.rotateY(Math.PI).rotateZ(w * 0.18).translate(hc.x + w * 0.012, hc.y - 0.012, hc.z - 0.112);
      d.add('Head', 'cloth', t);
    }
    // Pale half-mask, brow to nose, with narrow eye slits and one red line down the centre.
    const mask = new THREE.SphereGeometry(1, 28, 14, Math.PI * 0.18, Math.PI * 0.64, Math.PI * 0.34, Math.PI * 0.2);
    const mp = mask.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < mp.count; i++) mp.setXYZ(i, hc.x + mp.getX(i) * 0.091, hc.y + mp.getY(i) * 0.112 + 0.005, hc.z + mp.getZ(i) * 0.104 + 0.006);
    mask.computeVertexNormals();
    d.add('Head', 'mask', paint(mask, (q) => {
      const x = (q.x - hc.x) * sx, y = q.y - hc.y;
      if (Math.abs(x) < 0.0045) return F.red;
      const slit = Math.abs(y - 0.004 + Math.abs(x) * 0.12) < 0.0055 && Math.abs(x) > 0.012 && Math.abs(x) < 0.052;
      return slit ? F.soot : y > 0.03 ? F.maskShade : F.mask;
    }, rnd, 0.03));
    // Soot cloth over mouth and jaw.
    const low = new THREE.SphereGeometry(1, 24, 10, Math.PI * 0.12, Math.PI * 0.76, Math.PI * 0.53, Math.PI * 0.27);
    const lp = low.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < lp.count; i++) lp.setXYZ(i, hc.x + lp.getX(i) * 0.094, hc.y + lp.getY(i) * 0.118 - 0.006, hc.z + lp.getZ(i) * 0.104 + 0.004);
    low.computeVertexNormals();
    d.add('Head', 'cloth', paint(low, flat(F.soot2), rnd, 0.05));
  }

  // ---- Under-tunic collar, crossed at the throat (rust) ----
  for (const s of [-1, 1]) {
    const g = new THREE.BoxGeometry(0.03, 0.13, 0.008).rotateZ(s * 0.6);
    const z = sec(chestTop).cz + sec(chestTop).rz + 0.012;
    g.translate(neck.x + s * 0.025, chestTop - 0.005, z);
    d.add('spine_03', 'cloth', paint(g, flat(s > 0 ? F.rust : F.rust2), rnd));
  }

  // ---- Chest plate: five lacquered leather lames front and sides, red lacing at the centre ----
  for (let i = 0; i < 5; i++) {
    const t = i / 4, y = chestTop - 0.035 - t * (chestTop - waist - 0.085);
    const s = sec(y);
    const g = band(s.rx + 0.03, s.rz + 0.028, 0.06, 30);
    g.translate(s.cx, y, s.cz + 0.004);
    d.add(t < 0.5 ? 'spine_03' : 'spine_02', 'hard', paint(g, (q) => {
      const x = (q.x - s.cx) * sx; const front = q.z > s.cz;
      if (front && Math.abs(x) < 0.008) return F.red;
      return q.y > y + 0.022 ? F.soot2 : F.lacquer;
    }, rnd, 0.06));
  }
  // Shoulder straps over the tunic.
  for (const s of [-1, 1]) {
    const g = new THREE.BoxGeometry(0.035, 0.012, 0.24).translate(neck.x + s * 0.085, chestTop + 0.03, sec(chestTop).cz);
    d.add('spine_03', 'hard', paint(g, flat(F.lacquer), rnd));
  }

  // ---- Rust sash with a knot and two long trailing tails ----
  {
    const s = sec(waist);
    d.add('pelvis', 'cloth', paint(band(s.rx + 0.035, s.rz + 0.033, 0.075, 30).translate(s.cx, waist, s.cz), (q) => (Math.sin(q.y * 220) > 0.5 ? F.rust2 : F.rust), rnd, 0.05));
    const kx = s.cx + sx * 0.06, kz = s.cz + s.rz + 0.03;
    d.add('pelvis', 'cloth', paint(blob(new THREE.Vector3(kx, waist, kz), new THREE.Vector3(0.028, 0.03, 0.02), 12), flat(F.rust2), rnd));
    const front = tail(0.3, 0.05, 0.035, 0.04, F.rust, rnd); front.translate(kx, waist - 0.01, kz + 0.005); d.add('pelvis', 'cloth', front);
    for (const [w, k] of [[1, 0], [-1, 1]] as const) {
      const t = tail(0.5 + k * 0.08, 0.06, 0.035, 0.22, k ? F.rust2 : F.rust, rnd);
      t.rotateY(Math.PI).translate(s.cx + w * 0.04, waist - 0.02, s.cz - s.rz - 0.04);
      d.add('pelvis', 'cloth', t);
    }
    // Short split skirt below the plate (front and back flaps).
    for (const z of [1, -1]) {
      const g = panel(0.24, 0.2, 0.03, 3, F.soot2, F.soot, rnd);
      if (z < 0) g.rotateY(Math.PI);
      g.translate(s.cx, waist - 0.035, s.cz + z * (s.rz + 0.04));
      d.add('pelvis', 'cloth', g);
    }
  }

  // ---- Arms: bound forearms, leather wrist grips ----
  for (const side of ['l', 'r'] as const) {
    const e = P(`lowerarm_${side}`), w = P(`hand_${side}`);
    const fl = e.distanceTo(w), Fm = frame(e, w);
    for (let k = 0; k < 7; k++) {
      const rr = 0.047 - k * 0.0022;
      const g = new THREE.CylinderGeometry(rr, rr + 0.002, 0.038, 12, 1, true).rotateZ(-Math.PI / 2).rotateX(0.22 * (k % 2 ? 1 : -1)).translate(fl * (0.22 + k * 0.105), 0, 0);
      d.add(`lowerarm_${side}`, 'cloth', paint(g, flat(k % 2 ? F.wrap : F.wrap2), rnd), Fm);
    }
    const under = new THREE.CylinderGeometry(0.046, 0.038, fl * 0.86, 14, 1, true).rotateZ(-Math.PI / 2).translate(fl * 0.55, 0, 0);
    d.add(`lowerarm_${side}`, 'cloth', paint(under, flat(F.wrap2), rnd), Fm);
    const cuff = new THREE.CylinderGeometry(0.041, 0.043, 0.045, 14, 1, true).rotateZ(-Math.PI / 2).translate(fl * 0.95, 0, 0);
    d.add(`lowerarm_${side}`, 'hard', paint(cuff, flat(F.leather), rnd), Fm);
  }

  // ---- Legs: leather shin guards and knee caps over bound trousers ----
  for (const side of ['l', 'r'] as const) {
    const k = P(`calf_${side}`), a = P(`foot_${side}`);
    const ll = k.distanceTo(a), Fm = frame(k, a, new THREE.Vector3(0, 0, 1));
    for (let i = 0; i < 6; i++) {
      const g = new THREE.CylinderGeometry(0.058 - i * 0.002, 0.06 - i * 0.002, 0.036, 12, 1, true).rotateZ(-Math.PI / 2).rotateX(0.2 * (i % 2 ? 1 : -1)).translate(ll * (0.15 + i * 0.13), 0, 0);
      d.add(`calf_${side}`, 'cloth', paint(g, flat(i % 2 ? F.wrap : F.wrap2), rnd), Fm);
    }
    const shin = plate(0.075, ll * 0.7, 0.008, 0.06, 8).rotateZ(Math.PI / 2);
    shin.translate(ll * 0.45, 0, 0.0);
    const m = Fm.clone().multiply(new THREE.Matrix4().makeTranslation(0, 0.062, 0)).multiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
    d.add(`calf_${side}`, 'hard', paint(shin, (q) => (Math.abs(q.x) < 0.004 ? F.leather2 : F.leather), rnd), m);
    d.add(`calf_${side}`, 'hard', paint(blob(k.clone().add(new THREE.Vector3(0, 0.01, 0.06)), new THREE.Vector3(0.042, 0.04, 0.022), 12), flat(F.leather2), rnd));
  }

  // ---- Twin short curved blades ----
  const mkBlade = (side: 'l' | 'r') => {
    const mount = handMount(d, side);
    const parts: [THREE.BufferGeometry, 'metal' | 'wood' | 'hard'][] = [];
    // Single-edged blade, 44 cm, curving toward the back edge.
    const bl = new THREE.BoxGeometry(0.006, 0.44, 0.032, 1, 24, 1).translate(0, 0.29, 0);
    const bp = bl.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < bp.count; i++) {
      const y = bp.getY(i), t = (y - 0.07) / 0.44;
      const taper = t > 0.82 ? 1 - (t - 0.82) / 0.18 * 0.85 : 1;
      const z = bp.getZ(i) * taper + (bp.getZ(i) > 0 ? 0 : 0) - t * t * 0.07;
      bp.setXYZ(i, bp.getX(i) * (1 - t * 0.5), y, z);
    }
    bl.computeVertexNormals();
    parts.push([paint(bl, (q) => (q.z > 0.012 - (q.y - 0.07) * (q.y - 0.07) * 0.36 ? F.steel : F.iron2), rnd, 0.03), 'metal']);
    parts.push([paint(new THREE.CylinderGeometry(0.035, 0.035, 0.008, 12).translate(0, 0.068, 0), flat(F.iron), rnd), 'metal']);
    parts.push([paint(new THREE.CylinderGeometry(0.014, 0.015, 0.13, 10).translate(0, 0.005, 0), (q) => (Math.sin(q.y * 140) > 0 ? F.rust : F.rust2), rnd, 0.04), 'wood']);
    parts.push([paint(new THREE.SphereGeometry(0.018, 10, 8).translate(0, -0.065, 0), flat(F.iron), rnd), 'metal']);
    const g = new THREE.Group();
    for (const [geo, m] of parts) { const mesh = new THREE.Mesh(geo, d.mats[m]); mesh.castShadow = true; g.add(mesh); }
    mount.add(g);
    const tip = new THREE.Object3D(); tip.position.y = 0.5; mount.add(tip);
    return { mount, tip };
  };
  const bl = mkBlade('l'), br = mkBlade('r');

  d.assemble();
  // Base outfit: tunic to soot, trousers dark grey, sandals near-black, skin sun-dark.
  recolour(model, 'runner', (name, isSkin) => {
    if (isSkin) return [0.62, 0.44, 0.33];
    if (/Feet/.test(name)) return [0.16, 0.15, 0.14];
    if (/Legs/.test(name)) return [0.22, 0.21, 0.2];
    return [0.17, 0.155, 0.145];
  });
  return { blades: { l: bl.mount, r: br.mount }, tips: { l: bl.tip, r: br.tip } };
}
