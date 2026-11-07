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
| Movement | Walks at 1.5 m/s holding 1.4–2.0 m; **sprints at 5.4 m/s** to close distance; **blinks** (smoke teleport, 3 m from the player) when more than 7.5 m away, or round in front of the player when he is out of their view (every 5 s; 2.5 s in the realm) |

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

### Unleashed powers

All five are open in the valley realm (below); back in the temple they join phase 2 (Inferno, Meteor, Tempest) and
phase 3 (Thunder Step, Wrath). Each is a spell (one at a time; he keeps the attack slot while it is live).

| Phase | Power | Clip / pose | Warning | Damage (blocked) | Counterplay |
|---|---|---|---|---|---|
| 2+ | **Inferno Wave** | Slow overhead cut (`Sword_Regular_C` at 0.8×); a wall of fire leaves the blade at 0.84 s and rolls 30 m at 9.5 m/s, widening 5 → 14 m | 0.55 s orange glint; **its whole path glows on the ground for 1.4 s** | 20 (8), knockdown | Run out to the side, or roll through the wall (under 1 m thick) |
| 2+ | **Meteor Fall** | Leaps 3 m up (`NinjaJump_Start`), bursts into flame and is gone; comes down as a meteor where the player was; crouched landing (`NinjaJump_Land`), open for 1.5 s | **4.6 m orange disc for 1.15 s**, the meteor visible for its last 0.55 s | 24 (12), knockdown; the ground then burns for 3.2 s (5 every 0.5 s) | Leave the disc; punish the landing |
| 3 | **Thunder Step** | Three teleport strikes in a row; each teleport calls lightning on the player first | **Violet circle (r 1.7 m) for 0.55 s**, then the 0.45 s pale strike warning | Bolt 10 (unblockable); strike 14 (4) | Step out of the circle, then parry or roll the strike |
| 3 | **Heaven's Wrath** | Blade raised (3.2 s); 9 strikes 0.3 s apart chase the player, led toward where they are heading; the sky flickers with harmless bolts around him | 0.35 s violet glint; **each strike: violet circle (r 1.5 m) for 0.62 s** | 10 each (unblockable) | Keep running and change direction; he is open at the end |
| 2+ | **Blade Tempest** | Whirling dash (`Sword_Heavy_Combo` spin ×3) along a line up to 11 m, leaving 3 fire tornadoes that drift toward the player for 4 s | 0.6 s red glint; **the dash line on the ground** | Whirl 16 (6), knockdown; tornado 7 (3) once each | Roll sideways off the line; outpace the tornadoes (1.8 m/s) |

## The Warden's realm

The fight keeps shifting between the temple and the **Forgotten Valley** (the existing valley scene,
`src/world/valleyWorld.ts`): an open meadow on the east slope facing the Colossus (`REALM` in `src/world/realm.ts`,
22 m fighting radius). Each shift is a **glitch** — slice tears, RGB split, block corruption, scanlines and flicker
(`src/core/post.ts`, the final grade pass) — with the worlds swapping at its peak. The music crossfades to the valley
track; the temple track pauses where it was and resumes on return.

- **Raids (mid-wave):** near the end of each wave (every soldier of it in the field and 2–4 still standing), lightning
  strikes beside the player and the Warden is there. A beat later the temple tears into the valley, taking the player,
  the Warden and the surviving soldiers. He fights unleashed alongside them until **36 s**, or he loses **15%** of his
  health, or (his soldiers down) after 20 s; then he withdraws in smoke, the realm shatters, and the player is back in
  the courtyard where they were, finishing the wave. His health carries over between raids and into the final fight.
- **The final fight:** when he comes out after wave 3 and closes in (within 7.5 m, or after 6 s), the realm takes them
  once more, until **48 s**, or he loses **20%**, or he falls below 30%; the fight then ends in the temple.

**The storm transition** (`beginTrans` in `src/combat/encounter.ts`, about 3.1 s): seen from the player's own view, the
camera turning (over the shoulder) to keep the Warden in focus while he raises his blade (going in) or drives it into
the ground (coming back). A heavy wind rises from him — dust and grit streaming past, the camera shaking harder, a
storm-wind sound with a low rising rumble — and the world darkens (the final colour grade dims and drains, edges
closing in). At its darkest, a flash of light: the worlds swap, and the other world is there as the flash fades.
Everyone is held still and the HUD hides throughout.

In the realm he is **unleashed**: every power, slightly quicker decisions (0.7–1.2 s between attacks instead of
0.8–1.4 s), cooldowns 1.15× faster, the powers weighted ×2, and no phase changes (they happen in the temple). After any
big power he gives the player an extra second's breather.

**Taking damage:** every hit snaps his body back; between his attacks a light cut jolts him and a heavy hit or an
ability stumbles or reels him back (at most once every 3.5 s). His warnings and swings are never interrupted.

**Voice:** his lines are spoken (opening, raids, the final fight, phases 2 and 3; `w_*.mp3`), synthesised from the CC0
"Joe" Piper voice, pitched down with a low boost and a short echo, mastered loud (about −11 LUFS) and played above the effects. The
music keeps playing but dips to 60% while he speaks (easing down in ~0.2 s and back in ~0.6 s). Both music tracks run
through the game's Web Audio mixer (with a limiter), so their volume works on every device, including iPhone Safari.

- **Loading:** the valley's models and textures download and it is built (terrain in time slices) while the menu and
  opening are up, hidden, with its own colliders, and its shaders are compiled in the background. A raid only happens
  once it is ready (on a slow connection the early raids are skipped; the final fight waits up to 20 s).
- **Swap:** the shared collider set exchanges contents with the valley's (`Colliders.swapWith`), the ground functions
  are swapped, the temple's objects and Gravity Rupture craters are hidden (the temple's craters come back on return;
  craters made in the valley stay there). Nothing can hit anyone during the glitch.
- **Low quality:** a lighter valley (no flowers, bushes, ivy, birds; sparser grass).
- **Tests:** `tools/realmtest.mjs` (background build, trigger, swap, each power, return, captures).

## Patterns and fairness

- **Attack choice:** weighted by distance (in-range moves favoured; ranged pressure when the player is far), with
  per-move cooldowns and never the same move twice in a row. The current phase's new moves are favoured.
- **Warnings:** every attack has a warning (≥ 0.45 s for sword moves; 0.9–1.0 s ground warnings for spells). He starts
  attacks only through the attack director, so the warning must be visible to the player.
- **One spell at a time.** While his spells are live, or he is teleporting, he keeps his attack slot and **no other
  enemy may start an attack** (director `exclusive`). With the summoned Runners the director's limits still apply:
  at most 3 attackers, 0.4 s between attack starts (revised in docs/combat.md §7).
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
