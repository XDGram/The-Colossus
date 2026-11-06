import { BREAKER, type MoveDef } from '../enemies/moves';

/**
 * Temple Warden boss move table (docs/boss.md). Clips are the existing library clips (UAL1 + UAL2 in enemies.glb)
 * played on the mentor's approved body, with his katana held two-handed ('clip' grip) or in the right hand only
 * ('none', while the left hand casts). Times are move time in seconds. Damage lives in src/combat/tables.ts
 * ('warden.*'); `hits` here only give the active windows (the `damage` field is not used).
 *
 * Base stances (idle, walk, guard, shudder, guard break, deaths) are the ones the Warden already used.
 */
export type WardenMove = 'idle' | 'walk' | 'guard' | 'shudder' | 'guardBreak' | 'stagger' | 'deathA' | 'deathB'
  | 'combo' | 'lunge' | 'cleave' | 'roll' | 'stepslash' | 'flamecut' | 'storm' | 'tpstrike' | 'plunge' | 'palm' | 'raise';

const hit = (t: number, window = 0.06) => ({ t, window, reach: 1.9, arc: 120, damage: 0 });

export const WARDEN: Record<WardenMove, MoveDef> = {
  idle: BREAKER.idle, walk: BREAKER.walk, guard: BREAKER.guard, shudder: BREAKER.shudder, guardBreak: BREAKER.guardBreak,
  deathA: BREAKER.deathA, deathB: BREAKER.deathB,
  // Posture break: the existing kneel with the blade planted, held 2.5 s.
  stagger: { ...BREAKER.stagger, duration: 2.5, recovery: 2.3 },
  // Sword (phase 1+).
  combo: { segs: [{ clip: 'Sword_Regular_Combo' }], club: 'clip', layer: 'wardenStep', hits: [hit(0.27), hit(0.73), hit(1.57)], openFrom: 1.7, recovery: 1.3 },
  lunge: { segs: [{ clip: 'Sword_Dash' }], club: 'clip', layer: 'wardenLunge', hits: [hit(0.33, 0.08)], openFrom: 0.43, recovery: 1.2 },
  cleave: { segs: [{ clip: 'Sword_Regular_C' }], club: 'clip', hits: [hit(0.67, 0.07)], openFrom: 0.8, recovery: 1.4 },
  roll: { segs: [{ clip: 'Roll', to: 0.75 }], club: 'clip' },
  stepslash: { segs: [{ clip: 'Sword_Regular_A' }, { clip: 'Sword_Regular_A_Rec' }], club: 'clip', layer: 'wardenStep', hits: [hit(0.27)], openFrom: 0.33, recovery: 1.0 },
  // Fire (phase 2+): a cut that leaves a burning strip, the blade driven into the ground (fire wave; also the phase roar),
  // and a palm cast (fireball volley).
  flamecut: { segs: [{ clip: 'Sword_Regular_B' }, { clip: 'Sword_Regular_B_Rec' }], club: 'clip', hits: [hit(0.27)], openFrom: 0.37, recovery: 1.0 },
  plunge: { segs: [{ clip: 'Sword_Heavy_Combo', from: 2.0, to: 4.3 }], club: 'clip', layer: 'smashTilt', openFrom: 0.67, recovery: 1.6 },
  palm: { segs: [{ clip: 'Sword_Idle' }], duration: 1.6, club: 'none', layer: 'wardenPalm', openFrom: 1.3, recovery: 0.6 },
  // Storm (phase 3): blade raised to call lightning, the two-hit storm combo, and the strike after a teleport.
  raise: { segs: [{ clip: 'Sword_Idle' }], duration: 1.9, club: 'none', layer: 'wardenRaise', openFrom: 1.5, recovery: 0.8 },
  storm: { segs: [{ clip: 'Sword_Regular_B', to: 0.53 }, { clip: 'Sword_Regular_C' }], club: 'clip', hits: [hit(0.27), hit(1.2, 0.07)], openFrom: 1.33, recovery: 1.4 },
  tpstrike: { segs: [{ clip: 'Sword_Regular_A' }, { clip: 'Sword_Regular_A_Rec' }], club: 'clip', layer: 'wardenStep', hits: [hit(0.27)], openFrom: 0.33, recovery: 1.2 },
};

/** Warning (tell) before each move and its glint: pale = parryable, red = unparryable, or a spell colour. */
export type Glint = 'pale' | 'red' | 'fire' | 'storm';
export const WARDEN_TELL: Record<string, { tell: number; glint: Glint }> = {
  combo: { tell: 0.45, glint: 'pale' }, lunge: { tell: 0.5, glint: 'pale' }, cleave: { tell: 0.5, glint: 'red' },
  stepslash: { tell: 0.45, glint: 'pale' }, flamecut: { tell: 0.45, glint: 'pale' }, storm: { tell: 0.5, glint: 'pale' },
  tpstrike: { tell: 0.45, glint: 'pale' }, plunge: { tell: 0.4, glint: 'fire' }, palm: { tell: 0.35, glint: 'fire' },
  raise: { tell: 0.3, glint: 'storm' },
};
export const GLINT_COLOR: Record<Glint, number> = { pale: 0xfff2d8, red: 0xff3a22, fire: 0xff8a2a, storm: 0xc9a8ff };
