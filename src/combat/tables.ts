/**
 * Combat numbers from docs/combat.md (approved). Single source for the player kit (Stage 1) and the hit
 * resolver / enemy brains (later stages). Times are seconds of move time.
 */
export type Weight = 'light' | 'medium' | 'heavy';

export const HEALTH = { player: 100, runner: 40, breaker: 120, warden: 450 };

/** Temple Warden boss (docs/boss.md): posture meter, knee-drop length and phase thresholds (fraction of health). */
export const BOSS = { posture: 150, kneeDrop: 2.5, phase2: 0.65, phase3: 0.30 };
export const OPEN_DAMAGE = 1.5;      // enemy in recovery or stagger
export const OPEN_METER = 2;         // meter / poise gain on an open enemy
export const BEHIND_METER = 1.5;     // Breaker meter gain from behind

/** Player katana moves: clip, playback window, active hit window, chain window, recovery and stagger values. */
export interface PlayerMove {
  clip: string; from?: number; to: number; speed?: number;
  active?: [number, number];           // hit window
  chain?: [number, number]; next?: PlayerMoveName;
  /** Recovery clip played when the chain isn't taken (and its length), and when the player becomes free. */
  rec?: { clip: string; length: number }; vulnerableUntil: number;
  damage?: number; poise?: number | 'break'; meter?: number;
  /** Root drive (m) over a time window, for moves that travel. */
  drive?: { dist: number; from: number; to: number };
}
export type PlayerMoveName = 'cut1' | 'cut2' | 'cut3' | 'lunge' | 'riposte' | 'roll' | 'heavy' | 'kick'
  // Extended light chain after the finisher: a spinning slash, then a leaping slam.
  | 'spin' | 'leap'
  // Supernatural abilities (docs/abilities.md): hit sources driven by src/player/abilities.ts, not katana sweeps.
  | 'phantom' | 'rift' | 'rupture' | 'implode';

export const PLAYER_MOVES: Record<PlayerMoveName, PlayerMove> = {
  cut1: { clip: 'Sword_Regular_A', to: 0.43, active: [0.24, 0.3], chain: [0.33, 0.43], next: 'cut2',
    rec: { clip: 'Sword_Regular_A_Rec', length: 0.45 }, vulnerableUntil: 0.88, damage: 8, poise: 10, meter: 6 },
  cut2: { clip: 'Sword_Regular_B', to: 0.53, active: [0.24, 0.3], chain: [0.37, 0.53], next: 'cut3',
    rec: { clip: 'Sword_Regular_B_Rec', length: 0.5 }, vulnerableUntil: 1.03, damage: 8, poise: 10, meter: 6 },
  // The finisher may chain on (press again in 0.80–1.05 s) into the spin and the leap.
  cut3: { clip: 'Sword_Regular_C', to: 1.3, active: [0.62, 0.72], chain: [0.8, 1.05], next: 'spin', vulnerableUntil: 1.3, damage: 16, poise: 25, meter: 15 },
  // Spinning slash: the wide two-handed sweep of Sword_Heavy_Combo (0.45–0.82 s, blade held out at 1.5–1.9 m, chest
  // height) carried through a full 360° turn of the body, so it hits all round.
  spin: { clip: 'Sword_Heavy_Combo', from: 0.45, to: 0.92, speed: 0.95, active: [0.04, 0.38], chain: [0.3, 0.49], next: 'leap',
    rec: { clip: 'Sword_Regular_A_Rec', length: 0.4 }, vulnerableUntil: 0.86, damage: 12, poise: 20, meter: 12, drive: { dist: 0.8, from: 0.05, to: 0.4 } },
  // Leaping slam: the big overhead cut from its wind-up while the body jumps forward, landing on the strike.
  leap: { clip: 'Sword_Regular_C', from: 0.3, to: 1.08, speed: 0.75, active: [0.38, 0.52], vulnerableUntil: 1.04, damage: 22, poise: 'break', meter: 22,
    drive: { dist: 2.2, from: 0.02, to: 0.46 } },
  lunge: { clip: 'Sword_Dash', to: 1.2, active: [0.28, 0.4], vulnerableUntil: 1.2, damage: 14, poise: 20, meter: 10,
    drive: { dist: 2.0, from: 0.05, to: 0.38 } },
  // Sword_Regular_C at 1.15x: hit 0.54-0.63 s, free at 1.13 s (move time).
  riposte: { clip: 'Sword_Regular_C', to: 1.3, speed: 1.15, active: [0.54, 0.63], vulnerableUntil: 1.13, damage: 30, poise: 'break', meter: 30 },
  // Heavy slash (hold Attack): the two-handed opening swing of Sword_Heavy_Combo (hit 0.50 s).
  heavy: { clip: 'Sword_Heavy_Combo', to: 0.95, active: [0.43, 0.57], vulnerableUntil: 0.95, damage: 20, poise: 'break', meter: 20 },
  // Guard-break kick (Attack while blocking): Melee_Hook (hit 0.27 s).
  kick: { clip: 'Melee_Hook', to: 0.47, active: [0.22, 0.32], rec: { clip: 'Melee_Hook_Rec', length: 0.3 }, vulnerableUntil: 0.77, damage: 4, poise: 'break', meter: 25 },
  roll: { clip: 'Roll', to: 0.75, vulnerableUntil: 0.75, drive: { dist: 2.4, from: 0.02, to: 0.55 } },
  // Abilities: damage / poise / meter per hit (timelines in ABILITY below). Rift values are at full charge
  // (scaled by ABILITY.rift.minScale at minimum charge).
  phantom: { clip: 'Sword_Dash', to: 0.62, vulnerableUntil: 0.62, damage: 14, poise: 20, meter: 12 },
  rift: { clip: 'Sword_Regular_C', to: 1.0, vulnerableUntil: 1.0, damage: 34, poise: 'break', meter: 34 },
  rupture: { clip: 'NinjaJump_Land', to: 1.7, vulnerableUntil: 1.7, damage: 18, poise: 'break', meter: 30 },
  implode: { clip: 'NinjaJump_Land', to: 1.7, vulnerableUntil: 1.7, damage: 12, poise: 'break', meter: 16 },
};

/**
 * Supernatural abilities (docs/abilities.md). Times are seconds from the ability's start.
 * - Phantom Step (Q): a dash that passes through enemies, cutting each once. Untouchable while travelling.
 * - Colossus Rift (E): hold to charge (min/full), release a crescent wave that travels forward.
 * - Gravity Rupture (R): katana driven into the ground; an expanding ring hits, then nearby enemies are pulled in,
 *   then the field collapses (second hit around the player).
 */
export const ABILITY = {
  phantom: { cooldown: 3.5, anticipate: 0.07, travel: 0.2, recover: 0.35, dist: 6.5, invulnerable: [0.03, 0.32] as [number, number], radius: 0.55 },
  rift: { cooldown: 6, minCharge: 0.3, fullCharge: 1.0, maxHold: 2.5, release: 0.12, recover: 0.55, minScale: 0.55,
    speed: 20, range: [11, 16] as [number, number], width: [2.6, 4.2] as [number, number], height: 1.0, radius: 0.35 },
  rupture: { cooldown: 10, impact: 0.42, implode: 1.2, end: 1.7, invulnerable: [0.3, 0.62] as [number, number],
    ring: 4.5, ringTime: 0.16, pull: { radius: 7.5, speed: 6.5, stopAt: 1.35, from: 0.5, to: 1.15 }, implodeRadius: 2.6 },
} as const;

export const ROLL = { invulnerable: [0.12, 0.45] as [number, number], cooldown: 0.8 };
export const BUFFER = 0.15;          // attack input accepted this long before a chain window opens
export const MASH_LOCK = 0.25;       // after a dropped chain, Cut 1 waits this long
export const BLOCK = { raise: 0.1, lower: 0.15, moveScale: 0.5, arc: 120, blockCancelAfter: 0.2 };
export const PARRY = { window: 0.18, lockout: 0.5, riposteWindow: 1.0 };
export const REACT = {
  flinch: 0.35, flinchPush: { light: 0.3, medium: 0.8 },
  knockdown: 2.0, knockdownInvulnerableFrom: 0.6,
  guardBreakStun: 0.8, parriedStun: 0.5, blockPush: 0.3,
};

/** Enemy attacks against the player (per individual hit). */
export interface EnemyHitDef { damage: number; blocked: number; parryable: boolean; weight: Weight }
export const ENEMY_HITS: Record<string, EnemyHitDef> = {
  'runner.slash': { damage: 8, blocked: 2, parryable: true, weight: 'light' },
  'runner.slash2': { damage: 8, blocked: 2, parryable: true, weight: 'light' },
  'runner.flurry': { damage: 6, blocked: 2, parryable: true, weight: 'light' },
  'runner.finisher': { damage: 12, blocked: 3, parryable: true, weight: 'medium' },
  'runner.lunge': { damage: 12, blocked: 3, parryable: true, weight: 'medium' },
  'runner.pommel': { damage: 5, blocked: 1, parryable: true, weight: 'light' },
  'runner.spin': { damage: 10, blocked: 3, parryable: false, weight: 'light' },
  // Ash kunai (the Runners' power): three thrown in a fan, each hit separately; block, roll or step aside.
  'runner.kunai': { damage: 4, blocked: 1, parryable: false, weight: 'light' },
  'breaker.sweep1': { damage: 12, blocked: 3, parryable: true, weight: 'medium' },
  'breaker.sweep2': { damage: 12, blocked: 3, parryable: true, weight: 'medium' },
  'breaker.sweep3': { damage: 14, blocked: 4, parryable: true, weight: 'medium' },
  'breaker.smash': { damage: 28, blocked: 14, parryable: false, weight: 'heavy' },
  'breaker.charge': { damage: 20, blocked: 10, parryable: false, weight: 'heavy' },
  'breaker.stamp': { damage: 10, blocked: 5, parryable: false, weight: 'heavy' },
  // Temple Warden boss (docs/boss.md). Sword moves:
  'warden.combo1': { damage: 10, blocked: 3, parryable: true, weight: 'light' },
  'warden.combo2': { damage: 10, blocked: 3, parryable: true, weight: 'light' },
  'warden.combo3': { damage: 14, blocked: 4, parryable: true, weight: 'medium' },
  'warden.lunge': { damage: 14, blocked: 4, parryable: true, weight: 'medium' },
  'warden.cleave': { damage: 22, blocked: 11, parryable: false, weight: 'heavy' },
  'warden.stepslash': { damage: 12, blocked: 3, parryable: true, weight: 'medium' },
  'warden.flamecut': { damage: 10, blocked: 3, parryable: true, weight: 'light' },
  'warden.storm1': { damage: 12, blocked: 3, parryable: true, weight: 'medium' },
  'warden.storm2': { damage: 24, blocked: 12, parryable: false, weight: 'heavy' },
  'warden.tpstrike': { damage: 14, blocked: 4, parryable: true, weight: 'medium' },
  // Spells (src/boss/spells.ts):
  'warden.firewave': { damage: 14, blocked: 4, parryable: false, weight: 'medium' },
  'warden.fireball': { damage: 10, blocked: 3, parryable: false, weight: 'medium' },
  'warden.flame': { damage: 5, blocked: 5, parryable: false, weight: 'light' },
  'warden.lightning': { damage: 22, blocked: 22, parryable: false, weight: 'heavy' },
  // Unleashed powers (src/boss/spells.ts): every one has a ground warning and can be dodged.
  'warden.inferno': { damage: 20, blocked: 8, parryable: false, weight: 'heavy' },
  'warden.meteor': { damage: 24, blocked: 12, parryable: false, weight: 'heavy' },
  'warden.wrath': { damage: 10, blocked: 10, parryable: false, weight: 'medium' },
  'warden.thunder': { damage: 10, blocked: 10, parryable: false, weight: 'medium' },
  'warden.tempest': { damage: 16, blocked: 6, parryable: false, weight: 'heavy' },
  'warden.tornado': { damage: 7, blocked: 3, parryable: false, weight: 'light' },
};

/** Damage a player move deals to an enemy (open = in recovery or staggered). */
export function playerDamage(move: PlayerMoveName, open: boolean) {
  const d = PLAYER_MOVES[move].damage ?? 0;
  return open ? d * OPEN_DAMAGE : d;
}
/** Breaker stagger-meter gain for a player move. */
export function meterGain(move: PlayerMoveName, open: boolean, behind: boolean) {
  return (PLAYER_MOVES[move].meter ?? 0) * (open ? OPEN_METER : 1) * (behind ? BEHIND_METER : 1);
}
