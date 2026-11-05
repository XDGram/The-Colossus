import * as THREE from 'three';
import { HitWorld, BODY, WEAPON_RADIUS, type HitEvent } from './hits';
import type { EnemyBrain } from './brain';
import type { PlayerCombat, ActiveAttack } from '../player/combat';
import type { Player } from '../player/player';
import { ENEMY_HITS, HEALTH, OPEN_METER, meterGain, playerDamage, PLAYER_MOVES, type PlayerMoveName } from './tables';

/**
 * Combat loop (Stage 2C): connects the shared hit detection to damage, health and reactions using the approved
 * values in docs/combat.md. No UI here.
 *
 * Per frame (after the player and enemy brains have posed): sweep the player's katana against enemies, and each
 * enemy's active attack (weapons, charge body, stamp ring) against the player; apply blocks, parries, the open
 * bonus, Runner poise and the Breaker's stagger meter; handle deaths and the player's defeat/restart.
 */
export const POISE = { runner: 20, reset: 1.5 };
export const METER = { max: 100, decay: 10, decayDelay: 2, immunity: 4, staggerLen: 2.2, parry: 35 };
export const STAMP_RING = { from: 0.75, to: 0.9, radius: 2.2 };
export const CHARGE_BODY = { from: 0.05, to: 0.65, radius: 0.5 };
export const RESTART_DELAY = 3;

export interface Vitals { hp: number; poise: number; lastPoise: number; meter: number; lastMeter: number; immuneUntil: number }
export interface CombatLogEntry { t: number; what: string; who: string; amount?: number; detail?: string }

/** Enemy move → damage-table key for the n-th hit of that move. */
function hitKey(kind: 'runner' | 'breaker', move: string, n: number) {
  if (kind === 'breaker' && move === 'sweep') return `breaker.sweep${n + 1}`;
  return `${kind}.${move}`;
}

export class CombatSystem {
  readonly vitals = new Map<EnemyBrain, Vitals>();
  readonly log: CombatLogEntry[] = [];
  time = 0;
  private deadAt = -1;
  /** Called to restart after the player's defeat (respawn player and enemies). */
  onRestart: (() => void) | null = null;

  constructor(readonly hits: HitWorld, private player: Player, private combat: PlayerCombat, private brains: EnemyBrain[]) {
    for (const b of brains) {
      this.vitals.set(b, this.freshVitals(b));
      hits.addTarget({ id: b.id, capsule: () => ({ base: b.effective(), ...(b.e.kind === 'breaker' ? BODY.breaker : b.e.kind === 'warden' ? { ...BODY.breaker, radius: 0.42 } : BODY.runner) }), active: () => !b.dead && !b.removed });
    }
  }
  freshVitals(b: EnemyBrain): Vitals { return { hp: HEALTH[b.e.cls], poise: 0, lastPoise: -99, meter: 0, lastMeter: -99, immuneUntil: -99 }; }

  update(dt: number) {
    this.time += dt;
    this.hits.beginFrame();
    // Meter decay and poise reset.
    for (const [b, v] of this.vitals) {
      if (this.time - v.lastMeter > METER.decayDelay) v.meter = Math.max(0, v.meter - METER.decay * dt);
      if (this.time - v.lastPoise > POISE.reset) v.poise = 0;
      void b;
    }
    // Player katana → enemies.
    const a = this.combat.activeAttack;
    if (a) for (const e of this.hits.sweepWeapon(a.key, 'player', { hilt: a.hilt, tip: a.tip, radius: WEAPON_RADIUS.blade }, this.combat.chest(), { hilt: a.prevHilt, tip: a.prevTip }))
      this.playerHits(a, e);
    // Enemy attacks → player.
    for (const b of this.brains) if (!b.dead && b.state === 'attack') this.enemyAttack(b);
    // Defeat and restart.
    if (this.combat.state === 'dead') {
      if (this.deadAt < 0) { this.deadAt = this.time; this.note('player defeated', 'player'); }
      else if (this.time - this.deadAt > RESTART_DELAY) { this.deadAt = -1; this.restart(); }
    }
  }

  // ------------------------------------------------------------------ player → enemy
  private playerHits(a: ActiveAttack, ev: HitEvent) {
    const b = this.brains.find((x) => x.id === ev.target);
    if (!b || b.dead) return;
    const v = this.vitals.get(b)!;
    const move = a.move as PlayerMoveName;
    // Dodging Runners are untouchable.
    if (b.invulnerable) { this.note('dodged', b.id, undefined, move); return; }
    const toPlayer = this.player.position.clone().sub(b.effective()).setY(0).normalize();
    const facing = new THREE.Vector3(Math.sin(b.e.object.rotation.y + b.e.pivot.rotation.y), 0, Math.cos(b.e.object.rotation.y + b.e.pivot.rotation.y));
    const front = toPlayer.dot(facing) > 0.5; // within 60 deg of where the enemy faces
    // A parrying Runner turns the cut aside and stuns the player.
    if (b.e.cls === 'runner' && b.parrying && front) { this.combat.parriedByEnemy(); this.note('enemy parried', b.id, undefined, move); return; }
    // The Breaker's guard blocks frontal Cut 1 / Cut 2 when he isn't attacking; it pushes the player back.
    if (b.e.cls === 'breaker' && front && (move === 'cut1' || move === 'cut2') && ['hold', 'reposition', 'approach'].includes(b.state)) {
      this.combat.pushFrom(b.effective(), 0.3); this.note('guard blocked', b.id, 0, move); return;
    }
    const open = b.isOpen();
    const dmg = playerDamage(move, open);
    v.hp = Math.max(0, v.hp - dmg);
    this.note('hit', b.id, dmg, `${move}${open ? ' (open x1.5)' : ''} hp ${v.hp}`);
    if (v.hp <= 0) { b.kill(); this.note('killed', b.id); return; }
    const m = PLAYER_MOVES[move];
    if (b.e.cls === 'runner') {
      // Poise: a break flinches him and interrupts his attack only before its first hit has landed.
      const breaks = m.poise === 'break';
      v.poise += breaks ? POISE.runner : (m.poise as number) * (open ? OPEN_METER : 1); v.lastPoise = this.time;
      if (breaks) { v.poise = 0; b.react('stagger'); this.note('poise broken (riposte)', b.id); }
      else if (v.poise >= POISE.runner) {
        v.poise = 0;
        if (b.state === 'stagger') this.note('poise broken while staggered (stays staggered)', b.id);
        else if (b.state !== 'attack' && b.state !== 'tell' || b.beforeFirstHit()) { b.react('flinch'); this.note('flinched', b.id); }
        else this.note('poise broken, attack already landed: no interrupt', b.id);
      }
    } else {
      // Super-armour: ordinary hits never interrupt. The meter builds toward the knee-drop.
      const behind = toPlayer.dot(facing) < -0.17;
      if (this.time < v.immuneUntil) { this.note('meter immune', b.id); return; }
      const gain = meterGain(move, open, behind);
      this.addMeter(b, v, gain, `${move}${open ? ' open' : ''}${behind ? ' behind' : ''}`);
      if (b.state === 'hold' || b.state === 'reposition') b.react('flinch'); // small shudder while not attacking
    }
  }
  private addMeter(b: EnemyBrain, v: Vitals, gain: number, why: string) {
    v.meter += gain; v.lastMeter = this.time;
    this.note('meter', b.id, gain, `${why} -> ${v.meter.toFixed(1)}`);
    if (v.meter >= METER.max) {
      v.meter = 0; v.immuneUntil = this.time + METER.staggerLen + METER.immunity;
      b.react('stagger'); this.note('KNEE-DROP', b.id);
    }
  }

  // ------------------------------------------------------------------ enemy → player
  private enemyAttack(b: EnemyBrain) {
    const e = b.e, moves = e.moves[e.move];
    if (!moves?.hits) return;
    const chest = e.chest();
    moves.hits.forEach((h, n) => {
      const key = `${b.id}#${e.moveInstance}#${n}`;
      const def = ENEMY_HITS[hitKey(e.cls, e.move, n)];
      if (!def) return;
      let evs: HitEvent[] = [];
      if (e.move === 'charge') {
        if (e.time >= CHARGE_BODY.from && e.time <= CHARGE_BODY.to) evs = this.hits.sweepBody(key, b.id, b.effective(), { radius: CHARGE_BODY.radius, bottom: 0.1, top: 1.75 });
      } else if (e.move === 'stamp') {
        if (e.time >= STAMP_RING.from && e.time <= STAMP_RING.to) {
          const k0 = Math.max(0, (e.time - 1 / 30 - STAMP_RING.from) / (STAMP_RING.to - STAMP_RING.from)), k1 = (e.time - STAMP_RING.from) / (STAMP_RING.to - STAMP_RING.from);
          evs = this.hits.sweepRing(key, b.id, b.effective(), STAMP_RING.radius * k0, STAMP_RING.radius * Math.min(1, k1));
        }
      } else if (Math.abs(e.time - h.t) <= h.window) {
        for (const w of e.weapons()) evs.push(...this.hits.sweepWeapon(key, b.id, w, chest));
      }
      for (const ev of evs) if (ev.target === 'player') this.enemyHitsPlayer(b, def, hitKey(e.cls, e.move, n), ev);
    });
  }
  private enemyHitsPlayer(b: EnemyBrain, def: typeof ENEMY_HITS[string], name: string, ev: HitEvent) {
    const hpBefore = this.combat.hp;
    const out = this.combat.receiveHit({ damage: def.damage, blocked: def.blocked, parryable: def.parryable, weight: def.weight, from: b.effective() });
    this.note(`player ${out}`, b.id, hpBefore - this.combat.hp, `${name} -> player hp ${this.combat.hp} [${ev.key}]`);
    if (b.e.move === 'charge') b.stopCharge();
    if (out === 'parried') {
      const v = this.vitals.get(b)!;
      if (b.e.cls === 'runner') { v.poise = 0; b.react('stagger'); this.note('parried: runner staggered 1.0 s', b.id); }
      else if (this.time >= v.immuneUntil) this.addMeter(b, v, METER.parry, 'sweep parry');
    }
    void ev;
  }

  // ------------------------------------------------------------------ defeat
  private restart() {
    this.combat.reset();
    for (const b of this.brains) this.vitals.set(b, this.freshVitals(b));
    this.onRestart?.();
    this.note('restart', 'all');
  }
  private note(what: string, who: string, amount?: number, detail?: string) {
    this.log.push({ t: +this.time.toFixed(3), what, who, amount, detail });
    if (this.log.length > 600) this.log.shift();
  }
}
