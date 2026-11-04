import * as THREE from 'three';
import type { Colliders } from '../world/colliders';

/**
 * Shared swept hit detection (docs/combat.md §3), used by player and enemy attacks alike.
 *
 * - Weapons are segments (hilt → tip) tracked between frames. Each frame's motion is split into sub-steps so the
 *   tip (and hilt, and any target) moves at most 0.1 m per step; each step tests the segment against target capsules.
 *   Hilt and tip are interpolated around the attacker's chest (direction slerp + distance lerp, with the chest itself
 *   moving), so fast arcs are followed instead of cut across along their chord.
 * - Targets are vertical capsules (feet + radius + height) whose motion over the frame is interpolated in the same
 *   sub-steps, so lunges, charges and rolls are tested along their whole path.
 * - Body sweeps (charge) and ground rings (stamp) use the same targets and rules.
 * - Each attack instance (key) hits each target at most once.
 * - A hit is rejected if a collider blocks the line from the attacker's chest to the contact point.
 *
 * Pure detection: it reports HitEvents; damage and reactions are applied by the caller.
 */

export interface Capsule { base: THREE.Vector3; radius: number; bottom: number; top: number }
export interface HitTarget {
  id: string;
  /** Current capsule (feet position + shape), read once per frame by beginFrame(). */
  capsule(): Capsule;
  /** Optional: skip this target (e.g. dead). */
  active?(): boolean;
}
export interface WeaponSample { hilt: THREE.Vector3; tip: THREE.Vector3; radius: number }
export interface HitEvent {
  key: string; attacker: string; target: string;
  /** Contact point (world) and the sub-step fraction within the frame where contact happened (0..1). */
  point: THREE.Vector3; at: number;
  kind: 'weapon' | 'body' | 'ring';
}

/** Default body shapes (docs/combat.md §3). */
export const BODY = {
  player: { radius: 0.38, bottom: 0.1, top: 1.75 },
  runner: { radius: 0.38, bottom: 0.1, top: 1.75 },
  breaker: { radius: 0.48, bottom: 0.1, top: 1.75 },
};
export const WEAPON_RADIUS = { blade: 0.03, clubHead: 0.085 };
export const MAX_STEP = 0.1;
const MAX_SUBSTEPS = 48;

const v = () => new THREE.Vector3();

/** Closest distance between segments p1-q1 and p2-q2; returns the distance and the closest point on the first. */
export function segSegDistance(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3) {
  const d1 = v().subVectors(q1, p1), d2 = v().subVectors(q2, p2), r = v().subVectors(p1, p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s: number, t: number;
  if (a <= 1e-9 && e <= 1e-9) { s = t = 0; }
  else if (a <= 1e-9) { s = 0; t = THREE.MathUtils.clamp(f / e, 0, 1); }
  else {
    const c = d1.dot(r);
    if (e <= 1e-9) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
    else {
      const b = d1.dot(d2), den = a * e - b * b;
      s = den > 1e-9 ? THREE.MathUtils.clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); }
      else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  const c1 = p1.clone().addScaledVector(d1, s), c2 = p2.clone().addScaledVector(d2, t);
  return { dist: c1.distanceTo(c2), onFirst: c1, onSecond: c2 };
}

interface TargetState { target: HitTarget; prev: Capsule; cur: Capsule }

export class HitWorld {
  private targets = new Map<string, TargetState>();
  private weaponPrev = new Map<string, { hilt: THREE.Vector3; tip: THREE.Vector3; chest: THREE.Vector3 }>();
  private bodyPrev = new Map<string, THREE.Vector3>();
  private hitOnce = new Map<string, Set<string>>();
  /** Sub-step counts used in the last frame (for tests). */
  lastSubsteps = 0;

  constructor(private colliders: Colliders | null) {}

  addTarget(t: HitTarget) { const c = t.capsule(); this.targets.set(t.id, { target: t, prev: clone(c), cur: clone(c) }); }
  removeTarget(id: string) { this.targets.delete(id); }

  /** Call once per frame before any sweeps: snapshots every target's capsule (previous → current). */
  beginFrame() {
    for (const s of this.targets.values()) { s.prev = s.cur; s.cur = clone(s.target.capsule()); }
  }

  /**
   * Sweep a weapon for attack instance `key` this frame. The first call for a key uses `prevSample` if given
   * (e.g. last frame's blade), otherwise the current sample (no motion). Returns new hits only.
   */
  sweepWeapon(key: string, attacker: string, cur: WeaponSample, chest: THREE.Vector3, prevSample?: { hilt: THREE.Vector3; tip: THREE.Vector3 }): HitEvent[] {
    const prev = this.weaponPrev.get(key) ?? { ...(prevSample ?? { hilt: cur.hilt, tip: cur.tip }), chest };
    this.weaponPrev.set(key, { hilt: cur.hilt.clone(), tip: cur.tip.clone(), chest: chest.clone() });
    const out: HitEvent[] = [];
    const done = this.done(key);
    for (const s of this.targets.values()) {
      if (s.target.id === attacker || done.has(s.target.id) || s.target.active?.() === false) continue;
      // Arc length of the tip around the chest (>= its chord), so sub-steps stay under MAX_STEP along the real path.
      const arc = (a: THREE.Vector3, b: THREE.Vector3) => Math.max(a.distanceTo(b), a.clone().sub(prev.chest).angleTo(b.clone().sub(chest)) * Math.max(a.distanceTo(prev.chest), b.distanceTo(chest)));
      const move = Math.max(arc(prev.tip, cur.tip), arc(prev.hilt, cur.hilt), s.prev.base.distanceTo(s.cur.base));
      const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(move / MAX_STEP)));
      this.lastSubsteps = Math.max(this.lastSubsteps, n);
      for (let i = 1; i <= n; i++) {
        const k = i / n;
        const c = prev.chest.clone().lerp(chest, k);
        const h = orbit(prev.hilt, prev.chest, cur.hilt, chest, c, k), tp = orbit(prev.tip, prev.chest, cur.tip, chest, c, k);
        const cap = lerpCapsule(s.prev, s.cur, k);
        const a = cap.base.clone().setY(cap.base.y + cap.bottom), b = cap.base.clone().setY(cap.base.y + cap.top);
        const r = segSegDistance(h, tp, a, b);
        if (r.dist <= cap.radius + cur.radius) {
          if (this.blocked(chest, r.onFirst)) break;
          done.add(s.target.id);
          out.push({ key, attacker, target: s.target.id, point: r.onFirst, at: k, kind: 'weapon' });
          break;
        }
      }
    }
    return out;
  }

  /** Sweep an attacker's body capsule (charge) from its previous position to `cur` (feet). */
  sweepBody(key: string, attacker: string, cur: THREE.Vector3, shape: { radius: number; bottom: number; top: number }): HitEvent[] {
    const prev = this.bodyPrev.get(key) ?? cur.clone();
    this.bodyPrev.set(key, cur.clone());
    const out: HitEvent[] = [], done = this.done(key);
    for (const s of this.targets.values()) {
      if (s.target.id === attacker || done.has(s.target.id) || s.target.active?.() === false) continue;
      const n = Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(Math.max(prev.distanceTo(cur), s.prev.base.distanceTo(s.cur.base)) / MAX_STEP)));
      for (let i = 1; i <= n; i++) {
        const k = i / n, p = prev.clone().lerp(cur, k), cap = lerpCapsule(s.prev, s.cur, k);
        const r = segSegDistance(p.clone().setY(p.y + shape.bottom), p.clone().setY(p.y + shape.top),
          cap.base.clone().setY(cap.base.y + cap.bottom), cap.base.clone().setY(cap.base.y + cap.top));
        if (r.dist <= shape.radius + cap.radius) {
          if (this.blocked(p.clone().setY(p.y + 1.2), r.onSecond)) break;
          done.add(s.target.id);
          out.push({ key, attacker, target: s.target.id, point: r.onSecond, at: k, kind: 'body' });
          break;
        }
      }
    }
    return out;
  }

  /**
   * Ground ring (stamp shockwave) expanding from `r0` to `r1` this frame around `center` (feet height).
   * Hits targets whose feet are within `band` of the ring's edge and no more than `maxAir` above the ground.
   */
  sweepRing(key: string, attacker: string, center: THREE.Vector3, r0: number, r1: number, band = 0.4, maxAir = 0.25): HitEvent[] {
    const out: HitEvent[] = [], done = this.done(key);
    for (const s of this.targets.values()) {
      if (s.target.id === attacker || done.has(s.target.id) || s.target.active?.() === false) continue;
      const d = Math.hypot(s.cur.base.x - center.x, s.cur.base.z - center.z);
      // Edge of the target's footprint against the ring band swept this frame.
      if (d + s.cur.radius < r0 - band || d - s.cur.radius > r1 + band) continue;
      if (s.cur.base.y - center.y > maxAir) continue;
      const point = new THREE.Vector3(s.cur.base.x, center.y, s.cur.base.z);
      if (this.blocked(center.clone().setY(center.y + 0.4), point.clone().setY(center.y + 0.4))) continue;
      done.add(s.target.id);
      out.push({ key, attacker, target: s.target.id, point, at: 1, kind: 'ring' });
    }
    return out;
  }

  /** Forget an attack instance (call when the move ends). */
  endAttack(key: string) { this.weaponPrev.delete(key); this.bodyPrev.delete(key); this.hitOnce.delete(key); }

  /** True if a collider blocks the line from `from` to `to` (sampled every 0.1 m, stopping 5 cm short of the contact). */
  blocked(from: THREE.Vector3, to: THREE.Vector3) {
    if (!this.colliders) return false;
    const d = from.distanceTo(to) - 0.05;
    if (d <= 0) return false;
    const dir = to.clone().sub(from).normalize();
    for (let s = 0.05; s <= d; s += 0.1) {
      const p = from.clone().addScaledVector(dir, s);
      if (this.colliders.blocks(p.x, p.y, p.z)) return true;
    }
    return false;
  }

  private done(key: string) { let s = this.hitOnce.get(key); if (!s) { s = new Set(); this.hitOnce.set(key, s); } return s; }
}

/** Interpolates a point that moves from a (relative to chest ca) to b (relative to chest cb), around the moving chest c. */
function orbit(a: THREE.Vector3, ca: THREE.Vector3, b: THREE.Vector3, cb: THREE.Vector3, c: THREE.Vector3, k: number) {
  const ra = a.clone().sub(ca), rb = b.clone().sub(cb);
  const la = ra.length(), lb = rb.length();
  if (la < 1e-4 || lb < 1e-4) return a.clone().lerp(b, k);
  const q = new THREE.Quaternion().setFromUnitVectors(ra.clone().normalize(), rb.clone().normalize());
  const dir = ra.normalize().applyQuaternion(new THREE.Quaternion().slerp(q, k));
  return c.clone().addScaledVector(dir, THREE.MathUtils.lerp(la, lb, k));
}
function clone(c: Capsule): Capsule { return { base: c.base.clone(), radius: c.radius, bottom: c.bottom, top: c.top }; }
function lerpCapsule(a: Capsule, b: Capsule, k: number): Capsule {
  return { base: a.base.clone().lerp(b.base, k), radius: b.radius, bottom: b.bottom, top: b.top };
}
