import * as THREE from 'three';

/**
 * World-space posing helpers layered on top of an animated pose (call after the mixer updates and a full
 * updateMatrixWorld of the character, as Enemy.pose does).
 *
 * Performance: these run many times per character per frame. World matrices are read as they are (every helper
 * refreshes what it changes), and a refresh updates the changed bone's subtree WITHOUT its meshes: nothing reads a
 * mesh's world matrix while posing, and the renderer refreshes every mesh before drawing. The pose is identical;
 * only redundant matrix work is skipped (previously each call re-walked all ancestors and re-multiplied every
 * armour piece under the bone).
 */
const V = () => new THREE.Vector3();
const _p = new THREE.Vector3(), _s = new THREE.Vector3(), _q = new THREE.Quaternion();
export const wpos = (o: THREE.Object3D) => V().setFromMatrixPosition(o.matrixWorld);
export const wquat = (o: THREE.Object3D) => { const q = new THREE.Quaternion(); o.matrixWorld.decompose(_p, q, _s); return q; };
/** Recompute `o`'s world matrix and its descendants' (skipping meshes), from its parent's current world matrix. */
export function refresh(o: THREE.Object3D) {
  if (o.matrixAutoUpdate) o.updateMatrix();
  if (o.parent) o.matrixWorld.multiplyMatrices(o.parent.matrixWorld, o.matrix); else o.matrixWorld.copy(o.matrix);
  const ch = o.children;
  for (let i = 0; i < ch.length; i++) if (!(ch[i] as THREE.Mesh).isMesh) refresh(ch[i]);
}

/** Sets a bone's world rotation (keeping its position). */
export function setWorldQuat(bone: THREE.Object3D, q: THREE.Quaternion) {
  bone.quaternion.copy(wquat(bone.parent!).invert().multiply(q));
  refresh(bone);
}
/** Rotates `bone` so the direction to `child` points at `target`. */
export function aim(bone: THREE.Object3D, child: THREE.Object3D, target: THREE.Vector3) {
  refresh(bone);
  const b = wpos(bone), c = wpos(child);
  const q = new THREE.Quaternion().setFromUnitVectors(c.sub(b).normalize(), target.clone().sub(b).normalize());
  setWorldQuat(bone, q.multiply(wquat(bone)));
}
/** Adds a world-space rotation (axis, angle) to a bone on top of its current pose. */
export function rotateWorld(bone: THREE.Object3D, axis: THREE.Vector3, angle: number) {
  if (Math.abs(angle) < 1e-5) return;
  refresh(bone);
  setWorldQuat(bone, new THREE.Quaternion().setFromAxisAngle(axis, angle).multiply(wquat(bone)));
}
/** Two-bone IK (upper -> lower -> end) to put `end` at `target`, bending toward `pole`. Returns the stretch ratio. */
export function twoBone(upper: THREE.Object3D, lower: THREE.Object3D, end: THREE.Object3D, target: THREE.Vector3, pole: THREE.Vector3) {
  refresh(upper);
  const S = wpos(upper), L1 = S.distanceTo(wpos(lower)), L2 = wpos(lower).distanceTo(wpos(end));
  const toT = target.clone().sub(S);
  const want = toT.length();
  const d = THREE.MathUtils.clamp(want, Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3);
  const dir = toT.normalize();
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d), h = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  const pp = pole.clone().sub(S); pp.sub(dir.clone().multiplyScalar(pp.dot(dir)));
  if (pp.lengthSq() < 1e-8) pp.set(0, -1, 0); pp.normalize();
  const E = S.clone().addScaledVector(dir, a).addScaledVector(pp, h);
  aim(upper, lower, E);
  aim(lower, end, S.clone().addScaledVector(dir, d));
  return want / (L1 + L2);
}

/** Per-hand grip calibration captured at rest: grip axis and finger direction (hand space), grip point (hand-local). */
export interface HandCal { axis: THREE.Vector3; fingers: THREE.Vector3; off: THREE.Vector3 }
export function calibrateHand(bones: Record<string, THREE.Bone>, side: 'l' | 'r'): HandCal {
  const hb = bones[`hand_${side}`];
  hb.updateMatrixWorld(true);
  const qi = wquat(hb).invert();
  const ix = wpos(bones[`index_01_${side}`]), pk = wpos(bones[`pinky_01_${side}`]), md = wpos(bones[`middle_01_${side}`]), w = wpos(hb);
  const axis = ix.clone().sub(pk).normalize().applyQuaternion(qi);
  const fingers = md.clone().sub(w).normalize().applyQuaternion(qi);
  fingers.sub(axis.clone().multiplyScalar(fingers.dot(axis))).normalize();
  const grip = ix.clone().add(pk).multiplyScalar(0.5).lerp(md, 0.3).add(w.clone().sub(md).normalize().multiplyScalar(-0.02));
  return { axis, fingers, off: hb.worldToLocal(grip) };
}
/** World rotation for a hand whose grip axis runs along D with fingers wrapping toward F. */
export function handQuat(cal: HandCal, D: THREE.Vector3, F: THREE.Vector3) {
  let f = F.clone().sub(D.clone().multiplyScalar(F.dot(D)));
  // F nearly parallel to the grip axis: fall back to a stable perpendicular so the hand doesn't flip.
  if (f.lengthSq() < 0.04) {
    const alt = Math.abs(D.y) < 0.9 ? new THREE.Vector3(0, -1, 0) : new THREE.Vector3(0, 0, 1);
    const fa = alt.sub(D.clone().multiplyScalar(alt.dot(D))).normalize();
    f = f.lengthSq() < 1e-6 ? fa : f.normalize().lerp(fa, 1 - Math.sqrt(f.lengthSq()) / 0.2);
  }
  f.normalize();
  const Bl = new THREE.Matrix4().makeBasis(cal.axis, cal.fingers, V().crossVectors(cal.axis, cal.fingers));
  const Bw = new THREE.Matrix4().makeBasis(D, f, V().crossVectors(D, f));
  return new THREE.Quaternion().setFromRotationMatrix(Bw.multiply(Bl.invert()));
}
/** Places a hand's grip point at `grip` with the grip axis along D, solving the arm. Returns the stretch ratio. */
export function gripAt(bones: Record<string, THREE.Bone>, side: 'l' | 'r', cal: HandCal, grip: THREE.Vector3, D: THREE.Vector3, pole: THREE.Vector3) {
  const hb = bones[`hand_${side}`], S = wpos(bones[`upperarm_${side}`]);
  const F = grip.clone().sub(S).normalize();
  const q = handQuat(cal, D, F);
  hb.matrixWorld.decompose(_p, _q, _s); const scale = _s.x;
  const wrist = grip.clone().sub(cal.off.clone().multiplyScalar(scale).applyQuaternion(q));
  let stretch = twoBone(bones[`upperarm_${side}`], bones[`lowerarm_${side}`], hb, wrist, pole);
  // Out of reach: the shoulder reaches too (collarbone rotates up to ~17 deg toward the target).
  const clav = bones[`clavicle_${side}`];
  if (stretch > 0.98 && clav) {
    const C = wpos(clav), U = wpos(bones[`upperarm_${side}`]);
    const L1 = U.distanceTo(wpos(bones[`lowerarm_${side}`])), L2 = wpos(bones[`lowerarm_${side}`]).distanceTo(wpos(hb));
    const deficit = wrist.distanceTo(U) - (L1 + L2) * 0.97;
    const axis = new THREE.Vector3().crossVectors(U.clone().sub(C), wrist.clone().sub(C));
    if (deficit > 0 && axis.lengthSq() > 1e-8) rotateWorld(clav, axis.normalize(), Math.min(0.3, deficit / Math.max(0.08, U.distanceTo(C))));
  }
  for (let i = 0; i < 2; i++) { stretch = twoBone(bones[`upperarm_${side}`], bones[`lowerarm_${side}`], hb, wrist, pole); setWorldQuat(hb, q); }
  return stretch;
}
/** Closes a hand's fingers around a grip. */
export function closeFingers(bones: Record<string, THREE.Bone>, side: 'l' | 'r', amount = 1) {
  const z = new THREE.Vector3(0, 0, 1);
  for (const f of ['index', 'middle', 'ring', 'pinky']) for (const k of ['01', '02', '03']) bones[`${f}_${k}_${side}`]?.rotateOnAxis(z, amount * (k === '01' ? 0.9 : 1.25));
  bones[`thumb_02_${side}`]?.rotateOnAxis(z, amount * 0.6);
}
/** Lowers/raises the pelvis by `dy` (world metres) and re-solves both legs so the feet stay planted. */
export function dropPelvis(bones: Record<string, THREE.Bone>, dy: number, fwd: THREE.Vector3, feet?: { l?: THREE.Vector3; r?: THREE.Vector3 }) {
  const pelvis = bones['pelvis'];
  const plant = { l: feet?.l ?? wpos(bones['foot_l']), r: feet?.r ?? wpos(bones['foot_r']) };
  const fq = { l: wquat(bones['foot_l']), r: wquat(bones['foot_r']) };
  const p = wpos(pelvis).add(new THREE.Vector3(0, dy, 0));
  pelvis.position.copy(pelvis.parent!.worldToLocal(p));
  refresh(pelvis);
  for (const s of ['l', 'r'] as const) {
    const knee = wpos(bones[`calf_${s}`]).addScaledVector(fwd, 0.5);
    twoBone(bones[`thigh_${s}`], bones[`calf_${s}`], bones[`foot_${s}`], plant[s], knee);
    setWorldQuat(bones[`foot_${s}`], fq[s]);
  }
}
