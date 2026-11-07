import * as THREE from 'three';
import { HitWorld, BODY, WEAPON_RADIUS, type HitEvent } from './hits';
import type { EnemyBrain } from './brain';
import type { PlayerCombat } from '../player/combat';
import type { Player } from '../player/player';
import { GIANT, HITSTUN_COOLDOWN, KNOCK_SCALE, LIFT_SCALE, REACTIONS } from './reactions';
import { BOSS, ENEMY_HITS, HEALTH, OPEN_METER, meterGain, playerDamage, PLAYER_MOVES, type EnemyHitDef, type PlayerMoveName } from './tables';

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

/** Enemy move → damage-table key for the n-th hit of that move (per-hit entries such as breaker.sweep1 first). */
function hitKey(kind: string, move: string, n: number) {
  const per = `${kind}.${move}${n + 1}`;
  return ENEMY_HITS[per] ? per : `${kind}.${move}`;
}
/** Damage-table prefix: the Temple Warden has his own boss table; others use their class. */
const tableOf = (b: EnemyBrain) => (b.e.kind === 'warden' ? 'warden' : b.e.cls);
/** Posture / stagger meter size and knee-drop length (the Warden boss: docs/boss.md). */
const meterMax = (b: EnemyBrain) => (b.e.kind === 'warden' ? BOSS.posture : METER.max);
const kneeLen = (b: EnemyBrain) => (b.e.kind === 'warden' ? BOSS.kneeDrop : METER.staggerLen);

/** A hit on the player from a spell hazard (src/boss/spells.ts), applied through the normal block/parry/dodge rules. */
export interface HazardHit { key: string; table: string; from: THREE.Vector3; source: EnemyBrain | null }
export interface HazardSource { update(dt: number): HazardHit[] }
/** A hit on an enemy from a player ability (src/player/abilities.ts): no katana, never parried or guarded. */
export interface AbilityHit { move: PlayerMoveName; target: string; point: THREE.Vector3; scale?: number }
export interface AbilitySource { sweep(dt: number): AbilityHit[] }
/** Result of a player hit on an enemy (for ability feedback: sparks, hit-stop). */
export type PlayerHitResult = 'none' | 'dodged' | 'parried' | 'guarded' | 'immune' | 'hit' | 'killed';

export class CombatSystem {
  readonly vitals = new Map<EnemyBrain, Vitals>();
  readonly log: CombatLogEntry[] = [];
  time = 0;
  private deadAt = -1;
  /** Called to restart after the player's defeat (respawn player and enemies). */
  onRestart: (() => void) | null = null;

  /** When false, a defeat waits for the caller (encounter retry) instead of restarting after 3 s. */
  autoRestart = true;
  /** Spell hazards (fire, lightning) that can hit the player; updated every frame. */
  hazards: HazardSource | null = null;
  /** Player abilities: hit sources swept after the katana each frame. */
  abilities: AbilitySource | null = null;
  /** Called for every ability hit with its result (feedback). */
  onAbilityHit: ((h: AbilityHit, b: EnemyBrain, r: PlayerHitResult) => void) | null = null;
  constructor(readonly hits: HitWorld, private player: Player, private combat: PlayerCombat, private brains: EnemyBrain[]) {
    for (const b of brains) this.add(b);
  }
  /** Register an enemy (spawned later by an encounter). */
  add(b: EnemyBrain) {
    this.vitals.set(b, this.freshVitals(b));
    (b as EnemyBrain & { bindSystem?: (s: CombatSystem) => void }).bindSystem?.(this);
    this.hits.addTarget({ id: b.id, capsule: () => ({ base: b.effective(), ...(b.e.kind === 'breaker' ? BODY.breaker : b.e.kind === 'warden' ? { ...BODY.breaker, radius: 0.42 } : BODY.runner) }), active: () => !b.dead && !b.removed });
  }
  drop(b: EnemyBrain) { this.vitals.delete(b); this.hits.removeTarget(b.id); }
  freshVitals(b: EnemyBrain): Vitals { return { hp: b.e.kind === 'warden' ? HEALTH.warden : HEALTH[b.e.cls], poise: 0, lastPoise: -99, meter: 0, lastMeter: -99, immuneUntil: -99 }; }

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
      this.playerHits(a.move, e.target);
    // Player abilities → enemies.
    if (this.abilities) for (const h of this.abilities.sweep(dt)) {
      const b = this.brains.find((x) => x.id === h.target);
      if (!b) continue;
      const r = this.playerHits(h.move, h.target, h.scale ?? 1, true);
      this.onAbilityHit?.(h, b, r);
    }
    // Enemy attacks → player.
    for (const b of this.brains) if (!b.dead && b.state === 'attack') this.enemyAttack(b);
    // Spell hazards → player.
    if (this.hazards) for (const h of this.hazards.update(dt)) {
      const def = ENEMY_HITS[h.table];
      if (def) this.applyToPlayer(h.source, def, h.table, h.from, h.key);
    }
    // Defeat and restart.
    if (this.combat.state !== 'dead') this.deadAt = -1;
    if (this.combat.state === 'dead') {
      if (this.deadAt < 0) { this.deadAt = this.time; this.note('player defeated', 'player'); }
      else if (this.autoRestart && this.time - this.deadAt > RESTART_DELAY) { this.deadAt = -1; this.restart(); }
    }
  }

  // ------------------------------------------------------------------ player → enemy
  /** Apply one player hit (katana move or ability) to an enemy. Abilities are spirit energy: never parried or guarded. */
  private playerHits(move: PlayerMoveName, target: string, scale = 1, ability = false): PlayerHitResult {
    const b = this.brains.find((x) => x.id === target);
    if (!b || b.dead) return 'none';
    const v = this.vitals.get(b)!;
    // Dodging Runners are untouchable.
    if (b.invulnerable) { this.note('dodged', b.id, undefined, move); return 'dodged'; }
    const toPlayer = this.player.position.clone().sub(b.effective()).setY(0).normalize();
    const facing = new THREE.Vector3(Math.sin(b.e.object.rotation.y + b.e.pivot.rotation.y), 0, Math.cos(b.e.object.rotation.y + b.e.pivot.rotation.y));
    const front = toPlayer.dot(facing) > 0.5; // within 60 deg of where the enemy faces
    // A parrying Runner turns the cut aside and stuns the player.
    if (!ability && b.e.cls === 'runner' && b.parrying && front) { this.combat.parriedByEnemy(); this.note('enemy parried', b.id, undefined, move); return 'parried'; }
    // The Breaker's guard blocks frontal Cut 1 / Cut 2 when he isn't attacking; it pushes the player back.
    if (!ability && b.e.cls === 'breaker' && front && (move === 'cut1' || move === 'cut2') && ['hold', 'reposition', 'approach'].includes(b.state)) {
      this.combat.pushFrom(b.effective(), 0.3); this.note('guard blocked', b.id, 0, move);
      b.impulse(this.player.position, 0.12, 0, 0.05);   // the guard takes the blow: a small recoil
      return 'guarded';
    }
    const open = b.isOpen();
    const dmg = Math.round(playerDamage(move, open) * scale);
    v.hp = Math.max(0, v.hp - dmg);
    b.hurt = v.hp / (b.e.kind === 'warden' ? HEALTH.warden : HEALTH[b.e.cls]);
    this.note('hit', b.id, dmg, `${move}${open ? ' (open x1.5)' : ''} hp ${v.hp}`);
    // Hit reaction (src/combat/reactions.ts): the physical layer and a knockback for everyone.
    const rx = REACTIONS[move], from = this.player.position, kscale = KNOCK_SCALE[b.e.kind === 'warden' ? 'warden' : b.e.cls];
    if (v.hp <= 0) {
      b.kill(from); this.note('killed', b.id);
      // A killing blow throws the body (armoured classes less).
      b.impulse(from, rx.lean * 1.3, rx.twist, (rx.knock + 0.6) * kscale);
      if (rx.lift) b.launch(rx.lift * LIFT_SCALE[b.e.kind === 'warden' ? 'warden' : b.e.cls]);
      return 'killed';
    }
    b.impulse(from, rx.lean, rx.twist, rx.knock * kscale);
    if (rx.lift) b.launch(rx.lift * LIFT_SCALE[b.e.kind === 'warden' ? 'warden' : b.e.cls]);
    const m = PLAYER_MOVES[move];
    if (b.e.cls === 'runner') {
      // Every hit interrupts a Runner (he can't keep attacking while being cut). The weight of the attack picks the
      // reaction: light cuts flinch, heavy attacks stagger (open), the Rift and the collapse knock him down. Poise
      // still accumulates as before (a break is logged; it no longer changes the reaction, so damage is unchanged).
      const breaks = m.poise === 'break';
      v.poise += breaks ? POISE.runner : (m.poise as number) * scale * (open ? OPEN_METER : 1); v.lastPoise = this.time;
      const kind = rx.runner;
      if (breaks || v.poise >= POISE.runner) { v.poise = 0; this.note('poise broken', b.id); }
      if (b.downed && kind !== 'knockdown') this.note('hit while down', b.id);     // stays down
      else if (b.state === 'stagger' && kind === 'flinch') this.note('hit while staggered (stays staggered)', b.id);
      else {
        const was = b.state;
        b.react(kind); b.hitstun(HITSTUN_COOLDOWN);
        this.note(kind === 'flinch' ? 'flinched' : kind === 'stagger' ? 'staggered' : 'knocked down', b.id, undefined, was === 'attack' || was === 'tell' ? 'attack interrupted' : undefined);
      }
    } else {
      const behind = toPlayer.dot(facing) < -0.17;
      // Iron Breaker: heavy armour, but the weight of the attack moves him (reactions.ts GIANT): light cuts jolt him,
      // heavy attacks stumble him back (unless mid-swing), the leap slam and the Rift reel him, the Rupture drops him to
      // a knee. The meter still builds toward the armour break (the long knee-drop).
      if (b.e.kind === 'breaker') {
        const kind = b.state === 'tell' && rx.giant === 'none' ? 'jolt' : rx.giant;
        const was = b.state, out = b.giantReact(kind);
        if (out !== 'none' && out !== 'armoured' && out !== 'kneeling') {
          const g = GIANT[kind as keyof typeof GIANT];
          b.impulse(from, rx.lean * 1.1, rx.twist + (kind === 'reel' ? 0.5 : 0), g.knock);
          b.hitstun(g.stun);
          this.note(out, b.id, undefined, was === 'attack' || was === 'tell' ? 'attack interrupted' : undefined);
        } else if (out === 'armoured') { b.impulse(from, rx.lean * 1.2, rx.twist, 0.35); this.note('armoured', b.id); }
      }
      // Super-armour (the Warden): ordinary hits never interrupt. The meter builds toward the knee-drop.
      if (this.time < v.immuneUntil) { this.note('meter immune', b.id); return 'immune'; }
      const gain = meterGain(move, open, behind) * scale;
      this.addMeter(b, v, gain, `${move}${open ? ' open' : ''}${behind ? ' behind' : ''}`);
      // A Breaker's warning is cancelled by any hit (strike first and he can't attack); his swing itself is armoured.
      if (b.e.kind !== 'breaker' && (b.state === 'hold' || b.state === 'reposition')) b.react('flinch'); // the Warden's shudder
    }
    return 'hit';
  }
  private addMeter(b: EnemyBrain, v: Vitals, gain: number, why: string) {
    v.meter += gain; v.lastMeter = this.time;
    this.note('meter', b.id, gain, `${why} -> ${v.meter.toFixed(1)}`);
    if (v.meter >= meterMax(b)) {
      v.meter = 0; v.immuneUntil = this.time + kneeLen(b) + METER.immunity;
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
      const def = ENEMY_HITS[hitKey(tableOf(b), e.move, n)];
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
      for (const ev of evs) if (ev.target === 'player') this.enemyHitsPlayer(b, def, hitKey(tableOf(b), e.move, n), ev);
    });
  }
  private lastPlayerHit = -1;
  private enemyHitsPlayer(b: EnemyBrain, def: typeof ENEMY_HITS[string], name: string, ev: HitEvent) {
    // Fairness: hits never stack in one frame. With up to three attackers, two swings can rarely connect on the same
    // frame; the second glances off.
    if (this.lastPlayerHit === this.time) { this.note('glanced (same frame)', b.id, 0, name); return; }
    this.lastPlayerHit = this.time;
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
  /** A spell hazard hits the player: same block / parry / dodge rules as a weapon hit, from the hazard's position. */
  private applyToPlayer(src: EnemyBrain | null, def: EnemyHitDef, name: string, from: THREE.Vector3, key: string) {
    // Thrown kunai never land in the same frame as another hit (hits never stack in one frame).
    if (name === 'runner.kunai' && this.lastPlayerHit === this.time) { this.note('kunai deflected (same frame)', src?.id ?? 'hazard'); return; }
    this.lastPlayerHit = this.time;
    const hpBefore = this.combat.hp;
    const out = this.combat.receiveHit({ damage: def.damage, blocked: def.blocked, parryable: def.parryable, weight: def.weight, from });
    this.note(`player ${out}`, src?.id ?? 'hazard', hpBefore - this.combat.hp, `${name} -> player hp ${this.combat.hp} [${key}]`);
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
