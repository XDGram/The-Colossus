import * as THREE from 'three';
import type { Enemy } from '../enemies/enemy';
import type { AttackDirector } from './director';
import { ENEMY_HITS } from './tables';
import { CHARGE_BODY } from './system';

/**
 * Enemy behaviour (docs/combat.md §7): movement, spacing, attack choice, tells and reactions, driving an Enemy.
 * Attacks play their animations but are NOT connected to damage yet (later stage).
 *
 * States: approach → hold → (engage) → tell → attack → reposition, interrupted by dodge / parry / flinch /
 * stagger / dead.
 */
export type BrainState = 'approach' | 'hold' | 'engage' | 'tell' | 'attack' | 'reposition' | 'dodge' | 'parry' | 'flinch' | 'stagger' | 'dead';

export interface PlayerView {
  position: THREE.Vector3;
  facing: number;
  radius: number;
  /** Key of the player's current attack (changes when a new attack starts), or null. */
  attackKey: string | null;
  /** Unchained Cut 1s in the last 3 s (anti-mash: raises a Runner's parry chance). */
  mash?: number;
}
export interface WorldQuery {
  height(x: number, z: number): number;
  resolve(x: number, z: number, y: number, r: number): [number, number];
}

interface Personality {
  radius: number;
  walk: number; jog: number; turn: number;
  nativeWalk: number; nativeJog: number;
  ring?: [number, number]; hold?: [number, number];
  decide: [number, number];
}
const RUNNER: Personality = { radius: 0.38, walk: 1.6, jog: 4.3, turn: 9, nativeWalk: 1.45, nativeJog: 3.9, ring: [3, 5], decide: [1.2, 2.6] };
// The Temple Warden moves like a Breaker; his body is the slimmer older warrior (native walk at his own scale).
const BREAKER: Personality = { radius: 0.48, walk: 0.92, jog: 0.92, turn: 1.8, nativeWalk: 1.45 * 1.15 * 0.55, nativeJog: 1.45 * 1.15 * 0.55, hold: [2.0, 2.5], decide: [1.6, 3.0] };

/** Tell (warning) before each attack (docs/combat.md §5) and whether it can be parried (glint colour). */
const TELL: Record<string, { tell: number; hit: string }> = {
  slash: { tell: 0.3, hit: 'runner.slash' }, slash2: { tell: 0.3, hit: 'runner.slash2' }, flurry: { tell: 0.3, hit: 'runner.flurry' },
  lunge: { tell: 0.4, hit: 'runner.lunge' }, pommel: { tell: 0.3, hit: 'runner.pommel' }, spin: { tell: 0.35, hit: 'runner.spin' },
  sweep: { tell: 0.4, hit: 'breaker.sweep1' }, smash: { tell: 0.35, hit: 'breaker.smash' },
  charge: { tell: 0.6, hit: 'breaker.charge' }, stamp: { tell: 0.15, hit: 'breaker.stamp' },
};
export const SPACING = 1.6;

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

export class EnemyBrain {
  state: BrainState = 'approach';
  stateT = 0;
  attack: string | null = null;
  readonly p: Personality;
  private orbitSide = 1;
  private orbitFlip = 0;
  private radiusWant = 4;
  private nextDecision = 0;
  private dodgeCool = 0;
  private farFor = 0;
  private lastKey: string | null = null;
  private stuckT = 0; private stuckRef = new THREE.Vector3();
  private cue: THREE.Sprite;
  private deadT = 0;
  /** Debug: last steering target (world). */
  readonly target = new THREE.Vector3();
  removed = false;

  constructor(readonly e: Enemy, readonly id: string, private director: AttackDirector, private world: WorldQuery, private rnd: () => number) {
    this.p = e.kind === 'runner' ? RUNNER : e.kind === 'warden' ? { ...BREAKER, radius: 0.42, hold: [1.2, 1.6] as [number, number], nativeWalk: 1.45 * 1.05 * 0.55, nativeJog: 1.45 * 1.05 * 0.55 } : BREAKER;
    this.orbitSide = rnd() < 0.5 ? -1 : 1;
    this.radiusWant = this.p.ring ? THREE.MathUtils.lerp(this.p.ring[0] + 0.4, this.p.ring[1] - 0.4, rnd()) : 2.25;
    this.nextDecision = THREE.MathUtils.lerp(this.p.decide[0], this.p.decide[1], rnd());
    // Tell cue: a soft glint (pale = parryable, red = unparryable) shown during the warning.
    const tex = glintTexture();
    this.cue = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.cue.visible = false; this.cue.scale.setScalar(0.35);
    e.object.parent?.add(this.cue);
  }

  get pos() { return this.e.object.position; }
  get dead() { return this.state === 'dead'; }
  /** Effective position including any root offset of the current move (side-step, charge). */
  effective() { return this.e.pivot.position.clone().applyQuaternion(this.e.object.quaternion).add(this.e.object.position); }

  // ------------------------------------------------------------------ external reactions (later stages call these)
  react(kind: 'flinch' | 'stagger' | 'dodge' | 'parry') {
    if (this.dead) return;
    this.release();
    const r = this.e.cls === 'runner';
    if (kind === 'flinch') { this.set('flinch'); this.e.play((r ? 'flinchChest' : 'shudder') as never, 0.08); }
    else if (kind === 'stagger') { this.set('stagger'); this.e.play((r ? 'flinchHead' : 'stagger') as never, 0.12); if (r) this.e.rate = 0.43; }
    else if (kind === 'dodge' && r) this.startDodge();
    else if (kind === 'parry' && r) { this.set('parry'); this.e.play('parry' as never, 0.08); }
  }
  kill() {
    if (this.dead) return;
    this.release(); this.set('dead'); this.e.rate = 1;
    this.e.play((this.rnd() < 0.5 ? 'deathA' : 'deathB') as never, 0.15);
  }

  /** Open (punishable): in an attack's recovery window, or staggered. */
  isOpen() {
    if (this.state === 'stagger') return true;
    if (this.state !== 'attack') return false;
    const m = this.e.moves[this.e.move];
    return m.openFrom !== undefined && this.e.time >= m.openFrom && this.e.time <= m.openFrom + (m.recovery ?? 0);
  }
  /** Untouchable while dodging (side-step / roll). */
  get invulnerable() { return this.state === 'dodge' || this.dead; }
  get parrying() { return this.state === 'parry'; }
  /** True before the first hit of the current attack has landed (tell, or attack wind-up): poise may interrupt it. */
  beforeFirstHit() {
    if (this.state === 'tell') return true;
    if (this.state !== 'attack') return false;
    const h = this.e.moves[this.e.move].hits?.[0];
    return !!h && this.e.time < h.t - h.window;
  }
  /** The charge stops on contact (it does not pass through). */
  stopCharge() { if (this.attack === 'charge' && this.state === 'attack') { this.e.play('guard' as never, 0.15); } }
  /** Back to life at a spawn point (arena restart after a defeat). */
  revive(pos: THREE.Vector3, yaw: number) {
    this.release(); this.removed = false; this.deadT = 0; this.attack = null;
    this.e.pivot.position.set(0, 0, 0); this.e.pivot.rotation.y = 0;
    this.e.object.position.copy(pos); this.e.object.rotation.y = yaw; this.e.object.visible = true;
    this.e.rate = 1; this.e.frozen = false; this.e.play('idle' as never, 0); this.set('approach');
  }

  // ------------------------------------------------------------------ per frame
  update(dt: number, now: number, player: PlayerView, others: EnemyBrain[]) {
    this.stateT += dt;
    this.dodgeCool = Math.max(0, this.dodgeCool - dt);
    const me = this.effective();
    const toP = player.position.clone().sub(me).setY(0);
    const dist = toP.length();
    const facePlayer = Math.atan2(toP.x, toP.z);
    let want = new THREE.Vector3();  // desired horizontal velocity
    let face: number | null = facePlayer;
    let idleMove = this.e.cls === 'runner' ? 'idle' : 'guard';

    // Player starting an attack nearby: a Runner may dodge or parry (when free to).
    const newAttack = player.attackKey && player.attackKey !== this.lastKey;
    this.lastKey = player.attackKey;
    if (newAttack && this.e.cls === 'runner' && dist < 2.6 && ['approach', 'hold', 'engage', 'reposition'].includes(this.state) && this.dodgeCool <= 0) {
      const r = this.rnd();
      const parry = Math.min(0.5, 0.15 + 0.1 * (player.mash ?? 0));
      if (r < 0.35) { this.dodgeCool = 3; this.startDodge(player); }
      else if (r < 0.35 + parry) { this.dodgeCool = 3; this.set('parry'); this.e.play('parry' as never, 0.08); }
    }

    switch (this.state) {
      case 'approach': {
        const stopAt = this.p.ring ? this.p.ring[1] : this.p.hold![1];
        if (dist <= stopAt) { this.set('hold'); break; }
        // Far away, Breakers march at double pace so they reach the fight from the halls.
        want = toP.clone().normalize().multiplyScalar(this.e.cls === 'runner' && dist > stopAt + 2 ? this.p.jog : dist > 8 ? this.p.walk * 2 : this.p.walk);
        face = null;
        break;
      }
      case 'hold': {
        if (this.p.ring) { want = this.orbit(me, player, others, dt); face = want.lengthSq() > 0.05 ? null : facePlayer; }
        else want = this.holdLine(me, player, dist);
        this.nextDecision -= dt;
        if (this.e.cls === 'breaker') { this.farFor = dist > 5 ? this.farFor + dt : 0; if (this.farFor > 3) { this.tryAttack('charge', me, now); break; } }
        if (this.nextDecision <= 0) this.decide(me, player, dist, now);
        if (dist > (this.p.ring ? this.p.ring[1] + 1.5 : this.p.hold![1] + 1.5) && this.state === 'hold') this.set('approach');
        break;
      }
      case 'engage': {
        // Close in for a melee attack, then start it when the director allows (and the player can see the tell).
        const range = this.attack === 'lunge' ? 3.2 : this.e.cls === 'runner' ? 1.25 : 2.2;
        if (dist > range) want = toP.clone().normalize().multiplyScalar(this.e.cls === 'runner' ? this.p.jog : this.p.walk);
        else if (this.director.tryStart(this.id, this.e.cls, now, this.tellPoints())) this.beginTell();
        if (this.stateT > 2.5) { this.attack = null; this.set('reposition'); }
        break;
      }
      case 'tell': {
        face = this.e.cls === 'runner' ? facePlayer : null; // the Breaker commits to his line
        this.updateCue(now);
        if (this.stateT >= TELL[this.attack!].tell) { this.cue.visible = false; this.e.frozen = false; this.set('attack'); }
        break;
      }
      case 'attack':
        face = null;
        if (this.e.move !== this.attack) { this.release(); this.attack = null; this.set('reposition'); }
        break;
      case 'reposition': {
        if (this.e.cls === 'runner') {
          // Back off 2-3 m, then return to circling.
          if (dist < 3.2 && this.stateT < 1.6) want = toP.clone().normalize().multiplyScalar(-this.p.walk * 1.4);
          else this.set('hold');
          face = facePlayer;
        } else if (this.stateT > 0.6) this.set('hold');
        break;
      }
      case 'dodge': case 'parry': case 'flinch': case 'stagger':
        face = null;
        if (this.e.move === 'idle' || this.e.move === 'guard') { this.e.rate = 1; this.set(this.state === 'dodge' ? 'hold' : 'reposition'); }
        break;
      case 'dead':
        face = null; this.deadT += dt;
        if (this.deadT > 8) { this.e.object.position.y -= dt * 0.6; if (this.deadT > 10) { this.removed = true; this.e.object.visible = false; } }
        break;
    }

    // Movement, facing and locomotion clip.
    const busy = ['tell', 'attack', 'dodge', 'parry', 'flinch', 'stagger', 'dead'].includes(this.state);
    if (!busy) {
      want.add(this.separation(me, others));
      this.move(want, dt, player, idleMove);
    }
    if (face !== null && !['attack', 'dead', 'dodge', 'flinch', 'stagger'].includes(this.state)) this.turnTo(face, dt);
    else if (face === null && !busy && want.lengthSq() > 0.05) this.turnTo(Math.atan2(want.x, want.z), dt);
    this.e.groundY = this.world.height(this.pos.x, this.pos.z);
    this.e.update(dt);
    this.constrain(player, others);
    this.unstick(dt, busy);
  }

  // ------------------------------------------------------------------ decisions
  private decide(me: THREE.Vector3, player: PlayerView, dist: number, now: number) {
    this.nextDecision = THREE.MathUtils.lerp(this.p.decide[0], this.p.decide[1], this.rnd());
    if (this.e.cls === 'runner') {
      // Runners prefer to strike while the Breaker is committed (his attack in progress).
      const r = this.rnd() - (this.director.breakerAttacking() ? 0.1 : 0);
      let pick = r < 0.45 ? (this.rnd() < 0.5 ? 'slash' : 'slash2') : r < 0.7 ? 'flurry' : r < 0.85 ? 'lunge' : r < 0.95 ? 'pommel' : 'spin';
      if (pick === 'lunge' && (dist < 2 || dist > 4)) pick = 'slash';
      this.attack = pick; this.set('engage');
    } else {
      const toE = me.clone().sub(player.position).setY(0).normalize();
      const pf = new THREE.Vector3(Math.sin(player.facing), 0, Math.cos(player.facing));
      const behindPlayer = toE.dot(pf) < -0.17; // Breaker is behind the player
      const meF = new THREE.Vector3(Math.sin(this.e.object.rotation.y), 0, Math.cos(this.e.object.rotation.y));
      const playerBehindMe = player.position.clone().sub(me).setY(0).normalize().dot(meF) < -0.17;
      let pick: string;
      // Ranges follow the holding distance (Breaker 2.0-2.5 m with the club; the Warden's katana holds 1.2-1.6 m).
      const [h0, h1] = this.p.hold!;
      if (dist < h0 - 0.4 || playerBehindMe) pick = 'stamp';
      else if (dist <= h1 + 0.1) pick = this.rnd() < 0.59 ? 'sweep' : 'smash';
      else return; // keep closing in via hold
      void behindPlayer;
      this.tryAttack(pick, me, now);
    }
  }
  private tryAttack(name: string, _me: THREE.Vector3, now: number) {
    this.attack = name;
    if (this.director.tryStart(this.id, this.e.cls, now, this.tellPoints())) this.beginTell();
    else { this.attack = null; this.nextDecision = 0.4; }
  }
  private beginTell() {
    this.set('tell');
    this.e.play(this.attack as never, 0.12);
    this.e.frozen = true; this.e.time = 0; // hold the first frame of the attack as the warning pose
    const unparryable = !ENEMY_HITS[TELL[this.attack!].hit].parryable;
    (this.cue.material as THREE.SpriteMaterial).color.set(unparryable ? 0xff3a22 : 0xfff2d8);
    this.cue.visible = true;
  }
  private startDodge(player?: PlayerView) {
    this.release(); this.set('dodge');
    const r = this.rnd();
    const mv = r < 0.4 ? 'stepL' : r < 0.8 ? 'stepR' : 'roll';
    void player;
    this.e.play(mv as never, 0.08);
  }

  // ------------------------------------------------------------------ steering
  /** Runner: circle the player on a ring, drifting toward a flank; flip direction now and then. */
  private orbit(me: THREE.Vector3, player: PlayerView, others: EnemyBrain[], dt: number) {
    this.orbitFlip -= dt;
    if (this.orbitFlip <= 0) { this.orbitFlip = 2.5 + this.rnd() * 2.5; if (this.rnd() < 0.45) this.orbitSide *= -1; }
    const rel = me.clone().sub(player.position).setY(0);
    const ang = Math.atan2(rel.x, rel.z);
    // Preferred angle: the player's flank on our side (about 100 deg from where the player faces).
    const flank = wrap(player.facing + this.orbitSide * THREE.MathUtils.degToRad(100));
    // Stay out of an attacking Breaker's front arc.
    let goal = flank;
    for (const o of others) if (o.e.cls === 'breaker' && o.state === 'attack' || o.e.cls === 'breaker' && o.state === 'tell') {
      const ba = Math.atan2(o.pos.x - player.position.x, o.pos.z - player.position.z);
      if (Math.abs(wrap(goal - ba)) < 0.9) goal = wrap(ba + Math.sign(wrap(goal - ba) || 1) * 1.2);
    }
    const dAng = wrap(goal - ang);
    // Circle briskly (up to 2.6 m/s) while far from the flank, settling to a walk near it.
    const tangential = THREE.MathUtils.clamp(dAng * 2.5, -1, 1) * (Math.abs(dAng) > 0.8 ? 2.6 : this.p.walk);
    const radial = THREE.MathUtils.clamp((this.radiusWant - rel.length()) * 1.5, -this.p.walk, this.p.walk);
    const out = rel.clone().normalize(), tan = new THREE.Vector3(out.z, 0, -out.x).multiplyScalar(-1);
    const v = tan.multiplyScalar(tangential).addScaledVector(out, radial);
    this.target.copy(player.position).add(new THREE.Vector3(Math.sin(goal) * this.radiusWant, 0, Math.cos(goal) * this.radiusWant));
    if (v.length() > 2.6) v.setLength(2.6);
    return v.length() < 0.25 ? new THREE.Vector3() : v;
  }
  /** Breaker: hold 2-2.5 m in front of the player, guard up, adjusting slowly. */
  private holdLine(me: THREE.Vector3, player: PlayerView, dist: number) {
    const [a, b] = this.p.hold!;
    const toP = player.position.clone().sub(me).setY(0).normalize();
    if (dist > b) return toP.multiplyScalar(this.p.walk);
    // The Iron Breaker holds 2.0-2.5 m (docs/combat.md §7): he backs off whenever he is closer than 2.0 m.
    // The Temple Warden keeps his existing 0.3 m allowance below his band.
    if (dist < (this.e.kind === 'breaker' ? a : a - 0.3)) return toP.multiplyScalar(-this.p.walk * 0.7);
    return new THREE.Vector3();
  }
  private separation(me: THREE.Vector3, others: EnemyBrain[]) {
    const v = new THREE.Vector3();
    for (const o of others) {
      if (o === this || o.dead) continue;
      const d = me.clone().sub(o.effective()).setY(0);
      const l = d.length(), need = SPACING;
      if (l < need && l > 1e-4) v.addScaledVector(d.normalize(), (need - l) * 3);
    }
    return v;
  }
  private detour: { dir: THREE.Vector3; t: number } | null = null;
  private blockedT = 0;
  private move(v: THREE.Vector3, dt: number, player: PlayerView, idleMove: string) {
    // Blocked by an obstacle (wanting to move but not progressing): step around it for a moment.
    if (this.detour) { this.detour.t -= dt; if (this.detour.t <= 0) this.detour = null; else if (v.lengthSq() > 0.01) v = this.detour.dir.clone().multiplyScalar(Math.max(this.p.walk, v.length())).add(v.clone().multiplyScalar(0.35)); }
    const sp = Math.hypot(v.x, v.z);
    const before = this.pos.clone();
    let nx = this.pos.x + v.x * dt, nz = this.pos.z + v.z * dt;
    [nx, nz] = this.world.resolve(nx, nz, this.pos.y, this.p.radius);
    this.pos.x = nx; this.pos.z = nz;
    this.pos.y = this.world.height(nx, nz);
    void player;
    const progress = Math.hypot(this.pos.x - before.x, this.pos.z - before.z);
    if (sp > 0.3 && progress < sp * dt * 0.25) this.blockedT += dt; else this.blockedT = Math.max(0, this.blockedT - dt);
    if (this.blockedT > 0.6 && !this.detour) {
      const side = this.rnd() < 0.5 ? -1 : 1;
      this.detour = { dir: new THREE.Vector3(v.z * side, 0, -v.x * side).normalize(), t: 0.9 + this.rnd() * 0.6 };
      this.blockedT = 0; this.unstuckCount++;
    }
    // Locomotion clip with feet matched to ground speed.
    const wantMove = sp < 0.2 ? idleMove : sp < (this.p.walk + this.p.jog) / 2 || this.e.cls === 'breaker' ? 'walk' : 'jog';
    if (this.e.move !== wantMove) this.e.play(wantMove as never, 0.2);
    this.e.rate = wantMove === 'walk' ? sp / this.p.nativeWalk : wantMove === 'jog' ? sp / this.p.nativeJog : 1;
  }
  private turnTo(yaw: number, dt: number) {
    const d = wrap(yaw - this.e.object.rotation.y);
    this.e.object.rotation.y += THREE.MathUtils.clamp(d, -this.p.turn * dt, this.p.turn * dt);
  }
  /** Keep the body out of walls, the player and other enemies (including root-driven moves). */
  private constrain(player: PlayerView, others: EnemyBrain[]) {
    const eff = this.effective();
    let [x, z] = this.world.resolve(eff.x, eff.z, eff.y, this.p.radius);
    const fix = (px: number, pz: number, r: number) => {
      const dx = x - px, dz = z - pz, l = Math.hypot(dx, dz);
      if (l < r && l > 1e-4) { x = px + dx / l * r; z = pz + dz / l * r; }
    };
    // An Iron Breaker's shoulder charge must be able to reach the player: during its body-hit window the player spacing
    // is suspended (spacing between enemies still applies). The charge stops on contact (CombatSystem → stopCharge) and
    // the normal spacing pushes him back out on the next frame. The Temple Warden keeps the normal spacing throughout.
    const charging = this.e.kind === 'breaker' && this.state === 'attack' && this.attack === 'charge' && this.e.move === 'charge'
      && this.e.time >= CHARGE_BODY.from && this.e.time <= CHARGE_BODY.to;
    if (!charging) fix(player.position.x, player.position.z, player.radius + this.p.radius + 0.05);
    for (const o of others) if (o !== this && !o.dead) { const q = o.effective(); fix(q.x, q.z, o.p.radius + this.p.radius + 0.02); }
    const dx = x - eff.x, dz = z - eff.z;
    if (Math.abs(dx) + Math.abs(dz) > 1e-5) {
      // Absorb the correction into the root offset when a move is driving it; otherwise move the body.
      if (this.e.pivot.position.lengthSq() > 0) { this.pos.x += dx; this.pos.z += dz; }
      else { this.pos.x += dx; this.pos.z += dz; }
    }
  }
  /** If trying to move but not getting anywhere for 1.5 s, flip the circling side and re-pick the radius. */
  private unstick(dt: number, busy: boolean) {
    if (busy || this.state === 'tell') { this.stuckT = 0; this.stuckRef.copy(this.pos); return; }
    this.stuckT += dt;
    if (this.stuckT > 1.5) {
      if (this.stuckRef.distanceTo(this.pos) < 0.15 && this.e.move !== 'idle' && this.e.move !== 'guard') {
        this.orbitSide *= -1; this.orbitFlip = 3;
        if (this.p.ring) this.radiusWant = THREE.MathUtils.lerp(this.p.ring[0] + 0.3, this.p.ring[1] - 0.3, this.rnd());
        this.unstuckCount++;
      }
      this.stuckT = 0; this.stuckRef.copy(this.pos);
    }
  }
  unstuckCount = 0;

  /** Points the player must be able to see for this enemy's warning to count: chest, head and the glint position. */
  tellPoints() {
    const chest = this.e.chest(), head = chest.clone().add(new THREE.Vector3(0, 0.45, 0));
    const unparryable = this.attack ? !ENEMY_HITS[TELL[this.attack].hit].parryable : false;
    return [chest, head, unparryable ? head : this.e.weapons()[0].tip];
  }
  private updateCue(now: number) {
    const w = this.e.weapons()[0];
    this.cue.position.copy(this.attack && !ENEMY_HITS[TELL[this.attack].hit].parryable ? this.e.chest().add(new THREE.Vector3(0, 0.45, 0)) : w.tip);
    const k = Math.min(1, this.stateT / 0.12);
    this.cue.scale.setScalar((0.22 + 0.25 * k) * (1 + 0.15 * Math.sin(now * 40)));
  }
  private release() { this.director.release(this.id); this.cue.visible = false; this.e.frozen = false; }
  private set(s: BrainState) { this.state = s; this.stateT = 0; }
}

let glint: THREE.Texture | null = null;
function glintTexture() {
  if (glint) return glint;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.6)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  g.strokeStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = 2; g.beginPath(); g.moveTo(32, 4); g.lineTo(32, 60); g.moveTo(4, 32); g.lineTo(60, 32); g.stroke();
  glint = new THREE.CanvasTexture(c);
  return glint;
}
