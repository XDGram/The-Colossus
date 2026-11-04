/**
 * Attack permissions (docs/combat.md §7): at most two enemies attacking at once, at most one of them a Breaker,
 * and at least 0.6 s between attack starts. An enemy holds a ticket from the start of its tell until its attack
 * (including recovery) ends; the tell may only start where the player's camera can see it.
 */
export type EnemyKind = 'runner' | 'breaker';

export const DIRECTOR = { maxAttackers: 2, maxBreakers: 1, startGap: 0.6 };

export class AttackDirector {
  private holders = new Map<string, EnemyKind>();
  private lastStart = -Infinity;
  /** Log of granted starts [time, id] (tests). */
  readonly starts: [number, string][] = [];

  constructor(private visible: (p: { x: number; y: number; z: number }) => boolean) {}

  get attackers() { return this.holders.size; }
  holds(id: string) { return this.holders.has(id); }

  /** Ask to start an attack (its tell) now. Grants and records the start if every rule allows it. */
  tryStart(id: string, kind: EnemyKind, now: number, tellAt: { x: number; y: number; z: number }) {
    if (this.holders.has(id)) return true;
    if (this.holders.size >= DIRECTOR.maxAttackers) return false;
    if (kind === 'breaker' && [...this.holders.values()].filter((k) => k === 'breaker').length >= DIRECTOR.maxBreakers) return false;
    if (now - this.lastStart < DIRECTOR.startGap) return false;
    if (!this.visible(tellAt)) return false;
    this.holders.set(id, kind); this.lastStart = now; this.starts.push([now, id]);
    return true;
  }
  /** The attack (and its recovery) is over, or the enemy was interrupted / died. */
  release(id: string) { this.holders.delete(id); }
  breakerAttacking() { return [...this.holders.values()].includes('breaker'); }
}
