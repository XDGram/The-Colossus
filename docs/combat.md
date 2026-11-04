# Combat design — Phase 2 proposal (for review, not implemented)

Built on the approved enemies (`docs/enemies.md`, `src/enemies/moves.ts`). One shared skeleton means the
player can reuse the same UAL clips the enemies use.

## What exists / what's missing

| Area | Exists | Missing |
|---|---|---|
| Player | Walk/jog/sprint, gravity, colliders, sheathed katana | Drawn sword, attacks, dodge, block/parry, hurt/knockdown/death, health |
| Input | WASD + mouse look; mobile joystick, look-drag, RUN | Attack / dodge / block bindings (desktop + 3 mobile buttons) |
| Enemies | Dressed models, 21 + 12 moves, hit timings, reach, arcs, open/recovery windows, `activeHits()` | AI, movement/steering, health, stagger meter, taking damage |
| Systems | — | Hit resolution, attack coordination, HUD (health), hit feedback, defeat/restart |

## 1. Enemy decision-making

Each enemy runs a small state machine; a shared **combat director** decides who may attack.

`Approach → Hold position → (ticket granted) → Tell → Attack → Recover → Reposition`, interrupted by
`React` (dodge / parry / block / flinch / stagger) and `Dead`.

| | Ash Runner | Iron Breaker |
|---|---|---|
| Hold distance | Circles at 3–5 m, drifts to the player's flank/back | Advances steadily to 2–2.5 m, faces the player |
| Move speed | Walk 1.6 / jog 4.3 m/s | Walk ~0.9 m/s; charge 4 m burst |
| Attack choice (in range) | slash / slash2 45%, flurry 25%, lunge (2–4 m) 15%, pommel (close) 10%, spin (player behind or surrounded) 5% | sweep 50%, smash 35% (player in front), stamp if the player is behind/close, charge if the player stays > 5 m for 3 s |
| After attacking | Backs off 2–3 m | Holds ground, raises guard |

## 2. Hit detection, damage, knockback

- **Analytic hit test** (no physics): while a hit is active (`t ± window`), the target is hit if its horizontal
  distance ≤ `reach + 0.38` (body radius), it is within `arc/2` of the attacker's facing, and the height difference is under 1.2 m.
  Each hit damages a target at most once.
- The same test serves player → enemy (player sword: reach 1.6 m, arc 130°).
- **Hit weights** decide the player's reaction:

| Weight | Moves | Player reaction |
|---|---|---|
| Light | Runner slash/flurry/pommel/spin | Flinch (Hit_Chest), pushed back 0.3 m |
| Medium | Runner lunge/finisher, Breaker sweep | Flinch, pushed back 0.8 m |
| Heavy | Breaker smash, charge, stamp | Knockdown (Hit_Knockback + LayToIdle, ~1.6 s), invulnerable while getting up |

## 3. Dodge and parry

- **Dodge (roll):** 0.15–0.45 s of invulnerability, 0.8 s cooldown. Dodges everything, including heavy hits.
- **Block (hold):** cuts light/medium damage by 75% from the front; heavy hits break the guard (no damage block, short stagger).
- **Parry:** block pressed within 0.18 s before a hit lands.
  - vs Runner: no damage, and the Runner is staggered (open 1.0 s).
  - vs Breaker sweep: no damage, +35 to his stagger meter. Smash, charge and stamp **cannot be parried** (dodge them).
- Enemies dodge/parry too: when the player starts an attack within range, a Runner may side-step/roll (35%, 3 s cooldown) or parry (15%).
  A Breaker in guard blocks frontal light hits (pushes the player back); hits from behind always land.

## 4. Telegraphs and reaction windows

The approved clips are fast (Runner hits land 0.27 s in), so every attack gets a **tell** before the move starts:
a short held pose plus a cue (blade/club glint, mask red-line flash).

| Attack | Tell | Move start → hit | Total reaction window |
|---|---|---|---|
| Runner slash / flurry first hit | 0.30 s | 0.27 s | 0.57 s |
| Runner lunge | 0.40 s (low crouch) | 0.33 s | 0.73 s |
| Runner spin | 0.35 s (hop) | 0.45 s | 0.80 s |
| Breaker sweep, first hit | 0.40 s | 0.50 s | 0.90 s |
| Breaker smash | 0.35 s | 0.63 s (club raised from 0.2 s) | 0.98 s |
| Breaker charge | 0.60 s (feet planted, head lowered) | 0.35 s | 0.95 s |
| Breaker stamp | 0.15 s | 0.75 s (knee lift is the tell) | 0.90 s |

## 5. Vulnerability and recovery

Uses the approved `openFrom` / `recovery` values. While open: no block, dodge or parry, and damage taken ×1.5.
Biggest punish windows: Breaker smash (1.6 s), stagger (2.0 s); Runner flurry (1.3 s), lunge (1.2 s).
The Breaker has **super-armour** during his attacks: hits still damage him but don't interrupt him.

## 6. Coordinating Runners and Breakers

- **Attack tickets:** at most 2 enemies attacking at once (max 1 Breaker), at least 0.6 s between attack starts,
  so hits never land at the same instant.
- **Roles:** the Breaker anchors in front; Runners take the flanks and back. A Runner prefers to attack while the Breaker is in recovery,
  to stop the player punishing freely.
- **Spacing:** enemies keep 1.6 m apart and never stand inside a Breaker's sweep arc while he attacks.
- Off-screen enemies don't start attacks (the camera must see the tell).

## 7. Health, damage, stagger

| | Player | Ash Runner | Iron Breaker |
|---|---|---|---|
| Health | 100 | 40 | 140 |
| Player sword damage | — | 10 per hit (4 hits) | 10 per hit (14 hits; ×1.5 when open) |
| Stagger | Knocked down by heavy hits | 2 hits within 1 s → flinch-stagger 0.6 s; parry → 1.0 s | Meter 100: hit +8, hit while open +15, parry +35; decays 10/s after 2 s; full → knee-drop stagger (2.2 s) |

Enemy damage comes from the move table (Runner 5–12, Breaker 10–28). Health regenerates 0 in combat.

## 8. Death and defeat

- **Enemy:** health 0 → Death A or B (random); body stays down 8 s, then sinks/fades. Dead enemies free their ticket.
- **Player:** health 0 → Death01, fade to black, restart at the temple start with full health (enemies reset).
- The mentor is not part of combat yet (untargeted, no AI) until a later phase.

## Recommended build order

1. Player combat kit: draw sword, 3-hit light combo (Sword_Regular_A → B → C), roll, block/parry, hurt/knockdown/death, health.
2. Hit resolver (shared), damage, knockback, hit-stop (0.05 s) and flash feedback.
3. Enemy brain + steering (Runner, then Breaker), health and stagger.
4. Combat director (tickets, roles, spacing).
5. Minimal HUD: player health bar, enemy health over damaged enemies.
6. Test arena behind a dev flag (not an encounter).

## Needs your decision

- **Mobile controls:** combat needs three on-screen buttons (Attack, Dodge, Block). Mobile controls were frozen earlier.
- **Camera:** light screen shake on heavy hits, and an optional soft lock-on. The camera was frozen earlier.
- **Desktop bindings:** left mouse = attack, right mouse = block/parry, Space = dodge (Shift stays sprint).
