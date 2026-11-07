import * as THREE from 'three';
import type { HitWorld } from '../combat/hits';
import type { HazardHit, HazardSource } from '../combat/system';
import type { EnemyBrain } from '../combat/brain';
import { FX_COLORS, type Vfx } from '../fx/vfx';

/**
 * Temple Warden spell hazards (docs/boss.md): fire wave, fireball volley, burning strip, lightning strikes and the
 * phase-change shockwave. Each has a readable ground warning before it can hurt, hits only the player, and goes
 * through CombatSystem.hazards → PlayerCombat.receiveHit (the normal block / parry / dodge rules). Walls stop
 * fireballs and rings (shared HitWorld obstruction).
 */
export interface SpellWorld {
  height(x: number, z: number): number;
  blocks(x: number, y: number, z: number): boolean;
  player: { position: THREE.Vector3 };
  /** Push the player away from a point (no damage): the phase-change shockwave. */
  push(from: THREE.Vector3, dist: number): void;
  /** Sound cue (src/audio). */
  sound?(name: string, at?: THREE.Vector3): void;
}

export const SPELL = {
  fireWave: { radius: 7, speed: 7.5, band: 0.35 },
  fireball: { speed: 10, range: 15, radius: 0.3, height: 1.25, aimLead: 0.4 },
  flame: { length: 5.0, width: 1.3, life: 2.0, armAfter: 0.25, tick: 0.5 },
  lightning: { radius: 1.6, warn: 1.0 },
  shock: { radius: 5, speed: 9, push: 2.0 },
};

interface Spell { owner: EnemyBrain; t: number; done: boolean; step(dt: number, out: HazardHit[]): void; end(): void }

export class Spells implements HazardSource {
  private list: Spell[] = [];
  private serial = 0;
  constructor(private hits: HitWorld, private vfx: Vfx, private w: SpellWorld) {}

  /** Live hazards cast by `owner` (the boss keeps his attack slot while any are live). */
  active(owner: EnemyBrain) { return this.list.filter((s) => s.owner === owner && !s.done).length; }
  clear() { for (const s of this.list) s.end(); this.list.length = 0; }

  update(dt: number): HazardHit[] {
    const out: HazardHit[] = [];
    for (const s of this.list) { if (!s.done) { s.t += dt; s.step(dt, out); } }
    this.list = this.list.filter((s) => { if (s.done) s.end(); return !s.done; });
    return out.filter((h) => h.source === null || !h.source.dead);
  }
  private ground(p: THREE.Vector3) { return new THREE.Vector3(p.x, this.w.height(p.x, p.z), p.z); }
  private key(kind: string) { return `spell:${kind}#${++this.serial}`; }

  // ------------------------------------------------------------------ telegraphs (shown by the boss during his tell)
  /** Danger-zone outline and filling disc for `warn` seconds. Returns a stop function. */
  warnCircle(center: THREE.Vector3, radius: number, color: THREE.Color, warn: number) {
    const c = this.ground(center);
    const ring = this.vfx.decal('circle_03', c, { color, size: radius * 2.15, life: warn, fadeIn: 0.1, fadeOut: 0.05, alpha: 0.95 });
    const fill = this.vfx.decal('circle_05', c, { color, size: radius * 2.0, life: warn, fadeIn: warn * 0.9, fadeOut: 0.05, alpha: 0.55 });
    return () => { this.vfx.kill(ring); this.vfx.kill(fill); };
  }
  /** A path line on the ground from `a` toward `b` (fireball aim). */
  warnLine(a: THREE.Vector3, b: THREE.Vector3, life: number) {
    const ga = this.ground(a), gb = this.ground(b), mid = ga.clone().lerp(gb, 0.5), len = ga.distanceTo(gb);
    const yaw = Math.atan2(gb.x - ga.x, gb.z - ga.z);
    this.vfx.decal('trace_04', mid, { color: FX_COLORS.fire, size: 0.9, length: len, life, yaw, fadeIn: 0.05, fadeOut: 0.1, alpha: 0.85 });
  }

  // ------------------------------------------------------------------ spells
  /** Ring of fire expanding from the boss's blade along the ground. Roll through it, block (4) or outrun it. */
  fireWave(owner: EnemyBrain, center: THREE.Vector3) {
    const c = this.ground(center), key = this.key('firewave'), S = SPELL.fireWave;
    let r = 0.6;
    this.vfx.burst('fire_02', c.clone().setY(c.y + 0.3), { count: 16, color: FX_COLORS.fire, life: 0.5, size: 1.1, size1: 0.3, speed: 3, up: 2 });
    this.vfx.decal('scorch_02', c, { color: FX_COLORS.ember, size: 3, life: 2.5, fadeOut: 1.5 });
    const n = this.vfx.quality === 'high' ? 30 : 18;
    const me: Spell = { owner, t: 0, done: false, end: () => {}, step: (dt, out) => {
      const r0 = r; r = Math.min(S.radius, r + S.speed * dt);
      for (let i = 0; i < n; i++) {
        if (Math.random() < 0.5) continue;
        const a = (i / n) * Math.PI * 2 + Math.random() * 0.2;
        this.vfx.flame(new THREE.Vector3(c.x + Math.sin(a) * r, c.y + 0.25, c.z + Math.cos(a) * r), 0.9, 1);
      }
      for (const ev of this.hits.sweepRing(key, owner.id, c, r0, r, S.band)) if (ev.target === 'player') out.push({ key, table: 'warden.firewave', from: c, source: owner });
      if (r >= S.radius) { me.done = true; this.hits.endAttack(key); }
    } };
    this.list.push(me);
  }
  /** One fireball from `from` toward `target` (aimed where the player was), with a short ground path warning. */
  fireball(owner: EnemyBrain, from: THREE.Vector3, target: THREE.Vector3) {
    const S = SPELL.fireball, key = this.key('fireball');
    const dir = target.clone().sub(from).setY(0); if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1); dir.normalize();
    const pos = from.clone().setY(this.w.height(from.x, from.z) + S.height);
    let travelled = 0;
    const me: Spell = { owner, t: 0, done: false, end: () => {}, step: (dt, out) => {
      const d = S.speed * dt; pos.addScaledVector(dir, d); travelled += d;
      const gy = this.w.height(pos.x, pos.z); pos.y = gy + S.height;
      this.vfx.orb(pos);
      if (this.w.blocks(pos.x, pos.y, pos.z) || travelled > S.range) { this.explode(pos); me.done = true; this.hits.endAttack(key); return; }
      for (const ev of this.hits.sweepBody(key, owner.id, new THREE.Vector3(pos.x, gy, pos.z), { radius: S.radius, bottom: S.height - S.radius, top: S.height + S.radius }))
        if (ev.target === 'player') { out.push({ key, table: 'warden.fireball', from: pos.clone(), source: owner }); this.explode(pos); me.done = true; this.hits.endAttack(key); return; }
    } };
    this.list.push(me);
  }
  private explode(p: THREE.Vector3) {
    this.w.sound?.('fireball', p);
    this.vfx.burst('fire_02', p, { count: 10, color: FX_COLORS.fire, life: 0.4, size: 0.9, size1: 0.2, speed: 3, up: 1 });
    this.vfx.spawn('circle_05', p, { color: FX_COLORS.fireCore, life: 0.18, size: 2.2, size1: 0.8 });
  }
  /**
   * Ash kunai (the Runners' power): three glowing blades in a narrow fan toward `at`, 16 m/s, up to 14 m; each hits the
   * player once (runner.kunai: 4, blocked 1, not parryable); walls stop them. Ember-red, unlike the player's cyan.
   */
  kunai(owner: EnemyBrain, from: THREE.Vector3, at: THREE.Vector3) {
    const base = at.clone().sub(from).setY(0); if (base.lengthSq() < 1e-4) base.set(0, 0, 1); base.normalize();
    const y0 = from.y, y1 = at.y;
    this.w.sound?.('whoosh', from);
    // One volley hits at most once (the first blade to connect; the others are spent).
    const volley = { hit: false };
    for (const ang of [-0.13, 0, 0.13]) {
      const dir = base.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), ang), key = this.key('kunai');
      const pos = from.clone(); let travelled = 0;
      const me: Spell = { owner, t: 0, done: false, end: () => {}, step: (dt, out) => {
        const d = 16 * dt; pos.addScaledVector(dir, d); travelled += d; pos.y = THREE.MathUtils.lerp(y0, y1, Math.min(1, travelled / 6));
        // Glowing blade and a short ember trail.
        this.vfx.spawn('circle_05', pos, { color: FX_COLORS.fireCore, life: 0.04, size: 0.42, alpha: 1, alpha1: 1 });
        this.vfx.spawn('spark_06', pos, { color: FX_COLORS.fire, life: 0.05, size: 0.3, stretch: 3, alpha: 1, alpha1: 1, rot: Math.PI / 2 });
        this.vfx.spawn('fire_01', pos.clone(), { color: FX_COLORS.ember, life: 0.28, size: 0.34, size1: 0.06, alpha: 0.9 });
        const g = this.w.height(pos.x, pos.z);
        if (volley.hit || this.w.blocks(pos.x, pos.y, pos.z) || travelled > 14) {
          this.vfx.burst('spark_04', pos, { count: 5, color: FX_COLORS.fire, life: 0.25, size: 0.18, size1: 0.03, speed: 3, up: 1 });
          me.done = true; this.hits.endAttack(key); return;
        }
        for (const ev of this.hits.sweepBody(key, owner.id, new THREE.Vector3(pos.x, g, pos.z), { radius: 0.12, bottom: pos.y - g - 0.12, top: pos.y - g + 0.12 }))
          if (ev.target === 'player') { volley.hit = true; out.push({ key, table: 'runner.kunai', from: pos.clone(), source: owner }); this.vfx.burst('spark_04', pos, { count: 6, color: FX_COLORS.fire, life: 0.2, size: 0.2, size1: 0.03, speed: 3 }); me.done = true; this.hits.endAttack(key); return; }
      } };
      this.list.push(me);
    }
  }
  /** A burning strip along the ground from `a` in direction `dir` (left by the flame-line cut). Hurts after 0.25 s, ticks every 0.5 s. */
  flameLine(owner: EnemyBrain, a: THREE.Vector3, dir: THREE.Vector3) {
    const S = SPELL.flame, d = dir.clone().setY(0).normalize(), start = this.ground(a.clone().addScaledVector(d, 0.6));
    const end = start.clone().addScaledVector(d, S.length); end.y = this.w.height(end.x, end.z);
    const mid = start.clone().lerp(end, 0.5), yaw = Math.atan2(d.x, d.z);
    const glow = this.vfx.decal('circle_05', mid, { color: FX_COLORS.fire, size: S.width * 1.5, length: S.length + 0.8, life: S.life, yaw, fadeIn: 0.12, fadeOut: 0.5, alpha: 1 });
    let nextTick = S.armAfter, tick = 0;
    const me: Spell = { owner, t: 0, done: false, end: () => this.vfx.kill(glow), step: (dt, out) => {
      const reach = Math.min(1, me.t / 0.15);
      for (let i = 0; i < 4; i++) if (Math.random() < 0.8) this.vfx.flame(start.clone().lerp(end, Math.random() * reach).setY(mid.y + 0.15), 0.85, 1);
      if (me.t >= S.life) { me.done = true; return; }
      if (me.t >= nextTick) {
        nextTick += S.tick; tick++;
        const p = this.w.player.position, t = THREE.MathUtils.clamp(p.clone().sub(start).dot(d), 0, S.length);
        const near = start.clone().addScaledVector(d, t);
        if (Math.hypot(p.x - near.x, p.z - near.z) <= S.width / 2 + 0.38 && p.y - near.y < 0.5)
          out.push({ key: `${this.key('flame')}#${tick}`, table: 'warden.flame', from: near, source: owner });
      }
    } };
    this.list.push(me);
  }
  /** Lightning: a violet-white warning circle where the player stands, then the strike 1.0 s later. Move or roll. */
  lightning(owner: EnemyBrain, at: THREE.Vector3) {
    const S = SPELL.lightning, c = this.ground(at), key = this.key('lightning');
    const stop = this.warnCircle(c, S.radius, FX_COLORS.storm, S.warn);
    const me: Spell = { owner, t: 0, done: false, end: stop, step: (_dt, out) => {
      if (me.t < S.warn) {
        if (Math.random() < 0.25) this.vfx.spawn('spark_01', c.clone().add(new THREE.Vector3((Math.random() - 0.5) * 2 * S.radius, 0.1, (Math.random() - 0.5) * 2 * S.radius)), { color: FX_COLORS.storm, life: 0.2, size: 0.4 });
        return;
      }
      this.vfx.bolt(c); this.w.sound?.('thunder', c);
      for (const ev of this.hits.sweepRing(key, owner.id, c, 0, S.radius, 0)) if (ev.target === 'player') out.push({ key, table: 'warden.lightning', from: c, source: owner });
      this.hits.endAttack(key); me.done = true;
    } };
    this.list.push(me);
  }
  /** Phase-change shockwave: an expanding ring that pushes the player back (no damage). */
  shockwave(owner: EnemyBrain, center: THREE.Vector3, color: THREE.Color) {
    const S = SPELL.shock, c = this.ground(center);
    let r = 0.5, pushed = false;
    this.vfx.decal('circle_03', c, { color, size: 2, life: 0.6, fadeOut: 0.4 });
    const me: Spell = { owner, t: 0, done: false, end: () => {}, step: (dt) => {
      r = Math.min(S.radius, r + S.speed * dt);
      if (Math.random() < 0.9) this.vfx.decal('circle_03', c, { color, size: r * 2.1, life: 0.12, fadeIn: 0.01, fadeOut: 0.1, alpha: 0.8 });
      const p = this.w.player.position, d = Math.hypot(p.x - c.x, p.z - c.z);
      if (!pushed && d <= r + 0.4) { pushed = true; if (d < S.radius) this.w.push(c, S.push); }
      if (r >= S.radius) me.done = true;
    } };
    this.list.push(me);
  }
}
