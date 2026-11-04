# Combat design — Phase 2 (revision 2, for approval; not implemented)

Built on the approved enemies (`docs/enemies.md`, `src/enemies/moves.ts`). The player shares the enemies'
skeleton, so every player move below reuses a clip already in `enemies.glb` (UAL1 + UAL2).
Clip lengths quoted are measured from that file.

**Pillars:** timing, positioning, dodging and parrying win fights. Mashing loses them (see 1.3).

## Decisions (approved)

| Area | Decision |
|---|---|
| Desktop | Left mouse = Attack, Right mouse = Block/Parry (hold = block, press = parry), Space = Dodge, Shift = Sprint |
| Mobile | Add Attack, Dodge and Block buttons. The existing joystick and RUN button are not moved, resized or restyled; the new buttons sit in free space on the right side |
| Camera | Unchanged: no shake, no lock-on |
| Coordination | Max 2 enemies attacking at once (max 1 Breaker), 0.6 s between attack starts, Breaker anchors / Runners flank |

## What exists / what's missing

| Area | Exists | To build |
|---|---|---|
| Player | Walk/jog/sprint, gravity, colliders, sheathed katana | Drawn katana, combo, sprint attack, roll, block/parry, hurt/knockdown/death, health |
| Input | WASD + mouse look; mobile joystick, look-drag, RUN | Mouse buttons, Space; three mobile buttons |
| Enemies | Models, move table (hits, reach, arcs, open/recovery), `activeHits()` | AI, steering, health, poise/stagger, taking hits |
| Systems | — | Swept hit resolver, combat director, minimal HUD, defeat/restart |

---

## 1. Player katana moves

### 1.1 Move list

| Move | Clip (length) | Active (hit) | Chain window | If not chained | Vulnerable until |
|---|---|---|---|---|---|
| Cut 1 | Sword_Regular_A (0.43 s) | 0.24–0.30 s | 0.33–0.43 s → Cut 2 | first 0.45 s of A_Rec | 0.88 s |
| Cut 2 | Sword_Regular_B (0.53 s) | 0.24–0.30 s | 0.37–0.53 s → Cut 3 | first 0.50 s of B_Rec | 1.03 s |
| Cut 3 (finisher) | Sword_Regular_C, cut at 1.30 s | 0.62–0.72 s | — | — | 1.30 s |
| Sprint lunge | Sword_Dash (1.57 s), attack while sprinting | 0.28–0.40 s | — | — | 1.20 s |
| Riposte | Sword_Regular_C at 1.15× speed, attack within 1.0 s of a parry | 0.54–0.63 s | — | — | 1.13 s |
| Roll | Roll (1.47 s), cut at 0.75 s | invulnerable 0.12–0.45 s | — | — | 0.75 s |
| Block | Sword_Block (1.23 s), held in its guard pose | guard up at 0.10 s | — | — | lowers in 0.15 s |
| Flinch | Hit_Chest (0.33 s) / Hit_Head (0.43 s) | — | — | — | 0.35 s |
| Knockdown | Hit_Knockback (0.83 s) + LayToIdle (1.53 s) | — | — | — | 2.0 s, invulnerable from 0.6 s |
| Death | Death01 (2.40 s) | — | — | — | — |

The katana is drawn when combat starts (an enemy within 12 m) and sheathed 6 s after the last enemy is out of range.

### 1.2 Cancels

- Roll can cancel Cut 1/Cut 2 recovery and Block, but **not** an active hit window or Cut 3.
- Block can cancel any recovery after its first 0.2 s.
- Nothing cancels a knockdown before its invulnerable get-up.

### 1.3 Anti-mash rules

- An attack press only queues the next cut if it arrives in the **0.15 s buffer** before the chain window, or inside it.
  A press earlier than that is a mash: the chain ends and the move goes to its recovery.
- After a dropped chain, the next Cut 1 cannot start for 0.25 s.
- A Runner's chance to parry a Cut 1 rises 10% for each unchained Cut 1 in the last 3 s (cap 50%).
  A parried player is stunned for 0.5 s (Hit_Head), which is easy to punish.

## 2. Damage and health

### 2.1 Player attacks

| Move | Damage | Runner poise | Breaker meter |
|---|---|---|---|
| Cut 1 | 8 | 10 | +6 |
| Cut 2 | 8 | 10 | +6 |
| Cut 3 | 16 | 25 | +15 |
| Sprint lunge | 14 | 20 | +10 |
| Riposte | 30 | breaks | +30 |

**Open bonus:** hits on an enemy in recovery or stagger deal ×1.5 damage and double meter gain.

### 2.2 Enemy attacks (from the move table)

| Enemy | Move | Damage | Weight | Parry | Blocked damage |
|---|---|---|---|---|---|
| Runner | slash / slash2 | 8 | light | yes | 2 |
| Runner | flurry (×3) | 6 each | light | yes | 2 each |
| Runner | finisher | 12 | medium | yes | 3 |
| Runner | lunge | 12 | medium | yes | 3 |
| Runner | pommel | 5 | light | yes | 1 |
| Runner | spin | 10 | light | no | 3 |
| Breaker | sweep (×3) | 12 / 12 / 14 | medium | yes | 3 / 3 / 4 |
| Breaker | smash | 28 | heavy | no | breaks guard, 14 |
| Breaker | charge | 20 | heavy | no | breaks guard, 10 |
| Breaker | stamp (shockwave) | 10 | heavy | no | breaks guard, 5 |

### 2.3 Health (reviewed)

| | Health | Takes | Typical fight |
|---|---|---|---|
| Player | 100 | 3–4 Breaker smashes, or about 12 Runner slashes | — |
| Ash Runner | **40** (kept) | Cut 1-2-3 (32) + one cut, or a riposte + one cut | 2 good exchanges, about 6–10 s |
| Iron Breaker | **120** (down from 140) | About 2.5 punish windows: a full combo into recovery or stagger deals 48 | 3 punishes, about 25–35 s alone |

140 meant four or more punish cycles. Alongside Runners that dragged, so 120 keeps him a wall without becoming a grind.

## 3. Hit detection (swept, frame-rate independent)

Single-point distance checks miss fast and moving attacks, so every active hit is tested as a **swept volume between frames**.

**Weapon hits** (all cuts, sweep, smash, slashes, lunges):
- Each frame, the weapon is a segment from hilt to tip, taken from its mount at its true length: katana 0.95 m, Runner blade 0.5 m, club 1.74 m.
- Between the previous and current frame, the segment is interpolated in sub-steps. There are enough sub-steps that the tip moves at most 0.1 m per step (2–12 per frame).
- Each sub-step segment is tested against the target's capsule: a vertical segment 0.1–1.75 m high, radius 0.38 m for the player and Runner, 0.48 m for the Breaker.
  It's a hit if the distance is at most capsule radius + weapon radius (blade 0.03 m, club head 0.085 m).
- Both bodies' movement over the frame (root motion, lunge, roll, charge drive) is included by interpolating their capsules over the same sub-steps.
  A lunge through the player, or a player rolling through a swing, is therefore tested along the whole path.

**Body hits:**
- **Charge:** the Breaker's torso capsule (radius 0.5 m) is swept along his 4 m path during 0.05–0.65 s. On contact the charge stops (he doesn't pass through).
- **Stamp:** a ground ring expanding from 0 to 2.2 m over 0.75–0.90 s. It only hits targets on the ground within 0.4 m of the ring's edge; mid-roll invulnerability avoids it.

**Rules:**
- An attack instance hits each target at most once, even across sub-steps.
- Walls: no hit if a collider blocks the line from the attacker's chest to the contact point.
- The approved reach and arc values become a cheap pre-filter and the AI's "in range" test; the swept test decides the hit.

## 4. Block vs parry

| | Block (hold) | Parry (timed press) |
|---|---|---|
| Input | Hold right mouse / Block | Press from neutral, not while already blocking |
| Active | From 0.10 s after the press, for as long as it's held | The first 0.18 s after the press |
| Covers | 120° in front | 120° in front |
| Light / medium hit | Damage ×0.25, pushed back 0.3 m | No damage. Runner staggered 1.0 s; Breaker sweep: meter +35. Opens the riposte for 1.0 s |
| Heavy hit | Guard breaks: blocked damage, stunned 0.8 s | Not parryable |
| Movement | Walk at 50%, no sprint or attack | — |
| Miss / spam | — | A press with no hit has a 0.5 s parry lockout (you still block if you keep holding) |

So holding block is safe but slow and leaks chip damage, while a parry needs exact timing and pays off with a riposte.

**Telegraph colour tells which is which:**
- A pale glint on the weapon means parryable.
- A red flash on the mask line means unparryable (dodge it).

## 5. Telegraphs and reaction windows

Every enemy attack is preceded by a tell: a held pose plus the glint or flash.

| Attack | Tell | Tell → hit | Reaction window |
|---|---|---|---|
| Runner slash / flurry (1st hit) | 0.30 s | 0.27 s | 0.57 s |
| Runner lunge | 0.40 s | 0.33 s | 0.73 s |
| Runner spin (red) | 0.35 s | 0.45 s | 0.80 s |
| Breaker sweep (1st hit) | 0.40 s | 0.50 s | 0.90 s |
| Breaker smash (red) | 0.35 s | 0.63 s | 0.98 s |
| Breaker charge (red) | 0.60 s | 0.35 s | 0.95 s |
| Breaker stamp (red) | 0.15 s | 0.75 s | 0.90 s |

The parry window (0.18 s) and roll invulnerability (0.33 s) both fit inside every reaction window.

## 6. Vulnerability, interrupts, poise and stagger

**Enemy open windows** use the approved `openFrom` / `recovery` values. While open, an enemy can't block, dodge or parry, and takes the open bonus.

**Ash Runner — poise 20:**
- Each player hit adds poise damage (table 2.1).
- When poise reaches 20, he **flinches** (0.35 s) and his current move is interrupted, but only during a tell or before his hit's active window (not after it has landed).
- Poise resets 1.5 s after the last hit.
- A parry or riposte always breaks him (1.0 s stagger, then he retreats).
- During a dodge or roll he is untouchable, as the player is.

**Iron Breaker — super-armour plus a stagger meter (100):**
- Light hits never interrupt him: he takes damage and keeps swinging.
- The meter fills from hits (table 2.1) and from parries (+35, sweep only). It decays 10/s once 2 s have passed without gain.
- When it fills, he drops into the knee-drop stagger (2.2 s, open, ×1.5 damage). The meter then resets, and he can't be staggered again for 4 s.
- Hitting him from behind adds ×1.5 meter gain (rewards positioning).

**Player poise:** none. Every unblocked hit lands its reaction (light or medium flinch, heavy knockdown). The 0.35 s flinch gives a little invulnerability, so one hit isn't followed by a free combo.

## 7. Enemy decision-making and teamwork

**States:** `Approach → Hold → (ticket) → Tell → Attack → Recover → Reposition`.
Interrupted by `Dodge / Parry / Block / Flinch / Stagger / Dead`.

| | Ash Runner | Iron Breaker |
|---|---|---|
| Hold | Circles at 3–5 m, works to the player's flank/back | Advances to 2–2.5 m, guard up, faces the player |
| Choice in range | slash 45%, flurry 25%, lunge (2–4 m) 15%, pommel (close) 10%, spin (player behind or surrounded) 5% | sweep 50%, smash 35% (front), stamp (player close/behind), charge (player > 5 m for 3 s) |
| Reacts to player attack in range | side-step/roll 35% (3 s cooldown), parry 15% (+ anti-mash bonus) | guard blocks frontal Cut 1/2 when not attacking |
| After attacking | Backs off 2–3 m | Holds ground, guard up |

**Teamwork:**
- At most 2 enemies attack at once (1 Breaker), with 0.6 s between starts, so hits never land together.
- Runners prefer to attack while the Breaker is recovering.
- Enemies keep 1.6 m apart and stay out of a swinging Breaker's arc.
- Off-screen enemies don't start attacks.

## 8. Death and defeat

- **Enemy:** health 0 → Death A or B (random). It frees its ticket. The body stays 8 s, then sinks away.
- **Player:** health 0 → Death01, fade to black, restart at the temple start with full health; enemies reset.
- **Mentor:** not in combat in this phase.

## Build order

1. Input bindings and mobile buttons (new buttons only).
2. Player combat kit (moves, cancels, anti-mash, block/parry, health, reactions).
3. Swept hit resolver and damage.
4. Enemy brains, steering, poise and stagger.
5. Combat director.
6. Minimal HUD: player health bar, plus enemy health above damaged enemies.
7. Dev-only test arena (`?combat`, not an encounter).
