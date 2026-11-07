import * as THREE from 'three';
import type { Player } from './player';
import type { Input, SpiritKind } from '../core/input';
import { buildKatana } from './katana';
import { mergeStaticSiblings } from '../core/skinmerge';
import { BLOCK, BUFFER, HEALTH, MASH_LOCK, PARRY, PLAYER_MOVES, REACT, ROLL, playerDamage, type PlayerMoveName, type Weight } from '../combat/tables';

/**
 * Player combat kit (Stage 1): three-cut combo, sprint lunge, dodge roll, block and parry, riposte,
 * reactions and death, on the protagonist's shared skeleton (UAL clips from enemies.glb).
 * No hit detection here: `activeAttack` and `receiveHit()` are the hooks for the shared hit resolver.
 *
 * Per frame: preUpdate() before Player.update (sets movement control), postUpdate() after it (pose fixes).
 */
export type CombatState = 'free' | 'block' | 'attack' | 'recover' | 'roll' | 'flinch' | 'knockdown' | 'stun' | 'dead'
  // A supernatural ability is running (src/player/abilities.ts drives it).
  | 'spirit';
/** The ability controller, as PlayerCombat sees it (src/player/abilities.ts). */
export interface SpiritDriver {
  ready(kind: SpiritKind): boolean;
  start(kind: SpiritKind, aim: THREE.Vector3, camYaw: number): void;
  /** Advance the running ability; false when it has finished. */
  update(dt: number, input: Input, camYaw: number): boolean;
  /** After the mixer has posed the body (procedural pose layers, effects that follow the body). */
  pose(dt: number): void;
  /** A hit or a reset cut the ability short. */
  interrupt(): void;
  readonly invulnerable: boolean;
  /** Root velocity while the ability travels (or null to stand still). */
  drive(): THREE.Vector3 | null;
  /** Keep the pelvis over the body (clips with root travel). */
  readonly lockPelvis: boolean;
  /** Full reset (defeat / retry): cooldowns cleared. */
  reset?(): void;
}
/** An ability press is kept this long while the player is busy, then dropped. */
const SPIRIT_BUFFER = 0.3;
export interface IncomingHit { damage: number; blocked: number; parryable: boolean; weight: Weight; from: THREE.Vector3 }
export type HitOutcome = 'ignored' | 'dodged' | 'parried' | 'blocked' | 'guardBreak' | 'hit' | 'killed';
export interface ActiveAttack {
  move: PlayerMoveName; instance: number;
  /** Damage against a normal / open (recovering or staggered) enemy. */
  damage: number; damageOpen: number;
  poise: number | 'break'; meter: number;
  hilt: THREE.Vector3; tip: THREE.Vector3;
  /** Blade position on the previous frame (so the first active frame is swept too). */
  prevHilt: THREE.Vector3; prevTip: THREE.Vector3;
  /** Unique per attack instance, for the shared hit resolver's hit-once rule. */
  key: string;
}

const FADE = 0.08;
const UPPER = /^(spine|neck|Head|clavicle|upperarm|lowerarm|hand|thumb|index|middle|ring|pinky)/;

export class PlayerCombat {
  state: CombatState = 'free';
  hp = HEALTH.player;
  drawn = false;
  /** Seconds in the current state / move. */
  t = 0;
  move: PlayerMoveName | null = null;
  activeAttack: ActiveAttack | null = null;
  /** Transition log for tests: [time, event]. */
  readonly trace: [number, string][] = [];
  clock = 0;

  private katana: ReturnType<typeof buildKatana>;
  private hiltSheathed: THREE.Object3D[] = [];
  private clips = new Map<string, THREE.AnimationClip>();
  private cur: { a: THREE.AnimationAction; from: number; speed: number; w: number; t0: number } | null = null;
  private prev: { a: THREE.AnimationAction; w: number } | null = null;
  private queued = false; private dropped = false;
  private instance = 0;
  private recLen = 0;
  private rollCool = 0; private mashLock = 0;
  private parryT = 0; private parryLock = 0; private riposteT = 0;
  private blockT = 0; private blockWasHeld = false; private lowering = 0;
  private push: { v: THREE.Vector3; until: number } | null = null;
  private dir = new THREE.Vector3(0, 0, 1);
  private lastAction = -99;
  private unchainedCut1: number[] = [];
  private pelvisRest: THREE.Vector3;
  private reactLen = 0;
  /** Ability controller (temple fight); null leaves the kit exactly as before. */
  spirit: SpiritDriver | null = null;
  spiritKind: SpiritKind | null = null;
  private spiritBuf: SpiritKind | null = null; private spiritBufT = 0;
  private clipAt: number | null = null;
  /** Combat events for effects and camera (leap landing, knocked flying). */
  onEvent: ((e: 'leapLand' | 'knockdown', p: THREE.Vector3) => void) | null = null;
  private spinBase = 0; private leapLanded = false;
  /** Living enemy positions (feet) for the soft lock (set by the game). */
  targets: (() => THREE.Vector3[]) | null = null;
  /** Step-in toward the soft-locked enemy at the start of a cut (metres over 0.02–0.22 s). */
  private stepIn = 0;
  /** Travelling moves (spin, leap) stretch their drive to reach a soft-locked enemy (×1–2). */
  private driveBoost = 1;

  constructor(private player: Player, clips: THREE.AnimationClip[]) {
    for (const c of clips) this.clips.set(c.name, c);
    // Block holds the guard with the upper body only, so the legs keep walking.
    const blk = this.clips.get('Sword_Block')!;
    this.clips.set('Sword_Block_Upper', new THREE.AnimationClip('Sword_Block_Upper', blk.duration, blk.tracks.filter((t) => UPPER.test(t.name.split('.')[0]))));
    this.katana = buildKatana(player.model);
    mergeStaticSiblings(this.katana.mount);
    player.model.traverse((o) => { if (o.name === 'katana-hilt') this.hiltSheathed.push(o); });
    let pelvis: THREE.Object3D | null = null;
    player.model.traverse((o) => { if (o.name === 'pelvis') pelvis = o; });
    this.pelvis = pelvis!;
    this.pelvisRest = this.pelvis.position.clone();
  }
  private pelvis: THREE.Object3D;

  // ---------------------------------------------------------------- state queries
  /** Invulnerable: roll i-frames, flinch, knockdown get-up, dead. */
  get invulnerable() {
    if (this.state === 'roll') return this.t >= ROLL.invulnerable[0] && this.t <= ROLL.invulnerable[1];
    if (this.state === 'spirit') return !!this.spirit?.invulnerable;
    if (this.state === 'flinch') return true;
    if (this.state === 'knockdown') return this.t >= REACT.knockdownInvulnerableFrom;
    return this.state === 'dead';
  }
  get guardUp() { return this.state === 'block' && this.blockT >= BLOCK.raise && this.lowering <= 0; }
  get parryActive() { return this.parryT > 0; }
  get riposteReady() { return this.riposteT > 0; }
  /** Increments with every new move (for observers reacting to a new attack). */
  get attackInstance() { return this.instance; }
  /** Unchained Cut 1s in the last 3 s (raises an enemy's parry chance; anti-mash). */
  mashScore() { return this.unchainedCut1.filter((t) => this.clock - t <= 3).length; }

  // ---------------------------------------------------------------- per frame
  preUpdate(dt: number, input: Input, camYaw: number, enabled: boolean) {
    this.clock += dt; this.t += dt;
    for (const k of ['rollCool', 'mashLock', 'riposteT', 'parryLock'] as const) this[k] = Math.max(0, this[k] - dt);
    if (this.parryT > 0) { this.parryT -= dt; if (this.parryT <= 0) { this.parryT = 0; this.parryLock = PARRY.lockout; this.log('parry window missed (lockout)'); } }

    const atk = enabled ? input.consumeAttack() : 0, dodge = enabled ? input.consumeDodge() : 0, bpress = enabled ? input.consumeBlockPress() : 0;
    const held = enabled && input.blockHeld;
    // Holding Attack for 0.2 s turns the opening cut (before it lands) into a heavy slash.
    if (enabled && input.attackHeld) this.attackHold += dt; else { this.attackHold = 0; this.heavyDone = false; }
    if (atk || dodge || bpress || held) { this.lastAction = this.clock; if (!this.drawn) this.setDrawn(true); }
    if (this.drawn && this.clock - this.lastAction > 6 && this.state === 'free') this.setDrawn(false);

    // Input direction (camera-relative), for rolls and attack facing.
    const ax = enabled ? input.axis() : { x: 0, y: 0, mag: 0 };
    const f = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw)), r = new THREE.Vector3(-f.z, 0, f.x);
    const wish = f.multiplyScalar(ax.y).add(r.multiplyScalar(ax.x));
    const facing = new THREE.Vector3(Math.sin(this.player.facing), 0, Math.cos(this.player.facing));
    const aimDir = wish.lengthSq() > 0.01 ? wish.normalize() : facing;

    // Parry: a press from neutral (not already holding block) opens the window, unless locked out.
    if (bpress && !this.blockWasHeld && this.parryLock <= 0 && this.canDefend()) { this.parryT = PARRY.window; this.log('parry window open'); }
    this.blockWasHeld = held;

    if (this.attackHold >= 0.2 && !this.heavyDone && (this.state === 'free' || this.state === 'attack' && this.move === 'cut1' && this.t < 0.24)) {
      this.heavyDone = true; this.startMove('heavy', aimDir);
    }
    // Abilities: a press is buffered briefly; it starts from neutral, block, a cut's recovery, or the tail of a cut.
    const sp = enabled ? input.consumeSpirit() : null;
    if (sp) { this.spiritBuf = sp; this.spiritBufT = SPIRIT_BUFFER; }
    else if (this.spiritBuf && (this.spiritBufT -= dt) <= 0) this.spiritBuf = null;
    if (this.spiritBuf && this.spirit && this.canSpirit() && this.spirit.ready(this.spiritBuf)) {
      const k = this.spiritBuf; this.spiritBuf = null;
      this.move = null; this.parryT = 0; this.lowering = 0; this.instance++; this.spiritKind = k;
      this.setState('spirit'); this.lastAction = this.clock; if (!this.drawn) this.setDrawn(true);
      this.spirit.start(k, aimDir, camYaw); this.log(`start ${k}`);
    }
    switch (this.state) {
      case 'spirit':
        if (!this.spirit!.update(dt, input, camYaw)) { this.spiritKind = null; this.clipAt = null; this.toFree(); }
        break;
      case 'free':
        if (dodge && this.rollCool <= 0) this.startMove('roll', aimDir);
        else if (atk) this.attackFromNeutral(aimDir, input);
        else if (held) this.enterBlock();
        break;
      case 'block':
        this.blockT += dt;
        if (dodge && this.rollCool <= 0) { this.startMove('roll', aimDir); break; }
        if (!held && this.lowering <= 0) { this.lowering = BLOCK.lower; this.log('block released'); }
        if (held && this.lowering > 0) { this.lowering = 0; }
        // A riposte may follow a parry while the guard is still up or already lowering.
        if (atk && this.riposteT > 0) { this.startMove('riposte', aimDir); break; }
        // Attack while blocking: guard-break kick.
        if (atk && this.lowering <= 0) { this.startMove('kick', aimDir); break; }
        if (this.lowering > 0) { this.lowering -= dt; if (this.lowering <= 0) this.toFree(); }
        break;
      case 'attack': this.updateAttack(atk, dodge, held, aimDir); break;
      case 'recover': {
        const into = this.t;
        if (dodge && this.rollCool <= 0 && (this.move === 'cut1' || this.move === 'cut2')) { this.startMove('roll', aimDir); break; }
        if (held && into >= BLOCK.blockCancelAfter) { this.enterBlock(); break; }
        if (atk && this.riposteT > 0) { this.startMove('riposte', aimDir); break; }
        if (into >= this.recLen) { if (this.dropped) this.mashLock = MASH_LOCK; this.toFree(); }
        break;
      }
      case 'roll': if (this.t >= PLAYER_MOVES.roll.to) this.toFree(); break;
      case 'flinch': case 'stun': if (this.t >= this.reactLen) this.toFree(); break;
      case 'knockdown': if (this.t >= REACT.knockdown) this.toFree(); break;
      case 'dead': break;
    }

    // Movement control for Player.update.
    const c = this.player.control;
    const busy = this.state !== 'free' && this.state !== 'block';
    // While a hit pushes the player back, he keeps facing his attacker (no turning toward the push).
    c.lockMove = busy || (this.push !== null && this.clock < this.push.until);
    // Blocking keeps the guard facing the same way (walking while blocking doesn't turn the player).
    c.noTurn = this.state === 'block';
    c.moveScale = this.state === 'block' ? BLOCK.moveScale : 1;
    c.noSprint = this.state === 'block';
    c.drive = this.driveVector();
    c.locomotion = this.state === 'free' || this.state === 'block' ? 1 : 0;
  }

  postUpdate(dt: number) {
    // Blend the action clip over locomotion (Player.update has already advanced the mixer).
    if (this.cur) {
      const fadingOut = this.state === 'free';
      this.cur.w = THREE.MathUtils.clamp(this.cur.w + (fadingOut ? -dt : dt) / FADE, 0, 1);
      this.cur.a.setEffectiveWeight(this.cur.w);
      if (fadingOut && this.cur.w <= 0) { this.cur.a.stop(); this.cur = null; }
    }
    if (this.prev) { this.prev.w -= dt / FADE; this.prev.a.setEffectiveWeight(Math.max(0, this.prev.w)); if (this.prev.w <= 0) { this.prev.a.stop(); this.prev = null; } }
    if (this.cur) {
      let time = this.cur.from + (this.clipTime() - this.cur.t0) * this.cur.speed;
      if (this.holdAt >= 0) time = Math.min(time, this.holdAt);
      if (this.clipAt !== null) time = this.clipAt;
      this.cur.a.time = Math.min(time, this.cur.a.getClip().duration - 1e-3);
      // The upper-body guard shares bones with locomotion: weight it to dominate them while held.
      if (this.state === 'block') this.cur.a.setEffectiveWeight(this.cur.w * 6);
    }
    this.player.mixer.update(0);
    // Roll and lunge travel with the body: keep the pelvis over it (no double movement).
    if ((this.state === 'roll' || this.move === 'lunge' && this.state === 'attack' || this.state === 'spirit' && this.spirit?.lockPelvis) && this.cur) {
      this.pelvis.position.x = THREE.MathUtils.lerp(this.pelvis.position.x, this.pelvisRest.x, this.cur.w);
      this.pelvis.position.z = THREE.MathUtils.lerp(this.pelvis.position.z, this.pelvisRest.z, this.cur.w);
    }
    // Update from the player root (its transform was just moved this frame), so weapon positions are current.
    // Spinning slash: the body turns a full circle through the cut. Leaping slam: the body jumps and lands on the strike.
    const model = this.player.model;
    if (this.state === 'attack' && this.move === 'spin') {
      const k = THREE.MathUtils.smoothstep(this.t, 0.05, 0.42);
      this.player.setFacing(this.spinBase + Math.PI * 2 * k);
    }
    if (this.state === 'attack' && this.move === 'leap' && this.t < 0.46) model.position.y = Math.sin(Math.PI * this.t / 0.46) * 1.05;
    else if (model.position.y !== 0) model.position.y = 0;
    if (this.state === 'attack' && this.move === 'leap' && this.t >= 0.46 && !this.leapLanded) { this.leapLanded = true; this.onEvent?.('leapLand', this.player.position.clone()); }
    this.player.object.updateMatrixWorld(true);
    if (this.state === 'spirit') { this.spirit?.pose(dt); this.player.object.updateMatrixWorld(true); }
    // Active hit window (for the shared hit resolver). The blade is tracked every frame so the first active frame has a previous position.
    const hiltNow = new THREE.Vector3().setFromMatrixPosition(this.katana.hilt.matrixWorld), tipNow = new THREE.Vector3().setFromMatrixPosition(this.katana.tip.matrixWorld);
    const prevHilt = this.bladePrev?.hilt ?? hiltNow, prevTip = this.bladePrev?.tip ?? tipNow;
    this.bladePrev = { hilt: hiltNow, tip: tipNow };
    this.activeAttack = null;
    if (this.state === 'attack' && this.move) {
      const m = PLAYER_MOVES[this.move];
      if (m.active && this.t >= m.active[0] && this.t <= m.active[1]) {
        this.activeAttack = {
          move: this.move, instance: this.instance, damage: playerDamage(this.move, false), damageOpen: playerDamage(this.move, true),
          poise: m.poise ?? 0, meter: m.meter ?? 0,
          hilt: hiltNow, tip: tipNow, prevHilt, prevTip, key: `player#${this.instance}`,
        };
      }
    }
  }

  // ---------------------------------------------------------------- incoming hits (hook for later stages)
  receiveHit(h: IncomingHit): HitOutcome {
    if (this.state === 'dead') return 'ignored';
    if (this.invulnerable) { this.log('hit avoided (invulnerable)'); return 'dodged'; }
    // A hit lands during an ability: it is cut short (the reaction below takes over).
    if (this.state === 'spirit') { this.spirit?.interrupt(); this.spiritKind = null; this.clipAt = null; this.log('ability interrupted'); }
    const toA = h.from.clone().sub(this.player.position).setY(0).normalize();
    const facing = new THREE.Vector3(Math.sin(this.player.facing), 0, Math.cos(this.player.facing));
    const front = toA.dot(facing) >= Math.cos(THREE.MathUtils.degToRad(BLOCK.arc / 2));
    if (front && this.parryT > 0 && h.parryable) {
      this.parryT = 0; this.riposteT = PARRY.riposteWindow; this.log('PARRY'); return 'parried';
    }
    // Only an already-active block is a guard: a parry press from neutral is not (docs/combat.md §4). An unparryable
    // attack landing during a parry press without an active block hits normally.
    if (front && this.guardUp) {
      if (h.weight === 'heavy') {
        this.parryT = 0; this.damage(h.blocked);
        if (this.hp <= 0) return this.die();
        this.react('stun', 'Hit_Head', REACT.guardBreakStun); this.pushFrom(h.from, REACT.blockPush); this.log('guard broken'); return 'guardBreak';
      }
      this.damage(h.blocked); if (this.hp <= 0) return this.die();
      this.pushFrom(h.from, REACT.blockPush); this.log(`blocked (${h.blocked})`); return 'blocked';
    }
    this.damage(h.damage);
    if (this.hp <= 0) return this.die();
    if (h.weight === 'heavy') this.knockdown(h.from);
    else { this.react('flinch', h.weight === 'light' ? 'Hit_Chest' : 'Hit_Head', REACT.flinch); this.pushFrom(h.from, REACT.flinchPush[h.weight]); }
    this.log(`hit (${h.damage}, ${h.weight})`);
    return 'hit';
  }
  /** An enemy parried the player's attack: short stun (punishable). */
  /** Full reset after defeat: full health, free, sword sheathed. */
  reset() {
    this.hp = HEALTH.player; this.move = null; this.setState('free'); this.parryT = 0; this.riposteT = 0; this.push = null;
    this.rollCool = this.mashLock = this.parryLock = 0;
    this.spirit?.interrupt(); this.spirit?.reset?.(); this.spiritKind = null; this.spiritBuf = null; this.clipAt = null;
    if (this.cur) { this.cur.a.stop(); this.cur = null; } if (this.prev) { this.prev.a.stop(); this.prev = null; }
    this.setDrawn(false); this.log('reset');
  }
  parriedByEnemy() { if (this.state !== 'dead') this.react('stun', 'Hit_Head', REACT.parriedStun); }

  // ---------------------------------------------------------------- internals
  private canSpirit() {
    if (this.state === 'free' || this.state === 'block') return true;
    if (this.state === 'recover') return this.t >= 0.12;
    // The tail of a cut (after its hit window) can be cancelled into an ability.
    if (this.state === 'attack' && this.move) { const a = PLAYER_MOVES[this.move].active; return !!a && this.t > a[1] + 0.05; }
    return false;
  }
  // ---------------------------------------------------------------- ability controller API
  /** Play a clip as the current action (cross-faded). `hold` clamps playback at that clip time. */
  playClip(name: string, from: number, speed: number, hold?: number) { this.play(name, from, speed, hold); this.cur!.t0 = this.t; }
  /** Pin the current clip to a time (null: normal playback from the state timer). */
  setClipTime(t: number | null) { this.clipAt = t; }
  get blade() { return this.katana; }
  private canDefend() { return this.state === 'free' || this.state === 'block' || (this.state === 'recover' && this.t >= BLOCK.blockCancelAfter); }
  private attackFromNeutral(aim: THREE.Vector3, input: Input) {
    if (this.riposteT > 0) return this.startMove('riposte', aim);
    const speed = Math.hypot(this.player.velocity.x, this.player.velocity.z);
    if (input.sprint && speed > 5.5) return this.startMove('lunge', aim);
    if (this.mashLock > 0) { this.log('cut1 refused (mash lock)'); return; }
    this.startMove('cut1', aim);
  }
  private updateAttack(atk: number, dodge: number, held: boolean, aim: THREE.Vector3) {
    const m = PLAYER_MOVES[this.move!];
    const end = (m.to - (m.from ?? 0)) / (m.speed ?? 1);
    if (atk && m.chain) {
      if (this.t >= m.chain[0] - BUFFER && this.t <= m.chain[1]) { if (!this.dropped) { this.queued = true; this.log(`${this.move} chain queued`); } }
      else if (this.t < m.chain[0] - BUFFER) { this.dropped = true; this.queued = false; this.log(`${this.move} chain dropped (mash)`); }
    }
    if (m.chain && m.next && this.queued && !this.dropped && this.t >= m.chain[0]) { this.startMove(m.next, aim); return; }
    // Block may cancel the tail (recovery) of the finisher, lunge, riposte and leap (moves without a recovery clip).
    if (held && m.active && this.t >= m.active[1] + BLOCK.blockCancelAfter && (!m.chain || !m.rec)) { this.enterBlock(); return; }
    void dodge;
    if (this.t >= end) {
      if (m.rec) {
        if (this.move === 'cut1') this.unchainedCut1.push(this.clock);
        this.setState('recover'); this.recLen = m.rec.length; this.play(m.rec.clip, 0, 1);
      } else this.toFree();
    }
  }
  /**
   * Soft lock for the sword: the enemy nearest the aim (within 65° and 3.6 m) becomes the cut's target; the cut turns to
   * him and steps in to keep him in reach (so a combo connects even as each hit pushes him back).
   */
  private softLock(aim: THREE.Vector3) {
    const P = this.player.position;
    let best: THREE.Vector3 | null = null, bestScore = Infinity;
    for (const q of this.targets?.() ?? []) {
      const to = q.clone().sub(P).setY(0), d = to.length();
      if (d < 0.2 || d > 3.6) continue;
      const ang = to.normalize().angleTo(aim);
      if (ang > 1.13) continue;
      const score = ang * 2 + d;
      if (score < bestScore) { bestScore = score; best = q; }
    }
    if (!best) return null;
    const to = best.clone().sub(P).setY(0), d = to.length();
    return { dir: to.normalize(), step: THREE.MathUtils.clamp(d - 1.05, 0, 1.4) };
  }
  private startMove(name: PlayerMoveName, aim: THREE.Vector3) {
    const m = PLAYER_MOVES[name];
    this.stepIn = 0; this.driveBoost = 1;
    if (name !== 'roll' && name !== 'lunge') {
      const lock = this.softLock(aim);
      if (lock) {
        aim = lock.dir;
        // Combo cuts step in; counters (riposte, kick, heavy slash) only turn to the target and keep their footing.
        if (!m.drive && (name === 'cut1' || name === 'cut2' || name === 'cut3')) this.stepIn = lock.step;
        else if (m.drive) this.driveBoost = THREE.MathUtils.clamp((lock.step + 0.2) / (m.drive?.dist ?? 1), 1, 2);
      }
    }
    this.move = name; this.queued = false; this.dropped = false; this.instance++;
    this.parryT = 0; this.lowering = 0;
    if (name === 'riposte') this.riposteT = 0;
    if (name === 'roll') this.rollCool = ROLL.cooldown;
    this.dir.copy(aim);
    this.player.setFacing(Math.atan2(aim.x, aim.z));
    this.spinBase = this.player.facing; this.leapLanded = false;
    this.setState(name === 'roll' ? 'roll' : 'attack');
    this.play(m.clip, m.from ?? 0, m.speed ?? 1);
    this.log(`start ${name}`);
  }
  private enterBlock() {
    this.move = null; this.setState('block'); this.blockT = 0; this.lowering = 0;
    this.play('Sword_Block_Upper', 0, 0.3 / BLOCK.raise, 0.3);
  }
  private react(state: 'flinch' | 'stun', clip: string, len: number) {
    this.move = null; this.parryT = 0; this.setState(state); this.reactLen = len;
    const d = this.clips.get(clip)!.duration;
    this.play(clip, 0, Math.min(1, d / len));
  }
  /** Heavy hits knock the player flying: launched up and back, falling under gravity into the knockdown. */
  private knockdown(from?: THREE.Vector3) {
    this.move = null; this.parryT = 0; this.setState('knockdown');
    this.play('Hit_Knockback', 0, 1);
    if (from) {
      const away = this.player.position.clone().sub(from).setY(0);
      // A blow from straight above (lightning) has no direction: fall backwards from where he faces.
      if (away.lengthSq() < 0.01) away.set(-Math.sin(this.player.facing), 0, -Math.cos(this.player.facing));
      away.normalize();
      this.push = { v: away.multiplyScalar(2.6 / 0.5), until: this.clock + 0.5 };
      this.player.setFacing(Math.atan2(-away.x, -away.z));   // facing the attacker: the fall goes backwards
      this.player.launch(5.2);
      this.onEvent?.('knockdown', this.player.position.clone());
    }
  }
  private die(): HitOutcome {
    this.move = null; this.setState('dead'); this.play('Death01', 0, 1); this.log('DEAD'); return 'killed';
  }
  private damage(n: number) { this.hp = Math.max(0, this.hp - n); }
  /** Push the player away from `from` by `dist` metres over 0.15 s (blocked hits, enemy guard). */
  pushFrom(from: THREE.Vector3, dist: number) {
    const away = this.player.position.clone().sub(from).setY(0).normalize();
    this.push = { v: away.multiplyScalar(dist / 0.15), until: this.clock + 0.15 };
  }
  private driveVector(): THREE.Vector3 | null {
    if (this.push && this.clock < this.push.until) return this.push.v.clone();
    if (this.push && this.state === 'block') {
      // A blocked hit's push-back ends at its full distance: cancel only the push's leftover velocity along the push
      // direction (the block state doesn't lock movement, so it would otherwise ease out and slide further).
      // Input and any other movement are left as they are.
      const d = this.push.v.clone().setY(0).normalize(), v = this.player.velocity;
      const along = v.x * d.x + v.z * d.z;
      if (along > 0) { v.x -= d.x * along; v.z -= d.z * along; }
    }
    this.push = null;
    const m = this.move ? PLAYER_MOVES[this.move] : null;
    if (m?.drive && (this.state === 'attack' || this.state === 'roll') && this.t >= m.drive.from && this.t <= m.drive.to)
      return this.dir.clone().multiplyScalar((m.drive.dist * (this.state === 'attack' ? this.driveBoost : 1)) / (m.drive.to - m.drive.from));
    if (this.stepIn > 0 && this.state === 'attack' && this.t >= 0.02 && this.t <= 0.22) return this.dir.clone().multiplyScalar(this.stepIn / 0.2);
    if (this.state === 'spirit') return this.spirit?.drive() ?? new THREE.Vector3();
    if (this.state !== 'free' && this.state !== 'block') return new THREE.Vector3();
    return null;
  }
  private toFree() { this.move = null; this.setState('free'); }
  private setState(s: CombatState) { this.state = s; this.t = 0; if (s !== 'block') this.blockT = 0; }
  /** Clip time is move time, except the knockdown chains two clips into 2.0 s. */
  private clipTime() {
    if (this.state === 'knockdown') {
      const kb = this.clips.get('Hit_Knockback')!.duration;
      if (this.t >= kb && this.cur?.a.getClip().name === 'Hit_Knockback') {
        const lay = this.clips.get('LayToIdle')!.duration;
        this.play('LayToIdle', 0, lay / (REACT.knockdown - kb));
      }
      return this.cur?.a.getClip().name === 'LayToIdle' ? this.t - kb : this.t;
    }
    return this.t;
  }
  /** Start a clip as the current action (cross-fading from the previous). `hold` clamps at that clip time. */
  private play(name: string, from: number, speed: number, hold?: number) {
    const clip = this.clips.get(name)!;
    if (this.prev) { this.prev.a.stop(); this.prev = null; }
    if (this.cur) this.prev = { a: this.cur.a, w: this.cur.w };
    const a = this.player.mixer.clipAction(clip);
    a.reset(); a.play(); a.paused = true; a.setEffectiveWeight(this.prev ? 0 : 0.0001);
    if (this.prev && this.prev.a === a) this.prev = null;
    this.cur = { a, from, speed, w: this.prev ? 0 : 0.0001, t0: 0 };
    this.holdAt = hold ?? -1;
  }
  private holdAt = -1;
  private attackHold = 0; private heavyDone = false;
  private bladePrev: { hilt: THREE.Vector3; tip: THREE.Vector3 } | null = null;
  /** World position of the chest (line-of-sight origin for hits). */
  chest() { return this.player.position.clone().setY(this.player.position.y + 1.3); }
  setDrawn(d: boolean) {
    this.drawn = d; this.katana.mount.visible = d;
    for (const h of this.hiltSheathed) h.visible = !d;
    this.log(d ? 'katana drawn' : 'katana sheathed');
  }
  private log(e: string) { this.trace.push([+this.clock.toFixed(3), e]); if (this.trace.length > 400) this.trace.shift(); }
}
