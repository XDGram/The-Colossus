import * as THREE from 'three';
import { gripAt, rotateWorld, twoBone, wpos } from '../enemies/ik';
import type { LayerCtx, LayerOut } from '../enemies/custom';

/**
 * Temple Warden boss pose layers (applied after the base clip, like src/enemies/custom.ts, which is unchanged):
 * the lunge drive, the left-palm fire cast and the blade raised to call lightning. The approved mentor body,
 * head, costume and katana are untouched; these only pose his arms and move his root.
 */
const ss = THREE.MathUtils.smoothstep;
const bump = (t: number, a: number, b: number, c: number, d: number) => ss(t, a, b) * (1 - ss(t, c, d));

export const BOSS_LAYERS = new Set(['wardenLunge', 'wardenStep', 'wardenPalm', 'wardenRaise']);

export function applyBossLayer(name: string, t: number, dur: number, ctx: LayerCtx): LayerOut {
  const B = ctx.bones, root = wpos(ctx.root);
  const at = (r: number, f: number, u: number) => root.clone().addScaledVector(ctx.right, r).addScaledVector(ctx.fwd, f).addScaledVector(ctx.up, u);
  switch (name) {
    case 'wardenLunge':
      // Closing thrust: 2.2 m between 0.05 s and the 0.33 s hit (Sword_Dash itself barely travels).
      return { offset: ctx.fwd.clone().multiplyScalar(2.2 * ss(t, 0.05, 0.33)) };
    case 'wardenStep':
      // A short step into the opening swing (its arc only reaches ~1.4 m): 0.6 m before the 0.27 s hit, so the move
      // connects from his 1.4-2.0 m holding distance.
      return { offset: ctx.fwd.clone().multiplyScalar(0.6 * ss(t, 0.02, 0.26)) };
    case 'wardenPalm': {
      // Left palm thrust toward the player for the fireball volley; the katana stays low in the right hand.
      const k = bump(t, 0.05, 0.35, dur - 0.35, dur - 0.05);
      const hand = wpos(B['hand_l']);
      const target = hand.lerp(at(-0.12, 0.62, 1.38), k);
      const pole = wpos(B['upperarm_l']).addScaledVector(ctx.up, -1).addScaledVector(ctx.right, -0.6).addScaledVector(ctx.fwd, -0.3);
      twoBone(B['upperarm_l'], B['lowerarm_l'], B['hand_l'], target, pole);
      rotateWorld(B['spine_02'], ctx.up, -0.22 * k);
      return {};
    }
    case 'wardenRaise': {
      // Katana raised high, point to the sky, left hand open beside it: calling the storm.
      const k = bump(t, 0.05, 0.4, dur - 0.4, dur - 0.05);
      const grip = wpos(B['hand_r']).lerp(at(0.12, 0.18, 2.02), k);
      const D = ctx.fwd.clone().lerp(ctx.up.clone().addScaledVector(ctx.fwd, 0.12), k).normalize();
      const poleR = wpos(B['upperarm_r']).addScaledVector(ctx.right, 1).addScaledVector(ctx.fwd, -0.3);
      gripAt(B, 'r', ctx.cal.r, grip, D, poleR);
      const left = wpos(B['hand_l']).lerp(at(-0.32, 0.28, 1.72), k);
      const poleL = wpos(B['upperarm_l']).addScaledVector(ctx.right, -1).addScaledVector(ctx.fwd, -0.3);
      twoBone(B['upperarm_l'], B['lowerarm_l'], B['hand_l'], left, poleL);
      rotateWorld(B['spine_02'], new THREE.Vector3().crossVectors(ctx.up, ctx.fwd).normalize(), -0.12 * k);
      return {};
    }
  }
  return {};
}
