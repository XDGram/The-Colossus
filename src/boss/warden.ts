import * as THREE from 'three';
import { EnemyBrain, type PlayerView } from '../combat/brain';
import type { CombatSystem } from '../combat/system';
import { BOSS, HEALTH } from '../combat/tables';
import { GLINT_COLOR, WARDEN_TELL } from './moves';
import { FX_COLORS, type Vfx } from '../fx/vfx';
import type { Spells } from './spells';

/**
 * The Temple Warden boss (docs/boss.md): the approved mentor model and katana with his own moveset, three phases
 * and spells. Built on EnemyBrain, so the combat system, attack director, hit detection and HUD treat him like any
 * other enemy (450 HP, 150 posture, super-armour, frontal guard).
 *
 * Phase 1 Blade (100-65%): combo, lunge, cleave, side-step roll + slash.
 * Phase 2 Fire  (65-30%):  + flame-line cut, fire wave, fireball volley; one summon of two Ash Runners.
 * Phase 3 Storm (<30%):    + lightning strikes, storm combo, teleport strikes (up to two in a row).
 *
 * Fairness: every attack has a warning (>= 0.45 s for sword moves, 0.9-1.0 s ground warnings for spells); he only
 * starts an attack through the director (so it can be seen) and, while his spells are live or he is teleporting,
 * he keeps his attack slot and other enemies may not start attacks ("exclusive"); one spell at a time.
 */
export interface BossCtx {
  spells: Spells | null;
  vfx: Vfx | null;
  /** Bring in reinforcements (phase 2): `n` Ash Runners. */
  summon: ((n: number) => void) | null;
  /** Sound cue hook (src/audio). */
  sound: ((name: string, at?: THREE.Vector3) => void) | null;
  /** Camera shake (meteor landing). */
  shake?: ((amount: number, time: number) => void) | null;
}

type Action = 'combo' | 'lunge' | 'cleave' | 'stepslash' | 'flamecut' | 'firewave' | 'fireballs' | 'lightning' | 'storm' | 'teleport'
  | 'inferno' | 'meteor' | 'thunderstep' | 'wrath' | 'tempest';
/** power: one of the five unleashed powers (all of them in the valley realm; from phase 2/3 back in the temple). */
interface ActionDef { phase: 1 | 2 | 3; range: [number, number]; cd: number; w: number; magic?: boolean; power?: boolean; move: string }
const ACTIONS: Record<Action, ActionDef> = {
  combo: { phase: 1, range: [0, 1.9], cd: 3.5, w: 3, move: 'combo' },
  lunge: { phase: 1, range: [2.4, 4.2], cd: 4.5, w: 2, move: 'lunge' },
  cleave: { phase: 1, range: [0, 2.0], cd: 5.5, w: 2, move: 'cleave' },
  stepslash: { phase: 1, range: [0, 3.2], cd: 8, w: 1.2, move: 'roll' },
  flamecut: { phase: 2, range: [0, 2.0], cd: 5, w: 2.2, move: 'flamecut' },
  firewave: { phase: 2, range: [0, 5.5], cd: 9, w: 2, magic: true, move: 'plunge' },
  fireballs: { phase: 2, range: [3, 13], cd: 7, w: 2.6, magic: true, move: 'palm' },
  lightning: { phase: 3, range: [0, 14], cd: 9, w: 2.6, magic: true, move: 'raise' },
  storm: { phase: 3, range: [0, 1.9], cd: 5, w: 2.6, move: 'storm' },
  teleport: { phase: 3, range: [2.2, 14], cd: 7, w: 2.2, magic: true, move: 'tpstrike' },
  // The five unleashed powers.
  inferno: { phase: 2, range: [2.5, 18], cd: 11, w: 2.2, magic: true, power: true, move: 'inferno' },
  meteor: { phase: 2, range: [3.5, 22], cd: 13, w: 2.0, magic: true, power: true, move: 'leap' },
  thunderstep: { phase: 3, range: [0, 22], cd: 12, w: 2.0, magic: true, power: true, move: 'tpstrike' },
  wrath: { phase: 3, range: [0, 22], cd: 14, w: 1.8, magic: true, power: true, move: 'wrath' },
  tempest: { phase: 2, range: [2, 9], cd: 10, w: 2.2, magic: true, power: true, move: 'tempest' },
};
/** Engage timeout: if he can't get into range for a sword move in this long, he picks again. */
const ENGAGE_MAX = 2.5;
const VANISH = 0.45;

export class WardenBrain extends EnemyBrain {
  phase: 1 | 2 | 3 = 1;
  ctx: BossCtx = { spells: null, vfx: null, summon: null, sound: null };
  /** Last action chosen and the per-action cooldowns (tests read these). */
  lastAction: Action | null = null;
  readonly actionLog: [number, Action, number][] = [];
  private sys: CombatSystem | null = null;
  private cool: Partial<Record<Action, number>> = {};
  private action: Action | null = null;
  private fired = new Set<string>();
  private aims: THREE.Vector3[] = [];
  private decideIn = 1.2;
  private summoned = false;
  private chain = 0;
  private holdingSlot = false;
  private rollFrom = new THREE.Vector3(); private rollTo = new THREE.Vector3();
  private now = 0;
  private lastSeen = new THREE.Vector3();
  private stopWarn: (() => void) | null = null;
  /**
   * The valley realm: every power is open regardless of phase, he decides faster and uses the powers far more; the
   * phase changes wait until he is back in the temple.
   */
  unleashed = false;
  private thunder = false;
  private meteorFall = false;
  private aimDir = new THREE.Vector3(0, 0, 1);
  private dashFrom = new THREE.Vector3(); private dashTo = new THREE.Vector3();
  private blinkCool = 3;

  constructor(...args: ConstructorParameters<typeof EnemyBrain>) {
    super(...args);
    // A swordsman, quicker on his feet than an Iron Breaker; holds 1.4-2.0 m with the katana.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this as any).p = { ...this.p, walk: 1.5, jog: 5.4, turn: 6, hold: [1.4, 2.0] };
    this.dodgeCool = 1e9; // never uses the Runner's reactive dodge/parry
  }
  bindSystem(s: CombatSystem) { this.sys = s; }
  get hpFrac() { const v = this.sys?.vitals.get(this); return v ? v.hp / HEALTH.warden : 1; }
  override get invulnerable() { return this.state === 'vanish' || this.state === 'transition' || this.dead; }
  protected override tellOf(name: string) { const t = WARDEN_TELL[name] ?? { tell: 0.45, glint: 'pale' as const }; return { tell: t.tell, unparryable: t.glint !== 'pale' }; }
  protected override beginTell() {
    super.beginTell();
    // Attacks play at their authored speed (walking sets a locomotion rate on the enemy that would otherwise carry over).
    this.e.rate = 1;
    const g = WARDEN_TELL[this.attack!]?.glint ?? 'pale';
    (this.cue.material as THREE.SpriteMaterial).color.set(GLINT_COLOR[g]);
    this.fired.clear();
    this.onTell(this.attack!);
  }
  override revive(pos: THREE.Vector3, yaw: number) {
    super.revive(pos, yaw);
    this.phase = 1; this.summoned = false; this.cool = {}; this.action = null; this.chain = 0; this.decideIn = 1.2;
    this.thunder = false; this.meteorFall = false; this.blinkCool = 3; this.airY = 0; this.airV = 0;
    this.e.object.visible = true; this.endExclusive(); this.ctx.spells?.clear();
  }
  override kill(from?: THREE.Vector3) { super.kill(from); this.endExclusive(); this.stopWarn?.(); }

  /** Locomotion: he walks while holding his line and sprints to close distance (Sprint_Loop). */
  protected override loco(sp: number, idleMove: string): [string, number] {
    if (sp < 0.2) return [idleMove, 1];
    if (sp > 2.6) return ['jog', THREE.MathUtils.clamp(sp / 3.4, 0.8, 1.7)];
    return ['walk', sp / this.p.nativeWalk];
  }
  /** Put him somewhere else at once (the valley realm transition). */
  relocate(p: THREE.Vector3, yaw: number) {
    this.ctx.spells?.clear(); this.stopWarn?.();
    this.e.pivot.position.set(0, 0, 0); this.e.pivot.rotation.y = 0;
    this.airY = 0; this.airV = 0; this.knockVel.set(0, 0, 0); this.meteorFall = false; this.thunder = false; this.chain = 0;
    this.pos.set(p.x, this.world.height(p.x, p.z), p.z); this.e.object.rotation.y = yaw; this.e.object.visible = true;
    this.cue.visible = false; this.attack = null; this.action = null; this.endExclusive();
    this.e.play('guard' as never, 0); this.set('hold'); this.decideIn = 1.0;
  }

  // ------------------------------------------------------------------ per frame
  override update(dt: number, now: number, player: PlayerView, others: EnemyBrain[]) {
    this.now = now; this.stateT += dt;
    for (const k of Object.keys(this.cool) as Action[]) this.cool[k] = Math.max(0, (this.cool[k] ?? 0) - dt * (this.unleashed ? 1.5 : 1));
    this.blinkCool -= dt;
    const me = this.effective(), toP = player.position.clone().sub(me).setY(0), dist = toP.length(), facePlayer = Math.atan2(toP.x, toP.z);
    let want = new THREE.Vector3(), face: number | null = facePlayer;
    const spellsLive = this.ctx.spells?.active(this) ?? 0;

    // Phase changes happen between attacks.
    if (!this.unleashed && ['approach', 'hold', 'engage', 'reposition'].includes(this.state)) {
      const f = this.hpFrac;
      if (this.phase === 1 && f <= BOSS.phase2) return this.startTransition(2, player, others, dt);
      if (this.phase === 2 && f <= BOSS.phase3) return this.startTransition(3, player, others, dt);
    }
    // While any of his hazards is live (spells, the flame-line strip) no other enemy may start an attack; he keeps his
    // attack slot until they're done.
    if (spellsLive > 0 && !this.dead) this.director.exclusive = this.id;
    if (this.holdingSlot && spellsLive === 0 && !['tell', 'attack', 'vanish'].includes(this.state)) this.endExclusive();
    else if (!this.holdingSlot && spellsLive === 0 && this.director.exclusive === this.id && this.state !== 'vanish') this.director.exclusive = null;

    switch (this.state) {
      case 'approach': case 'hold': {
        want = this.holdLine(me, player, dist);
        if (dist > 6) want = toP.clone().normalize().multiplyScalar(this.p.jog);
        if (this.state === 'approach' && dist <= 2.6) this.set('hold');
        this.decideIn -= dt;
        if (this.decideIn <= 0) this.choose(dist, player, now);
        break;
      }
      case 'engage': {
        const d = ACTIONS[this.action!];
        if (dist > d.range[1]) {
          // Far away he sprints, or blinks in through smoke.
          want = toP.clone().normalize().multiplyScalar(dist > 4.5 ? this.p.jog : this.p.walk * 1.4);
          if (dist > 7.5 && this.blinkCool <= 0) this.blink(player);
        }
        else if (dist < d.range[0]) want = toP.clone().normalize().multiplyScalar(-this.p.walk);
        else this.startAction(this.action!, player, now);
        if (this.state === 'engage' && this.stateT > ENGAGE_MAX) { this.action = null; this.set('hold'); this.decideIn = 0.3; }
        break;
      }
      case 'tell':
        face = this.attack === 'tpstrike' || this.attack === 'stepslash' || this.attack === 'wrath' ? facePlayer
          : this.attack === 'inferno' || this.attack === 'tempest' ? Math.atan2(this.aimDir.x, this.aimDir.z)
          : (this.stateT < 0.25 ? facePlayer : null);
        this.updateCue(now);
        if (this.stateT >= this.tellOf(this.attack!).tell) { this.cue.visible = false; this.e.frozen = false; this.set('attack'); }
        break;
      case 'attack':
        face = this.e.move === 'roll' || this.e.move === 'palm' || this.e.move === 'raise' || this.e.move === 'wrath' ? facePlayer : null;
        this.events(player, me);
        if (this.e.move !== this.attack) this.attackEnded(player, now);
        break;
      case 'vanish':
        face = null;
        // Meteor Fall: he stays hidden in the sky until the meteor lands (the spell brings him back).
        if (!this.meteorFall && this.stateT >= (this.thunder ? 0.55 : VANISH)) this.reappear(player, now);
        break;
      case 'transition':
        face = null;
        this.transitionEvents(me);
        if (this.e.move !== 'plunge') { this.set('hold'); this.decideIn = 0.6; }
        break;
      case 'reposition':
        if (this.stateT > 0.7) { this.set('hold'); }
        break;
      case 'flinch': case 'stagger': case 'dodge': case 'parry':
        face = null; this.cue.visible = false;
        if (this.e.move === 'idle' || this.e.move === 'guard') { this.e.rate = 1; this.set('reposition'); }
        break;
      case 'dead':
        face = null; this.deadT += dt;
        if (this.deadT > 8) { this.e.object.position.y -= dt * 0.6; if (this.deadT > 10) { this.removed = true; this.e.object.visible = false; } }
        break;
    }

    const busy = ['tell', 'attack', 'dodge', 'parry', 'flinch', 'stagger', 'dead', 'vanish', 'transition'].includes(this.state);
    if (!busy) { want.add(this.separation(me, others)); this.move(want, dt, player, 'guard'); }
    if (face !== null && !['dead', 'flinch', 'stagger', 'vanish'].includes(this.state)) this.turnTo(face, dt);
    if (this.state === 'attack' && this.e.move === 'roll') this.driveRoll();
    if (this.state === 'attack' && this.e.move === 'tempest') this.driveTempest(dt);
    if (this.state !== 'vanish') this.applyPull(dt); else this.pullVel.set(0, 0, 0);
    this.e.groundY = this.world.height(this.pos.x, this.pos.z);
    this.e.update(dt);
    if (this.state !== 'vanish') this.constrain(player, others);
    this.unstick(dt, busy);
  }

  // ------------------------------------------------------------------ decisions
  private choose(dist: number, player: PlayerView, now: number) {
    this.decideIn = this.unleashed ? THREE.MathUtils.lerp(0.25, 0.6, this.rnd()) : THREE.MathUtils.lerp(0.6, 1.2, this.rnd());
    const spellsLive = (this.ctx.spells?.active(this) ?? 0) > 0;
    const cands = (Object.keys(ACTIONS) as Action[]).filter((a) => {
      const d = ACTIONS[a];
      if ((d.phase > this.phase && !this.unleashed) || (this.cool[a] ?? 0) > 0 || a === this.lastAction) return false;
      if (d.magic && spellsLive) return false;                      // one spell at a time
      return true;
    });
    if (!cands.length) return;
    // Weights: in-range moves are favoured; far away he prefers ranged pressure; later phases lean on new moves.
    const weight = (a: Action) => {
      const d = ACTIONS[a]; let w = d.w;
      if (dist >= d.range[0] && dist <= d.range[1]) w *= 2.2; else if (!d.magic) w *= dist > d.range[1] + 3 ? 0.2 : 0.7;
      if (d.phase === this.phase && this.phase > 1) w *= 1.6;
      if (dist > 6 && d.magic) w *= 1.8;
      if (d.power) w *= this.unleashed ? 3.2 : 1.3;
      // Rotation: each use among his last four actions makes a move less likely, so the fight keeps changing.
      const recent = this.actionLog.slice(-4).filter((x) => x[1] === a).length;
      return w * Math.pow(0.4, recent);
    };
    const total = cands.reduce((s, a) => s + weight(a), 0);
    let r = this.rnd() * total, pick = cands[0];
    for (const a of cands) { r -= weight(a); if (r <= 0) { pick = a; break; } }
    this.action = pick;
    const d = ACTIONS[pick];
    if (dist >= d.range[0] && dist <= d.range[1]) this.startAction(pick, player, now);
    else this.set('engage');
  }
  private startAction(a: Action, player: PlayerView, now: number) {
    const d = ACTIONS[a];
    // He needs the attack slot (director: max 2 attackers, 1 heavy, 0.6 s apart, warning visible to the player).
    if (!this.director.tryStart(this.id, 'breaker', now, this.tellPoints())) {
      // Out of the player's view (behind them): he blinks round in front instead of waiting there.
      if (this.blinkCool <= 0 && !this.director.exclusive && !this.director.canSee(this.id, this.tellPoints())) this.blink(player, true);
      this.set('hold'); this.decideIn = 0.4; return;
    }
    this.holdingSlot = true;
    if (d.magic) this.director.exclusive = this.id;
    this.cool[a] = d.cd; this.lastAction = a; this.actionLog.push([+now.toFixed(2), a, this.phase]);
    this.chain = a === 'thunderstep' ? 2 : a === 'teleport' && this.phase === 3 ? (this.rnd() < 0.5 ? 1 : 0) : 0;
    this.thunder = a === 'thunderstep';
    this.aimDir.copy(player.position).sub(this.effective()).setY(0); if (this.aimDir.lengthSq() < 1e-4) this.aimDir.copy(this.forward()); this.aimDir.normalize();
    if (a === 'teleport' || a === 'thunderstep') return this.vanish(player);
    this.lastSeen.copy(player.position);
    if (a === 'tempest') {
      const me = this.effective(), len = THREE.MathUtils.clamp(player.position.distanceTo(me) + 3, 5, 11);
      this.dashFrom.copy(me); this.dashTo.copy(me).addScaledVector(this.aimDir, len);
      [this.dashTo.x, this.dashTo.z] = this.world.resolve(this.dashTo.x, this.dashTo.z, this.world.height(this.dashTo.x, this.dashTo.z), this.p.radius);
    }
    if (a === 'stepslash') return this.startRoll(player);
    this.attack = d.move; this.beginTell();
  }
  /** Spell warnings that start with the tell. */
  private onTell(move: string) {
    const sp = this.ctx.spells; if (!sp) return;
    const me = this.effective(), fwd = this.forward();
    if (move === 'plunge') this.stopWarn = sp.warnCircle(me.clone().addScaledVector(fwd, 1.0), 7, FX_COLORS.fire, this.tellOf('plunge').tell + 0.63);
    // Inferno Wave: its whole path is marked on the ground before the wall leaves the blade.
    if (move === 'inferno') this.stopWarn = sp.infernoWarn(me.clone().addScaledVector(this.aimDir, 1.2), this.aimDir, this.tellOf('inferno').tell + 0.84);
    // Blade Tempest: the dash line.
    if (move === 'tempest') {
      sp.warnLine(me, this.dashTo, this.tellOf('tempest').tell + 0.2);
    }
    if (move === 'inferno' || move === 'leap' || move === 'tempest') this.ctx.vfx?.burst('fire_02', me.clone().setY(me.y + 1), { count: 10, color: FX_COLORS.fire, life: 0.5, size: 0.9, size1: 0.2, speed: 2, up: 2 });
    this.ctx.sound?.(move === 'raise' || move === 'wrath' ? 'stormCall' : move === 'plunge' || move === 'palm' || move === 'inferno' || move === 'leap' ? 'fireCharge' : 'tell', me);
  }
  /** Timed events inside an attack: spells, mid-move warnings. */
  private events(player: PlayerView, me: THREE.Vector3) {
    const t = this.e.time, mv = this.e.move, sp = this.ctx.spells, fwd = this.forward();
    const once = (k: string, at: number, fn: () => void) => { if (t >= at && !this.fired.has(k)) { this.fired.add(k); fn(); } };
    const hand = () => this.e.chest().addScaledVector(fwd, 0.6).add(new THREE.Vector3(0, -0.05, 0));
    switch (mv) {
      case 'plunge':
        once('wave', 0.63, () => { this.stopWarn?.(); sp?.fireWave(this, me.clone().addScaledVector(fwd, 1.0)); this.ctx.sound?.('fireWave', me); });
        break;
      case 'palm':
        for (let i = 0; i < 3; i++) {
          once(`aim${i}`, 0.15 + 0.25 * i, () => { this.aims[i] = player.position.clone(); sp?.warnLine(hand(), this.aims[i].clone().addScaledVector(this.aims[i].clone().sub(me).setY(0).normalize(), 2), 0.42); });
          once(`orb${i}`, 0.55 + 0.25 * i, () => { sp?.fireball(this, hand(), this.aims[i]); this.ctx.sound?.('fireball', me); });
        }
        if (t < 1.2 && Math.random() < 0.6) this.ctx.vfx?.flame(hand(), 0.45, 1);
        break;
      case 'raise':
        for (let i = 0; i < 3; i++) once(`bolt${i}`, 0.25 + 0.45 * i, () => { sp?.lightning(this, player.position.clone()); this.ctx.sound?.('stormMark', player.position); });
        if (Math.random() < 0.5) this.ctx.vfx?.spawn('spark_01', this.e.weapons()[0].tip, { color: FX_COLORS.storm, life: 0.15, size: 0.5 });
        break;
      case 'flamecut':
        once('line', 0.27, () => { sp?.flameLine(this, me, fwd); this.ctx.sound?.('flame', me); });
        break;
      case 'inferno':
        if (t < 0.84 && Math.random() < 0.7) this.ctx.vfx?.flame(this.e.weapons()[0].tip, 0.7, 1.2);
        once('wall', 0.84, () => { this.stopWarn?.(); sp?.infernoWave(this, me.clone().addScaledVector(this.aimDir, 1.2), this.aimDir); this.ctx.sound?.('fireWave', me); });
        break;
      case 'leap':
        // Up into the sky; at the top he bursts into fire and is gone until the meteor lands.
        once('jump', 0.1, () => { this.launch(13); this.ctx.sound?.('whoosh', me); this.ctx.vfx?.burst('smoke_04', me.clone().setY(me.y + 0.1), { count: 10, color: FX_COLORS.dust, life: 0.7, size: 0.8, size1: 2, speed: 4, up: 0.3, alpha: 0.5, drag: 3, normal: true, flat: true }); });
        if (this.airY > 0.3 && Math.random() < 0.8) this.ctx.vfx?.flame(this.e.chest(), 1.0, 1);
        once('gone', 0.5, () => {
          const target = player.position.clone();
          this.ctx.vfx?.burst('fire_02', this.e.chest(), { count: 18, color: FX_COLORS.fire, life: 0.5, size: 1.4, size1: 0.3, speed: 5, up: 1 });
          this.e.object.visible = false; this.cue.visible = false; this.airY = 0; this.airV = 0;
          this.meteorFall = true; this.set('vanish'); this.director.exclusive = this.id; this.holdingSlot = true;
          sp?.meteor(this, target, (c) => this.meteorLand(c, player));
          if (!sp) this.meteorLand(target, player);
        });
        break;
      case 'wrath':
        // Lightning chases the player: a strike every 0.3 s where they are heading; the sky flickers around him.
        for (let i = 0; i < 9; i++) once(`w${i}`, 0.3 + 0.3 * i, () => {
          const lead = player.position.clone().sub(this.lastSeen).multiplyScalar(i ? 2.2 : 0);
          sp?.wrathBolt(this, player.position.clone().add(lead.clampLength(0, 2.2)));
          this.lastSeen.copy(player.position);
        });
        if (Math.random() < 0.12) {
          const a = Math.random() * Math.PI * 2, r = 6 + Math.random() * 10, q = me.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
          q.y = this.world.height(q.x, q.z); this.ctx.vfx?.bolt(q, 18, 1.2);
        }
        if (Math.random() < 0.5) this.ctx.vfx?.spawn('spark_01', this.e.weapons()[0].tip, { color: FX_COLORS.storm, life: 0.15, size: 0.6 });
        break;
      case 'tempest':
        once('whirl', 0.1, () => { sp?.tempest(this, () => this.effective(), () => this.state === 'attack' && this.e.move === 'tempest' && this.e.time < 1.42); this.ctx.sound?.('whoosh', me); });
        for (let i = 0; i < 3; i++) once(`tor${i}`, 0.45 + 0.4 * i, () => sp?.tornado(this, this.effective(), 0.1));
        break;
      case 'storm': {
        // The second hit can't be parried: a red warning 0.5 s before it lands; violet sparks along the blade.
        const show = t >= 0.7 && t < 1.13;
        this.cue.visible = show;
        if (show) { (this.cue.material as THREE.SpriteMaterial).color.set(GLINT_COLOR.red); this.cue.position.copy(this.e.chest().add(new THREE.Vector3(0, 0.45, 0))); this.cue.scale.setScalar(0.42); }
        once('redcue', 0.7, () => this.ctx.sound?.('tell', me));
        if (Math.random() < 0.6) this.ctx.vfx?.spawn('spark_01', this.e.weapons()[0].tip, { color: FX_COLORS.storm, life: 0.12, size: 0.35 });
        break;
      }
    }
  }
  private attackEnded(player: PlayerView, now: number) {
    this.cue.visible = false;
    if (this.attack === 'roll') { this.attack = 'stepslash'; this.beginTell(); return; }   // roll → slash
    if (this.attack === 'tpstrike' && this.chain > 0) { this.chain--; this.vanish(player); return; } // teleport again
    this.thunder = false;
    this.attack = null; this.action = null;
    if ((this.ctx.spells?.active(this) ?? 0) === 0) this.endExclusive();
    this.set('reposition'); this.decideIn = THREE.MathUtils.lerp(0.5, 1.0, this.rnd());
    void player; void now;
  }
  private endExclusive() {
    this.director.release(this.id); this.holdingSlot = false;
    if (this.director.exclusive === this.id) this.director.exclusive = null;
  }

  // ------------------------------------------------------------------ movement moves
  private forward() { const y = this.e.object.rotation.y + this.e.pivot.rotation.y; return new THREE.Vector3(Math.sin(y), 0, Math.cos(y)); }
  /** Side-step roll to the player's flank, then the slash (with its own warning). */
  private startRoll(player: PlayerView) {
    const pf = new THREE.Vector3(Math.sin(player.facing), 0, Math.cos(player.facing)), right = new THREE.Vector3(pf.z, 0, -pf.x);
    const side = this.rnd() < 0.5 ? 1 : -1;
    const to = player.position.clone().addScaledVector(right, side * 1.7).addScaledVector(pf, -0.4);
    [to.x, to.z] = this.world.resolve(to.x, to.z, this.world.height(to.x, to.z), this.p.radius);
    this.rollFrom.copy(this.pos); this.rollTo.copy(to);
    this.attack = 'roll'; this.e.play('roll' as never, 0.08); this.e.rate = 1; this.set('attack'); this.fired.clear();
    this.e.object.rotation.y = Math.atan2(to.x - this.pos.x, to.z - this.pos.z);
    this.ctx.sound?.('whoosh', this.pos);
  }
  private driveRoll() {
    const k = THREE.MathUtils.smoothstep(this.e.time, 0.05, 0.6);
    const p = this.rollFrom.clone().lerp(this.rollTo, k);
    [p.x, p.z] = this.world.resolve(p.x, p.z, this.world.height(p.x, p.z), this.p.radius);
    this.pos.x = p.x; this.pos.z = p.z;
  }
  /** Blade Tempest: the whirling dash along the marked line (0.1-1.4 s), spinning. */
  private driveTempest(dt: number) {
    const t = this.e.time;
    if (t > 1.42) return;
    const k = THREE.MathUtils.smoothstep(t, 0.1, 1.4);
    const p = this.dashFrom.clone().lerp(this.dashTo, k);
    [p.x, p.z] = this.world.resolve(p.x, p.z, this.world.height(p.x, p.z), this.p.radius);
    this.pos.x = p.x; this.pos.z = p.z;
    if (t > 0.1) this.e.object.rotation.y += dt * 13;
  }
  /** Meteor Fall: he lands where the meteor struck, crouched (open to punishment). */
  private meteorLand(c: THREE.Vector3, player: PlayerView) {
    if (this.dead) return;
    this.meteorFall = false;
    this.e.pivot.position.set(0, 0, 0); this.e.pivot.rotation.y = 0;
    this.pos.set(c.x, this.world.height(c.x, c.z), c.z);
    this.e.object.rotation.y = Math.atan2(player.position.x - c.x, player.position.z - c.z);
    this.e.object.visible = true;
    this.attack = 'land'; this.e.play('land' as never, 0.05); this.e.rate = 1; this.set('attack'); this.fired.clear();
    this.ctx.shake?.(0.25, 0.5);
  }
  /** Blink: a short teleport through smoke to close distance (not an attack). */
  private blink(player: PlayerView, front = false) {
    this.blinkCool = this.unleashed ? 2.5 : 5;
    const toMe = front ? new THREE.Vector3(Math.sin(player.facing), 0, Math.cos(player.facing)) : this.pos.clone().sub(player.position).setY(0).normalize();
    const side = new THREE.Vector3(toMe.z, 0, -toMe.x);
    const p = player.position.clone().addScaledVector(toMe, 3.2).addScaledVector(side, (this.rnd() - 0.5) * 3);
    [p.x, p.z] = this.world.resolve(p.x, p.z, this.world.height(p.x, p.z), this.p.radius);
    this.ctx.vfx?.puff(this.pos, false); this.ctx.sound?.('vanish', this.pos);
    this.pos.set(p.x, this.world.height(p.x, p.z), p.z);
    this.e.object.rotation.y = Math.atan2(player.position.x - p.x, player.position.z - p.z);
    this.ctx.vfx?.puff(this.pos, true);
  }
  /** Teleport: vanish in smoke and sparks, untouchable for 0.45 s. Thunder Step: lightning is called on the player first. */
  private vanish(player?: PlayerView) {
    if (this.thunder && player) this.ctx.spells?.wrathBolt(this, player.position.clone(), 0.55, 1.7, 'warden.thunder');
    this.ctx.vfx?.puff(this.pos, false); this.ctx.sound?.('vanish', this.pos);
    this.e.object.visible = false; this.cue.visible = false; this.set('vanish');
    this.director.exclusive = this.id; this.holdingSlot = true;
  }
  /** Reappear behind or beside the player (never in front of the camera's blind spot), then strike after 0.45 s. */
  private reappear(player: PlayerView, now: number) {
    const pf = new THREE.Vector3(Math.sin(player.facing), 0, Math.cos(player.facing)), right = new THREE.Vector3(pf.z, 0, -pf.x);
    const opts = [pf.clone().multiplyScalar(-1.6), right.clone().multiplyScalar(1.6), right.clone().multiplyScalar(-1.6)];
    const o = opts[Math.floor(this.rnd() * opts.length)];
    const p = player.position.clone().add(o);
    [p.x, p.z] = this.world.resolve(p.x, p.z, this.world.height(p.x, p.z), this.p.radius);
    this.e.pivot.position.set(0, 0, 0); this.e.pivot.rotation.y = 0;
    this.pos.set(p.x, this.world.height(p.x, p.z), p.z);
    this.e.object.rotation.y = Math.atan2(player.position.x - p.x, player.position.z - p.z);
    this.e.object.visible = true;
    this.ctx.vfx?.puff(this.pos, true); this.ctx.sound?.('appear', this.pos);
    if (this.thunder) this.ctx.vfx?.bolt(this.pos.clone(), 12, 1.0);
    this.attack = 'tpstrike'; this.beginTell();
    void now;
  }

  // ------------------------------------------------------------------ phases
  private startTransition(to: 2 | 3, player: PlayerView, others: EnemyBrain[], dt: number) {
    this.phase = to; this.endExclusive(); this.cue.visible = false; this.action = null; this.lastAction = null;
    this.attack = 'plunge'; this.e.play('plunge' as never, 0.15); this.e.rate = 1; this.set('transition'); this.fired.clear();
    this.ctx.sound?.('roar', this.pos);
    this.e.groundY = this.world.height(this.pos.x, this.pos.z);
    this.e.update(dt); this.constrain(player, others);
  }
  private transitionEvents(me: THREE.Vector3) {
    if (this.e.time >= 0.63 && !this.fired.has('shock')) {
      this.fired.add('shock');
      const col = this.phase === 2 ? FX_COLORS.fire : FX_COLORS.storm;
      this.ctx.spells?.shockwave(this, me, col);
      if (this.phase === 2) this.ctx.vfx?.burst('fire_02', me.clone().setY(me.y + 0.5), { count: 22, color: FX_COLORS.fire, life: 0.7, size: 1.4, size1: 0.3, speed: 4, up: 2.5 });
      else this.ctx.vfx?.bolt(me.clone().add(new THREE.Vector3(0.6, 0, 0.6)));
      this.ctx.sound?.(this.phase === 2 ? 'fireWave' : 'thunder', me);
      if (this.phase === 2 && !this.summoned) { this.summoned = true; this.ctx.summon?.(2); }
    }
  }
}
