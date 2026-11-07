import * as THREE from 'three';
import type { Input, SpiritKind } from '../core/input';
import type { Player } from './player';
import type { PlayerCombat, SpiritDriver } from './combat';
import type { HitWorld } from '../combat/hits';
import type { EnemyBrain } from '../combat/brain';
import type { AbilityHit, AbilitySource, PlayerHitResult } from '../combat/system';
import { FX_COLORS, type Vfx } from '../fx/vfx';
import type { SpiritFx } from '../fx/spirit';
import { ABILITY } from '../combat/tables';
import { setWorldQuat, twoBone, wpos, wquat } from '../enemies/ik';

/**
 * The protagonist's supernatural abilities (docs/abilities.md), driven as a PlayerCombat state ('spirit'):
 *
 * - Phantom Step (Q): crouch, vanish into cyan light and dash 6.5 m straight through enemies (cutting each once),
 *   leaving afterimages and an energy ribbon, then reappear in the follow-through. Untouchable while travelling.
 * - Colossus Rift (E, hold): the katana is raised and charges (blade aura, inward motes, ground light); releasing
 *   swings it and launches a crescent energy wave that travels forward, hitting every enemy in its path once.
 * - Gravity Rupture (R): both hands drive the katana point-first into the ground: glowing cracks, a glyph ring and a
 *   shockwave burst out, paving lifts and hovers, nearby enemies are dragged inward, then the field collapses.
 *
 * Hits go through the shared HitWorld (once per enemy per use, walls block) and CombatSystem's normal damage, poise
 * and meter rules (ability values in src/combat/tables.ts). Effects are pooled (src/fx/vfx.ts, src/fx/spirit.ts).
 */
export interface AbilityDeps {
  player: Player; combat: PlayerCombat; hits: HitWorld; brains: () => EnemyBrain[];
  vfx: Vfx; fx: SpiritFx; sound: (name: string, at?: THREE.Vector3) => void;
  shake: (amount: number, time: number) => void;
  height: (x: number, z: number) => number;
  blocks: (x: number, y: number, z: number) => boolean;
}
interface Wave { key: string; pos: THREE.Vector3; dir: THREE.Vector3; yaw: number; travelled: number; range: number; width: number; scale: number;
  crescent: ReturnType<SpiritFx['crescent']>; trace: number; done: boolean }
interface Ring { key: string; move: 'rupture' | 'implode'; c: THREE.Vector3; t: number; dur: number; r0: number; r1: number }

const C = FX_COLORS;
const UP = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3();

export class Abilities implements SpiritDriver, AbilitySource {
  readonly cool: Record<SpiritKind, number> = { phantom: 0, rift: 0, rupture: 0 };
  kind: SpiritKind | null = null;
  private t = 0;
  private serial = 0;
  private aim = new THREE.Vector3(0, 0, 1);
  private fired = new Set<string>();
  private driveV: THREE.Vector3 | null = null;
  private key = '';
  // Phantom Step
  private from = new THREE.Vector3();
  // Colossus Rift
  private charge = 0; private released = -1; private full = false;
  private waves: Wave[] = [];
  // Gravity Rupture
  private rings: Ring[] = [];
  private center = new THREE.Vector3();
  private ik: Record<string, THREE.Object3D> = {};
  /** Hit-stop: world time runs slowly for this long (seconds of real time). */
  private stop = 0;
  /** Enemies hit by the current Phantom Step (for the slash marks on reappearing). */
  private passed: EnemyBrain[] = [];

  constructor(private d: AbilityDeps) {
    for (const n of ['upperarm_r', 'lowerarm_r', 'hand_r', 'upperarm_l', 'lowerarm_l', 'hand_l', 'spine_03', 'pelvis']) {
      const o = d.player.model.getObjectByName(n); if (o) this.ik[n] = o;
    }
  }

  // ------------------------------------------------------------------ SpiritDriver
  ready(k: SpiritKind) { return this.cool[k] <= 0; }
  /** 0..1 readiness per ability (UI). */
  readiness(): Record<SpiritKind, number> {
    return { phantom: 1 - this.cool.phantom / ABILITY.phantom.cooldown, rift: 1 - this.cool.rift / ABILITY.rift.cooldown, rupture: 1 - this.cool.rupture / ABILITY.rupture.cooldown };
  }
  get invulnerable() {
    if (this.kind === 'phantom') return this.t >= ABILITY.phantom.invulnerable[0] && this.t <= ABILITY.phantom.invulnerable[1];
    if (this.kind === 'rupture') return this.t >= ABILITY.rupture.invulnerable[0] && this.t <= ABILITY.rupture.invulnerable[1];
    return false;
  }
  get lockPelvis() { return this.kind !== null; }
  /** True while the player passes through bodies (enemy spacing ignores him). */
  get ghost() { return this.kind === 'phantom' && this.t < ABILITY.phantom.anticipate + ABILITY.phantom.travel + 0.05; }
  drive() { return this.driveV; }
  /** World time scale this frame (hit-stop). Call once per frame with the real delta. */
  timeScale(dt: number) { if (this.stop > 0) { this.stop -= dt; return 0.06; } return 1; }

  start(k: SpiritKind, aim: THREE.Vector3, camYaw: number) {
    this.kind = k; this.t = 0; this.fired.clear(); this.driveV = null; this.key = `ability:${k}#${++this.serial}`;
    this.cool[k] = ABILITY[k].cooldown;
    const P = this.d.player;
    if (k === 'phantom') {
      // Aim: the stick direction (or facing), bent toward an enemy close to that line so the step passes through him.
      this.aim.copy(aim).setY(0).normalize();
      let best: THREE.Vector3 | null = null, bestScore = Infinity;
      for (const b of this.d.brains()) {
        if (b.dead || b.removed) continue;
        const to = b.effective().sub(P.position).setY(0), dist = to.length();
        if (dist < 0.5 || dist > ABILITY.phantom.dist - 0.8) continue;
        const ang = to.clone().normalize().angleTo(this.aim);
        if (ang < 0.45 && ang * 4 + dist * 0.2 < bestScore) { bestScore = ang * 4 + dist * 0.2; best = to.normalize(); }
      }
      if (best) this.aim.copy(best);
      P.setFacing(Math.atan2(this.aim.x, this.aim.z));
      this.from.copy(P.position); this.passed.length = 0;
      this.d.combat.playClip('Sword_Dash', 0.08, 1.7);
      this.d.fx.ribbon.clear();
      this.d.sound('spiritDash', P.position);
      // Anticipation: cyan motes drawn into the body, a streak along the blade.
      const chest = P.position.clone().setY(P.position.y + 1.1);
      for (let i = 0; i < 10; i++) {
        const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() * 0.8 - 0.3, Math.random() - 0.5).normalize();
        this.d.vfx.spawn('spark_01', chest.clone().addScaledVector(dir, 1.1), { color: C.spirit, life: 0.12, size: 0.34, size1: 0.08, vel: dir.multiplyScalar(-9), alpha: 1 });
      }
    } else if (k === 'rift') {
      this.charge = 0; this.released = -1; this.full = false;
      // Wind-up of the big cut (blade raised behind), held while charging.
      this.d.combat.playClip('Sword_Regular_Combo', 0.1, 1.0, 0.3);
      this.d.sound('riftCharge', P.position);
      // Aim: lock onto the enemy in front of the player (if any), else straight where he faces.
      this.riftTarget = this.lockOn(aim);
      void camYaw;
    } else {
      this.center.copy(P.position).addScaledVector(this.facingDir(), 0.55);
      this.center.y = this.d.height(this.center.x, this.center.z);
      // Lift: the two-handed raise, held, then the drop into the crouch.
      this.d.combat.playClip('Sword_Heavy_Combo', 0.22, 1.0, 0.36);
      this.d.sound('ruptureCharge', P.position);
    }
  }

  update(dt: number, input: Input, camYaw: number): boolean {
    for (const k of Object.keys(this.cool) as SpiritKind[]) this.cool[k] = Math.max(0, this.cool[k] - dt);
    if (!this.kind) return false;
    this.t += dt;
    if (this.kind === 'phantom') return this.updatePhantom();
    if (this.kind === 'rift') return this.updateRift(dt, input, camYaw);
    return this.updateRupture(dt);
  }
  /** Cooldowns keep running while no ability is active (called by the game every frame). */
  tick(dt: number) { if (this.kind) return; for (const k of Object.keys(this.cool) as SpiritKind[]) this.cool[k] = Math.max(0, this.cool[k] - dt); }

  reset() { this.cool.phantom = this.cool.rift = this.cool.rupture = 0; for (const w of this.waves) { w.done = true; w.crescent.dissipate(); } this.rings.length = 0; }
  interrupt() {
    if (!this.kind) return;
    if (this.kind === 'phantom') this.d.player.model.visible = true;
    this.d.fx.aura.set(0, 0);
    this.kind = null; this.driveV = null; this.d.combat.setClipTime(null);
    this.d.hits.endAttack(this.key);
  }

  // ------------------------------------------------------------------ Phantom Step
  private updatePhantom() {
    const A = ABILITY.phantom, P = this.d.player, fx = this.d.fx;
    const t0 = A.anticipate, t1 = A.anticipate + A.travel;
    const chest = P.position.clone().setY(P.position.y + 1.05);
    if (this.t >= t0 && !this.fired.has('vanish')) {
      this.fired.add('vanish');
      // Vanish: the body breaks into light; an afterimage stays behind; inward ring and flash at the start point.
      fx.afterimages.capture(0.5, 1.2, 0.35);
      P.model.visible = false;
      fx.shock().start(P.position, 1.7, 0.2, 0.14, 0.2, 0);
      this.d.vfx.spawn('star_06', chest, { color: C.spiritCore, life: 0.16, size: 2.4, size1: 0.6, alpha: 1 });
      this.d.vfx.spawn('circle_05', chest, { color: C.spirit, life: 0.2, size: 2.0, size1: 0.4, alpha: 0.8 });
      fx.flash(chest, 9, 0.35);
    }
    if (this.t >= t0 && this.t < t1) {
      this.driveV = this.aim.clone().multiplyScalar(A.dist / A.travel);
      fx.ribbon.push(P.position);
      // Afterimages along the path and sparks streaming off the body.
      const n = this.d.vfx.quality === 'high' ? 3 : 2;
      for (let i = 1; i <= n; i++) if (this.t >= t0 + (A.travel * i) / (n + 1) && !this.fired.has(`ghost${i}`)) { this.fired.add(`ghost${i}`); fx.afterimages.capture(0.3, 0.75, 0.2); }
      for (let i = 0; i < 3; i++) this.d.vfx.spawn(Math.random() < 0.5 ? 'spark_01' : 'spark_04', chest.clone().add(new THREE.Vector3((Math.random() - 0.5) * 0.6, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 0.6)),
        { color: Math.random() < 0.3 ? C.spiritCore : C.spirit, life: 0.25, size: 0.3, size1: 0.04, vel: this.aim.clone().multiplyScalar(-3).add(new THREE.Vector3(0, 0.6, 0)), alpha: 1 });
    } else this.driveV = this.t < t0 ? new THREE.Vector3() : null;
    if (this.t >= t1 && !this.fired.has('appear')) {
      this.fired.add('appear');
      fx.ribbon.push(P.position);
      P.model.visible = true;
      // Reappear: star flare, a burst of motes, a sharp ring, and a slash mark across everyone passed.
      this.d.vfx.spawn('star_06', chest, { color: C.spiritCore, life: 0.22, size: 3.0, size1: 0.5, alpha: 1, rot: 0 });
      this.d.vfx.burst('spark_04', chest, { count: 22, color: C.spirit, life: 0.4, size: 0.45, size1: 0.05, speed: 8, up: 0.5, drag: 3 });
      fx.shock().start(P.position, 0.3, 2.4, 0.16, 0.32, 0.5);
      fx.flash(chest, 7, 0.4);
      this.d.sound('spiritAppear', P.position);
      this.d.shake(0.06, 0.18);
      for (const b of this.passed) this.slashMark(b);
      this.d.hits.endAttack(this.key);
    }
    if (this.t >= t1 + A.recover) { this.kind = null; this.driveV = null; return false; }
    return true;
  }
  /** A cut through the body: a white-cyan streak across the chest and sparks. */
  private slashMark(b: EnemyBrain) {
    const c = b.e.chest();
    this.d.vfx.spawn('spark_06', c, { color: C.spiritCore, life: 0.22, size: 0.35, stretch: 7, alpha: 1, rot: Math.PI / 2 + 0.35 });
    this.d.vfx.spawn('spark_06', c, { color: C.spirit, life: 0.3, size: 0.6, stretch: 5, alpha: 0.9, rot: Math.PI / 2 + 0.35 });
    this.d.vfx.burst('spark_04', c, { count: 14, color: C.spirit, life: 0.35, size: 0.36, size1: 0.04, speed: 5, up: 1, grav: 6 });
  }

  // ------------------------------------------------------------------ Colossus Rift
  private updateRift(dt: number, input: Input, camYaw: number) {
    const A = ABILITY.rift, P = this.d.player, fx = this.d.fx;
    const blade = this.d.combat.blade;
    const tip = wpos(blade.tip), hilt = wpos(blade.hilt), mid = hilt.clone().lerp(tip, 0.55);
    if (this.released < 0) {
      // Charging: turn toward the locked enemy (tracked while it moves) or keep facing; the blade gathers light.
      void camYaw;
      if (this.riftTarget && (this.riftTarget.dead || this.riftTarget.removed)) this.riftTarget = this.lockOn(this.facingDir());
      const tp = this.riftTarget?.effective();
      const want = tp ? Math.atan2(tp.x - P.position.x, tp.z - P.position.z) : P.facing;
      const f = P.facing + Math.atan2(Math.sin(want - P.facing), Math.cos(want - P.facing)) * (1 - Math.exp(-10 * dt));
      P.setFacing(f);
      this.charge = Math.min(1, this.t / A.fullCharge);
      fx.aura.set(0.35 + this.charge * 1.0, fx.time, 1 + this.charge * 0.8);
      fx.glow(mid, 1.5 + this.charge * 5);
      const n = Math.random() < 0.4 + this.charge * 0.6 ? (this.d.vfx.quality === 'high' ? 3 : 2) : 0;
      for (let i = 0; i < n; i++) {
        // Motes spiral into the blade.
        const dir = new THREE.Vector3(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).normalize(), r = 0.9 + Math.random() * 0.6;
        const start = mid.clone().addScaledVector(dir, r), vel = dir.clone().multiplyScalar(-r / 0.28).add(dir.clone().cross(UP).multiplyScalar(2.5));
        this.d.vfx.spawn('spark_01', start, { color: Math.random() < 0.3 ? C.spiritCore : C.spirit, life: 0.28, size: 0.3, size1: 0.08, vel, alpha: 1, alpha1: 0.3 });
      }
      if (!this.fired.has('pool')) { this.fired.add('pool'); this.pool = this.d.vfx.decal('circle_05', P.position, { color: C.spirit, size: 1.6, life: -1, fadeIn: 0.25, alpha: 0.9, grow: 1.6 }); this.vortex = this.d.vfx.decal('twirl_02', P.position, { color: C.spirit, size: 3.0, life: -1, fadeIn: 0.4, alpha: 0.7, spin: 4 }); }
      if (this.charge >= 1 && !this.full) {
        // Fully charged: a ping of light from the blade.
        this.full = true;
        this.d.vfx.spawn('star_06', mid, { color: C.spiritCore, life: 0.2, size: 1.6, size1: 0.3, alpha: 1, rot: 0 });
        this.d.vfx.burst('spark_04', mid, { count: 8, color: C.spirit, life: 0.25, size: 0.18, size1: 0.02, speed: 3 });
        fx.shock().start(P.position, 0.4, 1.6, 0.18, 0.3, 0);
        this.d.sound('spiritAppear', mid);
      }
      if ((!input.riftHeld && this.t >= A.minCharge) || this.t >= A.maxHold) {
        // Release: the big cut swings through; the wave leaves the blade at the swing frame.
        this.released = this.t;
        this.d.combat.playClip('Sword_Regular_Combo', 0.3, 1.3);
        this.d.vfx.kill(this.pool); this.d.vfx.kill(this.vortex); this.pool = this.vortex = null;
      }
      return true;
    }
    const since = this.t - this.released;
    fx.aura.set(Math.max(0, 1.3 - since * 4), fx.time, 1.6);
    if (since >= A.release && !this.fired.has('wave')) { this.fired.add('wave'); this.launch(); }
    if (since >= A.release + A.recover) { this.kind = null; fx.aura.set(0, 0); return false; }
    return true;
  }
  private pool: ReturnType<Vfx['decal']> = null; private vortex: ReturnType<Vfx['decal']> = null;
  private riftTarget: EnemyBrain | null = null;
  /**
   * Lock-on: the living enemy nearest to the aim line (within 60° of it and 16 m), preferring closer ones. The aim is
   * the movement direction, or the player's facing when standing still.
   */
  private lockOn(aim: THREE.Vector3) {
    const P = this.d.player.position, dir = aim.clone().setY(0);
    if (dir.lengthSq() < 1e-6) dir.copy(this.facingDir()); dir.normalize();
    let best: EnemyBrain | null = null, bestScore = Infinity;
    for (const b of this.d.brains()) {
      if (b.dead || b.removed || !b.e.object.visible) continue;
      const to = b.effective().sub(P).setY(0), d = to.length();
      if (d < 0.3 || d > 16) continue;
      const ang = to.normalize().angleTo(dir);
      if (ang > Math.PI / 3) continue;
      const score = ang * 6 + d * 0.25;
      if (score < bestScore) { bestScore = score; best = b; }
    }
    return best;
  }
  private launch() {
    const A = ABILITY.rift, P = this.d.player, fx = this.d.fx, k = this.charge;
    // Release straight at the locked enemy (a quick tap may not have finished turning).
    const lt = this.riftTarget && !this.riftTarget.dead ? this.riftTarget.effective() : null;
    if (lt) P.setFacing(Math.atan2(lt.x - P.position.x, lt.z - P.position.z));
    const dir = this.facingDir(), yaw = Math.atan2(dir.x, dir.z);
    const pos = P.position.clone().addScaledVector(dir, 0.9); pos.y = this.d.height(pos.x, pos.z) + A.height;
    const width = THREE.MathUtils.lerp(A.width[0], A.width[1], k), range = THREE.MathUtils.lerp(A.range[0], A.range[1], k);
    const cr = fx.crescent();
    cr.start(pos, yaw, width, 1.0 + 0.5 * k, -0.45);
    this.waves.push({ key: `ability:rift#${++this.serial}`, pos, dir, yaw, travelled: 0, range, width, scale: THREE.MathUtils.lerp(A.minScale, 1, k), crescent: cr, trace: 0, done: false });
    this.d.sound('riftRelease', P.position);
    this.d.shake(0.05 + 0.06 * k, 0.22);
    fx.flash(pos, 10 + 8 * k, 0.4);
    this.d.vfx.spawn('star_06', pos, { color: C.spiritCore, life: 0.18, size: 2.4 + k, size1: 0.6, alpha: 1, rot: 0 });
    this.d.vfx.burst('spark_04', pos, { count: 14, color: C.spirit, life: 0.3, size: 0.25, size1: 0.03, speed: 6, drag: 2 });
  }
  /** Rift waves travel after the player has recovered; swept by CombatSystem through update() below. */
  private stepWaves(dt: number, out: AbilityHit[]) {
    const A = ABILITY.rift;
    for (const w of this.waves) {
      if (w.done) continue;
      const step = A.speed * dt;
      w.pos.addScaledVector(w.dir, step); w.travelled += step;
      const gy = this.d.height(w.pos.x, w.pos.z); w.pos.y = gy + A.height;
      w.crescent.group.position.copy(w.pos);
      // Leading edge (between the tips) for the swept hit; the arc's centre behind it is the line-of-sight origin.
      const right = tmp.set(w.dir.z, 0, -w.dir.x);
      const a = w.pos.clone().addScaledVector(right, -w.width / 2).addScaledVector(w.dir, -0.25), b = w.pos.clone().addScaledVector(right, w.width / 2).addScaledVector(w.dir, -0.25);
      const origin = w.pos.clone().addScaledVector(w.dir, -0.8);
      for (const ev of this.d.hits.sweepWeapon(w.key, 'player', { hilt: a, tip: b, radius: A.radius }, origin)) out.push({ move: 'rift', target: ev.target, point: ev.point, scale: w.scale });
      // Scar along the ground and light shed from the tips.
      w.trace += step;
      if (w.trace > 1.1) { w.trace = 0; this.d.vfx.decal('trace_04', tmp2.set(w.pos.x, gy, w.pos.z), { color: C.spirit, size: w.width * 0.45, length: 1.6, yaw: w.yaw, life: 0.9, fadeIn: 0.03, fadeOut: 0.7, alpha: 0.55 }); }
      for (const p of [a, b]) if (Math.random() < 0.7) this.d.vfx.spawn('spark_01', p, { color: C.spirit, life: 0.35, size: 0.34, size1: 0.03, vel: w.dir.clone().multiplyScalar(-2).add(new THREE.Vector3(0, 1, 0)), alpha: 1 });
      if (this.d.fx.light && Math.random() < 0.5) this.d.fx.glow(w.pos, 8);
      // Walls stop the wave: sample its centre along this frame's whole step (so a thin wall can't be skipped).
      let wall = this.d.blocks(a.x, a.y, a.z) && this.d.blocks(b.x, b.y, b.z);
      for (let s = 0; s <= step && !wall; s += 0.15) { const q = tmp2.copy(w.pos).addScaledVector(w.dir, -s); wall = this.d.blocks(q.x, q.y, q.z); }
      if (wall || w.travelled >= w.range) {
        w.done = true; w.crescent.dissipate(); this.d.hits.endAttack(w.key);
        // Dissipates into motes (and a burst against a wall).
        this.d.vfx.burst('spark_01', w.pos, { count: wall ? 22 : 12, color: C.spirit, life: 0.5, size: 0.25, size1: 0.03, speed: wall ? 6 : 3, up: 1, drag: 2 });
        if (wall) { this.d.vfx.spawn('circle_05', w.pos, { color: C.spirit, life: 0.2, size: 2.5, size1: 0.8 }); this.d.sound('riftHit', w.pos); this.d.fx.flash(w.pos, 8, 0.3); }
      }
    }
    this.waves = this.waves.filter((w) => !w.done || w.crescent.alive);
  }

  // ------------------------------------------------------------------ Gravity Rupture
  private updateRupture(dt: number) {
    const A = ABILITY.rupture, P = this.d.player, fx = this.d.fx;
    const c = this.center;
    if (this.t < A.impact) {
      // Anticipation: dust lifts, a pull vortex forms under the player.
      if (Math.random() < 0.6) this.d.vfx.spawn('smoke_04', c.clone().add(new THREE.Vector3((Math.random() - 0.5) * 3, 0.05, (Math.random() - 0.5) * 3)),
        { color: C.dust, life: 0.5, size: 0.6, size1: 1.0, vel: new THREE.Vector3(0, 0.8, 0), alpha: 0.35, normal: true });
      if (!this.fired.has('vortex')) { this.fired.add('vortex'); this.d.vfx.decal('twirl_02', c, { color: C.spirit, size: 3.2, life: A.impact + 0.1, fadeIn: 0.3, fadeOut: 0.1, alpha: 0.55, spin: -6, grow: -3 }); }
      fx.glow(c.clone().setY(c.y + 0.5), this.t / A.impact * 4);
    }
    if (this.t >= A.impact - 0.08 && !this.fired.has('drop')) { this.fired.add('drop'); this.d.combat.playClip('NinjaJump_Land', 0.3, 0); }
    if (this.t >= A.impact && !this.fired.has('impact')) {
      this.fired.add('impact');
      fx.marks.start(c, 10, Math.random() * Math.PI * 2);
      fx.shock().start(c, 0.4, A.ring + 1.5, 0.35, 0.7, 1.6);
      fx.shock().start(c, 0.2, A.ring * 0.6, 0.18, 0.4, 0);
      fx.debris.lift(c, A.ring - 0.3, this.d.height, A.implode - A.impact + 0.05);
      fx.flash(c.clone().setY(c.y + 0.6), 16, 0.8);
      this.d.vfx.spawn('star_06', c.clone().setY(c.y + 0.3), { color: C.spiritCore, life: 0.25, size: 4, size1: 1, alpha: 1, rot: 0 });
      this.d.vfx.burst('spark_04', c.clone().setY(c.y + 0.2), { count: 30, color: C.spirit, life: 0.55, size: 0.45, size1: 0.04, speed: 9, up: 2, grav: 10 });
      this.d.vfx.burst('smoke_07', c.clone().setY(c.y + 0.3), { count: 14, color: C.dust, life: 0.9, size: 1.2, size1: 2.6, speed: 4.5, up: 0.4, alpha: 0.55, drag: 2.5, normal: true, flat: true });
      this.d.vfx.burst('smoke_04', c.clone().setY(c.y + 0.1), { count: 10, color: C.dust, life: 1.2, size: 0.8, size1: 1.8, speed: 7, up: 1.2, alpha: 0.4, drag: 3, normal: true });
      this.rings.push({ key: `ability:rupture#${++this.serial}`, move: 'rupture', c: c.clone(), t: 0, dur: A.ringTime, r0: 0, r1: A.ring });
      this.d.sound('ruptureBoom', c); this.d.sound('ruptureQuake', c);
      this.d.shake(0.16, 0.45);
      this.stop = 0.07;
    }
    // Suspension: pull nearby enemies toward the blade (through the normal wall resolve), glyphs turning.
    const pull = A.pull;
    if (this.t >= pull.from && this.t <= pull.to) {
      const k = Math.min(1, (this.t - pull.from) / 0.12);
      for (const b of this.d.brains()) {
        if (b.dead || b.removed) continue;
        const e = b.effective(), to = tmp.set(c.x - e.x, 0, c.z - e.z), d = to.length();
        if (d > pull.radius || d < pull.stopAt) continue;
        const fall = 1 - Math.pow(d / pull.radius, 2) * 0.6;
        b.pullVel.copy(to.normalize()).multiplyScalar(Math.min(pull.speed * fall * b.pullScale * k, (d - pull.stopAt) / Math.max(dt, 1e-3)));
        if (Math.random() < 0.35) this.d.vfx.spawn('spark_01', e.clone().setY(e.y + 0.3 + Math.random() * 1.2), { color: C.spirit, life: 0.3, size: 0.32, size1: 0.04, vel: to.clone().multiplyScalar(4), alpha: 1 });
      }
      // Ground dust streaming inward.
      if (Math.random() < 0.8) {
        const a = Math.random() * Math.PI * 2, r = 3 + Math.random() * 3;
        const p = c.clone().add(new THREE.Vector3(Math.sin(a) * r, 0.1, Math.cos(a) * r));
        this.d.vfx.spawn('smoke_04', p, { color: C.dust, life: 0.45, size: 0.7, size1: 0.3, vel: c.clone().sub(p).setY(0.3).multiplyScalar(1.8), alpha: 0.3, normal: true });
      }
      fx.glow(c.clone().setY(c.y + 0.4), 5);
    }
    if (this.t >= A.implode && !this.fired.has('implode')) {
      // Collapse: the field snaps shut around the blade.
      this.fired.add('implode');
      fx.shock().start(c, A.implodeRadius + 0.8, 0.2, 0.14, 0.25, 1.0);
      this.d.vfx.spawn('star_06', c.clone().setY(c.y + 0.5), { color: C.spiritCore, life: 0.2, size: 3, size1: 0.5, alpha: 1, rot: 0 });
      this.d.vfx.burst('spark_04', c.clone().setY(c.y + 0.4), { count: 16, color: C.spirit, life: 0.3, size: 0.25, size1: 0.02, speed: 6, up: 2 });
      this.rings.push({ key: `ability:implode#${++this.serial}`, move: 'implode', c: c.clone(), t: 0, dur: 0.1, r0: 0, r1: A.implodeRadius });
      this.d.sound('riftHit', c); this.d.shake(0.08, 0.2); fx.flash(c.clone().setY(c.y + 0.5), 10, 0.4);
      // Withdraw: the crouch rises.
      this.d.combat.playClip('NinjaJump_Land', 0.32, 1.25);
    }
    if (this.t >= A.end) { this.kind = null; return false; }
    return true;
  }
  /**
   * Gravity Rupture pose layer (after the mixer): both hands on the hilt, katana point-down, driven into the ground
   * in front of the body during the impact and hold; blended in during the lift and out on the withdraw.
   */
  private poseRupture() {
    const A = ABILITY.rupture, t = this.t, P = this.d.player, B = this.ik;
    if (!B.hand_r || !B.hand_l) return;
    const w = t < 0.16 ? t / 0.16 : t > A.implode + 0.12 ? Math.max(0, 1 - (t - A.implode - 0.12) / 0.25) : 1;
    if (w <= 0) return;
    const ease = w * w * (3 - 2 * w);
    const f = this.facingDir(), right = tmp2.set(f.z, 0, -f.x);
    // Grip height: raised above the chest during the lift, then down so the tip sinks 0.15 m into the ground.
    const lift = THREE.MathUtils.smoothstep(t, 0, 0.3), drop = THREE.MathUtils.smoothstep(t, A.impact - 0.1, A.impact);
    const ground = this.d.height(this.center.x, this.center.z);
    const blade = this.d.combat.blade;
    const save = (n: string) => B[n].quaternion.clone();
    const names = ['upperarm_r', 'lowerarm_r', 'hand_r', 'upperarm_l', 'lowerarm_l', 'hand_l'];
    const before = names.map(save);
    const bladeDir = new THREE.Vector3().copy(f).multiplyScalar(0.12).add(new THREE.Vector3(0, -1, 0)).normalize();
    const solve = (gripY: number) => {
      const G = P.position.clone().addScaledVector(f, THREE.MathUtils.lerp(0.25, 0.42, drop)).addScaledVector(right, 0.04); G.y = gripY;
      const poleR = wpos(B.upperarm_r).addScaledVector(right, -0.6).addScaledVector(f, -0.3).add(new THREE.Vector3(0, -0.3, 0));
      twoBone(B.upperarm_r, B.lowerarm_r, B.hand_r, G, poleR);
      // Turn the right hand so the blade points down (edge forward).
      const qh = wquat(B.hand_r), d0 = new THREE.Vector3(0, 1, 0).applyQuaternion(wquat(blade.mount));
      setWorldQuat(B.hand_r, new THREE.Quaternion().setFromUnitVectors(d0, bladeDir).multiply(qh));
      const e0 = new THREE.Vector3(0, 0, 1).applyQuaternion(wquat(blade.mount)).projectOnPlane(bladeDir).normalize(), e1 = f.clone().projectOnPlane(bladeDir).normalize();
      const roll = new THREE.Quaternion().setFromUnitVectors(e0, e1);
      setWorldQuat(B.hand_r, roll.multiply(wquat(B.hand_r)));
      // Left hand above the right on the grip (toward the pommel), mirrored around the blade.
      const GL = wpos(B.hand_r).addScaledVector(bladeDir, -0.1);
      const poleL = wpos(B.upperarm_l).addScaledVector(right, 0.6).addScaledVector(f, -0.3).add(new THREE.Vector3(0, -0.3, 0));
      twoBone(B.upperarm_l, B.lowerarm_l, B.hand_l, GL, poleL);
      setWorldQuat(B.hand_l, new THREE.Quaternion().setFromAxisAngle(bladeDir, Math.PI).multiply(wquat(B.hand_r)));
    };
    const high = P.position.y + 1.45, low = ground + 0.62;
    const gripY = THREE.MathUtils.lerp(THREE.MathUtils.lerp(P.position.y + 1.0, high, lift), low, drop);
    solve(gripY);
    // Correct the depth: put the tip 0.15 m below the ground once the blade is down.
    if (drop > 0.5) { P.model.updateMatrixWorld(true); const err = wpos(blade.tip).y - (ground - 0.15); solve(gripY - err * drop); }
    // Blend with the clip's own arms.
    names.forEach((n, i) => B[n].quaternion.copy(before[i].slerp(B[n].quaternion.clone(), ease)));
  }

  pose(dt: number) {
    void dt;
    if (this.kind === 'rupture') this.poseRupture();
  }

  // ------------------------------------------------------------------ AbilitySource (CombatSystem sweeps)
  sweep(dt: number): AbilityHit[] {
    const out: AbilityHit[] = [];
    const P = this.d.player;
    if (this.kind === 'phantom') {
      const A = ABILITY.phantom;
      if (this.t >= A.anticipate - 0.02 && this.t <= A.anticipate + A.travel + 0.03)
        for (const ev of this.d.hits.sweepBody(this.key, 'player', P.position, { radius: A.radius, bottom: 0.1, top: 1.75 })) out.push({ move: 'phantom', target: ev.target, point: ev.point });
    }
    this.stepWaves(dt, out);
    for (const r of this.rings) {
      const r0 = r.r0 + (r.r1 - r.r0) * Math.min(1, r.t / r.dur);
      r.t += dt;
      const r1 = r.r0 + (r.r1 - r.r0) * Math.min(1, r.t / r.dur);
      for (const ev of this.d.hits.sweepRing(r.key, 'player', r.c, r0, r1, 0.6, 1.2)) out.push({ move: r.move, target: ev.target, point: ev.point });
      if (r.t >= r.dur) this.d.hits.endAttack(r.key);
    }
    this.rings = this.rings.filter((r) => r.t < r.dur);
    return out;
  }
  /** Feedback for an ability hit (CombatSystem.onAbilityHit). */
  onHit(h: AbilityHit, b: EnemyBrain, r: PlayerHitResult) {
    // Launched bodies kick up dust where they land.
    if (!b.onLand) b.onLand = (p) => this.debrisLanded(p, true);
    if (r === 'none' || r === 'dodged') return;
    const c = b.e.chest();
    if (h.move === 'phantom') { this.passed.push(b); this.d.sound('spiritCut', c); this.stop = Math.max(this.stop, 0.035); this.d.shake(0.05, 0.12); return; }
    // Rift / Rupture: a flash of light and sparks on the body.
    this.d.vfx.spawn('circle_05', c, { color: C.spirit, life: 0.16, size: 1.8, size1: 0.6, alpha: 0.9 });
    this.d.vfx.spawn('star_06', c, { color: C.spiritCore, life: 0.14, size: 1.4, size1: 0.3, alpha: 1 });
    this.d.vfx.burst('spark_04', c, { count: 14, color: C.spirit, life: 0.35, size: 0.38, size1: 0.04, speed: 6, up: 1, grav: 8 });
    if (h.move === 'rift') { this.d.sound('riftHit', c); this.stop = Math.max(this.stop, 0.05); this.d.shake(0.07, 0.15); }
  }

  /** Debris landing: a dust puff and a stone knock. */
  debrisLanded(p: THREE.Vector3, body = false) {
    if (body) {
      this.d.vfx.burst('smoke_04', p.clone().setY(p.y + 0.1), { count: 6, color: C.dust, life: 0.7, size: 0.7, size1: 1.6, speed: 2.2, up: 0.4, alpha: 0.45, drag: 3, normal: true, flat: true });
      this.d.sound('debris', p); this.d.shake(0.03, 0.12);
      return;
    }
    this.d.vfx.spawn('smoke_04', p, { color: C.dust, life: 0.6, size: 0.5, size1: 1.1, vel: new THREE.Vector3(0, 0.4, 0), alpha: 0.4, normal: true });
    if (Math.random() < 0.35) this.d.sound('debris', p);
  }

  private facingDir() { const f = this.d.player.facing; return new THREE.Vector3(Math.sin(f), 0, Math.cos(f)); }
}
