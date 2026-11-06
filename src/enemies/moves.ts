/**
 * Enemy move table: the approved clip mappings and timings from docs/enemies.md.
 * All times are seconds of MOVE time (0 = move start). For clip segments that start mid-clip, the clip time
 * is noted beside each hit. Hit reach (horizontal, from the enemy's origin) comes from the adjusted in-game
 * weapon paths on the dressed models (tools/enemyprev analyse), rounded down slightly. Charge reach is
 * relative to the moving body; the stamp is a shockwave radius.
 */
export type ClubMode = 'clip' | 'carry' | 'guard' | 'lean' | 'none';
export type LayerName = 'runnerReady' | 'runnerSpin' | 'runnerStepL' | 'runnerStepR' | 'runnerDeathB'
  | 'breakerStamp' | 'breakerStagger' | 'breakerDeathB' | 'breakerCharge' | 'smashTilt' | 'runnerLunge';

export interface Seg { clip: string; from?: number; to?: number }
export interface Hit {
  /** Impact time (move time). */ t: number;
  /** Active window either side of the impact (s). */ window: number;
  /** Horizontal reach from the enemy's origin (m) and arc (degrees, centred on facing). */ reach: number; arc: number;
  damage: number;
}
export interface MoveDef {
  segs: Seg[];
  loop?: boolean;
  speed?: number;
  /** Fixed duration for procedural moves (otherwise the segment lengths). */ duration?: number;
  /** Optional clip blended underneath at (1 - weight). */ under?: string; weight?: number;
  /** Pose layer: src/enemies/custom.ts, or a Temple Warden boss layer (src/boss/poses.ts). */
  layer?: LayerName | 'wardenLunge' | 'wardenStep' | 'wardenPalm' | 'wardenRaise';
  club?: ClubMode;
  hits?: Hit[];
  /** Move time from which the enemy is open to punishment, and the length of that recovery. */
  openFrom?: number; recovery?: number;
  /** Clamp on the last frame instead of returning to idle (deaths). */ hold?: boolean;
}

export type RunnerMove = 'idle' | 'walk' | 'jog' | 'sprint' | 'slash' | 'slash2' | 'flurry' | 'finisher' | 'lunge' | 'pommel'
  | 'spin' | 'parry' | 'roll' | 'hop' | 'stepL' | 'stepR' | 'flinchChest' | 'flinchHead' | 'knockdown' | 'deathA' | 'deathB';
export type BreakerMove = 'idle' | 'walk' | 'guard' | 'sweep' | 'smash' | 'charge' | 'guardBreak' | 'shudder' | 'stamp'
  | 'stagger' | 'deathA' | 'deathB';

export const RUNNER: Record<RunnerMove, MoveDef> = {
  idle: { segs: [{ clip: 'Sword_Idle' }], loop: true, layer: 'runnerReady' },
  walk: { segs: [{ clip: 'Walk_Loop' }], loop: true },
  jog: { segs: [{ clip: 'Jog_Fwd_Loop' }], loop: true },
  sprint: { segs: [{ clip: 'Sprint_Loop' }], loop: true },
  slash: { segs: [{ clip: 'Sword_Regular_A' }, { clip: 'Sword_Regular_A_Rec' }], hits: [{ t: 0.27, window: 0.06, reach: 1.2, arc: 140, damage: 8 }], openFrom: 0.33, recovery: 1.0 },
  slash2: { segs: [{ clip: 'Sword_Regular_B' }, { clip: 'Sword_Regular_B_Rec' }], hits: [{ t: 0.27, window: 0.06, reach: 1.45, arc: 140, damage: 8 }], openFrom: 0.37, recovery: 1.0 },
  flurry: { segs: [{ clip: 'Sword_Regular_Combo' }], hits: [[0.27, 1.2], [0.73, 1.45], [1.57, 1.45]].map(([t, reach]) => ({ t, window: 0.06, reach, arc: 140, damage: 7 })), openFrom: 1.7, recovery: 1.3 },
  finisher: { segs: [{ clip: 'Sword_Regular_C' }], hits: [{ t: 0.67, window: 0.07, reach: 1.45, arc: 150, damage: 12 }], openFrom: 0.8, recovery: 1.2 },
  // Closing thrust: Sword_Dash travels only ~0.4 m, so the game drives 1.8 m forward into the 0.33 s hit.
  lunge: { segs: [{ clip: 'Sword_Dash' }], layer: 'runnerLunge', hits: [{ t: 0.33, window: 0.08, reach: 1.45, arc: 60, damage: 12 }], openFrom: 0.43, recovery: 1.2 },
  pommel: { segs: [{ clip: 'Melee_Hook' }, { clip: 'Melee_Hook_Rec' }], hits: [{ t: 0.27, window: 0.05, reach: 1.3, arc: 90, damage: 5 }], openFrom: 0.3, recovery: 0.6 },
  // Spin: active 0.45-0.62 s (t 0.535 ± 0.085) while the retimed turn sweeps the full circle; nothing lands before 0.45 s.
  spin: { segs: [{ clip: 'Sword_Idle' }], duration: 0.95, layer: 'runnerSpin', hits: [{ t: 0.535, window: 0.085, reach: 1.1, arc: 360, damage: 10 }], openFrom: 0.62, recovery: 0.33 },
  parry: { segs: [{ clip: 'Sword_Block' }] },
  roll: { segs: [{ clip: 'Roll' }] },
  hop: { segs: [{ clip: 'NinjaJump_Start', to: 0.6 }, { clip: 'NinjaJump_Land', from: 0.5 }] },
  stepL: { segs: [{ clip: 'Sword_Idle' }], duration: 0.5, layer: 'runnerStepL' },
  stepR: { segs: [{ clip: 'Sword_Idle' }], duration: 0.5, layer: 'runnerStepR' },
  flinchChest: { segs: [{ clip: 'Hit_Chest' }] },
  flinchHead: { segs: [{ clip: 'Hit_Head' }] },
  knockdown: { segs: [{ clip: 'Hit_Knockback' }, { clip: 'LayToIdle' }] },
  deathA: { segs: [{ clip: 'Death01' }], hold: true },
  deathB: { segs: [{ clip: 'Death01' }], layer: 'runnerDeathB', hold: true },
};

export const BREAKER: Record<BreakerMove, MoveDef> = {
  idle: { segs: [{ clip: 'Idle_Loop' }], loop: true, club: 'carry' },
  walk: { segs: [{ clip: 'Walk_Loop' }], loop: true, speed: 0.55, club: 'carry' },
  guard: { segs: [{ clip: 'Idle_Shield_Loop' }], loop: true, club: 'guard' },
  // Three-hit sweep: Sword_Heavy_Combo 0-2.0 s. Hits at clip 0.50 / 1.17 / 1.83 s.
  sweep: { segs: [{ clip: 'Sword_Heavy_Combo', from: 0, to: 2.0 }], club: 'clip',
    hits: [{ t: 0.5, window: 0.07, reach: 2.4, arc: 180, damage: 14 }, { t: 1.17, window: 0.07, reach: 1.8, arc: 120, damage: 14 }, { t: 1.83, window: 0.08, reach: 2.3, arc: 200, damage: 16 }],
    openFrom: 1.9, recovery: 0.6 },
  // Overhead smash: Sword_Heavy_Combo 2.0-4.3 s, 40 deg wind-up tilt peaking at clip 2.5 s. Impact at clip 2.63 s.
  smash: { segs: [{ clip: 'Sword_Heavy_Combo', from: 2.0, to: 4.3 }], club: 'clip', layer: 'smashTilt',
    hits: [{ t: 0.63, window: 0.06, reach: 2.0, arc: 60, damage: 28 }], openFrom: 0.67, recovery: 1.6 },
  charge: { segs: [{ clip: 'Shield_Dash' }], club: 'carry', layer: 'breakerCharge', hits: [{ t: 0.35, window: 0.3, reach: 1.0, arc: 70, damage: 18 }], openFrom: 0.75, recovery: 1.1 },
  guardBreak: { segs: [{ clip: 'Idle_Shield_Break' }], club: 'guard' },
  shudder: { segs: [{ clip: 'Hit_Chest' }], under: 'Idle_Shield_Loop', weight: 0.35, club: 'guard' },
  stamp: { segs: [{ clip: 'Idle_Shield_Loop' }], duration: 1.4, club: 'guard', layer: 'breakerStamp', hits: [{ t: 0.75, window: 0.08, reach: 2.2, arc: 360, damage: 10 }], openFrom: 0.85, recovery: 0.8 },
  stagger: { segs: [{ clip: 'Idle_Shield_Loop' }], duration: 2.2, club: 'lean', layer: 'breakerStagger', openFrom: 0.15, recovery: 2.0 },
  deathA: { segs: [{ clip: 'Death01' }], club: 'none', hold: true },
  deathB: { segs: [{ clip: 'Idle_Shield_Loop' }], duration: 2.8, club: 'lean', layer: 'breakerDeathB', hold: true },
};
