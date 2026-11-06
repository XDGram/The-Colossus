# Stage 2C combat test results

**Result: 152 / 165 checks passed, 13 failed.** The 13 failures come from **5 implementation issues** (section 2).
No gameplay code was changed and no expected value was adjusted. Per the instructions, every failure is recorded here
and nothing has been fixed.

| | |
|---|---|
| Harness | `tools/combattest.mjs` (run: `npm run dev`, then `node tools/combattest.mjs`; `--only <group,…>` for a subset) |
| Code under test | `feature/mentor-temple` @ `fcfd223`, gameplay unchanged (only `docs/` and `tools/` differ on this branch) |
| Expected values | `docs/combat.md`, including the two rulings resolved on this branch (pommel blocked = 1; a parry press is not a guard against any unparryable attack) |
| Environment | Headless Chromium (Playwright 1.63, SwiftShader), Node 22, three 0.170, Vite 5.4; `?quality=low` |
| Repeatability | Two full runs gave the same pass/fail on all 165 checks. Controlled tests (fixed seed, 1/60 s steps) reproduce exactly. The two unmodified-AI runs (items 13 and 18) vary in detail between runs, e.g. 11 vs 20 attack starts in the 60 s fight, because the game renders a few real-time frames before the harness pauses it. |

## 1. How the harness works

- **Isolation.** Pages load the dev arena `/?combat=r1b0` (one Runner), `r0b1` (one Breaker) or `r2b1` (two Runners and a
  Breaker). With `?combat` set, the encounter, waves and Temple Warden are off, and no spec includes a Warden.
- **Determinism.** The game is paused and stepped with `__tlc.step(1, 1/60)`.
- **Player input** goes through the real `Input` queues. Attack is only ever tapped, never held, so the unapproved heavy
  slash cannot start. Attack is never pressed while blocking, so the unapproved guard-break kick cannot start. Neither
  move is tested.
- **Controlled enemies (test-side only).** For targeted tests, the enemy's decision, steering, turning and auto-dodge
  methods are stubbed on that instance only. A specific attack is started through the brain's own `beginTell()`. The
  finisher has no tell entry and is never chosen by the AI (the same as the doc's choice table), so it is started
  directly in its attack state.
- **Unmodified AI.** The multi-enemy test (item 13) and the Stage 2B behaviour samples (item 18) use the AI unchanged.
- **Measurements** are read from `CombatSystem.log` and `PlayerCombat.trace`. Each entry is captured with a snapshot of
  player and enemy state at the moment it was written.
- **Expected values are written into the harness from the doc**, not imported from `src/combat/tables.ts`.
- **Tolerances** (set before the run):

  | Measurement | Tolerance |
  |---|---|
  | Player active windows, roll i-frames, guard raise | ±1 frame (16.7 ms) |
  | Enemy hit times (the doc gives a single impact time) | ±0.10 s |
  | Reaction durations | ±0.05 s |
  | Distances | ±0.10 m |
  | Breaker hold band | ±0.05 m |

- **Setup steps that are not gameplay changes:** some tests set health or meter values directly (e.g. a Runner at
  8 HP for a kill). The multi-enemy run tops the player's health up once per second so restarts don't cut it short.

## 2. Failures (implementation does not match docs/combat.md)

### F1. The Breaker's shoulder charge can never hit the player (7 checks)

Failed checks:
- Charge damage (20).
- Charge hit time (0.05–0.65 s).
- Charge reaction (knockdown).
- Charge vs an active block (10 + guard break).
- Charge guard-break stun.
- Charge vs a parry press.
- "Charge stops on contact".

The charge plays and drives forward, but it stops 0.91 m from the player and never registers a hit (0 hits from 2.2 m,
3.0 m and 4.0 m).

**Cause:**
- `EnemyBrain.constrain` (`src/combat/brain.ts`) keeps every enemy at least
  `player radius + enemy radius + 0.05 = 0.38 + 0.48 + 0.05 = 0.91 m` from the player.
- The charge's swept body test (`src/combat/system.ts`, `CHARGE_BODY.radius = 0.5`, against `BODY.player.radius = 0.38`)
  needs the centres within `0.5 + 0.38 = 0.88 m`.
- The 0.03 m gap means contact is impossible.
- The synthetic Stage 2A charge test (no separation rule) still passes. The bug only appears when the two systems run
  together.

### F2. A parry press counts as a guard against unparryable attacks (3 checks)

Rule: a parry press from neutral is not an active guard. The Runner's spin should deal 10 with a light flinch, and the
smash and stamp should deal full damage with a knockdown.

Measured, with the parry press timed 0.08 s before contact and no active block:

| Attack | Measured | Expected |
|---|---|---|
| Spin | blocked, 3 damage | 10, light flinch |
| Smash | guard break, 14 damage, stun | 28, knockdown |
| Stamp | guard break, 5 damage, stun | 10, knockdown |

The charge is also affected in principle but can't be shown because of F1.

**Cause:** `src/player/combat.ts:215`, `if (front && (this.guardUp || this.parryT > 0))`. An open parry window is
treated as a guard. This was flagged before the run; the harness confirms it.

### F3. The Runner's spin cut lands 0.12 s before its documented hit time (1 check)

- Doc (tables A and §5): hit at 0.45 s after a 0.35 s tell, so a 0.80 s reaction window.
- Measured: contact at move time 0.33 s with the player in front, so a reaction window of about 0.68 s.
- **Cause:** the move's active window is 0.45 ± 0.14 s (`src/enemies/moves.ts`, `spin`). The 360° blade connects as
  soon as it sweeps past the player, which happens early in that window.

### F4. A blocked hit pushes the player back 0.48 m, not 0.3 m (1 check)

- The 0.3 m push itself is applied correctly: 2 m/s for 0.15 s.
- In the block state, the player's movement velocity then eases out instead of stopping, adding about 0.18 m.
- Settled total: 0.48 m.
- In a flinch (movement locked) the same 0.3 m push stops exactly at 0.30 m.
- **Cause:** `PlayerCombat` (`src/player/combat.ts`, `c.lockMove`) leaves movement unlocked while blocking, so
  `Player.update` keeps the push velocity and decelerates it.

### F5. The Breaker settles anywhere from 1.7 to 2.5 m, not 2.0–2.5 m (1 check, Stage 2B regression)

- Starting at 1.8 m, he stays at 1.80 m. He only backs off below 1.7 m.
- When he approaches from range, he correctly stops at 2.49 m (that check passes).
- **Cause:** `EnemyBrain.holdLine` (`src/combat/brain.ts`) backs off only when `dist < hold[0] - 0.3`, a 0.3 m dead band
  under the documented 2.0 m.
- It showed up in practice: after a 60 s fight his median spacing was 1.71 m.

## 3. Observations (not failures)

- **Guard raise is one frame late.** The guard comes up on the frame at 0.1167 s, not 0.100 s. Summing 1/60 s steps
  gives 0.0999… at frame 6, so `blockT >= 0.1` is true one frame later. This is within the stated ±1-frame tolerance
  and recorded as a pass.
- **Hits land slightly before their nominal time.** Enemy hits land 0.01–0.07 s before the doc's impact times, at the
  start of each move's active window: slash 0.22 vs 0.27, finisher 0.60 vs 0.67, sweep 0.48/1.13/1.78 vs 0.50/1.17/1.83.
  All are within ±0.10 s except the spin (F3).
- **Unused, wrong numbers in `src/enemies/moves.ts`.** The `damage` fields in the hit table disagree with the doc:
  flurry 7, sweep 14/14/16, charge 18. They are **not used**: damage comes from `src/combat/tables.ts`, which matches
  the doc and is what the tests measured. These dead fields could mislead future work.
- **An unaided player takes only 2 of the 3 sweep hits** (12 and 14). The 0.8 m push-back after hit 1 moves him outside
  the shorter second arc (reach 1.8 m). The per-hit tests re-place the player after each hit and confirm all three
  values (12/12/14).
- **The finisher is unreachable in play.** It is defined in the move table but never chosen by the AI. That matches the
  doc's §7 choice list, which doesn't include it.
- **Breaker walking speed:** median 0.92 m/s within 8 m (passes). Individual frames reach 1.73 m/s, from separation
  pushes and the double-pace approach beyond 8 m added after Stage 2B.

## 4. Results by requirement

| # | Requirement | Result |
|---|---|---|
| 1 | Player attacks → Runner | 13/13 |
| 2 | Player attacks → Breaker | 8/8 |
| 3 | Runner attacks → player (all 9 hits) | 27/28 (F3) |
| 4 | Breaker attacks → player (all 6 hits) | 10/13 (F1) |
| 5 | Block | 14/17 (F4, F1 ×2) |
| 6 | Parry | 12/16 (F2 ×3, F1) |
| 7 | Riposte and open / positional multipliers | Included in 1, 2 and the 2 multiplier checks: all pass |
| 8 | Runner poise | 6/6 |
| 9–10 | Breaker meter, knee-drop, immunity, decay | 7/7 |
| 11 | Knockdowns | 2/3 (F1) |
| 12 | Death (Runner, Breaker, player and restart) | 6/6 |
| 13 | Multiple enemies (unmodified AI, 60 s) | 5/5 |
| 14 | Wall obstruction | 3/3 |
| 15 | Moving targets | 4/4 |
| 16 | Stage 1 regression | 8/8 |
| 17 | Stage 2A regression (existing `tools/hittest`, unchanged) | 20/20 |
| 18 | Stage 2B regression | 5/6 (F5) |

## 5. Full output (run 1)

```
PASS  [1 Player → Runner] Cut 1 deals 8  — hits 8, hp 40→32
PASS  [1 Player → Runner] Cut 1 lands inside its active window 0.24–0.30 s  — at move time 0.25
PASS  [1 Player → Runner] Combo Cut 1-2-3 deals 8 / 8 / 16 = 32  — cut1:8@0.25 cut2:8@0.25 cut3:16@0.67
PASS  [1 Player → Runner] Cut 2 lands inside 0.24–0.30 s, Cut 3 inside 0.62–0.72 s  — cut1:8@0.25 cut2:8@0.25 cut3:16@0.67
PASS  [1 Player → Runner] Sprint lunge deals 14  — moves start lunge; hits lunge:14
PASS  [1 Player → Runner] Sprint lunge lands inside 0.28–0.40 s  — at 0.32
PASS  [1 Player → Runner] Riposte after a parry, Runner staggered (open): 30 × 1.5 = 45  — parry true; riposte:45 (enemy stagger)
PASS  [1 Player → Runner] Riposte lands inside 0.54–0.63 s  — at 0.58
PASS  [1 Player → Runner] Riposte of 45 kills a 40 HP Runner  — hp 0
PASS  [1 Player → Runner] Riposte after the Runner's 1.0 s stagger has ended deals 30  — riposte:30 (enemy reposition)
PASS  [1 Player → Runner] Cut 1 on a Runner in recovery (open) deals 8 × 1.5 = 12  — 12 cut1 (open x1.5) hp 28 (enemy attack t=0.4)
PASS  [1 Player → Runner] Open hit doubles poise (10 → 20): poise break  — hit, poise broken, attack already landed: no interrupt
PASS  [1 Player → Runner] …but the slash had already landed: no interrupt  — hit, poise broken, attack already landed: no interrupt
PASS  [8 Runner poise] Cut 1 + Cut 2 (10 + 10 = 20) breaks poise: flinch  — hit 8, hit 8, flinched
PASS  [8 Runner poise] Runner flinch length ≈ 0.35 s  — 0.37 s
PASS  [8 Runner poise] Poise break during the tell interrupts the attack (flinch)  — hit [hold/idle], hit [tell/lunge], flinched [flinch/flinchChest]
PASS  [8 Runner poise] Interrupted attack never lands on the player  — player hp 100
PASS  [8 Runner poise] Poise resets 1.5 s after the last hit (second Cut 1 after 1.6 s: no flinch)  — {"flinched":false,"poiseLog":[0,0]}
PASS  [8 Runner poise] Within the reset time poise accumulates (second Cut 1 after 1.0 s: flinch)  — {"flinched":true,"poiseLog":[0,10]}
PASS  [3 Runner → player] slash: 1 hit(s) of 8  — got player hit 8
PASS  [3 Runner → player] slash: hit time(s) 0.27 s (±0.1)  — at 0.22
PASS  [3 Runner → player] slash: reaction flinch  — flinch
PASS  [3 Runner → player] slash: push-back 0.3 m  — 0.30 m
PASS  [3 Runner → player] slash2: 1 hit(s) of 8  — got player hit 8
PASS  [3 Runner → player] slash2: hit time(s) 0.27 s (±0.1)  — at 0.22
PASS  [3 Runner → player] slash2: reaction flinch  — flinch
PASS  [3 Runner → player] slash2: push-back 0.3 m  — 0.30 m
PASS  [3 Runner → player] flurry: 3 hit(s) of 6/6/6  — got player hit 6, player hit 6, player hit 6
PASS  [3 Runner → player] flurry: hit time(s) 0.27/0.73/1.57 s (±0.1)  — at 0.22/0.68/1.52
PASS  [3 Runner → player] flurry: reaction flinch  — flinch/flinch/flinch
PASS  [3 Runner → player] finisher: 1 hit(s) of 12  — got player hit 12
PASS  [3 Runner → player] finisher: hit time(s) 0.67 s (±0.1)  — at 0.60
PASS  [3 Runner → player] finisher: reaction flinch  — flinch
PASS  [3 Runner → player] finisher: push-back 0.8 m  — 0.80 m
PASS  [3 Runner → player] lunge: 1 hit(s) of 12  — got player hit 12
PASS  [3 Runner → player] lunge: hit time(s) 0.33 s (±0.1)  — at 0.28
PASS  [3 Runner → player] lunge: reaction flinch  — flinch
PASS  [3 Runner → player] lunge: push-back 0.8 m  — 0.80 m
PASS  [3 Runner → player] pommel: 1 hit(s) of 5  — got player hit 5
PASS  [3 Runner → player] pommel: hit time(s) 0.27 s (±0.1)  — at 0.23
PASS  [3 Runner → player] pommel: reaction flinch  — flinch
PASS  [3 Runner → player] pommel: push-back 0.3 m  — 0.30 m
PASS  [3 Runner → player] spin: 1 hit(s) of 10  — got player hit 10
FAIL  [3 Runner → player] spin: hit time(s) 0.45 s (±0.1)  — at 0.33
PASS  [3 Runner → player] spin: reaction flinch  — flinch
PASS  [3 Runner → player] spin: push-back 0.3 m  — 0.30 m
PASS  [3 Runner → player] Runner lunge (1.8 m drive) connects from 2.6 m, exactly once  — 1 hit(s)
PASS  [5 Block] slash blocked: 2 damage  — player blocked 2
FAIL  [5 Block] Blocked hit pushes back 0.3 m (settled distance)  — 0.48 m
PASS  [5 Block] slash2 blocked: 2 damage  — player blocked 2
PASS  [5 Block] flurry blocked: 2/2/2 damage  — player blocked 2, player blocked 2, player blocked 2
PASS  [5 Block] finisher blocked: 3 damage  — player blocked 3
PASS  [5 Block] lunge blocked: 3 damage  — player blocked 3
PASS  [5 Block] pommel blocked: 1 damage  — player blocked 1
PASS  [5 Block] spin blocked: 3 damage  — player blocked 3
PASS  [5 Block] Guard is up 0.10 s after pressing Block (±1 frame)  — first guarded frame at 0.1167 s
PASS  [5 Block] Walking while blocking is 50% speed  — 3.80 m vs 1.90 m in 1 s (×0.50)
PASS  [6 Parry] slash: parried (first hit), 0 damage  — player parried 0; press at move time 0.14
PASS  [6 Parry] slash2: parried (first hit), 0 damage  — player parried 0; press at move time 0.14
PASS  [6 Parry] lunge: parried (first hit), 0 damage  — player parried 0; press at move time 0.20
PASS  [6 Parry] pommel: parried (first hit), 0 damage  — player parried 0; press at move time 0.15
PASS  [6 Parry] flurry: parried (first hit), 0 damage  — player parried 0; press at move time 0.14
PASS  [6 Parry] Parried Runner is staggered 1.0 s  — 1.03 s
PASS  [6 Parry] A parry opens a 1.0 s riposte window  — 1.00 s
PASS  [6 Parry] Press 0.10 s before the hit (inside 0.18 s): parried  — {"contact":0.2167,"res":["player parried"]}
PASS  [6 Parry] Press 0.25 s before the hit (outside 0.18 s): not parried  — {"contact":0.2167,"res":["player hit"]}
PASS  [6 Parry] Missed parry: 0.5 s lockout (press 0.2 s after the miss does not open a window; 0.6 s after does)  — {"opens":[1,1,2],"missed":true}
FAIL  [6 Parry] Spin vs a parry press from neutral: full 10 damage and a light flinch  — player blocked 3 (block)
PASS  [6 Parry] Spin vs an active block: 3 damage  — player blocked 3
PASS  [12 Death] Runner at 0 HP dies (Death A or B)  — {"state":"dead","move":"deathB","log":["player:start cut1","sys:hit 8","sys:killed"]}
PASS  [12 Death] Dead enemy holds no attack ticket
PASS  [12 Death] Body stays 8 s, then sinks and is removed  — y 0.00 @0s, 0.00 @7.5s, -0.80 @9s, removed true
PASS  [12 Death] Player at 0 HP dies  — player killed, player defeated, restart
PASS  [12 Death] Restart after 3 s with full health on both sides  — restart after 3.02 s; player 100, runner 40
PASS  [14 Wall obstruction] Wall between them: the player's cut does not hit  — {"playerHits":0,"enemyHits":0,"blocked":true}
PASS  [14 Wall obstruction] Wall between them: the Runner's slash 2 does not hit  — {"playerHits":0,"enemyHits":0,"blocked":true}
PASS  [14 Wall obstruction] Same distance in the open: both hit  — {"playerHits":1,"enemyHits":1,"blocked":false}
PASS  [15 Moving targets] Roll: hit arriving inside the 0.12–0.45 s i-frames is avoided  — {"res":["player dodged@roll t=0.183 (roll)"],"trace":["hit avoided (invulnerable)"]}
PASS  [15 Moving targets] Roll: hit arriving before the i-frames (roll t < 0.12 s) lands  — {"res":["player hit@roll t=0.000 (flinch)"],"trace":[]}
PASS  [15 Moving targets] A dodging Runner is untouchable  — dodged
PASS  [15 Moving targets] A Runner moving sideways at 1.6 m/s is hit once by Cut 1  — {"hits":1,"moved":0.9599999999999992}
PASS  [16 Stage 1 regression] Roll travels 2.4 m  — 2.42 m
PASS  [16 Stage 1 regression] Roll lasts 0.75 s  — 0.75 s
PASS  [16 Stage 1 regression] Roll invulnerable 0.12–0.45 s  — 0.13–0.45 s
PASS  [16 Stage 1 regression] Roll cooldown 0.8 s: press at 0.76 s refused  — state free
PASS  [16 Stage 1 regression] Roll cooldown 0.8 s: press at 0.82 s accepted  — state roll
PASS  [16 Stage 1 regression] Attack press before the 0.15 s buffer drops the chain (mash)  — start cut1, cut1 chain dropped (mash)
PASS  [16 Stage 1 regression] Mash lock: Cut 1 refused right after a dropped chain, allowed 0.25 s later  — cut1 refused (mash lock) → start cut1
PASS  [16 Stage 1 regression] Attack press inside the buffer queues Cut 2  — start cut1, cut1 chain queued, start cut2
PASS  [2 Player → Breaker] Cut 1 from the side: 8 damage, meter +6  — 8 / meter 6
PASS  [2 Player → Breaker] Combo from the side: 8 / 8 / 16, meter 6 / 6 / 15  — cut1:8,cut2:8,cut3:16 / meter 6,6,15
PASS  [2 Player → Breaker] Cut 1 from behind: meter 6 × 1.5 = 9  — meter 9 (cut1 behind -> 9.0)
PASS  [2 Player → Breaker] Frontal Cut 1 against his guard: 0 damage, guard blocked  — guard blocked
PASS  [2 Player → Breaker] Sprint lunge: 14 damage, meter +10  — [{"what":"hit","amount":14,"move":"lunge"},{"what":"meter","amount":10,"move":"lunge"}]
PASS  [2 Player → Breaker] Sweep parry adds 35 meter  — player parried 0, meter 35
PASS  [2 Player → Breaker] Riposte on a (non-open) Breaker: 30 damage, meter +30  — [{"what":"hit","amount":30,"detail":"riposte hp 90","move":"riposte","e":"attack"},{"what":"meter","amount":30,"detail":"riposte -> 65.0","move":"riposte","e":"attack"},{"what":"player hit","amount":12,"detail":"breaker.sweep2 -> player hp 88 [breaker0#22#1]","move":null,"e":"attack"}]
PASS  [2 Player → Breaker] Ordinary hits do not interrupt a Breaker attack  — {"hits":2,"interrupted":false,"move":"smash"}
PASS  [4 Breaker → player] sweep: 3 hit(s) of 12/12/14  — player hit 12, player hit 12, player hit 14
PASS  [4 Breaker → player] sweep: hit time(s) 0.5/1.17/1.83 s  — at 0.48/1.13/1.78
PASS  [4 Breaker → player] sweep: reaction flinch  — flinch/flinch/flinch
PASS  [4 Breaker → player] sweep: push-back 0.8 m (measured 0.3 s after hit 1)  — 0.71 m
PASS  [4 Breaker → player] smash: 1 hit(s) of 28  — player hit 28
PASS  [4 Breaker → player] smash: hit time(s) 0.63 s  — at 0.62
PASS  [4 Breaker → player] smash: reaction knockdown  — knockdown
FAIL  [4 Breaker → player] charge: 1 hit(s) of 20
FAIL  [4 Breaker → player] charge: hit time(s) 0.05–0.65 s  — at 
FAIL  [4 Breaker → player] charge: reaction knockdown
PASS  [4 Breaker → player] stamp: 1 hit(s) of 10  — player hit 10
PASS  [4 Breaker → player] stamp: hit time(s) 0.75–0.9 s  — at 0.80
PASS  [4 Breaker → player] stamp: reaction knockdown  — knockdown
      info: unaided player takes 2 of 3 sweep hits (12/14) — push-back moves him out of later arcs
PASS  [5 Block (Breaker)] sweep vs active block: 3/3/4 damage  — player blocked 3, player blocked 3, player blocked 4
PASS  [5 Block (Breaker)] smash vs active block: 14 damage + guard break  — player guardBreak 14
PASS  [5 Block (Breaker)] smash: guard break stuns 0.8 s  — 0.80 s
FAIL  [5 Block (Breaker)] charge vs active block: 10 damage + guard break
FAIL  [5 Block (Breaker)] charge: guard break stuns 0.8 s  — null s
PASS  [5 Block (Breaker)] stamp vs active block: 5 damage + guard break  — player guardBreak 5
PASS  [5 Block (Breaker)] stamp: guard break stuns 0.8 s  — 0.80 s
FAIL  [6 Parry (Breaker)] smash vs a parry press from neutral: full 28 damage and knockdown  — player guardBreak 14 (stun; parry press at move time 0.54)
FAIL  [6 Parry (Breaker)] charge vs a parry press from neutral: full 20 damage and knockdown
FAIL  [6 Parry (Breaker)] stamp vs a parry press from neutral: full 10 damage and knockdown  — player guardBreak 5 (stun; parry press at move time 0.72)
PASS  [6 Parry (Breaker)] Sweep hit 1 vs a timed parry: 0 damage, meter +35  — player parried 0; meter 35
PASS  [9-10 Breaker meter and knee-drop] Meter fills by 27 per side combo (27 → 54 → 81); knee-drop on reaching 100 in the 4th combo  — after each combo 27 → 54 → 81 → 0 (reset to 0 at the knee-drop); gains: cut1 -> 6.0 | cut2 -> 12.0 | cut3 -> 27.0 | cut1 -> 33.0 | cut2 -> 39.0 | cut3 -> 54.0 | cut1 -> 60.0 | cut2 -> 66.0 | cut3 -> 81.0 | cut1 -> 87.0 | cut2 -> 93.0 | cut3 -> 108.0
PASS  [9-10 Breaker meter and knee-drop] Knee-drop lasts 2.2 s  — 2.23 s
PASS  [9-10 Breaker meter and knee-drop] Knee-drop counts as open (a Cut 1 during it: 8 × 1.5 = 12)  — 8 cut1 hp 112 | 12 cut1 (open x1.5) hp 100; second cut started during the knee-drop: true
PASS  [9-10 Breaker meter and knee-drop] No meter gain during the 4 s immunity after the knee-drop (2.2 + 4 = 6.2 s)  — [{"at":3,"gain":0,"log":["hit","meter immune"]},{"at":5.5,"gain":0,"log":["hit","meter immune"]}]
PASS  [9-10 Breaker meter and knee-drop] Meter gain resumes after the immunity  — {"at":6.6,"gain":6,"log":["hit","meter"]}
PASS  [9-10 Breaker meter and knee-drop] Meter holds for 2 s after the last gain  — {"m0":27,"at19":27,"at25":21.83,"at30":16.83}
PASS  [9-10 Breaker meter and knee-drop] Then decays at 10 / s  — {"m0":27,"at19":27,"at25":21.83,"at30":16.83}
PASS  [7 Open and positional multipliers (Breaker)] Cut 1 on an open Breaker from the side: 12 damage, meter 6 × 2 = 12  — hit 12 cut1 (open x1.5) hp 108 | meter 12 cut1 open -> 12.0
PASS  [7 Open and positional multipliers (Breaker)] Cut 1 on an open Breaker from behind: meter 6 × 2 × 1.5 = 18  — hit 12 cut1 (open x1.5) hp 108 | meter 18 cut1 open behind -> 18.0
PASS  [11 Knockdowns] Knockdown lasts 2.0 s  — 2.02 s
PASS  [11 Knockdowns] Invulnerable from 0.6 s into the knockdown  — from 0.60 s
FAIL  [11 Knockdowns] Charge stops on contact (does not pass through the player)  — {"pz":44,"bz":43.09,"minZ":40,"hits":0}
PASS  [12 Death] Breaker at 0 HP dies (Death A or B), ticket released  — {"killed":true,"state":"dead","move":"deathB","ticket":false}
PASS  [13 Multiple enemies (AI, 60 s, seed 1)] Never more than 2 enemies attacking at once  — max 2
PASS  [13 Multiple enemies (AI, 60 s, seed 1)] Never more than 1 Breaker attacking at once  — max 1
PASS  [13 Multiple enemies (AI, 60 s, seed 1)] At least 0.6 s between attack starts  — 11 starts, min gap 0.60 s
PASS  [13 Multiple enemies (AI, 60 s, seed 1)] No two enemy hits land on the player in the same frame  — 13 hits on the player, 0 same-frame pairs
PASS  [13 Multiple enemies (AI, 60 s, seed 1)] The fight produced attacks (sanity)  — 11 starts, 13 hits
PASS  [18 Stage 2B regression] Runners hold a 3–5 m ring  — median 4.23 m, 100% of 340 samples inside 3–5 m
PASS  [18 Stage 2B regression] Breaker holds 2.0–2.5 m (±0.05 m)  — median 2.493 m, 100% of 50 samples inside 1.95–2.55 m
PASS  [18 Stage 2B regression] Breaker walks at about 0.9 m/s within 8 m  — median 0.92 m/s, max 1.73 m/s
FAIL  [18 Stage 2B regression] Breaker starting at 1.8 m settles inside 2.0–2.5 m  — settled at 1.800 m after 4 s
PASS  [18 Stage 2B regression] No attack starts while every warning is off-screen (camera turned away, 5 s)  — 0 starts
PASS  [18 Stage 2B regression] A warning behind a wall is not visible; the same in the open is  — behind wall false, open true
PASS  [17 Stage 2A regression] Repeated contact frames hit once  — 1 hit(s) over 31 frames of a slow swing
PASS  [17 Stage 2A regression] A new attack instance can hit again  — 1 hit(s) for a second attack key
PASS  [17 Stage 2A regression] Fast swing (150 deg in one frame) still hits  — swept: 1 hit; endpoint-only check would miss
PASS  [17 Stage 2A regression] Sub-steps keep the tip under 10 cm per step  — max tip travel per sub-step 7.3 cm (tip moved 2.86 m arc in one frame)
PASS  [17 Stage 2A regression] Swing away from the target misses  — 0 hits
PASS  [17 Stage 2A regression] Target just out of reach is missed  — target edge at 1.22 m, blade tip at 1.10 m + 0.03: 0 hits
PASS  [17 Stage 2A regression] Moving target crossing a still blade is hit  — 1 hit; contact at x=0.00
PASS  [17 Stage 2A regression] Target retreating faster than the swing is missed  — 0 hits (target backed off 1.4 m during the swing)
PASS  [17 Stage 2A regression] Target dashing 3 m through the blade in one frame is hit  — 1 hit
PASS  [17 Stage 2A regression] Lunge reaches a target 2.8 m ahead  — 1 hit
PASS  [17 Stage 2A regression] Lunge misses a target 3.6 m ahead  — 0 hits
PASS  [17 Stage 2A regression] Wall between attacker and target blocks the hit  — 0 hits through the wall
PASS  [17 Stage 2A regression] Same swing without the wall hits  — 1 hit
PASS  [17 Stage 2A regression] Waist-low obstacle does not block a chest-height cut  — 1 hit
PASS  [17 Stage 2A regression] No self-hits; inactive targets skipped  — 0 hits
PASS  [17 Stage 2A regression] Charge hits a target in its path once  — 1 hit
PASS  [17 Stage 2A regression] Charge misses a target 1.2 m to the side  — 0 hits
PASS  [17 Stage 2A regression] Stamp ring hits a grounded target at 1.8 m  — 1 hit
PASS  [17 Stage 2A regression] Stamp ring misses an airborne target  — 0 hits
PASS  [17 Stage 2A regression] Stamp ring misses a target at 3.5 m  — 0 hits

152/165 passed, 13 failed
```
