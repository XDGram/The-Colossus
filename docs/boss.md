# Temple Warden — boss combat (approved)

The Warden is the mentor turned antagonist: the approved mentor model, LPS head scan, costume and katana, with his own
moveset, three phases, fire and lightning magic and teleport strikes. The temple fight ends with him (`?combat=w1` is
the dev arena with him alone). Cinematic intros, transitions and cutscenes are deferred.

Values are the approved design. 450 HP is the starting balance value, to be checked against actual fight length.

## Core

| | |
|---|---|
| Health | **450** |
| Posture | **150**. A break (meter full) drops him to one knee for **2.5 s**, open (×1.5 damage). Then 4 s immunity. Decay and gain rules are the Iron Breaker's (`docs/combat.md` §6) |
| Super-armour | Ordinary hits don't interrupt him. While he isn't attacking, his guard blocks frontal Cut 1 / Cut 2 (as the Breaker) |
| Phases | **1 Blade** 100–65% → **2 Fire** 65–30% → **3 Storm** below 30%. Each change: he drives his blade into the ground (untouchable), and a shockwave pushes the player back with no damage |
| Summon | Once, at the start of phase 2: **two Ash Runners**, one to either side behind him |
| Movement | Walks at 1.5 m/s, holds 1.4–2.0 m with the katana |

## Moves

Damage values live in `src/combat/tables.ts` (`warden.*`). Clips and timings are in `src/boss/moves.ts`. Tells and
glints are in `WARDEN_TELL`.

| Phase | Move | Clip / pose | Warning | Damage (blocked) | Counterplay |
|---|---|---|---|---|---|
| 1+ | 3-hit combo | `Sword_Regular_Combo` + 0.6 m step | 0.45 s pale | 10 / 10 / 14 (3 / 3 / 4) | Parry each hit, or block |
| 1+ | Lunge thrust | `Sword_Dash`, 2.2 m drive | 0.5 s pale | 14 (4) | Parry or roll |
| 1+ | Overhead cleave | `Sword_Regular_C` | 0.5 s red | 22 (11 + guard break), knockdown | Roll |
| 1+ | Side-step roll, then slash | `Roll` to the player's flank, then `Sword_Regular_A` + step | 0.45 s pale after the roll | 12 (3) | Parry or roll |
| 2+ | Flame-line cut | `Sword_Regular_B`; leaves a burning strip (5.0 × 1.3 m, 2 s) | 0.45 s pale | Slash 10 (3); strip 5 every 0.5 s, not in the first 0.25 s | Parry the slash; step out of the strip |
| 2+ | Fire wave | Blade driven into the ground (`Sword_Heavy_Combo` smash) | 0.4 s orange glint plus a **7 m orange ground ring for about 1.0 s** | 14 (4) | Roll through, block, or be outside 7 m |
| 2+ | Fireball volley | Left-palm cast; 3 orbs, 0.25 s apart, aimed where the player was | 0.35 s orange glint; **a ground path line 0.4 s before each orb** | 10 each (3) | Sidestep or roll. Walls stop orbs |
| 3 | Lightning strikes | Katana raised to the sky; 3 strikes 0.45 s apart, each where the player stood | 0.3 s violet glint; **violet ground circle (r 1.6 m) for 1.0 s** before each strike | 22, **can't be blocked**: full damage and knockdown even when blocking (the strike lands where the player stands, so there is no front to guard) | Keep moving or roll |
| 3 | Storm combo | `Sword_Regular_B` → `Sword_Regular_C` | 0.5 s pale; **red warning 0.5 s before the second hit** | 12 (3), then 24 (12 + guard break) | Parry the first hit, roll the second |
| 3 | Teleport strike | Vanishes in smoke and sparks (0.45 s, untouchable), reappears 1.6 m behind or beside the player, then strikes | Arrival flash + sound, then 0.45 s pale | 14 (4) | Parry or roll. Punish window after. Up to 2 in a row |

## Patterns and fairness

- **Attack choice:** weighted by distance (in-range moves favoured; ranged pressure when the player is far), with
  per-move cooldowns and never the same move twice in a row. The current phase's new moves are favoured.
- **Warnings:** every attack has a warning (≥ 0.45 s for sword moves; 0.9–1.0 s ground warnings for spells). He starts
  attacks only through the attack director, so the warning must be visible to the player.
- **One spell at a time.** While his spells are live, or he is teleporting, he keeps his attack slot and **no other
  enemy may start an attack** (director `exclusive`). With the summoned Runners the director's limits still apply:
  at most 2 attackers, 0.6 s between attack starts.
- **Colours:** pale = parryable, red = unparryable (as all enemies). Fire is orange; lightning is violet-white, kept
  distinct from the player's planned cyan abilities (`docs/abilities.md`).

## Effects and sound

- **Effects** (`src/fx/vfx.ts`): pooled additive sprites and ground decals from Kenney's Particle Pack (CC0), tinted
  in code and not tone-mapped, so they stay saturated and readable on Low quality without bloom.
- **Sound** (`src/audio/audio.ts`): one Web Audio context, unlocked on the first input, and 12 CC0 sound effects
  (`public/assets/audio`). See `ASSET_CREDITS.md`.

## Tests

`tools/bosstest.mjs` (`npm run dev`, then `node tools/bosstest.mjs`) checks the values above, counterplay, phases, the
summon, posture, fairness under the real AI, and estimates fight length with a scripted player. The Stage 2C suite
(`tools/combattest.mjs`) must keep passing.
