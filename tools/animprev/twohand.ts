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
    const off = hb.worldToLocal(grip.clone()); // hand-local (unscaled) grip point
    out[s] = { axis, fingers, off, L1: wp(bones[`upperarm_${s}`]).distanceTo(wp(bones[`lowerarm_${s}`])), L2: wp(bones[`lowerarm_${s}`]).distanceTo(w) };
  }
  return out;
}

/** Grip offset from the wrist in world units for hand world rotation q. */
const offW = (hb: THREE.Object3D, off: THREE.Vector3, q: THREE.Quaternion) => off.clone().multiplyScalar(hb.getWorldScale(V()).x).applyQuaternion(q);
/** Live bone lengths (correct at any model scale). */
const armLen = (B: Record<string, THREE.Bone>, s: string) => [wp(B[`upperarm_${s}`]).distanceTo(wp(B[`lowerarm_${s}`])), wp(B[`lowerarm_${s}`]).distanceTo(wp(B[`hand_${s}`]))];
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
export const DBG: any = {};
function ik(bones: Record<string, THREE.Bone>, s: 'l' | 'r', L1: number, L2: number, wrist: THREE.Vector3, pole: THREE.Vector3) {
  const u = bones[`upperarm_${s}`], l = bones[`lowerarm_${s}`], h = bones[`hand_${s}`];
  DBG[s] = { reach: +(L1 + L2).toFixed(3), want: +wrist.distanceTo(wp(u)).toFixed(3), L1r: +wp(u).distanceTo(wp(l)).toFixed(3), L1: +L1.toFixed(3) };
  const S = wp(u), toT = wrist.clone().sub(S);
  const d = THREE.MathUtils.clamp(toT.length(), Math.abs(L1 - L2) + 1e-3, L1 + L2 - 1e-3);
  const dir = toT.normalize();
  const a = (L1 * L1 - L2 * L2 + d * d) / (2 * d), hgt = Math.sqrt(Math.max(0, L1 * L1 - a * a));
  const pp = pole.clone().sub(S); pp.sub(dir.clone().multiplyScalar(pp.dot(dir))).normalize();
  const E = S.clone().addScaledVector(dir, a).addScaledVector(pp, hgt);
  aim(u, l, E); aim(l, h, S.clone().addScaledVector(dir, d));
  DBG[s].miss = +wp(h).distanceTo(wrist).toFixed(3); DBG[s].elbowMiss = +wp(l).distanceTo(E).toFixed(3); DBG[s].L2r = +wp(l).distanceTo(wp(h)).toFixed(3); DBG[s].L2 = +L2.toFixed(3);
}
function segDist(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  const ab = b.clone().sub(a), t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
  const c = a.clone().addScaledVector(ab, t); return { d: p.distanceTo(c), c };
}

export interface AdjustInfo { s: number; pen: number; tipY: number; groundLift: number; gap: number; gapR: number }

/** Wind-up tilt for the overhead smash (Sword_Heavy_Combo): 0 -> 1 over 2.2-2.5 s, back to 0 exactly at the 2.63 s impact. */
export function smashTilt(clip: string, t: number) {
  if (clip !== 'Sword_Heavy_Combo') return 0;
  if (t < 2.2 || t >= 2.63) return 0;
  return t < 2.5 ? THREE.MathUtils.smoothstep(t, 2.2, 2.5) : 1 - THREE.MathUtils.smoothstep(t, 2.5, 2.63);
}

export function adjustTwoHand(rig: TwoHandRig, hands: ReturnType<typeof captureHands>, groundY = 0, tilt = 0): AdjustInfo {
  const B = rig.bones;
  // Clip's own grip and club direction this frame.
  const g0 = wp(rig.mount), D = new THREE.Vector3(0, 1, 0).applyQuaternion(wq(rig.mount)).normalize();
  const Sr = wp(B['upperarm_r']), Sl = wp(B['upperarm_l']);
  const right = Sr.clone().sub(Sl).normalize(), up = new THREE.Vector3(0, 1, 0);
  const fwd = V().crossVectors(right, up).normalize().multiplyScalar(-1);
  // Make sure fwd faces the way the character looks (toward the head's forward).
  const headF = new THREE.Vector3(0, 0, 1).applyQuaternion(wq(B['spine_03'])); if (headF.dot(fwd) < 0) fwd.negate();
  // Smash wind-up: tilt the club back about the character's right axis (tip goes up and behind the head).
  if (tilt > 0) {
    const ang = THREE.MathUtils.degToRad(40) * tilt;
    const q1 = new THREE.Quaternion().setFromAxisAngle(right, ang), q2 = new THREE.Quaternion().setFromAxisAngle(right, -ang);
    const d1 = D.clone().applyQuaternion(q1), d2 = D.clone().applyQuaternion(q2);
    D.copy(d1.y > d2.y ? d1 : d2); // always tip up and back over the head
  }
  const C = wp(B['spine_03']).addScaledVector(fwd, 0.28).addScaledVector(up, -0.12);
  const D0 = D.clone();
  const caps: [THREE.Vector3, THREE.Vector3, number][] = [
    [wp(B['pelvis']), wp(B['neck_01']), 0.2], [wp(B['neck_01']), wp(B['Head']).addScaledVector(up, 0.15), 0.14],
    [wp(B['thigh_l']), wp(B['calf_l']), 0.1], [wp(B['thigh_r']), wp(B['calf_r']), 0.1]];
  const penAt = (gp: THREE.Vector3, d: THREE.Vector3) => {
    let worst = 0, push = V();
    for (let k = 0; k <= 16; k++) {
      const t = -rig.pommelLen + (rig.tipLen + rig.pommelLen) * (k / 16);
      const p = gp.clone().addScaledVector(d, t), r = t > rig.tipLen * 0.4 ? rig.clubR : 0.025;
      for (const [a, b, cr] of caps) { const { d: dd, c } = segDist(p, a, b); const q = cr + r - dd; if (q > worst) { worst = q; push = p.clone().sub(c).setY(0).normalize().multiplyScalar(q); } }
    }
    return { worst, push };
  };
  const minY = groundY + rig.clubR + 0.01;
  /** Place the club for pull fraction s: pull in, push out of the body, keep the head above the ground. */
  const place = (s: number) => {
    const g = C.clone().lerp(g0, s), d = D0.clone();
    let lift = 0;
    // Alternate body push-out and ground lift until both hold (the lift can swing the haft into a leg).
    for (let round = 0; round < 4; round++) {
      for (let it = 0; it < 4; it++) { const { worst, push } = penAt(g, d); if (worst < 0.004) break; g.add(push); }
      const tipY = g.y + d.y * rig.tipLen;
      if (tipY >= minY - 0.002) break;
      lift = Math.max(lift, minY - tipY);
      const h = new THREE.Vector3(d.x, 0, d.z); if (h.lengthSq() < 1e-6) h.copy(fwd); h.normalize();
      const sy = THREE.MathUtils.clamp((minY - g.y) / rig.tipLen, -1, 1);
      d.copy(h.multiplyScalar(Math.sqrt(1 - sy * sy))).setY(sy).normalize();
    }
    return { g, d, lift };
  };
  /** IK both arms onto the haft; returns how far each grip ends up from its target. */
  const solve = (g: THREE.Vector3, d: THREE.Vector3) => {
    const gl = g.clone().addScaledVector(d, -rig.spacing);
    let stretch = 0;
    for (let pass = 0; pass < 2; pass++) for (const side of ['r', 'l'] as const) {
      const target = side === 'r' ? g : gl, S = side === 'r' ? Sr : Sl, H = hands[side];
      const F = target.clone().sub(S).normalize();
      const q = setHandWorld(B[`hand_${side}`], H.axis, H.fingers, d, F);
      const wrist = target.clone().sub(offW(B[`hand_${side}`], H.off, q));
      const pole = S.clone().addScaledVector(up, -1).addScaledVector(right, side === 'r' ? 0.7 : -0.7).addScaledVector(fwd, -0.3);
      const [L1, L2] = armLen(B, side);
      stretch = Math.max(stretch, wrist.distanceTo(S) / (L1 + L2));
      ik(B, side, L1, L2, wrist, pole);
      setHandWorld(B[`hand_${side}`], H.axis, H.fingers, d, F);
    }
    const grip = (side: 'l' | 'r') => B[`hand_${side}`].localToWorld(hands[side].off.clone());
    const e = Math.max(gl.distanceTo(grip('l')), g.distanceTo(grip('r')));
    // Treat a fully straightened arm as a miss: keep ~5% slack so the elbows stay bent.
    return stretch > 0.95 ? Math.max(e, 0.01) : e;
  };
  // Largest pull fraction (closest to the clip's own swing) at which both grips land on the haft.
  let s = 1, pl = place(1), err = solve(pl.g, pl.d);
  if (err > 0.002) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 14; i++) { const m = (lo + hi) / 2; const p = place(m); if (solve(p.g, p.d) <= 0.002) lo = m; else hi = m; }
    s = lo; pl = place(s); err = solve(pl.g, pl.d);
  }
  const { g, d: Df, lift: groundLift } = pl;
  D.copy(Df);
  const pen = penAt(g, D).worst, gap = err, gapR = 0;
  // Close the fingers around the haft.
  for (const side of ['l', 'r']) for (const f of ['index', 'middle', 'ring', 'pinky']) for (const k of ['01', '02', '03']) B[`${f}_${k}_${side}`]?.rotateOnAxis(new THREE.Vector3(0, 0, 1), k === '01' ? 0.9 : 1.25);
  for (const side of ['l', 'r']) { B[`thumb_02_${side}`]?.rotateOnAxis(new THREE.Vector3(0, 0, 1), 0.6); }
  B['hand_r'].parent!.parent!.updateMatrixWorld(true);
  return { s: +s.toFixed(2), pen: +pen.toFixed(3), tipY: +(g.y + D.y * rig.tipLen).toFixed(3), groundLift: +groundLift.toFixed(3), gap: +gap.toFixed(4), gapR: +gapR.toFixed(4) };
}
