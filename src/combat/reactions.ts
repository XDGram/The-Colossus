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
/** lift: launch speed upward (m/s) for the Runner; armoured classes are launched less (LIFT_SCALE). */
/**
 * giant: the Iron Breaker's reaction (heavy armour, heavier than a Runner's): jolt = shoulder jolt and a half step,
 * never stops his swing; stumble = staggers back 1-2 m, interrupted unless mid-swing; reel = a long stagger, turned
 * aside, interrupts even a swing; knee = thrown to one knee.
 */
export type GiantReaction = 'none' | 'jolt' | 'stumble' | 'reel' | 'knee';
export interface Reaction { lean: number; twist: number; knock: number; runner: RunnerReaction; giant: GiantReaction; lift?: number }

export const REACTIONS: Record<PlayerMoveName, Reaction> = {
  cut1: { lean: 0.32, twist: 0.12, knock: 0.2, runner: 'flinch', giant: 'jolt' },
  cut2: { lean: 0.34, twist: -0.14, knock: 0.22, runner: 'flinch', giant: 'jolt' },
  cut3: { lean: 0.5, twist: 0.2, knock: 0.9, runner: 'stagger', giant: 'jolt' },
  lunge: { lean: 0.48, twist: 0, knock: 1.0, runner: 'stagger', giant: 'stumble' },
  riposte: { lean: 0.6, twist: 0.25, knock: 1.0, runner: 'stagger', giant: 'stumble' },
  heavy: { lean: 0.62, twist: 0.3, knock: 1.2, runner: 'stagger', giant: 'stumble' },
  kick: { lean: 0.55, twist: 0, knock: 1.4, runner: 'stagger', giant: 'stumble' },
  roll: { lean: 0, twist: 0, knock: 0, runner: 'flinch', giant: 'none' },
  spin: { lean: 0.45, twist: 0.9, knock: 0.8, runner: 'stagger', giant: 'stumble' },
  leap: { lean: 0.7, twist: 0.1, knock: 1.4, runner: 'knockdown', giant: 'reel', lift: 3.5 },
  // Abilities.
  phantom: { lean: 0.35, twist: 1.1, knock: 0.6, runner: 'stagger', giant: 'jolt' },
  rift: { lean: 0.75, twist: 0.2, knock: 2.6, runner: 'knockdown', giant: 'reel' },
  // The ground shatters under them: launched into the air, slammed down, then dragged in by the pull.
  rupture: { lean: 0.55, twist: 0.4, knock: 0, runner: 'knockdown', giant: 'knee', lift: 5.5 },
  implode: { lean: 0.7, twist: 0.4, knock: 1.6, runner: 'knockdown', giant: 'reel', lift: 3 },
};
/** Slide multiplier for the armoured classes (heavy armour: they barely move, so a combo stays in reach). */
export const KNOCK_SCALE = { runner: 1, breaker: 0.08, warden: 0.05 };
/** Launch multiplier for the armoured classes (a Breaker only hops; the Warden barely leaves the ground). */
export const LIFT_SCALE = { runner: 1, breaker: 0.45, warden: 0.2 };
/** Giant reactions: extra slide (m) and how long he can't start an attack afterwards (s). */
export const GIANT = { jolt: { knock: 0.25, stun: 0.5 }, stumble: { knock: 1.4, stun: 1.0 }, reel: { knock: 2.0, stun: 1.4 }, knee: { knock: 0.3, stun: 1.6 } };
/** After a hit reaction a Runner waits this long before deciding to attack again (the player keeps the initiative). */
export const HITSTUN_COOLDOWN = 0.6;
