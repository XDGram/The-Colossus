import type { PlayerMoveName } from './tables';

/**
 * How enemies react to each player attack (docs/combat.md §6, revised). Every hit that lands produces:
 *
 * - a physical hit layer: the spine, neck and head snap away from the blow and spring back (src/enemies/enemy.ts),
 *   on top of whatever the body is doing, even during an armoured swing;
 * - a knockback: the body slides back along the blow through the normal wall resolve;
 * - a reaction move: Runners are always interrupted (flinch, stagger or knockdown by the weight of the attack);
 *   a Breaker's warning (tell) is cancelled by any hit, but his swing is armoured; the Temple Warden keeps his boss
 *   armour (physical layer and knockback only, plus his existing shudder and knee-drop).
 *
 * lean: radians of the snap away from the blow; twist: radians of turn about the spine (Phantom Step spins them);
 * knock: metres of slide (Runner; armoured classes slide less); runner: the Runner's reaction.
 */
export type RunnerReaction = 'flinch' | 'stagger' | 'knockdown';
export interface Reaction { lean: number; twist: number; knock: number; runner: RunnerReaction; lift?: number }

export const REACTIONS: Record<PlayerMoveName, Reaction> = {
  cut1: { lean: 0.32, twist: 0.12, knock: 0.3, runner: 'flinch' },
  cut2: { lean: 0.34, twist: -0.14, knock: 0.35, runner: 'flinch' },
  cut3: { lean: 0.5, twist: 0.2, knock: 0.9, runner: 'stagger' },
  lunge: { lean: 0.48, twist: 0, knock: 1.0, runner: 'stagger' },
  riposte: { lean: 0.6, twist: 0.25, knock: 1.0, runner: 'stagger' },
  heavy: { lean: 0.62, twist: 0.3, knock: 1.2, runner: 'stagger' },
  kick: { lean: 0.55, twist: 0, knock: 1.4, runner: 'stagger' },
  roll: { lean: 0, twist: 0, knock: 0, runner: 'flinch' },
  // Abilities.
  phantom: { lean: 0.35, twist: 1.1, knock: 0.6, runner: 'stagger' },
  rift: { lean: 0.75, twist: 0.2, knock: 2.6, runner: 'knockdown' },
  rupture: { lean: 0.4, twist: 0.3, knock: 0, runner: 'stagger', lift: 0.25 },
  implode: { lean: 0.7, twist: 0.4, knock: 1.6, runner: 'knockdown' },
};
/** Slide multiplier for the armoured classes (heavy armour: they barely move, so a combo stays in reach). */
export const KNOCK_SCALE = { runner: 1, breaker: 0.08, warden: 0.05 };
/** After a hit reaction a Runner waits this long before deciding to attack again (the player keeps the initiative). */
export const HITSTUN_COOLDOWN = 0.6;
