import * as THREE from 'three';
import type { Player } from './player';
import type { Input } from '../core/input';
import { buildKatana } from './katana';
import { BLOCK, BUFFER, HEALTH, MASH_LOCK, PARRY, PLAYER_MOVES, REACT, ROLL, playerDamage, type PlayerMoveName, type Weight } from '../combat/tables';

/**
 * Player combat kit (Stage 1): three-cut combo, sprint lunge, dodge roll, block and parry, riposte,
 * reactions and death, on the protagonist's shared skeleton (UAL clips from enemies.glb).
 * No hit detection here: `activeAttack` and `receiveHit()` are the hooks for the shared hit resolver.
 *
 * Per frame: preUpdate() before Player.update (sets movement control), postUpdate() after it (pose fixes).
 */
export type CombatState = 'free' | 'block' | 'attack' | 'recover' | 'roll' | 'flinch' | 'knockdown' | 'stun' | 'dead';
export interface IncomingHit { damage: number; blocked: number; parryable: boolean; weight: Weight; from: THREE.Vector3 }
export type HitOutcome = 'ignored' | 'dodged' | 'parried' | 'blocked' | 'guardBreak' | 'hit' | 'killed';
export interface ActiveAttack {
  move: PlayerMoveName; instance: number;
  /** Damage against a normal / open (recovering or staggered) enemy. */
  damage: number; damageOpen: number;
  poise: number | 'break'; meter: number;
  hilt: THREE.Vector3; tip: THREE.Vector3;
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
  private cur: { a: THREE.AnimationAction; from: number; speed: number; w: number } | null = null;
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

  constructor(private player: Player, clips: THREE.AnimationClip[]) {
    for (const c of clips) this.clips.set(c.name, c);
    // Block holds the guard with the upper body only, so the legs keep walking.
    const blk = this.clips.get('Sword_Block')!;
    this.clips.set('Sword_Block_Upper', new THREE.AnimationClip('Sword_Block_Upper', blk.duration, blk.tracks.filter((t) => UPPER.test(t.name.split('.')[0]))));
    this.katana = buildKatana(player.model);
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
    if (this.state === 'flinch') return true;
    if (this.state === 'knockdown') return this.t >= REACT.knockdownInvulnerableFrom;
    return this.state === 'dead';
  }
  get guardUp() { return this.state === 'block' && this.blockT >= BLOCK.raise && this.lowering <= 0; }
  get parryActive() { return this.parryT > 0; }
  get riposteReady() { return this.riposteT > 0; }
  /** Unchained Cut 1s in the last 3 s (raises an enemy's parry chance; anti-mash). */
  mashScore() { return this.unchainedCut1.filter((t) => this.clock - t <= 3).length; }

  // ---------------------------------------------------------------- per frame
  preUpdate(dt: number, input: Input, camYaw: number, enabled: boolean) {
    this.clock += dt; this.t += dt;
    for (const k of ['rollCool', 'mashLock', 'riposteT', 'parryLock'] as const) this[k] = Math.max(0, this[k] - dt);
    if (this.parryT > 0) { this.parryT -= dt; if (this.parryT <= 0) { this.parryT = 0; this.parryLock = PARRY.lockout; this.log('parry window missed (lockout)'); } }

    const atk = enabled ? input.consumeAttack() : 0, dodge = enabled ? input.consumeDodge() : 0, bpress = enabled ? input.consumeBlockPress() : 0;
    const held = enabled && input.blockHeld;
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

    switch (this.state) {
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
        if (this.lowering > 0) { this.lowering -= dt; if (this.lowering <= 0) this.toFree(); }
        else if (atk && this.riposteT > 0) this.startMove('riposte', aimDir);
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
    c.lockMove = busy;
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
      let time = this.cur.from + this.clipTime() * this.cur.speed;
      if (this.holdAt >= 0) time = Math.min(time, this.holdAt);
      this.cur.a.time = Math.min(time, this.cur.a.getClip().duration - 1e-3);
      // The upper-body guard shares bones with locomotion: weight it to dominate them while held.
      if (this.state === 'block') this.cur.a.setEffectiveWeight(this.cur.w * 6);
    }
    this.player.mixer.update(0);
    // Roll and lunge travel with the body: keep the pelvis over it (no double movement).
    if ((this.state === 'roll' || this.move === 'lunge' && this.state === 'attack') && this.cur) {
      this.pelvis.position.x = THREE.MathUtils.lerp(this.pelvis.position.x, this.pelvisRest.x, this.cur.w);
      this.pelvis.position.z = THREE.MathUtils.lerp(this.pelvis.position.z, this.pelvisRest.z, this.cur.w);
    }
    this.player.model.updateMatrixWorld(true);
    // Active hit window (for the shared hit resolver in a later stage).
    this.activeAttack = null;
    if (this.state === 'attack' && this.move) {
      const m = PLAYER_MOVES[this.move];
      if (m.active && this.t >= m.active[0] && this.t <= m.active[1]) {
        this.activeAttack = {
          move: this.move, instance: this.instance, damage: playerDamage(this.move, false), damageOpen: playerDamage(this.move, true),
          poise: m.poise ?? 0, meter: m.meter ?? 0,
          hilt: new THREE.Vector3().setFromMatrixPosition(this.katana.hilt.matrixWorld), tip: new THREE.Vector3().setFromMatrixPosition(this.katana.tip.matrixWorld),
        };
      }
    }
  }

  // ---------------------------------------------------------------- incoming hits (hook for later stages)
  receiveHit(h: IncomingHit): HitOutcome {
    if (this.state === 'dead') return 'ignored';
    if (this.invulnerable) { this.log('hit avoided (invulnerable)'); return 'dodged'; }
    const toA = h.from.clone().sub(this.player.position).setY(0).normalize();
    const facing = new THREE.Vector3(Math.sin(this.player.facing), 0, Math.cos(this.player.facing));
    const front = toA.dot(facing) >= Math.cos(THREE.MathUtils.degToRad(BLOCK.arc / 2));
    if (front && this.parryT > 0 && h.parryable) {
      this.parryT = 0; this.riposteT = PARRY.riposteWindow; this.log('PARRY'); return 'parried';
    }
    if (front && (this.guardUp || this.parryT > 0)) {
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
    if (h.weight === 'heavy') this.knockdown();
    else { this.react('flinch', h.weight === 'light' ? 'Hit_Chest' : 'Hit_Head', REACT.flinch); this.pushFrom(h.from, REACT.flinchPush[h.weight]); }
    this.log(`hit (${h.damage}, ${h.weight})`);
    return 'hit';
  }
  /** An enemy parried the player's attack: short stun (punishable). */
  parriedByEnemy() { if (this.state !== 'dead') this.react('stun', 'Hit_Head', REACT.parriedStun); }

  // ---------------------------------------------------------------- internals
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
    // Block may cancel the tail (recovery) of the finisher, lunge and riposte.
    if (held && m.active && this.t >= m.active[1] + BLOCK.blockCancelAfter && !m.chain) { this.enterBlock(); return; }
    void dodge;
    if (this.t >= end) {
      if (m.rec) {
        if (this.move === 'cut1') this.unchainedCut1.push(this.clock);
        this.setState('recover'); this.recLen = m.rec.length; this.play(m.rec.clip, 0, 1);
      } else this.toFree();
    }
  }
  private startMove(name: PlayerMoveName, aim: THREE.Vector3) {
    const m = PLAYER_MOVES[name];
    this.move = name; this.queued = false; this.dropped = false; this.instance++;
    this.parryT = 0; this.lowering = 0;
    if (name === 'riposte') this.riposteT = 0;
    if (name === 'roll') this.rollCool = ROLL.cooldown;
    this.dir.copy(aim);
    this.player.setFacing(Math.atan2(aim.x, aim.z));
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
  private knockdown() {
    this.move = null; this.parryT = 0; this.setState('knockdown');
    this.play('Hit_Knockback', 0, 1);
  }
  private die(): HitOutcome {
    this.move = null; this.setState('dead'); this.play('Death01', 0, 1); this.log('DEAD'); return 'killed';
  }
  private damage(n: number) { this.hp = Math.max(0, this.hp - n); }
  private pushFrom(from: THREE.Vector3, dist: number) {
    const away = this.player.position.clone().sub(from).setY(0).normalize();
    this.push = { v: away.multiplyScalar(dist / 0.15), until: this.clock + 0.15 };
  }
  private driveVector(): THREE.Vector3 | null {
    if (this.push && this.clock < this.push.until) return this.push.v.clone();
    this.push = null;
    const m = this.move ? PLAYER_MOVES[this.move] : null;
    if (m?.drive && (this.state === 'attack' || this.state === 'roll') && this.t >= m.drive.from && this.t <= m.drive.to)
      return this.dir.clone().multiplyScalar(m.drive.dist / (m.drive.to - m.drive.from));
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
    this.cur = { a, from, speed, w: this.prev ? 0 : 0.0001 };
    this.holdAt = hold ?? -1;
  }
  private holdAt = -1;
  setDrawn(d: boolean) {
    this.drawn = d; this.katana.mount.visible = d;
    for (const h of this.hiltSheathed) h.visible = !d;
    this.log(d ? 'katana drawn' : 'katana sheathed');
  }
  private log(e: string) { this.trace.push([+this.clock.toFixed(3), e]); if (this.trace.length > 400) this.trace.shift(); }
}
