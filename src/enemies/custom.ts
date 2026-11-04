import * as THREE from 'three';
import { closeFingers, dropPelvis, gripAt, rotateWorld, twoBone, wpos, type HandCal } from './ik';
import type { LayerName } from './moves';

/**
 * The seven custom animations, built as procedural layers over a base clip (shared skeleton):
 * Runner: ready stance, spin cut, side-step (L/R), Death B. Breaker: ground stamp, knee-drop stagger, Death B.
 * (breakerCharge and smashTilt are small drivers for clip-based moves.)
 * Each layer runs after the mixer each frame and may return a root offset / yaw for the enemy's pivot.
 */
export interface LayerCtx {
  bones: Record<string, THREE.Bone>;
  root: THREE.Object3D;          // the enemy's placement object (world)
  cal: { l: HandCal; r: HandCal };
  fwd: THREE.Vector3; right: THREE.Vector3; up: THREE.Vector3;
  /** Feet positions captured from the base clip this frame (world). */
  feet: { l: THREE.Vector3; r: THREE.Vector3 };
}
export interface LayerOut { offset?: THREE.Vector3; yaw?: number; clubLower?: number }

const ss = THREE.MathUtils.smoothstep;
const bump = (t: number, a: number, b: number, c: number) => ss(t, a, b) * (1 - ss(t, b, c));
const at = (ctx: LayerCtx, r: number, f: number, u: number) => wpos(ctx.root).addScaledVector(ctx.right, r).addScaledVector(ctx.fwd, f).addScaledVector(ctx.up, u);

/** Runner hands holding both blades: positions relative to the enemy (right, forward, up) and blade directions. */
function bladesAt(ctx: LayerCtx, R: [number, number, number], L: [number, number, number], dR: THREE.Vector3, dL: THREE.Vector3) {
  const S = (s: 'l' | 'r') => wpos(ctx.bones[`upperarm_${s}`]);
  for (const [side, p, d] of [['r', R, dR], ['l', L, dL]] as const) {
    const pole = S(side).addScaledVector(ctx.up, -1).addScaledVector(ctx.right, side === 'r' ? 0.8 : -0.8).addScaledVector(ctx.fwd, -0.4);
    gripAt(ctx.bones, side, ctx.cal[side], at(ctx, p[0], p[1], p[2]), d.clone().normalize(), pole);
    closeFingers(ctx.bones, side);
  }
}
const dirOf = (ctx: LayerCtx, r: number, f: number, u: number) => new THREE.Vector3().addScaledVector(ctx.right, r).addScaledVector(ctx.fwd, f).addScaledVector(ctx.up, u).normalize();

export function applyLayer(name: LayerName, t: number, dur: number, ctx: LayerCtx): LayerOut {
  const B = ctx.bones;
  // Forward-bend axis (rotating up toward forward), independent of the right vector's sign.
  const pitch = new THREE.Vector3().crossVectors(ctx.up, ctx.fwd).normalize();
  switch (name) {
    case 'runnerReady': {
      // Low, wide dual-blade stance: knees bent, blades forward and slightly out, points raised.
      const br = Math.sin(t * 2.2) * 0.008;
      dropPelvis(B, -0.08 + br, ctx.fwd, ctx.feet);
      rotateWorld(B['spine_02'], pitch, 0.12);
      bladesAt(ctx, [0.3, 0.3, 0.98 + br], [-0.27, 0.36, 1.02 + br], dirOf(ctx, 0.25, 1, 0.55), dirOf(ctx, -0.2, 1, 0.75));
      return {};
    }
    case 'runnerSpin': {
      // Hop-turn through a full circle with both blades held out wide; hit at 0.45 s.
      const k = ss(t, 0.12, 0.62), crouch = bump(t, 0.0, 0.12, 0.3) * 0.1 - bump(t, 0.2, 0.42, 0.7) * 0.05;
      dropPelvis(B, -0.06 - crouch, ctx.fwd, ctx.feet);
      const ext = bump(t, 0.1, 0.3, 0.8);
      const R: [number, number, number] = [THREE.MathUtils.lerp(0.3, 0.62, ext), THREE.MathUtils.lerp(0.3, 0.12, ext), THREE.MathUtils.lerp(0.98, 1.22, ext)];
      const L: [number, number, number] = [-R[0], R[1], R[2]];
      bladesAt(ctx, R, L, dirOf(ctx, 1, THREE.MathUtils.lerp(1, -0.25, ext), 0.15), dirOf(ctx, -1, THREE.MathUtils.lerp(1, -0.25, ext), 0.15));
      rotateWorld(B['spine_02'], ctx.fwd, Math.sin(k * Math.PI) * 0.12);
      return { yaw: -k * Math.PI * 2 };
    }
    case 'runnerStepL': case 'runnerStepR': {
      // Quick side-step (1.1 m) with a lean away and a dip; blades stay in the ready stance.
      const dir = name === 'runnerStepL' ? -1 : 1, k = ss(t, 0.02, 0.36), b = Math.sin(Math.min(1, t / 0.42) * Math.PI);
      dropPelvis(B, -0.08 - b * 0.07, ctx.fwd, ctx.feet);
      rotateWorld(B['spine_01'], ctx.fwd, dir * b * 0.22);
      bladesAt(ctx, [0.3 + dir * b * 0.08, 0.28, 0.98], [-0.27 + dir * b * 0.08, 0.34, 1.0], dirOf(ctx, 0.25, 1, 0.55), dirOf(ctx, -0.2, 1, 0.75));
      return { offset: ctx.right.clone().multiplyScalar(dir * 1.1 * k) };
    }
    case 'runnerDeathB': {
      // Spun around by the blow, then the Death01 collapse.
      const k = 1 - Math.pow(1 - Math.min(1, t / 0.75), 3);
      rotateWorld(B['spine_02'], ctx.up, -bump(t, 0, 0.25, 0.7) * 0.5);
      return { yaw: k * Math.PI * 1.15 };
    }
    case 'runnerLunge':
      // Drive the closing thrust: 1.8 m between 0.05 s and the 0.33 s hit.
      return { offset: ctx.fwd.clone().multiplyScalar(1.8 * ss(t, 0.05, 0.33)) };
    case 'breakerCharge': {
      // Shield_Dash only travels 0.4 m: drive the 4 m rush from the game side.
      rotateWorld(B['spine_02'], pitch, bump(t, 0.02, 0.15, 0.8) * 0.25);
      return { offset: ctx.fwd.clone().multiplyScalar(4 * ss(t, 0.04, 0.7)) };
    }
    case 'breakerStamp': {
      // Lift the right knee high (0.15-0.55 s), slam the foot down at 0.75 s; body drops into the impact.
      const lift = ss(t, 0.15, 0.55) * (1 - ss(t, 0.6, 0.75)), impact = bump(t, 0.72, 0.8, 1.2);
      dropPelvis(B, -0.02 * lift - 0.09 * impact, ctx.fwd, ctx.feet);
      // Foot comes forward under a high knee, and slams down a little ahead of where it started.
      const fwdAmt = Math.max(lift, ss(t, 0.55, 0.75));
      const target = ctx.feet.r.clone().addScaledVector(ctx.up, 0.4 * lift).addScaledVector(ctx.fwd, 0.4 * fwdAmt);
      const knee = wpos(B['calf_r']).addScaledVector(ctx.fwd, 1).addScaledVector(ctx.up, 0.4);
      twoLeg(B, 'r', target, knee);
      rotateWorld(B['spine_02'], pitch, 0.06 * lift + 0.18 * impact);
      rotateWorld(B['spine_01'], ctx.fwd, -0.08 * lift);
      return {};
    }
    case 'breakerStagger': {
      // Guard broken: drops to one knee (0.05-0.35 s), sags, then forces himself up (1.75-2.2 s).
      const k = ss(t, 0.05, 0.35) * (1 - ss(t, 1.75, 2.2));
      kneel(ctx, k);
      rotateWorld(B['spine_02'], pitch, 0.25 * k + Math.sin(t * 3) * 0.02 * k);
      rotateWorld(B['neck_01'], pitch, 0.22 * k);
      return { clubLower: k };
    }
    case 'breakerDeathB': {
      // Down to one knee, then slumps forward over the planted club and stays there.
      const k = ss(t, 0.05, 0.45), s = ss(t, 0.7, 1.9);
      kneel(ctx, k, 0.06 * s);
      rotateWorld(B['spine_01'], pitch, 0.18 * s);
      rotateWorld(B['spine_02'], pitch, 0.25 * k + 0.32 * s);
      rotateWorld(B['neck_01'], pitch, 0.2 * k + 0.4 * s);
      return { clubLower: k + 0.6 * s };
    }
    case 'smashTilt':
      return {};
  }
}

function twoLeg(B: Record<string, THREE.Bone>, s: 'l' | 'r', target: THREE.Vector3, pole: THREE.Vector3) {
  const fq = B[`foot_${s}`].getWorldQuaternion(new THREE.Quaternion());
  twoBone(B[`thigh_${s}`], B[`calf_${s}`], B[`foot_${s}`], target, pole);
  B[`foot_${s}`].quaternion.copy(B[`foot_${s}`].parent!.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(fq));
  B[`foot_${s}`].updateMatrixWorld(true);
}
/** One-knee kneel: left foot forward and planted, right knee down near the ground behind. k in [0,1]. */
function kneel(ctx: LayerCtx, k: number, extra = 0) {
  const B = ctx.bones;
  const lf = ctx.feet.l.clone().addScaledVector(ctx.fwd, 0.22 * k);
  const rf = ctx.feet.r.clone().addScaledVector(ctx.fwd, -0.42 * k).addScaledVector(ctx.up, 0.04 * k);
  dropPelvis(B, -(0.5 * k + extra), ctx.fwd, { l: lf, r: rf });
  const kneeR = wpos(B['calf_r']).addScaledVector(ctx.fwd, 0.6).addScaledVector(ctx.up, -1);
  twoLeg(B, 'r', rf, kneeR);
  // Toes of the kneeling leg tip down onto the ground.
  rotateWorld(B['foot_r'], ctx.right, 0.6 * k);
}

