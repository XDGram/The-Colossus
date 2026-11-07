import * as THREE from 'three';
import type { CombatArena } from './arena';
import type { CombatSystem } from './system';
import type { EnemyBrain } from './brain';
import type { PlayerCombat } from '../player/combat';
import type { Player } from '../player/player';
import { BOSS, HEALTH } from './tables';
import type { WardenBrain } from '../boss/warden';

const FX_DUST = new THREE.Color(0.62, 0.56, 0.48), FX_GRIT = new THREE.Color(0.35, 0.3, 0.24);

/**
 * The temple fight (MVP): the Temple Warden confronts the player, then sends two waves
 * (two Ash Runners; an Iron Breaker and an Ash Runner) before fighting himself. Includes the minimal
 * HUD (player health, damaged enemies' health, the Warden's health and stagger meter), captions, and the
 * defeat (retry) and victory screens. Combat rules are the existing ones.
 */
type Phase = 'intro' | 'wave1' | 'wave2' | 'wave3' | 'warden' | 'victory' | 'defeat';

const CSS = `
#hud { position: fixed; inset: 0; pointer-events: none; font-family: Inter, system-ui, sans-serif; color: #ece6d8; z-index: 5; }
#hud .pbar { position: absolute; left: max(16px, env(safe-area-inset-left)); top: max(12px, env(safe-area-inset-top)); width: min(22vw, 230px); }
#hud .lbl { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; opacity: 0.85; margin-bottom: 4px; text-shadow: 0 1px 2px #000; }
#hud .track { margin: 0; width: auto; height: 9px; background: rgba(10,10,10,0.55); border: 1px solid rgba(236,230,216,0.35); border-radius: 2px; overflow: hidden; }
#hud .fill { height: 100%; background: linear-gradient(#c9a35b, #9a7a3c); transition: width 0.15s; }
#hud .fill.red { background: linear-gradient(#b8463a, #7d2a22); }
#hud .fill.meter { background: linear-gradient(#e9dcc0, #b9ab8c); }
#hud .ebar { position: absolute; width: 64px; height: 5px; margin-left: -32px; background: rgba(10,10,10,0.6); border: 1px solid rgba(236,230,216,0.3); }
#hud .ebar > div { height: 100%; background: #b8463a; }
/* Boss bar: across the top of the screen, out of the way of the fight and the touch controls. */
#hud .boss { position: absolute; left: 50%; transform: translateX(-50%); top: max(12px, env(safe-area-inset-top)); width: min(40vw, 460px); display: none; text-align: center; }
#hud .boss .lbl { margin-bottom: 3px; }
#hud .boss .track { height: 7px; margin-bottom: 3px; }
#hud .boss .meter { height: 4px; }
#hud .cap { position: absolute; left: 50%; top: 22%; transform: translateX(-50%); max-width: 80vw; text-align: center; font-family: Georgia, serif; font-size: clamp(16px, 2.4vw, 24px); text-shadow: 0 2px 6px #000; opacity: 0; transition: opacity 0.4s; }
#hud .cap.show { opacity: 1; }
#hud .cap b { display: block; font-family: Inter, sans-serif; font-size: 11px; letter-spacing: 0.22em; color: #c9a35b; margin-bottom: 6px; }
#cinebars { position: fixed; inset: 0; pointer-events: none; z-index: 6; opacity: 0; transition: opacity 0.6s; }
#cinebars i { position: absolute; left: 0; right: 0; height: 11vh; background: #000; }
#cinebars i:first-child { top: 0; } #cinebars i:last-child { bottom: 0; }
#flash { position: fixed; inset: 0; background: #e8f0ff; opacity: 0; pointer-events: none; z-index: 6; transition: opacity 0.5s ease-out; }
#endscreen { position: fixed; inset: 0; display: none; align-items: center; justify-content: center; flex-direction: column; gap: 18px; background: rgba(6,6,6,0.72); z-index: 20; color: #ece6d8; font-family: Georgia, serif; text-align: center; padding: 16px; }
#endscreen h2 { margin: 0; font-size: clamp(26px, 5vw, 44px); font-weight: normal; letter-spacing: 0.06em; }
#endscreen p { margin: 0; opacity: 0.8; font-size: 15px; }
#endscreen .row { display: flex; gap: 12px; flex-wrap: wrap; justify-content: center; }
#endscreen button, #endscreen a { pointer-events: auto; font: 600 13px Inter, sans-serif; letter-spacing: 0.14em; text-transform: uppercase; color: #ece6d8; background: rgba(201,163,91,0.2); border: 1px solid #c9a35b; padding: 12px 22px; border-radius: 3px; cursor: pointer; text-decoration: none; }
`;

export class TempleEncounter {
  phase: Phase = 'intro';
  private t = 0;
  private warden: EnemyBrain | null = null;
  private wave: EnemyBrain[] = [];
  private hud: HTMLElement;
  private pbar: HTMLElement; private cap: HTMLElement; private boss: HTMLElement; private bossFill: HTMLElement; private meterFill: HTMLElement;
  private end: HTMLElement;
  private ebars = new Map<EnemyBrain, HTMLElement>();
  private capUntil = 0;
  private endAt = -1;
  private wardenUpdate: EnemyBrain['update'] | null = null;
  private bossPhase = 1;
  /**
   * Opening cinematic (set while it plays): the game walks the player in from the gate (`drive`, m/s) and ignores
   * input. Null once the fight has started.
   */
  cinematic: { drive: THREE.Vector3; cam: { pos: THREE.Vector3; look: THREE.Vector3 } | null; blend: number } | null = null;
  /** The sealed main gate (doors swing open in the opening; set by the game). */
  doors: { open(k: number): void; solid(on: boolean): void } | null = null;
  private bars: HTMLElement;
  private lastReal = -1;
  /** Camera shake hook (the thunderclap). */
  onShake: ((amount: number, time: number) => void) | null = null;
  private flash: HTMLElement;
  private introDone = new Set<string>();
  private pre: EnemyBrain[] = [];
  /**
   * The Warden's realm (set by the game): once he closes in, the temple glitches into the valley for a short, brutal
   * exchange of his powers, then glitches back (src/world/realm.ts). Null: the fight stays in the temple.
   */
  realm: {
    preload(): void; build(): void; readonly ready: boolean; readonly active: boolean;
    enter(): { player: THREE.Vector3; boss: THREE.Vector3 } | null; exit(): void;
    glitch(v: number): void; music(valley: boolean): void;
  } | null = null;
  /** Realm timing: in, inside (max REALM_TIME or until his health drops to REALM_HP), out, done. */
  realmStage: 'none' | 'arrive' | 'in' | 'inside' | 'out' | 'done' = 'none';
  private realmT = 0;
  private wardenT = 0;
  static readonly REALM_TIME = 48;
  static readonly REALM_HP = 0.67;
  static readonly GLITCH = { ramp: 1.1, swap: 1.25, end: 2.0 };

  constructor(private arena: CombatArena, private system: CombatSystem, private combat: PlayerCombat, private player: Player,
    private camera: THREE.PerspectiveCamera, private home: { x: number; z: number; yaw: number }, private gate: THREE.Vector3) {
    system.autoRestart = false;
    arena.onSpawn = (b) => system.add(b);
    arena.onClear = (b) => { system.drop(b); this.ebars.get(b)?.remove(); this.ebars.delete(b); };
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    this.hud = document.createElement('div'); this.hud.id = 'hud';
    this.hud.innerHTML = `<div class="pbar"><div class="lbl">Health</div><div class="track"><div class="fill"></div></div></div>
      <div class="cap"></div>
      <div class="boss"><div class="lbl">The Temple Warden</div><div class="track"><div class="fill red"></div></div><div class="track meter"><div class="fill meter" style="width:0"></div></div></div>`;
    this.hud.style.display = 'none'; // shown when the fight starts (not behind the menu)
    document.body.appendChild(this.hud);
    this.pbar = this.hud.querySelector('.pbar .fill')!; this.cap = this.hud.querySelector('.cap')!;
    this.boss = this.hud.querySelector('.boss')!; this.bossFill = this.boss.querySelector('.fill.red')!; this.meterFill = this.boss.querySelector('.fill.meter')!;
    this.end = document.createElement('div'); this.end.id = 'endscreen'; document.body.appendChild(this.end);
    this.flash = document.createElement('div'); this.flash.id = 'flash'; document.body.appendChild(this.flash);
    this.bars = document.createElement('div'); this.bars.id = 'cinebars'; this.bars.innerHTML = '<i></i><i></i>'; document.body.appendChild(this.bars);
    this.startIntro();
  }

  /** Point `n` m inside the gate, `side` m across (the enemies come in through the main gate). */
  private gateSpot(side: number, back = 0) { return this.gate.clone().add(new THREE.Vector3(side, 0, back)); }
  private faceHome(p: THREE.Vector3) { return Math.atan2(this.home.x - p.x, this.home.z - p.z); }

  private caption(who: string, text: string, secs = 4) {
    this.cap.innerHTML = who ? `<b>${who}</b>${text}` : text;
    this.cap.classList.add('show'); this.capUntil = this.t + secs;
  }

  /** Where the player starts the opening: outside the sealed gate, about to walk in through it. */
  static readonly INTRO_START = { x: 0, z: 51.2 };
  /** Where he stops, facing the Warden up the courtyard. */
  static readonly INTRO_STOP = 42.6;
  /** Opening length (s); an attack press after 1.5 s skips ahead to the lightning. */
  static readonly INTRO_END = 9.8;
  private startIntro() {
    this.phase = 'intro'; this.t = 0; this.introDone.clear(); this.pre = [];
    // The Warden waits up the courtyard, facing the gate.
    const p = new THREE.Vector3(0, 0, 31.5);
    this.warden = this.arena.spawn('warden', p, this.faceHome(p));
    this.wardenUpdate = this.warden.update.bind(this.warden);
    const w = this.warden;
    w.update = (dt) => { w.e.update(dt); };
    w.e.play('guard' as never, 0);
    this.system.drop(w); // not a target during the confrontation
    this.player.teleport(TempleEncounter.INTRO_START.x, TempleEncounter.INTRO_START.z); this.player.setFacing(this.home.yaw);
    this.cinematic = { drive: new THREE.Vector3(), cam: null, blend: -1 };
  }
  /** Skip ahead to the lightning (any attack press during the opening, after its first 1.5 s). */
  skipIntro() {
    if (this.phase !== 'intro' || !this.cinematic || this.t < 1.5 || this.t >= 7.3) return;
    this.t = 7.3; this.player.teleport(0, TempleEncounter.INTRO_STOP); this.player.setFacing(this.home.yaw);
    this.doors?.open(0); this.doors?.solid(true); this.introDone.add('doorsShut');
  }
  /**
   * The opening, timed from the moment the fight starts (letterboxed, input off):
   *  A 0–2.6 s   low inside the courtyard looking back at the gate: the doors swing open on the light and the warrior
   *              strides through;
   *  B 2.6–5.0   tracking over his shoulder as he walks toward the Warden, who waits up the courtyard; the doors
   *              boom shut behind him;
   *  C 5.0–7.2   the Warden, close: “This temple is ours now. You should not have returned.”;
   *  D 7.2–9.0   wide across the courtyard: lightning strikes him, he vanishes in smoke, his soldiers burst out of it;
   *  E 9.0–9.8   the camera settles behind the warrior and the fight begins.
   */
  private updateIntro(dt: number) {
    const t = this.t, w = this.warden!, ctx = this.arena.bossCtx, cine = this.cinematic!, P = this.player.position;
    const once = (k: string) => (this.introDone.has(k) ? false : (this.introDone.add(k), true));
    const ease = (x: number) => { const k = THREE.MathUtils.clamp(x, 0, 1); return k * k * (3 - 2 * k); };
    const wp = new THREE.Vector3(0, w.e.object.position.y, 31.5), head = wp.clone().setY(wp.y + 1.62);
    if (once('open')) { this.doors?.solid(false); this.cineBars(true); }
    // Doors: open 0.2–1.7 s, shut 4.9–5.5 s (with a boom), solid again once shut.
    if (!this.introDone.has('doorsShut')) {
      const k = t < 4.9 ? ease((t - 0.2) / 1.5) : 1 - ease((t - 4.9) / 0.6);
      this.doors?.open(k);
      if (t > 1.0 && once('doorSound')) ctx.sound?.('roar', new THREE.Vector3(0, 1, 47.6));
      if (t >= 5.5) { this.introDone.add('doorsShut'); this.doors?.open(0); this.doors?.solid(true); ctx.sound?.('debris', new THREE.Vector3(0, 1, 47.6)); this.onShake?.(0.05, 0.25); }
    }
    // Walk: from 0.6 s, at 1.9 m/s, stopping at INTRO_STOP.
    cine.drive.set(0, 0, t > 0.6 && P.z > TempleEncounter.INTRO_STOP ? -1.9 : 0);
    if (t < 2.6) cine.cam = { pos: new THREE.Vector3(2.4 - t * 0.25, 0.55 + t * 0.05, 41.6), look: new THREE.Vector3(0.3, 2.1 - t * 0.2, 48) };
    else if (t < 5.0) {
      const k = (t - 2.6) / 2.4;
      cine.cam = { pos: new THREE.Vector3(P.x + 0.9 - 0.2 * k, P.y + 1.55, P.z + 2.4 - 0.4 * k), look: head.clone().lerp(new THREE.Vector3(P.x, P.y + 1.4, P.z - 3), 0.15) };
    } else if (t < 7.2) {
      const k = (t - 5.0) / 2.2, toP = new THREE.Vector3(P.x - wp.x, 0, P.z - wp.z).normalize(), side = new THREE.Vector3(toP.z, 0, -toP.x);
      cine.cam = { pos: head.clone().addScaledVector(toP, 2.6 - 0.5 * k).addScaledVector(side, 0.7).add(new THREE.Vector3(0, -0.12, 0)), look: head.clone().add(new THREE.Vector3(0, -0.05, 0)) };
      if (once('speak')) this.caption('THE TEMPLE WARDEN', '“This temple is ours now. You should not have returned.”', 2.4);
    } else if (t < 9.0) {
      const k = (t - 7.2) / 1.8;
      cine.cam = { pos: new THREE.Vector3(-5.2 + 1.2 * k, 4.6 - 0.6 * k, 40.5 - 0.6 * k), look: new THREE.Vector3(0, 1.1, 32.5) };
    } else { cine.cam = null; cine.blend = Math.min(1, (t - 9.0) / 0.8); }
    if (t > 7.5 && once('strike')) {
      // The storm answers him: lightning, a white flash, thunder, smoke.
      ctx.vfx?.bolt(wp, 22, 2.6); ctx.vfx?.bolt(wp.clone().add(new THREE.Vector3(0.5, 0, 0.3)), 20, 1.8);
      ctx.vfx?.bolt(wp.clone().add(new THREE.Vector3(-0.6, 0, -0.2)), 18, 1.4);
      ctx.vfx?.spawn('star_06', wp.clone().setY(wp.y + 1.2), { color: new THREE.Color(0.93, 0.88, 1.0), life: 0.35, size: 7, size1: 2, alpha: 1, rot: 0 });
      ctx.vfx?.burst('smoke_07', wp.clone().setY(wp.y + 0.6), { count: 14, color: new THREE.Color(0.1, 0.08, 0.12), life: 1.4, size: 1.6, size1: 3.4, speed: 3, up: 0.6, alpha: 0.9, drag: 2 });
      ctx.sound?.('thunder', wp); this.flashScreen(); this.onShake?.(0.12, 0.5);
    }
    if (t > 7.65 && once('vanish')) {
      ctx.vfx?.puff(wp, false); ctx.sound?.('vanish', wp);
      w.e.object.visible = false; w.e.object.position.y -= 50; w.update = () => {};
    }
    for (let i = 0; i < 3; i++) if (t > 7.95 + i * 0.32 && once(`summon${i}`)) {
      const a = (i - 1) * 0.9, q = wp.clone().add(new THREE.Vector3(Math.sin(a) * 2.2, 0, Math.cos(a) * 2.2 + 1.2));
      const b = this.arena.spawn('runner', q, this.faceHome(q));
      ctx.vfx?.puff(b.e.object.position, true); ctx.sound?.('appear', q);
      this.pre.push(b);
      // They hold until the fight begins.
      const up = b.update.bind(b); b.update = (d, ...r) => (this.cinematic ? b.e.update(d) : up(d, ...r));
    }
    void dt;
    if (t >= TempleEncounter.INTRO_END) {
      this.cinematic = null; this.cineBars(false);
      if (!this.introDone.has('doorsShut')) { this.doors?.open(0); this.doors?.solid(true); }
      this.startWave(1);
    }
  }
  /** The opening plays full screen (no letterbox): only the HUD is hidden while it runs. */
  private cineBars(on: boolean) {
    this.hud.style.visibility = on ? 'hidden' : 'visible';
  }
  private flashScreen(big = false) {
    this.flash.style.transition = 'none'; this.flash.style.opacity = big ? '1' : '0.85';
    requestAnimationFrame(() => { this.flash.style.transition = `opacity ${big ? 1.1 : 0.6}s ease-out`; this.flash.style.opacity = '0'; });
  }
  /** Spawn points: the main gate, and the covered corridors on both sides of the courtyard (enemies come out of the buildings). */
  private spots = {
    // 'gate' now means the main hall at the far end of the courtyard (the player came in through the sealed gate).
    gate: (i: number) => new THREE.Vector3((i % 3 - 1) * 3, 0, -14 - (i % 2) * 2),
    left: (i: number) => new THREE.Vector3(-30, 0, [24, 8, 16, 0][i % 4]),
    right: (i: number) => new THREE.Vector3(30, 0, [24, 8, 16, 0][i % 4]),
  };
  private queue: { kind: 'runner' | 'breaker'; at: 'gate' | 'left' | 'right' }[] = [];
  private nextSpawn = 0;
  private spawned = 0;
  private spawnWave(list: { kind: 'runner' | 'breaker'; at: 'gate' | 'left' | 'right' }[]) {
    // Soldiers summoned in the opening count toward the first wave (the queue sends that many fewer Runners).
    this.wave = [...this.pre]; this.queue = [...list]; this.nextSpawn = this.t; this.spawned = 0;
    for (let n = this.pre.length; n > 0; n--) { const i = this.queue.findIndex((q) => q.kind === 'runner'); if (i >= 0) this.queue.splice(i, 1); }
    this.pre = [];
  }
  /** Enemies arrive one at a time (every 1.2 s), so the assault streams in. */
  private trickle() {
    if (!this.queue.length || this.t < this.nextSpawn) return;
    // Phones: at most 5 enemies on the field at once (the rest arrive as others fall) to keep the frame rate playable.
    const touch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
    if (touch && this.wave.filter((b) => !b.dead).length >= 5) return;
    const q = this.queue.shift()!; this.nextSpawn = this.t + 0.8;
    const p = this.spots[q.at](this.spawned++);
    this.wave.push(this.arena.spawn(q.kind, p, this.faceHome(p)));
  }
  private startWave(n: 1 | 2 | 3) {
    this.phase = n === 1 ? 'wave1' : n === 2 ? 'wave2' : 'wave3';
    // The valley realm downloads in the background while the waves are fought (built in the lull after a wave).
    if (n === 1) setTimeout(() => this.realm?.preload(), 2500);
    const R = (at: 'gate' | 'left' | 'right') => ({ kind: 'runner' as const, at }); let bs = 0; const B = () => ({ kind: 'breaker' as const, at: (bs++ % 2 ? 'left' : 'right') as 'left' | 'right' });
    // Large waves streaming from the gate and both side halls (two attack at a time; the rest circle).
    const mix = (runners: number, breakers: number) => {
      const out: { kind: 'runner' | 'breaker'; at: 'gate' | 'left' | 'right' }[] = [];
      const at = ['left', 'right', 'gate'] as const;
      const total = runners + breakers;
      for (let i = 0; i < total; i++) {
        if (i % 4 === 1 && breakers > 0) { breakers--; out.push(B()); } else if (runners > 0) { runners--; out.push(R(at[i % 3])); } else { breakers--; out.push(B()); }
      }
      return out;
    };
    this.spawnWave(n === 1 ? mix(8, 2) : n === 2 ? mix(9, 3) : mix(10, 4));
    this.caption('', n === 1 ? 'Invaders storm the temple.' : n === 2 ? 'More pour out of the halls.' : 'The Warden sends his last soldiers.', 2.5);
  }
  private startWarden() {
    this.phase = 'warden';
    const w = this.warden!;
    const p = new THREE.Vector3(0, 0, 26); // he strides out from the hall
    w.revive(p, this.faceHome(p));
    this.setUpdate(w, this.wardenUpdate!);
    this.system.add(w);
    // He keeps the wounds from his raids into the waves.
    const v = this.system.vitals.get(w); if (v) v.hp = this.wardenHp;
    this.boss.style.display = 'block';
    this.caption('THE TEMPLE WARDEN', '“Then I will finish this myself.”', 3.5);
    this.realmStage = 'none'; this.wardenT = 0;
    this.realm?.build();
  }

  // ------------------------------------------------------------------ the Warden's realm
  /** Waves he has already raided (1-3), and 4 for the final fight. */
  private visited = new Set<number>();
  /** True while the current realm sequence is a raid in the middle of a wave (he leaves again afterwards). */
  private raid = false;
  /** His health carries over between raids and into the final fight. */
  private wardenHp = HEALTH.warden;
  private entryHp = HEALTH.warden;
  private returnPos = new THREE.Vector3();
  static readonly RAID_TIME = 36;
  static readonly RAID_HP_LOSS = 0.15;
  static readonly FINAL_HP_LOSS = 0.2;
  private static readonly RAID_LINES = ['“You fight well. Now fight me where I choose.”', '“Again. Come.”', '“One last lesson, in my world.”'];
  private get waveNo() { return this.phase === 'wave1' ? 1 : this.phase === 'wave2' ? 2 : this.phase === 'wave3' ? 3 : 4; }
  /** Replace an enemy's update, even while the glitch has everyone frozen (the frozen wrapper is restored later). */
  private setUpdate(b: EnemyBrain, fn: EnemyBrain['update']) {
    const held = b as unknown as { _held?: EnemyBrain['update'] };
    if (held._held) held._held = fn; else b.update = fn;
  }

  /**
   * The realm sequence. Raids: near the end of each wave (all of it in the field and 2-4 soldiers left) the Warden
   * strikes down in lightning beside the player, and the temple glitches into the valley with him and the surviving
   * soldiers. He fights there unleashed until RAID_TIME, or he loses RAID_HP_LOSS of his health, or (once his soldiers
   * are down) after 14 s; then he withdraws, the realm shatters, and the wave is finished in the temple, where the
   * player left it. The final fight: once he closes in (or after 6 s), until REALM_TIME or FINAL_HP_LOSS.
   * Glitch: the screen tears and flickers for 1.1 s, the worlds swap at the peak, the glitch settles.
   */
  private updateRealm(dt: number) {
    const r = this.realm, w = this.warden as WardenBrain | null;
    if (!r || !w) return;
    const G = TempleEncounter.GLITCH, P = this.player.position, final = this.phase === 'warden', n = this.waveNo;
    if (final) this.wardenT += dt;
    const alive = this.wave.filter((b) => !b.dead).length;
    switch (this.realmStage) {
      case 'none': case 'done': {
        if (this.visited.has(n) || !r.ready || this.combat.state === 'dead') break;
        if (final) {
          if (w.dead) break;
          const close = w.effective().distanceTo(P) < 7.5;
          if ((close && this.wardenT > 1.2) || this.wardenT > 6) {
            this.visited.add(4); this.raid = false; this.returnPos.copy(P); this.entryHp = this.hp(w);
            this.beginTrans('in');
            this.caption('THE TEMPLE WARDEN', '“Let me show you where this ends.”', 2.5);
            this.arena.bossCtx.sound?.('stormCall', w.effective());
          }
        } else if (!this.queue.length && alive >= 2 && alive <= 4) {
          this.visited.add(n); this.raid = true; this.returnPos.copy(P);
          this.arrive(w);
          this.realmStage = 'arrive'; this.realmT = 0;
          this.caption('THE TEMPLE WARDEN', TempleEncounter.RAID_LINES[n - 1], 3);
        }
        break;
      }
      case 'arrive': {
        // He has struck down beside the player; a beat, then the world tears.
        this.realmT += dt;
        if (this.realmT > 1.1) this.beginTrans('in');
        break;
      }
      case 'in': case 'out': this.updateTrans(dt); break;
      case 'inside': {
        this.realmT += dt;
        const lost = (this.entryHp - this.hp(w)) / HEALTH.warden;
        const over = this.raid
          ? this.realmT > TempleEncounter.RAID_TIME || lost >= TempleEncounter.RAID_HP_LOSS || (alive === 0 && this.realmT > 20)
          : this.realmT > TempleEncounter.REALM_TIME || lost >= TempleEncounter.FINAL_HP_LOSS || w.hpFrac <= BOSS.phase3;
        if (over && !w.dead && this.combat.state !== 'dead' && !['attack', 'tell', 'vanish'].includes(w.state)) {
          w.unleashed = false;
          this.beginTrans('out');
          this.caption('', this.raid ? 'The Warden withdraws. The realm shatters.' : 'The realm shatters.', 2.5);
        }
        break;
      }
    }
  }
  // ------------------------------------------------------------------ the storm transition
  /**
   * Seen from the player's own view, the camera turning to keep the Warden in focus: a heavy wind rises from him —
   * dust and grit streaming past, the camera shaking harder — and the world darkens; at its darkest a flash of light,
   * and the other world is there as it fades. Everyone is held still and the HUD hides throughout.
   */
  private static readonly STORM = { swap: 2.2, end: 3.1 };
  private trans: { dir: 'in' | 'out'; swapped: boolean; wind: THREE.Vector3 } | null = null;
  /** Where the camera should look while the storm rises (the Warden); read by the game each frame. */
  focus: THREE.Vector3 | null = null;
  /** Darkness of the storm (0-1); read by the game into the final colour grade. */
  dark = 0;
  private beginTrans(dir: 'in' | 'out') {
    const w = this.warden as WardenBrain, ctx = this.arena.bossCtx;
    this.realmStage = dir; this.realmT = 0;
    this.freeze(true);
    const wp = w.effective();
    const wind = this.player.position.clone().sub(wp).setY(0); if (wind.lengthSq() < 1e-4) wind.set(0, 0, 1); wind.normalize();
    this.trans = { dir, swapped: false, wind };
    w.e.object.visible = true;
    // He calls it: blade raised to go, driven into the ground to return.
    w.e.play((dir === 'in' ? 'raise' : 'plunge') as never, 0.15); w.e.rate = 1;
    this.cinematic = { drive: new THREE.Vector3(), cam: null, blend: -1 };
    this.cineBars(true);
    ctx.sound?.('wind'); ctx.sound?.('riser');
  }
  private updateTrans(dt: number) {
    const tr = this.trans!, r = this.realm!, w = this.warden as WardenBrain, ctx = this.arena.bossCtx, S = TempleEncounter.STORM;
    this.realmT += dt;
    const t = this.realmT, P = this.player.position;
    // Keep him in focus (the player turns to face him too).
    if (w.e.object.visible) {
      this.focus = w.e.chest();
      const want = Math.atan2(this.focus.x - P.x, this.focus.z - P.z), d = Math.atan2(Math.sin(want - this.player.facing), Math.cos(want - this.player.facing));
      this.player.setFacing(this.player.facing + d * Math.min(1, dt * 5));
    }
    if (!tr.swapped) {
      const k = THREE.MathUtils.smoothstep(t, 0.1, S.swap);
      this.dark = 0.85 * k;
      // The wind: dust and grit streaming past the player, thicker as it builds.
      const vfx = ctx.vfx, n = Math.round((vfx?.quality === 'high' ? 11 : 6) * (0.3 + k));
      for (let i = 0; i < n && vfx; i++) {
        const side = new THREE.Vector3(tr.wind.z, 0, -tr.wind.x);
        const q = P.clone().addScaledVector(tr.wind, -6 + Math.random() * 4).addScaledVector(side, (Math.random() - 0.5) * 14).add(new THREE.Vector3(0, 0.2 + Math.random() * 2.8, 0));
        const v = tr.wind.clone().multiplyScalar(11 + Math.random() * 7).add(new THREE.Vector3(0, (Math.random() - 0.3) * 1.5, 0));
        if (Math.random() < 0.6) vfx.spawn('smoke_04', q, { color: FX_DUST, life: 0.8, size: 1.1, size1: 3.0, vel: v, alpha: 0.5 * (0.4 + k), normal: true });
        else vfx.spawn('spark_04', q, { color: FX_GRIT, life: 0.45, size: 0.18, size1: 0.12, vel: v, stretch: 7, alpha: 0.9, rot: Math.atan2(v.y, Math.hypot(v.x, v.z)) + Math.PI / 2, normal: true });
      }
      if (Math.random() < 0.3 + k * 0.5) this.onShake?.(0.02 + 0.07 * k, 0.2);
      if (t >= S.swap) {
        tr.swapped = true;
        this.swapWorld(tr.dir === 'in');
        r.music(tr.dir === 'in');
        // A flash of light, and the other world is there.
        this.dark = 0; this.flashScreen(true);
        ctx.sound?.('thunder'); ctx.sound?.('whoosh');
        this.onShake?.(0.12, 0.35);
      }
    } else if (t >= S.end) {
      this.focus = null; this.freeze(false); this.cinematic = null; this.cineBars(false); this.trans = null;
      if (this.realmStage === 'in') { this.realmStage = 'inside'; this.realmT = 0; w.unleashed = true; }
      else { this.realmStage = 'done'; this.introDone.delete('swap-in'); this.introDone.delete('swap-out'); }
    }
  }
  private hp(w: EnemyBrain) { return this.system.vitals.get(w)?.hp ?? this.wardenHp; }
  /** Raid: lightning strikes beside the player and he is there, sword drawn. */
  private arrive(w: WardenBrain) {
    const P = this.player.position, f = new THREE.Vector3(Math.sin(this.player.facing), 0, Math.cos(this.player.facing));
    const p = P.clone().addScaledVector(f, 5);
    w.revive(p, Math.atan2(P.x - p.x, P.z - p.z));
    w.e.play('guard' as never, 0);
    this.setUpdate(w, (d) => { w.e.update(d); });
    const g = w.e.object.position, ctx = this.arena.bossCtx;
    ctx.vfx?.bolt(g.clone(), 22, 2.4); ctx.vfx?.bolt(g.clone().add(new THREE.Vector3(0.5, 0, 0.3)), 18, 1.6);
    ctx.vfx?.puff(g, true); ctx.sound?.('thunder', g);
    this.flashScreen(); this.onShake?.(0.14, 0.5);
    this.boss.style.display = 'block';
  }
  /** Hold everyone still during the glitch (no hits can land while the world tears). */
  private frozen = false;
  private freeze(on: boolean) {
    if (on === this.frozen) return;
    this.frozen = on;
    this.arena.bossCtx.spells?.clear();
    for (const b of this.arena.brains) {
      if (b.dead) continue;
      if (on) { const up = b.update; (b as unknown as { _held: typeof up })._held = up; b.update = (d) => { b.e.update(d); }; }
      else { const h = (b as unknown as { _held?: EnemyBrain['update'] })._held; if (h) { b.update = h; delete (b as unknown as { _held?: unknown })._held; } }
    }
  }
  private swapWorld(toValley: boolean) {
    const r = this.realm!, w = this.warden as WardenBrain;
    let pp: THREE.Vector3, bp: THREE.Vector3;
    if (toValley) {
      const at = r.enter(); if (!at) { this.realmStage = 'done'; this.raidOff(w); return; }
      pp = at.player; bp = at.boss;
      if (this.raid) {
        // He joins the fight for real (his health carries over between raids).
        this.setUpdate(w, this.wardenUpdate!);
        this.system.add(w);
        const v = this.system.vitals.get(w); if (v) v.hp = this.wardenHp;
        this.entryHp = this.wardenHp;
      }
      w.relocate(bp, Math.atan2(pp.x - bp.x, pp.z - bp.z));
    } else {
      r.exit();
      pp = this.returnPos.clone();
      if (this.raid) { this.raidOff(w); bp = pp.clone().add(new THREE.Vector3(0, 0, -6)); }
      else {
        const f = new THREE.Vector3(Math.sin(this.player.facing), 0, Math.cos(this.player.facing));
        bp = pp.clone().addScaledVector(f, 6);
        w.relocate(bp, Math.atan2(pp.x - bp.x, pp.z - bp.z));
      }
    }
    this.player.teleport(pp.x, pp.z); this.player.setFacing(Math.atan2(bp.x - pp.x, bp.z - pp.z));
    // The soldiers still standing come through with him, spread around the player.
    let i = 0;
    for (const b of this.arena.brains) if (b !== w && !b.dead) {
      const a = (i++ / 4) * Math.PI * 2 + 0.6, q = pp.clone().add(new THREE.Vector3(Math.sin(a) * 7, 0, Math.cos(a) * 7));
      b.pos.set(q.x, 0, q.z); b.knockVel.set(0, 0, 0);
    }
    this.onSnap?.();
  }
  /** End of a raid: he leaves the fight (keeping his health) until the next. */
  private raidOff(w: WardenBrain) {
    this.wardenHp = this.hp(w);
    this.system.drop(w);
    w.unleashed = false; this.arena.bossCtx.spells?.clear();
    this.setUpdate(w, () => {});
    w.e.object.visible = false; w.e.object.position.y -= 50;
    this.director.release(w.id);
    if (this.director.exclusive === w.id) this.director.exclusive = null;
    this.boss.style.display = 'none';
  }
  private get director() { return this.arena.director; }
  /** Camera snap after a teleport (set by the game). */
  onSnap: (() => void) | null = null;
  /** Leave the realm at once (retry after a defeat inside it). */
  private resetRealm() {
    if (this.frozen) this.freeze(false);
    this.trans = null; this.focus = null; this.dark = 0;
    if (this.realmStage === 'in' || this.realmStage === 'out') this.cinematic = null;
    if (this.realm?.active) { this.realm.exit(); this.realm.music(false); }
    this.realm?.glitch(0);
    this.realmStage = 'none'; this.realmT = 0; this.wardenT = 0;
    this.introDone.delete('swap-in'); this.introDone.delete('swap-out');
    this.visited.clear(); this.raid = false; this.wardenHp = HEALTH.warden;
  }

  /** Clean restart after a defeat: same courtyard start, wave 1 again. */
  retry() {
    this.resetRealm();
    this.end.style.display = 'none'; this.endAt = -1; this.bossPhase = 1; this.cinematic = null; this.pre = []; this.cineBars(false);
    this.doors?.open(0); this.doors?.solid(true);
    this.arena.bossCtx.spells?.clear();
    this.arena.clear(); this.warden = null; this.wave = [];
    this.boss.style.display = 'none';
    this.combat.reset();
    this.player.teleport(this.home.x, this.home.z); this.player.setFacing(this.home.yaw);
    this.t = 0;
    // Warden spawns hidden (for the final phase), then wave 1 starts at once.
    const p = new THREE.Vector3(0, 0, 30);
    this.warden = this.arena.spawn('warden', p, this.faceHome(p));
    this.wardenUpdate = this.warden.update.bind(this.warden);
    const w = this.warden; w.update = () => {}; w.e.object.visible = false; w.e.object.position.y -= 50; this.system.drop(w);
    this.startWave(1);
  }

  private showEnd(win: boolean) {
    document.exitPointerLock?.();
    this.end.innerHTML = win
      ? `<h2>The Temple Warden has fallen</h2><p>The temple is yours again.</p><div class="row"><button data-a="again">Fight again</button><a href="./">Explore the valley</a></div>`
      : `<h2>You have fallen</h2><p>The temple is lost.</p><div class="row"><button data-a="retry">Retry</button></div>`;
    this.end.style.display = 'flex';
    this.end.querySelector('button')!.addEventListener('click', (e) => { e.stopPropagation(); this.retry(); });
  }

  update(dt: number) {
    if (this.hud.style.display === 'none') { this.hud.style.display = ''; this.capUntil = this.t + 4.5; this.cap.classList.add('show'); }
    this.t += dt;
    if (this.t > this.capUntil) this.cap.classList.remove('show');
    const allDown = (bs: EnemyBrain[]) => bs.length > 0 && bs.every((b) => b.dead);
    switch (this.phase) {
      case 'intro': {
        // The opening runs on real time, so a slow frame rate can't stretch it out (the game clamps long frames).
        const now = performance.now(), real = this.lastReal < 0 ? dt : Math.min(0.25, (now - this.lastReal) / 1000);
        this.lastReal = now; this.t += Math.max(0, real - dt);
        this.updateIntro(dt);
        break;
      }
      case 'wave1': case 'wave2': case 'wave3': {
        this.updateRealm(dt);
        const calm = this.realmStage === 'none' || this.realmStage === 'done';
        if (calm) this.trickle();
        if (calm && !this.queue.length && allDown(this.wave)) {
          if (this.endAt < 0) { this.endAt = this.t; this.realm?.build(); }
          if (this.t - this.endAt > 2) { this.endAt = -1; if (this.phase === 'wave1') this.startWave(2); else if (this.phase === 'wave2') this.startWave(3); else this.startWarden(); }
        }
        break;
      }
      case 'warden': this.updateRealm(dt); if (this.warden!.dead) { if (this.endAt < 0) this.endAt = this.t; if (this.t - this.endAt > 2.5) { this.phase = 'victory'; this.showEnd(true); } } break;
    }
    if (this.combat.state === 'dead' && this.phase !== 'defeat' && this.phase !== 'victory') { this.phase = 'defeat'; this.endAt = this.t; }
    if (this.phase === 'defeat' && this.end.style.display !== 'flex' && this.t - this.endAt > 1.5) this.showEnd(false);
    this.drawHud();
  }

  private drawHud() {
    this.pbar.style.width = `${(100 * this.combat.hp) / HEALTH.player}%`;
    // Damaged enemies: a small bar over the head.
    for (const b of this.arena.brains) {
      const v = this.system.vitals.get(b);
      let bar = this.ebars.get(b);
      const show = v && !b.dead && !b.removed && b.e.object.visible && b.e.kind !== 'warden' && v.hp < HEALTH[b.e.cls];
      if (!show) { if (bar) bar.style.display = 'none'; continue; }
      if (!bar) { bar = document.createElement('div'); bar.className = 'ebar'; bar.innerHTML = '<div></div>'; this.hud.appendChild(bar); this.ebars.set(b, bar); }
      const q = b.e.chest().add(new THREE.Vector3(0, 0.75, 0)).project(this.camera);
      if (q.z > 1 || Math.abs(q.x) > 1.1 || Math.abs(q.y) > 1.1) { bar.style.display = 'none'; continue; }
      bar.style.display = 'block';
      bar.style.left = `${(q.x * 0.5 + 0.5) * innerWidth}px`; bar.style.top = `${(-q.y * 0.5 + 0.5) * innerHeight}px`;
      (bar.firstElementChild as HTMLElement).style.width = `${(100 * v!.hp) / HEALTH[b.e.cls]}%`;
    }
    if ((this.phase === 'warden' || this.boss.style.display === 'block') && this.warden && this.system.vitals.get(this.warden)) {
      const v = this.system.vitals.get(this.warden);
      if (v) { this.bossFill.style.width = `${(100 * v.hp) / HEALTH.warden}%`; this.meterFill.style.width = `${Math.min(100, (100 * v.meter) / BOSS.posture)}%`; }
      // Phase changes (boss phases 2 and 3): a short caption, no cutscene.
      const ph = (this.warden as WardenBrain).phase ?? 1;
      if (ph !== this.bossPhase) {
        this.bossPhase = ph;
        if (ph === 2) this.caption('THE TEMPLE WARDEN', '“Burn, then.” His blade catches fire.', 3);
        if (ph === 3) this.caption('THE TEMPLE WARDEN', '“The storm answers me.”', 3);
      }
    }
  }
}
