import * as THREE from 'three';
import type { CombatArena } from './arena';
import type { CombatSystem } from './system';
import type { EnemyBrain } from './brain';
import type { PlayerCombat } from '../player/combat';
import type { Player } from '../player/player';
import { HEALTH } from './tables';

/**
 * The temple fight (MVP): the Temple Warden confronts the player, then sends two waves
 * (two Ash Runners; an Iron Breaker and an Ash Runner) before fighting himself. Includes the minimal
 * HUD (player health, damaged enemies' health, the Warden's health and stagger meter), captions, and the
 * defeat (retry) and victory screens. Combat rules are the existing ones.
 */
type Phase = 'intro' | 'wave1' | 'wave2' | 'wave3' | 'warden' | 'victory' | 'defeat';

const CSS = `
#hud { position: fixed; inset: 0; pointer-events: none; font-family: Inter, system-ui, sans-serif; color: #ece6d8; z-index: 5; }
#hud .pbar { position: absolute; left: max(18px, env(safe-area-inset-left)); top: 16px; width: min(34vw, 260px); }
#hud .lbl { font-size: 11px; letter-spacing: 0.16em; text-transform: uppercase; opacity: 0.85; margin-bottom: 4px; text-shadow: 0 1px 2px #000; }
#hud .track { height: 9px; background: rgba(10,10,10,0.55); border: 1px solid rgba(236,230,216,0.35); border-radius: 2px; overflow: hidden; }
#hud .fill { height: 100%; background: linear-gradient(#c9a35b, #9a7a3c); transition: width 0.15s; }
#hud .fill.red { background: linear-gradient(#b8463a, #7d2a22); }
#hud .fill.meter { background: linear-gradient(#e9dcc0, #b9ab8c); }
#hud .ebar { position: absolute; width: 64px; height: 5px; margin-left: -32px; background: rgba(10,10,10,0.6); border: 1px solid rgba(236,230,216,0.3); }
#hud .ebar > div { height: 100%; background: #b8463a; }
#hud .boss { position: absolute; left: 50%; transform: translateX(-50%); bottom: max(26px, env(safe-area-inset-bottom)); width: min(70vw, 520px); display: none; text-align: center; }
#hud .boss .track { height: 8px; margin-bottom: 4px; }
#hud .boss .meter { height: 4px; }
#hud .cap { position: absolute; left: 50%; top: 18%; transform: translateX(-50%); max-width: 80vw; text-align: center; font-family: Georgia, serif; font-size: clamp(16px, 2.4vw, 24px); text-shadow: 0 2px 6px #000; opacity: 0; transition: opacity 0.4s; }
#hud .cap.show { opacity: 1; }
#hud .cap b { display: block; font-family: Inter, sans-serif; font-size: 11px; letter-spacing: 0.22em; color: #c9a35b; margin-bottom: 6px; }
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
    this.startIntro();
  }

  /** Point `n` m inside the gate, `side` m across (the enemies come in through the main gate). */
  private gateSpot(side: number, back = 0) { return this.gate.clone().add(new THREE.Vector3(side, 0, back)); }
  private faceHome(p: THREE.Vector3) { return Math.atan2(this.home.x - p.x, this.home.z - p.z); }

  private caption(who: string, text: string, secs = 4) {
    this.cap.innerHTML = who ? `<b>${who}</b>${text}` : text;
    this.cap.classList.add('show'); this.capUntil = this.t + secs;
  }

  private startIntro() {
    this.phase = 'intro'; this.t = 0;
    // The Warden stands in the gateway, sword drawn, and speaks; then withdraws and sends his soldiers.
    const p = new THREE.Vector3(0, 0, 30); // in front of the main hall, facing the player at the gate
    this.warden = this.arena.spawn('warden', p, this.faceHome(p));
    this.wardenUpdate = this.warden.update.bind(this.warden);
    const w = this.warden;
    w.update = (dt) => { w.e.update(dt); };
    w.e.play('guard' as never, 0);
    this.system.drop(w); // not a target during the confrontation
    this.caption('THE TEMPLE WARDEN', '“This temple is ours now. You should not have returned.”', 4.5);
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
    this.wave = []; this.queue = [...list]; this.nextSpawn = this.t; this.spawned = 0;
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
    w.update = this.wardenUpdate!;
    this.system.add(w);
    this.boss.style.display = 'block';
    this.caption('THE TEMPLE WARDEN', '“Then I will finish this myself.”', 3.5);
  }

  /** Clean restart after a defeat: same courtyard start, wave 1 again. */
  retry() {
    this.end.style.display = 'none'; this.endAt = -1;
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
      case 'intro':
        if (this.t > 4.5) {
          const w = this.warden!; w.e.object.visible = false; w.e.object.position.y -= 50; w.update = () => {};
          this.startWave(1);
        }
        break;
      case 'wave1': case 'wave2': case 'wave3': {
        this.trickle();
        if (!this.queue.length && allDown(this.wave)) {
          if (this.endAt < 0) this.endAt = this.t;
          if (this.t - this.endAt > 2) { this.endAt = -1; if (this.phase === 'wave1') this.startWave(2); else if (this.phase === 'wave2') this.startWave(3); else this.startWarden(); }
        }
        break;
      }
      case 'warden': if (this.warden!.dead) { if (this.endAt < 0) this.endAt = this.t; if (this.t - this.endAt > 2.5) { this.phase = 'victory'; this.showEnd(true); } } break;
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
    if (this.phase === 'warden' && this.warden) {
      const v = this.system.vitals.get(this.warden);
      if (v) { this.bossFill.style.width = `${(100 * v.hp) / HEALTH.breaker}%`; this.meterFill.style.width = `${Math.min(100, v.meter)}%`; }
    }
  }
}
