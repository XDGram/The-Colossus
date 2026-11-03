import * as THREE from 'three';
import { closeFingers, gripAt, type HandCal, wpos, wquat } from './ik';

/**
 * Two-handed war-club grip for one-handed clips (Iron Breaker), re-implemented from the approved preview
 * (tools/animprev). Per frame, after the mixer: take the club grip and direction (from the clip's right hand,
 * or a fixed stance), pull the grip toward the chest until both arms reach with bent elbows, keep the club out
 * of the body and above the ground, then solve both arms onto the haft and close the fingers.
 */
export interface ClubSpec { tipLen: number; pommelLen: number; headR: number; spacing: number }
export interface GripResult { pull: number; err: number; pen: number; tipY: number }

const V = () => new THREE.Vector3();
function segDist(p: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3) {
  const ab = b.clone().sub(a), t = THREE.MathUtils.clamp(p.clone().sub(a).dot(ab) / ab.lengthSq(), 0, 1);
  const c = a.clone().addScaledVector(ab, t); return { d: p.distanceTo(c), c };
}

export class TwoHandGrip {
  constructor(private bones: Record<string, THREE.Bone>, private cal: { l: HandCal; r: HandCal }, private club: ClubSpec) {}

  /** Wind-up tilt for the overhead smash (clip time in Sword_Heavy_Combo): peaks at 2.5 s, back to 0 at the 2.63 s impact. */
  static smashTilt(clipTime: number) {
    if (clipTime < 2.2 || clipTime >= 2.63) return 0;
    return clipTime < 2.5 ? THREE.MathUtils.smoothstep(clipTime, 2.2, 2.5) : 1 - THREE.MathUtils.smoothstep(clipTime, 2.5, 2.63);
  }

  /** g0/D0: desired right-hand grip point and club direction (world). allowPull: may shorten the swing radius. */
  solve(g0: THREE.Vector3, D0: THREE.Vector3, groundY: number, tilt = 0, allowPull = true): GripResult {
    const B = this.bones, up = new THREE.Vector3(0, 1, 0);
    const Sr = wpos(B['upperarm_r']), Sl = wpos(B['upperarm_l']);
    const right = Sr.clone().sub(Sl).normalize();
    const fwd = V().crossVectors(up, right).normalize();
    const chestF = new THREE.Vector3(0, 0, 1).applyQuaternion(wquat(B['spine_03'])).setY(0);
    if (chestF.dot(fwd) < 0) fwd.negate();
    const D = D0.clone().normalize();
    if (tilt > 0) {
      const ang = THREE.MathUtils.degToRad(40) * tilt;
      const d1 = D.clone().applyAxisAngle(right, ang), d2 = D.clone().applyAxisAngle(right, -ang);
      D.copy(d1.y > d2.y ? d1 : d2);
    }
    const C = wpos(B['spine_03']).addScaledVector(fwd, 0.4).addScaledVector(up, -0.14);
    const caps: [THREE.Vector3, THREE.Vector3, number][] = [
      [wpos(B['pelvis']), wpos(B['neck_01']), 0.26], [wpos(B['neck_01']), wpos(B['Head']).addScaledVector(up, 0.2), 0.17],
      [wpos(B['thigh_l']), wpos(B['calf_l']), 0.13], [wpos(B['thigh_r']), wpos(B['calf_r']), 0.13],
      [wpos(B['calf_l']), wpos(B['foot_l']), 0.1], [wpos(B['calf_r']), wpos(B['foot_r']), 0.1]];
    const c = this.club;
    const penAt = (g: THREE.Vector3, d: THREE.Vector3) => {
      let worst = 0; const push = V();
      for (let k = 0; k <= 16; k++) {
        const t = -c.pommelLen + (c.tipLen + c.pommelLen) * (k / 16);
        if (t > -0.05 && t < 0.3) continue; // the gripped part of the haft sits between the hands
        const p = g.clone().addScaledVector(d, t), r = t > 0.6 ? c.headR : 0.026;
        for (const [a, b, cr] of caps) {
          const { d: dd, c: cc } = segDist(p, a, b); const q = cr + r - dd;
          if (q > worst) { worst = q; push.copy(p).sub(cc).normalize().multiplyScalar(q); }
        }
      }
      return { worst, push };
    };
    const minY = groundY + c.headR + 0.01;
    const place = (s: number) => {
      const g = C.clone().lerp(g0, s), d = D.clone();
      for (let round = 0; round < 4; round++) {
        for (let it = 0; it < 4; it++) { const { worst, push } = penAt(g, d); if (worst < 0.004) break; g.add(push); }
        const tipY = g.y + d.y * c.tipLen;
        if (tipY >= minY - 0.002) break;
        const h = new THREE.Vector3(d.x, 0, d.z); if (h.lengthSq() < 1e-6) h.copy(fwd); h.normalize();
        const sy = THREE.MathUtils.clamp((minY - g.y) / c.tipLen, -1, 1);
        d.copy(h.multiplyScalar(Math.sqrt(1 - sy * sy))).setY(sy).normalize();
      }
      return { g, d };
    };
    const grip = (side: 'l' | 'r') => B[`hand_${side}`].localToWorld(this.cal[side].off.clone());
    let spacing = c.spacing;
    const arms = (g: THREE.Vector3, d: THREE.Vector3) => {
      const gl = g.clone().addScaledVector(d, -spacing);
      let stretch = 0;
      for (let pass = 0; pass < 2; pass++) for (const side of ['r', 'l'] as const) {
        const S = side === 'r' ? Sr : Sl;
        const pole = S.clone().addScaledVector(up, -1).addScaledVector(right, side === 'r' ? 0.7 : -0.7).addScaledVector(fwd, -0.3);
        stretch = Math.max(stretch, gripAt(B, side, this.cal[side], side === 'r' ? g : gl, d, pole));
      }
      const e = Math.max(gl.distanceTo(grip('l')), g.distanceTo(grip('r')));
      return stretch > 0.95 ? Math.max(e, 0.01) : e;
    };
    let s = 1, pl = place(1), err = arms(pl.g, pl.d);
    if (err > 0.002 && allowPull) {
      let lo = 0, hi = 1;
      for (let i = 0; i < 12; i++) { const m = (lo + hi) / 2; const p = place(m); if (arms(p.g, p.d) <= 0.002) lo = m; else hi = m; }
      s = lo; pl = place(s); err = arms(pl.g, pl.d);
      // Still short: let the left hand slide along the haft (closer to, or further from, the right hand).
      if (err > 0.002) {
        let best = { err, sp: spacing };
        for (const sp of [0.11, 0.24, 0.3, 0.07]) { spacing = sp; const e = arms(pl.g, pl.d); if (e < best.err) best = { err: e, sp }; if (e <= 0.002) break; }
        spacing = best.sp; err = arms(pl.g, pl.d);
      }
    }
    closeFingers(B, 'l'); closeFingers(B, 'r');
    return { pull: s, err, pen: penAt(pl.g, pl.d).worst, tipY: pl.g.y + pl.d.y * c.tipLen };
  }
}
