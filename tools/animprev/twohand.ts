// Two-handed club adjustment for one-handed clips (preview only).
// Per frame: take the clip's right-hand grip point and club direction, pull the grip toward the chest until
// both arms can reach, keep the club out of the ground and the body, then IK both arms onto the haft.
import * as THREE from 'three';

const V = () => new THREE.Vector3();
const wp = (o: THREE.Object3D) => V().setFromMatrixPosition(o.matrixWorld);
const wq = (o: THREE.Object3D) => o.getWorldQuaternion(new THREE.Quaternion());

export interface TwoHandRig {
  bones: Record<string, THREE.Bone>;
  mount: THREE.Object3D;      // club group attached to hand_r; local +Y runs from grip to head
  tipLen: number;             // grip -> club tip (m, world)
  pommelLen: number;          // grip -> pommel end (m, world)
  clubR: number;              // club head radius for collision (m)
  spacing: number;            // left grip distance below the right grip along the haft
}

/** Captured once in the rest pose: per hand, grip axis / finger direction in hand space and the grip point offset. */
export function captureHands(bones: Record<string, THREE.Bone>) {
  const out: Record<'l' | 'r', { axis: THREE.Vector3; fingers: THREE.Vector3; off: THREE.Vector3; L1: number; L2: number }> = {} as any;
  for (const s of ['l', 'r'] as const) {
    const hb = bones[`hand_${s}`];
    const qi = wq(hb).invert();
    const ix = wp(bones[`index_01_${s}`]), pk = wp(bones[`pinky_01_${s}`]), md = wp(bones[`middle_01_${s}`]), w = wp(hb);
    const axis = ix.clone().sub(pk).normalize().applyQuaternion(qi);
    const fingers = md.clone().sub(w).normalize().applyQuaternion(qi);
    fingers.sub(axis.clone().multiplyScalar(fingers.dot(axis))).normalize();
    const grip = ix.clone().add(pk).multiplyScalar(0.5).lerp(md, 0.3).add(w.clone().sub(md).normalize().multiplyScalar(-0.02));
    const off = grip.sub(w).applyQuaternion(qi); // world-scale offset in hand-rotation space
    out[s] = { axis, fingers, off, L1: wp(bones[`upperarm_${s}`]).distanceTo(wp(bones[`lowerarm_${s}`])), L2: wp(bones[`lowerarm_${s}`]).distanceTo(w) };
  }
  return out;
}

/** Rotate `bone` (in world terms) so the direction to `child` points at `target`. */
function aim(bone: THREE.Object3D, child: THREE.Object3D, target: THREE.Vector3) {
  bone.updateMatrixWorld(true);
  const b = wp(bone), c = wp(child);
  const q = new THREE.Quaternion().setFromUnitVectors(c.sub(b).normalize(), target.clone().sub(b).normalize());
  const world = q.multiply(wq(bone));
  bone.quaternion.copy(wq(bone.parent!).invert().multiply(world));
  bone.updateMatrixWorld(true);
}
function setHandWorld(hb: THREE.Object3D, axisL: THREE.Vector3, fingL: THREE.Vector3, D: THREE.Vector3, F: THREE.Vector3) {
  const f = F.clone().sub(D.clone().multiplyScalar(F.dot(D))).normalize();
  const Bl = new THREE.Matrix4().makeBasis(axisL, fingL, V().crossVectors(axisL, fingL));
  const Bw = new THREE.Matrix4().makeBasis(D, f, V().crossVectors(D, f));
  const q = new THREE.Quaternion().setFromRotationMatrix(Bw.multiply(Bl.invert()));
  hb.quaternion.copy(wq(hb.parent!).invert().multiply(q));
  hb.updateMatrixWorld(true);
  return q;
}
function ik(bones: Record<string, THREE.Bone>, s: 'l' | 'r', L1: number, L2: number, wrist: THREE.Vector3, pole: THREE.Vector3) {
  const u = bones[`upperarm_${s}`], l = bones[`lowerarm_${s}`], h = bones[`hand_${s}`];
  const S = wp(u), toT = wrist.clone().sub(S);
  const d = THREE.MathUtils.clamp(toT.length(), Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3);
  const dir = toT.normalize();
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d), hgt = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  const pp = pole.clone().sub(S); pp.sub(dir.clone().multiplyScalar(pp.dot(dir))).normalize();
  const E = S.clone().addScaledVector(dir, a).addScaledVector(pp, hgt);
  aim(u, l, E); aim(l, h, S.clone().addScaledVector(dir, d));
}
function segDist(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  const ab = b.clone().sub(a), t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
  const c = a.clone().addScaledVector(ab, t); return { d: p.distanceTo(c), c };
}

export interface AdjustInfo { s: number; pen: number; tipY: number; groundLift: number }

export function adjustTwoHand(rig: TwoHandRig, hands: ReturnType<typeof captureHands>, groundY = 0): AdjustInfo {
  const B = rig.bones;
  // Clip's own grip and club direction this frame.
  const g0 = wp(rig.mount), D = new THREE.Vector3(0, 1, 0).applyQuaternion(wq(rig.mount)).normalize();
  const Sr = wp(B['upperarm_r']), Sl = wp(B['upperarm_l']);
  const right = Sr.clone().sub(Sl).normalize(), up = new THREE.Vector3(0, 1, 0);
  const fwd = V().crossVectors(right, up).normalize().multiplyScalar(-1);
  // Make sure fwd faces the way the character looks (toward the head's forward).
  const headF = new THREE.Vector3(0, 0, 1).applyQuaternion(wq(B['spine_03'])); if (headF.dot(fwd) < 0) fwd.negate();
  const C = wp(B['spine_03']).addScaledVector(fwd, 0.28).addScaledVector(up, -0.12);
  const offR = hands.r.off.length(), offL = hands.l.off.length();
  const Rr = (hands.r.L1 + hands.r.L2 + offR) * 0.97, Rl = (hands.l.L1 + hands.l.L2 + offL) * 0.97;
  const ok = (g: THREE.Vector3, d: THREE.Vector3) => g.distanceTo(Sr) <= Rr && g.clone().addScaledVector(d, -rig.spacing).distanceTo(Sl) <= Rl;
  // 1. Pull the grip toward the chest: largest fraction of the original swing radius both arms can reach.
  let lo = 0, hi = 1, s = 1;
  if (!ok(g0, D)) { for (let i = 0; i < 18; i++) { const m = (lo + hi) / 2; if (ok(C.clone().lerp(g0, m), D)) lo = m; else hi = m; } s = lo; }
  const g = C.clone().lerp(g0, s);
  // 2. Keep the club head out of the body (torso, head, thighs): push the grip outward.
  const caps: [THREE.Vector3, THREE.Vector3, number][] = [
    [wp(B['pelvis']), wp(B['neck_01']), 0.2], [wp(B['neck_01']), wp(B['Head']).addScaledVector(up, 0.15), 0.14],
    [wp(B['thigh_l']), wp(B['calf_l']), 0.1], [wp(B['thigh_r']), wp(B['calf_r']), 0.1]];
  let pen = 0;
  for (let it = 0; it < 4; it++) {
    let worst = 0, push = V();
    for (let k = 0; k <= 12; k++) {
      const t = -rig.pommelLen + (rig.tipLen + rig.pommelLen) * (k / 12);
      const p = g.clone().addScaledVector(D, t), r = t > rig.tipLen * 0.4 ? rig.clubR : 0.025;
      for (const [a, b, cr] of caps) { const { d, c } = segDist(p, a, b); const q = cr + r - d; if (q > worst) { worst = q; push = p.clone().sub(c).setY(0).normalize().multiplyScalar(q); } }
    }
    pen = worst; if (worst < 0.005) break; g.add(push);
  }
  // 3. Ground: if the head would sink in, pitch the club up around the grip until it rests on the surface.
  let groundLift = 0;
  const minY = groundY + rig.clubR + 0.01;
  const tipY0 = g.y + D.y * rig.tipLen;
  if (tipY0 < minY) {
    groundLift = minY - tipY0;
    const h = new THREE.Vector3(D.x, 0, D.z); if (h.lengthSq() < 1e-6) h.copy(fwd); h.normalize();
    const sy = THREE.MathUtils.clamp((minY - g.y) / rig.tipLen, -1, 1);
    D.copy(h.multiplyScalar(Math.sqrt(1 - sy * sy))).setY(sy).normalize();
  }
  // 4. IK both arms onto the haft (two passes so the wrist offsets settle).
  const gl = g.clone().addScaledVector(D, -rig.spacing);
  for (let pass = 0; pass < 2; pass++) for (const side of ['r', 'l'] as const) {
    const target = side === 'r' ? g : gl, S = side === 'r' ? Sr : Sl, H = hands[side];
    const F = target.clone().sub(S).normalize();
    const q = setHandWorld(B[`hand_${side}`], H.axis, H.fingers, D, F);
    const wrist = target.clone().sub(H.off.clone().applyQuaternion(q));
    const pole = S.clone().addScaledVector(up, -1).addScaledVector(right, side === 'r' ? 0.7 : -0.7).addScaledVector(fwd, -0.3);
    ik(B, side, H.L1, H.L2, wrist, pole);
    setHandWorld(B[`hand_${side}`], H.axis, H.fingers, D, F);
  }
  // Close the fingers around the haft.
  for (const side of ['l', 'r']) for (const f of ['index', 'middle', 'ring', 'pinky']) for (const k of ['01', '02', '03']) B[`${f}_${k}_${side}`]?.rotateOnAxis(new THREE.Vector3(0, 0, 1), k === '01' ? 0.9 : 1.25);
  for (const side of ['l', 'r']) { B[`thumb_02_${side}`]?.rotateOnAxis(new THREE.Vector3(0, 0, 1), 0.6); }
  B['hand_r'].parent!.parent!.updateMatrixWorld(true);
  return { s: +s.toFixed(2), pen: +pen.toFixed(3), tipY: +(g.y + D.y * rig.tipLen).toFixed(3), groundLift: +groundLift.toFixed(3) };
}
