import * as THREE from 'three';
import { Dresser, F, blob, band, flat, frame, handMount, makeMaterials, paint, panel, plate, recolour, rngFor } from './kit';

/**
 * Iron Breaker: heavy bruiser on the Quaternius Ranger body at 1.15x. Quilted rust coat under an iron
 * cuirass, hanging tassets, three-lame pauldrons, horned iron helmet with mail neck guard and a full pale
 * mask, iron greaves, and a two-handed studded war club. Call on a fresh clone at rest, already scaled.
 */
export const BREAKER_SCALE = 1.15;
export const CLUB = { pommel: 0.24, tip: 1.5, headR: 0.085, grip: 0.0, spacing: 0.17 };

export interface BreakerParts { club: THREE.Object3D; tip: THREE.Object3D }

export function dressBreaker(model: THREE.Object3D): BreakerParts {
  const rnd = rngFor(7333);
  // The Ranger's hood, pauldron, bracers and belts are replaced by the Breaker's own gear.
  model.traverse((o) => { if (/Head_Hood|Acc_Pauldron|Arms_Bracer|Belt/.test(o.name)) o.visible = false; });
  const d = new Dresser(model, makeMaterials('breaker'));
  let body: THREE.SkinnedMesh | null = null;
  model.traverse((o) => { if (/Ranger_Body$/.test(o.name)) body = o as THREE.SkinnedMesh; });
  const P = (n: string) => d.P(n);
  const sx = P('upperarm_r').x < 0 ? -1 : 1;
  const pelvis = P('pelvis'), neck = P('neck_01'), head = P('Head');
  const waist = pelvis.y + 0.08, chestTop = neck.y - 0.06;
  const sec = (y: number) => { const s = d.section(body!, y, 0.35); return { ...s, rx: Math.min(s.rx, 0.2), rz: Math.min(s.rz, 0.15) }; };

  // ---- Head under the helmet, mail neck guard, helmet bowl, brim, horns, full mask ----
  {
    const hc = head.clone().add(new THREE.Vector3(0, 0.09, 0.012));
    d.add('Head', 'skin', paint(blob(hc, new THREE.Vector3(0.085, 0.108, 0.097), 18), flat(F.soot2), rnd));
    // Mail aventail: hangs from the brim around the sides and back to the shoulders.
    const av = new THREE.CylinderGeometry(0.112, 0.15, 0.17, 30, 6, true, Math.PI * 0.2, Math.PI * 1.6);
    av.rotateY(Math.PI).translate(hc.x, hc.y - 0.08, hc.z - 0.004);
    d.add('Head', 'metal', paint(av, (q) => ((Math.round((q.y - hc.y) * 160) % 2) ? F.iron : F.soot2), rnd, 0.1));
    // Bowl.
    const bowl = new THREE.SphereGeometry(1, 30, 16, 0, Math.PI * 2, 0, Math.PI * 0.52);
    const bp = bowl.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < bp.count; i++) bp.setXYZ(i, hc.x + bp.getX(i) * 0.112, hc.y + 0.02 + bp.getY(i) * 0.13, hc.z + bp.getZ(i) * 0.122);
    bowl.computeVertexNormals();
    d.add('Head', 'metal', paint(bowl, (q) => (Math.abs(q.x - hc.x) < 0.012 ? F.iron2 : F.iron), rnd, 0.05));
    // Brim.
    const brim = new THREE.CylinderGeometry(0.15, 0.17, 0.018, 34, 1, false).translate(hc.x, hc.y + 0.02, hc.z);
    d.add('Head', 'metal', paint(brim, flat(F.iron2), rnd));
    d.add('Head', 'cloth', paint(new THREE.TorusGeometry(0.125, 0.008, 6, 34).rotateX(Math.PI / 2).translate(hc.x, hc.y + 0.035, hc.z), flat(F.rust), rnd));
    // Crest plate and two short swept-back horns.
    d.add('Head', 'metal', paint(new THREE.BoxGeometry(0.03, 0.06, 0.03).translate(hc.x, hc.y + 0.15, hc.z + 0.035), flat(F.iron2), rnd));
    for (const s of [-1, 1]) {
      const pts = [0, 0.25, 0.5, 0.75, 1].map((t) => new THREE.Vector3(hc.x + s * (0.03 + t * 0.15), hc.y + 0.14 + t * 0.14 - t * t * 0.02, hc.z + 0.02 - t * t * 0.12));
      const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 12, 0.016, 8, false);
      const tp = tube.getAttribute('position') as THREE.BufferAttribute;
      // Taper toward the tip.
      for (let i = 0; i < tp.count; i++) {
        const v = new THREE.Vector3().fromBufferAttribute(tp, i);
        const t = Math.min(1, Math.abs(v.x - hc.x) / 0.18), c = new THREE.CatmullRomCurve3(pts).getPoint(t);
        v.sub(c).multiplyScalar(1 - t * 0.8).add(c); tp.setXYZ(i, v.x, v.y, v.z);
      }
      tube.computeVertexNormals();
      d.add('Head', 'hard', paint(tube, flat(F.soot2), rnd, 0.05));
    }
    // Full pale mask on the faceplate: heavy brow, deep eye holes, red slashes, carved frown.
    const mask = new THREE.SphereGeometry(1, 30, 18, Math.PI * 0.1, Math.PI * 0.8, Math.PI * 0.36, Math.PI * 0.5);
    const mp = mask.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < mp.count; i++) {
      const x = mp.getX(i), y = mp.getY(i), z = mp.getZ(i);
      const brow = Math.exp(-((y + 0.02) ** 2) / 0.004) * 0.08; // heavy brow ridge
      mp.setXYZ(i, hc.x + x * 0.104, hc.y - 0.012 + y * 0.135, hc.z + z * (0.118 + brow * 0.25) + 0.014);
    }
    mask.computeVertexNormals();
    d.add('Head', 'mask', paint(mask, (q) => {
      const x = (q.x - hc.x) * sx, y = q.y - hc.y, ax = Math.abs(x);
      if (ax > 0.016 && ax < 0.052 && Math.abs(y + 0.016 - ax * 0.15) < 0.009) return F.soot;                  // eye holes
      if (ax > 0.008 && ax < 0.058 && Math.abs(y + 0.002 - (0.058 - ax) * 0.35) < 0.004) return F.red;         // brow slashes
      if (ax < 0.03 && Math.abs(y + 0.085 - ax * ax * 12) < 0.0035) return F.soot;                              // frown
      if (ax < 0.006 && y < -0.02 && y > -0.06) return F.maskShade;                                            // nose ridge
      return F.mask;
    }, rnd, 0.03));
    // Gorget.
    d.add('neck_01', 'metal', paint(band(0.085, 0.08, 0.06, 24, 0.25).translate(neck.x, neck.y + 0.01, neck.z + 0.005), flat(F.iron2), rnd));
  }

  // ---- Cuirass: six horizontal iron plates all round, red cord at the centre ----
  for (let i = 0; i < 6; i++) {
    const t = i / 5, y = chestTop - 0.03 - t * (chestTop - waist - 0.06);
    const s = sec(y);
    const g = band(s.rx + 0.04, s.rz + 0.04, 0.072, 34);
    g.translate(s.cx, y, s.cz + 0.006);
    d.add(t < 0.4 ? 'spine_03' : t < 0.8 ? 'spine_02' : 'spine_01', 'metal', paint(g, (q) => {
      const x = (q.x - s.cx) * sx, front = q.z > s.cz;
      if (front && Math.abs(x) < 0.009 && Math.sin(q.y * 260) > 0) return F.red;
      return q.y > y + 0.028 ? F.iron2 : F.iron;
    }, rnd, 0.06));
  }
  // Leather belt with an iron buckle.
  {
    const s = sec(waist);
    d.add('pelvis', 'hard', paint(band(s.rx + 0.05, s.rz + 0.048, 0.06, 32).translate(s.cx, waist, s.cz), flat(F.leather), rnd));
    d.add('pelvis', 'metal', paint(new THREE.BoxGeometry(0.06, 0.07, 0.015).translate(s.cx, waist, s.cz + s.rz + 0.055), flat(F.iron2), rnd));
  }

  // ---- Quilted rust coat skirt to the shins, with four rows of iron tassets over it ----
  {
    const s = sec(waist - 0.05);
    const quilt = (g: THREE.BufferGeometry) => paint(g, (q) => (Math.sin(q.y * 75) > 0.82 || Math.sin(q.x * 70) > 0.9 ? F.rust2.clone().multiplyScalar(0.7) : F.rust2), rnd, 0.05);
    for (const side of ['l', 'r'] as const) {
      const hip = P(`thigh_${side}`), xs = side === 'r' ? sx : -sx;
      // Front-and-side skirt panel on each thigh.
      const g = quilt(panel(0.27, 0.62, 0.025, 4, F.rust2, F.rust2, rnd));
      g.rotateY(xs * 0.32).translate(hip.x + xs * 0.05, waist - 0.05, s.cz + s.rz * 0.6);
      d.add(`thigh_${side}`, 'cloth', g);
      for (let r = 0; r < 4; r++) {
        const tp = plate(0.2, 0.085, 0.01, 0.24, 10);
        tp.rotateY(xs * 0.55).translate(hip.x + xs * 0.07, waist - 0.07 - r * 0.075, s.cz + s.rz + 0.04 - r * 0.004);
        d.add(`thigh_${side}`, 'metal', paint(tp, (q) => (q.y > waist - 0.07 - r * 0.075 + 0.03 ? F.iron2 : F.iron), rnd, 0.05));
      }
    }
    // Back skirt on the pelvis, and the rust front flap.
    const back = quilt(panel(0.46, 0.6, 0.08, 5, F.rust2, F.rust2, rnd));
    back.rotateY(Math.PI).translate(s.cx, waist - 0.05, s.cz - s.rz - 0.05);
    d.add('pelvis', 'cloth', back);
    const flap = panel(0.09, 0.5, 0.03, 1, F.rust, F.rust, rnd);
    flap.translate(s.cx, waist - 0.04, s.cz + s.rz + 0.07);
    d.add('pelvis', 'cloth', flap);
  }

  // ---- Pauldrons (three large lames), vambraces, gauntlet cuffs ----
  for (const side of ['l', 'r'] as const) {
    const a0 = P(`upperarm_${side}`), a1 = P(`lowerarm_${side}`), xs = side === 'r' ? sx : -sx;
    const Fm = frame(a0, a1);
    const len = a0.distanceTo(a1);
    for (let j = 0; j < 3; j++) {
      const g = plate(0.27 + j * 0.02, 0.1, 0.016, 0.11 + j * 0.008, 16);
      const m = new THREE.Matrix4().makeRotationZ(Math.PI / 2).premultiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
      const local = new THREE.Matrix4().makeTranslation(-0.035 + j * len * 0.18, 0.115 + j * 0.006, 0).multiply(m);
      d.add(`upperarm_${side}`, 'metal', paint(g, (q) => (Math.abs(q.y) > 0.042 ? F.rust : j % 2 ? F.iron : F.iron2), rnd, 0.05),
        Fm.clone().multiply(new THREE.Matrix4().makeRotationX(xs * 0)).multiply(local));
    }
    // Padded rust sleeve over the upper arm.
    const sl = new THREE.CylinderGeometry(0.075, 0.068, len * 0.9, 14, 1, true).rotateZ(-Math.PI / 2).translate(len * 0.5, 0, 0);
    d.add(`upperarm_${side}`, 'cloth', paint(sl, (q) => (Math.sin(q.x * 70) > 0.8 ? F.rust2.clone().multiplyScalar(0.7) : F.rust2), rnd), Fm);
    const e = P(`lowerarm_${side}`), w = P(`hand_${side}`);
    const fl = e.distanceTo(w), Fw = frame(e, w);
    for (let k = 0; k < 4; k++) {
      const g = new THREE.CylinderGeometry(0.058 - k * 0.003, 0.061 - k * 0.003, fl * 0.2, 16, 1, true).rotateZ(-Math.PI / 2).translate(fl * (0.18 + k * 0.19), 0, 0);
      d.add(`lowerarm_${side}`, 'metal', paint(g, flat(k % 2 ? F.iron : F.iron2), rnd), Fw);
    }
    const cuff = new THREE.CylinderGeometry(0.05, 0.055, 0.06, 14, 1, true).rotateZ(-Math.PI / 2).translate(fl * 0.98, 0, 0);
    d.add(`lowerarm_${side}`, 'hard', paint(cuff, flat(F.soot2), rnd), Fw);
  }

  // ---- Greaves and knee cops ----
  for (const side of ['l', 'r'] as const) {
    const k = P(`calf_${side}`), a = P(`foot_${side}`);
    const ll = k.distanceTo(a), Fm = frame(k, a, new THREE.Vector3(0, 0, 1));
    for (let i = 0; i < 5; i++) {
      const g = new THREE.CylinderGeometry(0.07 - i * 0.003, 0.072 - i * 0.003, ll * 0.17, 16, 1, true).rotateZ(-Math.PI / 2).translate(ll * (0.16 + i * 0.16), 0, 0);
      d.add(`calf_${side}`, 'metal', paint(g, flat(i % 2 ? F.iron : F.iron2), rnd), Fm);
    }
    d.add(`calf_${side}`, 'metal', paint(blob(k.clone().add(new THREE.Vector3(0, 0.01, 0.07)), new THREE.Vector3(0.06, 0.055, 0.03), 14), flat(F.iron2), rnd));
  }

  // ---- War club: hardwood haft, leather grip, pommel ring, octagonal studded iron head ----
  const mount = handMount(d, 'r');
  {
    const parts: [THREE.BufferGeometry, 'metal' | 'wood' | 'hard'][] = [];
    parts.push([paint(new THREE.CylinderGeometry(0.021, 0.023, 0.86, 10).translate(0, 0.19, 0), flat(F.wood), rnd), 'wood']);
    parts.push([paint(new THREE.CylinderGeometry(0.025, 0.025, 0.36, 10).translate(0, -0.04, 0), (q) => (Math.sin(q.y * 120 + Math.atan2(q.z, q.x) * 2) > 0 ? F.leather : F.leather2), rnd, 0.05), 'hard']);
    parts.push([paint(new THREE.TorusGeometry(0.026, 0.008, 6, 14).translate(0, -CLUB.pommel, 0), flat(F.iron2), rnd), 'metal']);
    const head = new THREE.CylinderGeometry(CLUB.headR, 0.05, 0.9, 8, 6).translate(0, 0.6 + 0.45, 0);
    parts.push([paint(head, (q) => (Math.abs(((Math.atan2(q.z, q.x) / (Math.PI / 4)) % 1 + 1) % 1 - 0.5) > 0.42 ? F.iron : F.soot2), rnd, 0.06), 'metal']);
    parts.push([paint(new THREE.CylinderGeometry(0.095, 0.095, 0.035, 8).translate(0, 1.485, 0), flat(F.iron), rnd), 'metal']);
    parts.push([paint(new THREE.CylinderGeometry(0.058, 0.058, 0.03, 8).translate(0, 0.62, 0), flat(F.iron), rnd), 'metal']);
    for (let r = 0; r < 7; r++) for (let k = 0; k < 8; k++) {
      const y = 0.72 + r * 0.11, rad = 0.05 + (y - 0.6) / 0.9 * 0.035, a = (k + (r % 2) * 0.5) * (Math.PI / 4) + Math.PI / 8;
      const stud = new THREE.ConeGeometry(0.012, 0.022, 6).rotateZ(-Math.PI / 2).rotateY(-a).translate(Math.cos(a) * (rad + 0.008), y, Math.sin(a) * (rad + 0.008));
      parts.push([paint(stud, flat(F.ironHi), rnd, 0.05), 'metal']);
    }
    const g = new THREE.Group();
    for (const [geo, m] of parts) { const mesh = new THREE.Mesh(geo, d.mats[m]); mesh.castShadow = true; g.add(mesh); }
    mount.add(g);
  }
  const tip = new THREE.Object3D(); tip.position.y = CLUB.tip; mount.add(tip);

  d.assemble();
  // Base outfit: tunic under the coat to rust, trousers soot, boots near-black.
  recolour(model, 'breaker', (name, isSkin) => {
    if (isSkin) return [0.5, 0.36, 0.27];
    if (/Feet|Boots/.test(name)) return [0.14, 0.13, 0.12];
    if (/Legs/.test(name)) return [0.18, 0.165, 0.155];
    if (/Arms/.test(name)) return [0.42, 0.2, 0.15];
    return [0.4, 0.18, 0.13];
  });
  return { club: mount, tip };
}
