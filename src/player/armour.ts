import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../core/noise';

/**
 * Original samurai-inspired armour for the protagonist, built procedurally on the Quaternius Ranger
 * skeleton. Every piece is modelled in the bind pose (model space), then re-parented to the bone it
 * belongs to, so it follows all existing animations without re-rigging.
 *
 * Call on a freshly loaded/cloned model BEFORE any animation is applied (bones must be at rest).
 */

const C = {
  // Linear values (vertex colours are not sRGB-decoded), so these are deliberately dark.
  leather: new THREE.Color(0.03, 0.024, 0.02),   // dark lacquered leather lames
  lacing: new THREE.Color(0.048, 0.014, 0.01),  // faded oxblood silk lacing
  trim: new THREE.Color(0.075, 0.055, 0.032),    // worn bronze/leather edge trim
  iron: new THREE.Color(0.055, 0.052, 0.048),
  sash: new THREE.Color(0.11, 0.06, 0.025),      // undyed ochre cloth
  wrap: new THREE.Color(0.016, 0.016, 0.018),    // dark face wrap
  saya: new THREE.Color(0.014, 0.009, 0.007),    // black-brown lacquer scabbard
  cord: new THREE.Color(0.025, 0.022, 0.026),    // dark hilt wrap
};

const rnd = mulberry32(1919);

/** Paints a geometry with weathering noise on top of a base colour. */
function paint(g: THREE.BufferGeometry, base: THREE.Color, fn?: (p: THREE.Vector3, u: number, v: number) => THREE.Color | null) {
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const uv = g.getAttribute('uv') as THREE.BufferAttribute | undefined;
  const col = new Float32Array(p.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    const c = (fn?.(v, uv ? uv.getX(i) : 0, uv ? uv.getY(i) : 0) ?? base).clone();
    c.multiplyScalar(0.82 + rnd() * 0.3);
    col.set([c.r, c.g, c.b], i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

/**
 * A lame: a plate of width w (along x, bent around the y axis with radius r), height h, thickness t.
 * uv.x runs across, uv.y up the plate; used for lacing and trim colours.
 */
function lame(w: number, h: number, t: number, r: number, segs = 10, laceEvery = 0.035, shingle = 0.18) {
  const g = new THREE.BoxGeometry(w, h, t, segs, 6, 1);
  const p = g.getAttribute('position') as THREE.BufferAttribute;
  const sm = (e: number, k: number) => { const x = Math.min(1, Math.max(0, e / k)); return x * x * (3 - 2 * x); };
  for (let i = 0; i < p.count; i++) {
    let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    const v = y / h + 0.5, u = x / w + 0.5;
    // Rolled, bevelled edges: thickness collapses toward the plate's mid-plane near every edge.
    const edge = Math.min(sm(Math.min(v, 1 - v), 0.22), sm(Math.min(u, 1 - u) * (w / h), 0.22));
    z *= 0.25 + 0.75 * edge;
    // Convex lame with a turned-out lower edge so rows shingle over one another.
    z += Math.sin(v * Math.PI) * h * 0.07 + (0.5 - v) * h * shingle;
    const a = x / r;
    const rr = r + z;
    p.setXYZ(i, Math.sin(a) * rr, y, Math.cos(a) * rr - r);
  }
  g.computeVertexNormals();
  return paint(g, C.leather, (_pt, u, v) => {
    if (v > 0.84) return C.trim;
    const across = (u * w) / laceEvery;
    if (Math.abs(across - Math.round(across)) < 0.05 && v > 0.2 && v < 0.8) return C.lacing;
    return null;
  });
}

/** Frame at a bone: origin at the bone, x along the bone toward `to`, y as close to `up` as possible. */
function frame(from: THREE.Vector3, to: THREE.Vector3, up = new THREE.Vector3(0, 1, 0)) {
  const x = to.clone().sub(from).normalize();
  const z = new THREE.Vector3().crossVectors(x, up).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(from);
}

export function dressWarrior(model: THREE.Object3D) {
  model.updateMatrixWorld(true);
  const bones: Record<string, THREE.Bone> = {};
  let body: THREE.SkinnedMesh | null = null;
  model.traverse((o) => {
    if ((o as THREE.Bone).isBone) bones[o.name] = o as THREE.Bone;
    if (/Ranger_Acc_Pauldron|Arms_Bracer|Belt/.test(o.name)) o.visible = false;
    if (/Ranger_Body$/.test(o.name)) body = o as THREE.SkinnedMesh;
  });
  const P = (n: string) => new THREE.Vector3().setFromMatrixPosition(bones[n].matrixWorld);
  const inv = new THREE.Matrix4().copy(model.matrixWorld).invert();
  const toModel = (v: THREE.Vector3) => v.clone().applyMatrix4(inv);

  // Torso cross-section from the body mesh (bind pose): half-width and half-depth at a given height.
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
    return { cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2, rx: (maxX - minX) / 2, rz: (maxZ - minZ) / 2 };
  };

  const leatherMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.08, name: 'warrior-lacquer' });
  const ironMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.62, metalness: 0.45, name: 'warrior-iron' });
  const clothMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide, name: 'warrior-cloth' });

  /** Builds geometry in model space, merges per (bone, material) and parents it to the bone. */
  const groups = new Map<string, { bone: THREE.Bone; mat: THREE.Material; geos: THREE.BufferGeometry[] }>();
  const add = (bone: string, mat: THREE.Material, g: THREE.BufferGeometry, m?: THREE.Matrix4) => {
    if (m) g.applyMatrix4(m);
    const key = `${bone}|${mat.name}`;
    (groups.get(key) ?? groups.set(key, { bone: bones[bone], mat, geos: [] }).get(key)!).geos.push(g);
  };

  const pelvis = toModel(P('pelvis')), spine1 = toModel(P('spine_01')), spine3 = toModel(P('spine_03')), neck = toModel(P('neck_01')), head = toModel(P('Head'));

  // ---- Do (cuirass): overlapping lames from chest to waist, plus a breastplate. ----
  const chestTop = neck.y - 0.1, waist = pelvis.y + 0.05;
  const rows = 6;
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1);
    const y = chestTop - t * (chestTop - waist);
    const s = torso(y);
    const rx = Math.max(0.14, s.rx) + 0.016 + t * 0.012, rz = Math.max(0.1, s.rz) + 0.016 + t * 0.01;
    // An elliptical band: bend a long lame around a unit circle then scale to the ellipse.
    const g = lame(Math.PI * 2 * 0.98, 0.092, 0.06, 1, 48, 0.33);
    g.scale(rx, 1, rz).translate(0, 0, rz);
    // Flatter breast, rounder flanks: pull the front of each band slightly toward the body.
    const gp = g.getAttribute('position') as THREE.BufferAttribute;
    for (let k = 0; k < gp.count; k++) { const z = gp.getZ(k); if (z > 0) gp.setZ(k, z * (0.9 + 0.1 * (1 - z / rz))); }
    g.computeVertexNormals();
    g.translate(s.cx, y, s.cz);
    // Lames shingle downward: each tilts slightly outward at the bottom.
    add(t < 0.5 ? 'spine_03' : 'spine_01', leatherMat, g);
  }
  {
    const s = torso(chestTop + 0.04);
    const g = lame(0.26, 0.09, 0.016, Math.max(0.12, s.rz + 0.04) * 1.6, 12, 0.05);
    g.translate(s.cx, chestTop + 0.07, s.cz + s.rz + 0.035);
    add('spine_03', ironMat, paint(g, C.iron, (_p, _u, v) => (v > 0.75 ? C.trim : null)));
  }

  // ---- Kusazuri (tassets): five laced panels hanging from the waist, front/side panels ride the thighs. ----
  {
    const s = torso(waist - 0.02);
    const ang = [-0.42, 0.42, -1.45, 1.45, Math.PI];
    ang.forEach((a, k) => {
      const owner = k === 4 ? 'pelvis' : a < 0 ? 'thigh_r' : 'thigh_l';
      const ex = Math.sin(a) * (s.rx + 0.035), ez = Math.cos(a) * (s.rz + 0.035);
      for (let j = 0; j < 3; j++) {
        const g = lame(0.17, 0.085, 0.012, 0.4, 8, 0.04);
        // Flare outward as they hang.
        const m = new THREE.Matrix4().makeRotationY(a).multiply(new THREE.Matrix4().makeRotationX(0.06 + j * 0.03));
        m.setPosition(s.cx + ex * (0.92 + j * 0.03), waist - 0.07 - j * 0.075, s.cz + ez * (0.92 + j * 0.03));
        add(owner, leatherMat, g, m);
      }
    });
  }

  // ---- Sode (shoulder guards): curved lames stacked down each upper arm. ----
  for (const side of ['l', 'r']) {
    const a0 = toModel(P(`upperarm_${side}`)), a1 = toModel(P(`lowerarm_${side}`));
    const F = frame(a0, a1);
    const len = a0.distanceTo(a1);
    for (let j = 0; j < 4; j++) {
      // In frame space: x along the arm, y = up (outside of the arm when lowered). Bend around the arm axis.
      const g = lame(0.26 + j * 0.018, 0.08, 0.014, 0.085 + j * 0.006, 16, 0.05, 0.28);
      // lame() bends around Y; rotate so the bend wraps around the arm (x axis) and plates hang over its top.
      const m = new THREE.Matrix4().makeRotationZ(Math.PI / 2).premultiply(new THREE.Matrix4().makeRotationX(-Math.PI / 2));
      const local = new THREE.Matrix4().makeTranslation(-0.02 + j * len * 0.16, 0.088 + j * 0.003, 0).multiply(m);
      const tilt = new THREE.Matrix4().makeRotationZ(-0.12 * (side === 'l' ? 1 : 1));
      add(`upperarm_${side}`, leatherMat, g, F.clone().multiply(tilt).multiply(local));
    }
  }

  // ---- Kote (forearm guards): iron splints over leather, and a hand plate. ----
  for (const side of ['l', 'r']) {
    const e = toModel(P(`lowerarm_${side}`)), w = toModel(P(`hand_${side}`));
    const F = frame(e, w);
    const len = e.distanceTo(w);
    const shell = new THREE.CylinderGeometry(0.052, 0.042, len * 0.85, 14, 3, true, -Math.PI * 1.05, Math.PI * 1.1);
    shell.rotateZ(-Math.PI / 2).translate(len * 0.5, 0, 0);
    add(`lowerarm_${side}`, leatherMat, paint(shell, C.leather), F);
    for (let k = -1; k <= 1; k++) {
      const sp = new THREE.BoxGeometry(len * 0.72, 0.012, 0.016);
      const a = k * 0.55;
      sp.translate(len * 0.5, 0, 0).applyMatrix4(new THREE.Matrix4().makeTranslation(0, Math.cos(a) * 0.056, Math.sin(a) * 0.056));
      add(`lowerarm_${side}`, ironMat, paint(sp, C.iron), F);
    }
    const cap = new THREE.SphereGeometry(0.05, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    cap.scale(1, 0.55, 1).translate(0, 0.03, 0);
    add(`lowerarm_${side}`, ironMat, paint(cap, C.iron), F);
    const hf = frame(w, w.clone().add(w.clone().sub(e).normalize()));
    const hp = new THREE.BoxGeometry(0.07, 0.01, 0.07).translate(0.045, 0.035, 0);
    add(`hand_${side}`, ironMat, paint(hp, C.iron), hf);
  }

  // ---- Suneate (shin guards): three iron splints over a leather backing, and a knee cop. ----
  for (const side of ['l', 'r']) {
    const k = toModel(P(`calf_${side}`)), a = toModel(P(`foot_${side}`));
    const F = frame(k, a, new THREE.Vector3(0, 0, 1));
    const len = k.distanceTo(a);
    const back = new THREE.CylinderGeometry(0.062, 0.05, len * 0.78, 14, 2, true, -Math.PI * 1.1, Math.PI * 1.2);
    back.rotateZ(-Math.PI / 2).translate(len * 0.48, 0, 0);
    add(`calf_${side}`, leatherMat, paint(back, C.leather), F);
    for (let s = -1; s <= 1; s++) {
      const ang = s * 0.5;
      const sp = new THREE.BoxGeometry(len * 0.7, 0.012, 0.024);
      sp.translate(len * 0.48, 0, 0).applyMatrix4(new THREE.Matrix4().makeTranslation(0, Math.cos(ang) * 0.066, Math.sin(ang) * 0.066));
      add(`calf_${side}`, ironMat, paint(sp, C.iron), F);
    }
    const knee = new THREE.SphereGeometry(0.06, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2);
    knee.scale(0.8, 0.6, 1).rotateZ(0).translate(0.0, 0.045, 0);
    add(`calf_${side}`, ironMat, paint(knee, C.iron), F);
  }

  // ---- Obi (waist sash) with a knot and trailing tails. ----
  {
    const y = waist + 0.005;
    const s = torso(y);
    const band = new THREE.CylinderGeometry(1, 1, 0.075, 40, 1, true);
    band.scale(s.rx + 0.045, 1, s.rz + 0.045).translate(s.cx, y, s.cz);
    add('pelvis', clothMat, paint(band, C.sash, (p) => (Math.abs(p.y - y) > 0.03 ? C.sash.clone().multiplyScalar(0.7) : null)));
    const knotPos = new THREE.Vector3(s.cx - (s.rx + 0.03) * 0.55, y, s.cz + s.rz + 0.05);
    const knot = new THREE.SphereGeometry(0.035, 10, 8).scale(1.3, 1, 0.8).translate(knotPos.x, knotPos.y, knotPos.z);
    add('pelvis', clothMat, paint(knot, C.sash));
    for (let k = 0; k < 2; k++) {
      const tail = new THREE.PlaneGeometry(0.045, 0.28, 1, 4);
      const pp = tail.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pp.count; i++) pp.setZ(i, Math.sin((pp.getY(i) + 0.16) * 6) * 0.012);
      tail.translate(0, -0.17, 0).rotateZ(0.12 + k * 0.18).translate(knotPos.x + k * 0.03, knotPos.y - 0.01, knotPos.z + 0.012);
      tail.computeVertexNormals();
      add(owner(k), clothMat, paint(tail, C.sash.clone().multiplyScalar(0.75)));
    }
    function owner(k: number) { return k === 0 ? 'thigh_r' : 'pelvis'; }
  }

  // ---- Katana in its saya, thrust through the sash on the left hip, edge up, slanting back. ----
  {
    const s = torso(waist);
    const hip = new THREE.Vector3(s.cx + s.rx + 0.05, waist + 0.02, s.cz + 0.04);
    const dir = new THREE.Vector3(0.18, -0.95, -0.75).normalize(); // toward the scabbard tip
    const F = frame(hip, hip.clone().add(dir), new THREE.Vector3(0, 1, 0));
    // Saya: slightly curved, tapering lacquered scabbard.
    const saya = new THREE.CylinderGeometry(0.019, 0.016, 0.6, 10, 8);
    saya.rotateZ(-Math.PI / 2).translate(0.3, 0, 0);
    const sp = saya.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < sp.count; i++) { const x = sp.getX(i); sp.setY(i, sp.getY(i) + (x / 0.6) ** 2 * 0.035); }
    saya.computeVertexNormals();
    add('pelvis', leatherMat, paint(saya, C.saya, (p) => (p.x > 0.56 ? C.iron : null)), F);
    // Koiguchi collar, tsuba (guard) and tsuka (wrapped hilt) pointing forward-up.
    const collar = new THREE.CylinderGeometry(0.022, 0.022, 0.03, 10).rotateZ(-Math.PI / 2).translate(0.0, 0, 0);
    add('pelvis', ironMat, paint(collar, C.trim), F);
    const tsuba = new THREE.CylinderGeometry(0.042, 0.042, 0.008, 16).rotateZ(-Math.PI / 2).translate(-0.02, 0, 0);
    add('pelvis', ironMat, paint(tsuba, C.iron), F);
    const tsuka = new THREE.CylinderGeometry(0.016, 0.017, 0.25, 8, 10).rotateZ(-Math.PI / 2).translate(-0.15, 0.006, 0);
    add('pelvis', leatherMat, paint(tsuka, C.cord, (_p, u, v) => (Math.abs(((v * 10 + u * 4) % 1) - 0.5) < 0.12 ? C.trim.clone().multiplyScalar(0.6) : null)), F);
    const kashira = new THREE.SphereGeometry(0.018, 8, 6).scale(1.2, 1, 1).translate(-0.28, 0.008, 0);
    add('pelvis', ironMat, paint(kashira, C.iron), F);
  }

  // ---- Head: shadowed face, a brow line under the hood, and layered cloth wraps with folds. ----
  {
    const hc = head.clone().add(new THREE.Vector3(0, 0.085, 0.015));
    const face = new THREE.SphereGeometry(0.096, 18, 14).scale(0.84, 1.06, 0.96).translate(hc.x, hc.y, hc.z);
    add('Head', clothMat, paint(face, new THREE.Color(0.018, 0.012, 0.01)));
    // Main wrap over nose, mouth and chin with horizontal draw-folds.
    const wrapMain = new THREE.SphereGeometry(0.104, 28, 14, -Math.PI * 0.64, Math.PI * 1.28, Math.PI * 0.515, Math.PI * 0.43);
    const wp = wrapMain.getAttribute('position') as THREE.BufferAttribute;
    const n = new THREE.Vector3();
    const folds = (g: THREE.BufferGeometry, amp: number, f1: number, f2: number) => {
      const pp = g.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < pp.count; i++) {
        n.fromBufferAttribute(pp, i);
        const ang = Math.atan2(n.x, n.z);
        const d = Math.sin(n.y * f1 + ang * 1.5) * amp + Math.sin(ang * f2 + n.y * 40) * amp * 0.5;
        const l = n.length();
        n.multiplyScalar((l + d) / l);
        pp.setXYZ(i, n.x, n.y, n.z);
      }
    };
    folds(wrapMain, 0.0035, 230, 9);
    void wp;
    wrapMain.scale(0.9, 1.08, 1.03).translate(hc.x, hc.y + 0.004, hc.z + 0.004);
    wrapMain.computeVertexNormals();
    add('Head', clothMat, paint(wrapMain, C.wrap, (p) => (Math.sin((p.y - hc.y) * 230) > 0.55 ? C.wrap.clone().multiplyScalar(0.55) : null)));
    // Forehead wrap: comes down to a brow line, leaving a narrow shadowed slit for the eyes.
    const brow = new THREE.SphereGeometry(0.106, 28, 10, -Math.PI * 0.66, Math.PI * 1.32, Math.PI * 0.14, Math.PI * 0.3);
    folds(brow, 0.0028, 200, 8);
    brow.scale(0.9, 1.08, 1.04).translate(hc.x, hc.y + 0.004, hc.z + 0.006);
    brow.computeVertexNormals();
    add('Head', clothMat, paint(brow, C.wrap, (p) => (Math.sin((p.y - hc.y) * 200) > 0.6 ? C.wrap.clone().multiplyScalar(0.55) : null)));
    // Neck scarf, gathered with folds.
    const scarf = new THREE.CylinderGeometry(0.086, 0.104, 0.08, 26, 3, true);
    const sp2 = scarf.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < sp2.count; i++) { n.fromBufferAttribute(sp2, i); const a2 = Math.atan2(n.x, n.z); const k = 1 + Math.sin(a2 * 11) * 0.05; sp2.setXYZ(i, n.x * k, n.y, n.z * k); }
    scarf.computeVertexNormals();
    scarf.translate(neck.x, neck.y + 0.02, neck.z + 0.005);
    add('neck_01', clothMat, paint(scarf, C.wrap));
  }

  // ---- Ankle wraps over the boots (kyahan-style cloth bindings below the shin guards). ----
  for (const side of ['l', 'r']) {
    const k = toModel(P(`calf_${side}`)), a = toModel(P(`foot_${side}`));
    const F = frame(k, a, new THREE.Vector3(0, 0, 1));
    const len = k.distanceTo(a);
    for (let j = 0; j < 3; j++) {
      const band = new THREE.CylinderGeometry(0.058 - j * 0.002, 0.06 - j * 0.002, 0.03, 16, 1, true);
      band.rotateZ(-Math.PI / 2).rotateX(0.2 * (j % 2 ? 1 : -1)).translate(len * (0.86 + j * 0.045), 0, 0);
      add(`calf_${side}`, clothMat, paint(band, new THREE.Color(0.03, 0.026, 0.024)), F);
    }
  }

  // Merge and parent each group to its bone, keeping the bind-pose placement.
  for (const { bone, mat, geos } of groups.values()) {
    const g = mergeGeometries(geos.map((x) => { for (const k of Object.keys(x.attributes)) if (!['position', 'normal', 'color'].includes(k)) x.deleteAttribute(k); return x.index ? x.toNonIndexed() : x; }), false)!;
    const mesh = new THREE.Mesh(g, mat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.applyMatrix4(model.matrixWorld);
    bone.attach(mesh);
  }

  // Outfit recolour: the Ranger's greens become weathered indigo-charcoal; leathers stay earthy.
  model.traverse((o) => {
    const m = o as THREE.SkinnedMesh;
    if (!m.isSkinnedMesh) return;
    if (/Feet_Boots/.test(m.name)) {
      // Boots get their own darkened, oiled-leather treatment to sit with the armour.
      const bm = (m.material as THREE.MeshStandardMaterial).clone();
      bm.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
          { float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
            diffuseColor.rgb = mix(diffuseColor.rgb, vec3(l) * vec3(0.9, 0.78, 0.66), 0.6) * 0.32; }`);
      };
      bm.customProgramCacheKey = () => 'warrior-boots';
      bm.roughness = 0.75;
      m.material = bm;
      return;
    }
    for (const mat of [m.material].flat() as THREE.MeshStandardMaterial[]) {
      mat.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
          {
            vec3 c = diffuseColor.rgb;
            float l = dot(c, vec3(0.299, 0.587, 0.114));
            float green = smoothstep(0.04, 0.22, (c.g - max(c.r, c.b)) / max(c.g, 1e-3));
            vec3 indigo = vec3(l) * vec3(0.55, 0.6, 0.74) * 0.9;
            vec3 earthy = mix(c, vec3(l) * vec3(1.0, 0.84, 0.66), 0.5) * 0.55;
            diffuseColor.rgb = mix(earthy, indigo, green);
          }`);
      };
      mat.customProgramCacheKey = () => 'warrior-outfit';
    }
  });
}
