/**
 * Attack permissions (docs/combat.md §7): at most three enemies attacking at once, at most one of them a Breaker,
 * and at least 0.4 s between attack starts. An enemy holds a ticket from the start of its tell until its attack
 * (including recovery) ends; the tell may only start where the player's camera can see it.
 */
export type EnemyKind = 'runner' | 'breaker';

export const DIRECTOR = { maxAttackers: 3, maxBreakers: 1, startGap: 0.4,
  /**
   * Off-screen attacks (revised): an enemy the player can't see may still attack — one at a time, at least 1.1 s
   * apart — with a battle cry from its direction, a screen-edge marker and a longer warning (OFFSCREEN_TELL).
   */
  offscreenGap: 1.1 };
/** Extra warning time (s) for an attack that starts off screen. */
export const OFFSCREEN_TELL = 0.3;

export class AttackDirector {
  private holders = new Map<string, EnemyKind>();
  private lastStart = -Infinity;
  private lastOffscreen = -Infinity;
  private offscreen = new Set<string>();
  /** Called when an attack is granted off screen (the game plays the cry and shows the edge marker). */
  onOffscreen: ((id: string) => void) | null = null;
  /** While set (the Warden boss's spells / teleport), only this enemy may start attacks. */
  exclusive: string | null = null;
  /** Log of granted starts [time, id] (tests). */
  readonly starts: [number, string][] = [];

  /** `visible` decides whether the player can genuinely see the warning (on screen and unobstructed). */
  constructor(private visible: (pts: { x: number; y: number; z: number }[], requester: string) => boolean) {}

  get attackers() { return this.holders.size; }
  holds(id: string) { return this.holders.has(id); }

  /** Ask to start an attack (its tell) now. Grants and records the start if every rule allows it. */
  tryStart(id: string, kind: EnemyKind, now: number, tellAt: { x: number; y: number; z: number }[]) {
    if (this.holders.has(id)) return true;
    if (this.exclusive && this.exclusive !== id) return false;
    if (this.holders.size >= DIRECTOR.maxAttackers) return false;
    if (kind === 'breaker' && [...this.holders.values()].filter((k) => k === 'breaker').length >= DIRECTOR.maxBreakers) return false;
    if (now - this.lastStart < DIRECTOR.startGap) return false;
    const seen = this.visible(tellAt, id);
    if (!seen) {
      // At most one unseen attacker at a time, and not in quick succession.
      if ([...this.offscreen].some((o) => this.holders.has(o)) || now - this.lastOffscreen < DIRECTOR.offscreenGap) return false;
      this.offscreen.add(id); this.lastOffscreen = now;
    } else this.offscreen.delete(id);
    this.holders.set(id, kind); this.lastStart = now; this.starts.push([now, id]);
    if (!seen) this.onOffscreen?.(id);
    return true;
  }
  /** Would this enemy's warning be visible to the player right now (on screen and unobstructed)? */
  canSee(id: string, pts: { x: number; y: number; z: number }[]) { return this.visible(pts, id); }
  /** The attack (and its recovery) is over, or the enemy was interrupted / died. */
  release(id: string) { this.holders.delete(id); this.offscreen.delete(id); }
  /** Was this enemy's current attack started off screen (longer warning)? */
  unseen(id: string) { return this.offscreen.has(id) && this.holders.has(id); }
  breakerAttacking() { return [...this.holders.values()].includes('breaker'); }
}
