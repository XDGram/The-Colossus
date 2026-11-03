# Enemies — asset and animation plan (approved direction, not yet built)

Two regular enemies for the temple invasion. Both share the protagonist/mentor skeleton
(Quaternius 65-bone rig) so every clip plays without retargeting.

## Locked constraints — Iron Breaker animation

- Use the **adjusted two-handed** three-hit sweep and overhead smash (swing path pulled toward the body, both arms IK'd onto the haft).
- Preserve the confirmed impact frames and recovery windows (below).
- Keep the two-handed grip for the whole of every attack, ready pose and recovery.
- Set hit ranges from the **adjusted, shorter arcs** (about 40% less reach than the original one-handed clip), never from the raw clips.
- Re-check club/body/ground clipping once the real armour, helmet and club are attached.
- `tools/animprev/` is a **reference only**. Re-implement its fixes deliberately in game code; do not copy preview-only code
  (uniform 1.15 scale, placeholder club, debug output) blindly.

## Sources

| Asset | Source | Licence |
|---|---|---|
| Ash Runner body | Quaternius Male_Peasant (Modular Character Outfits – Fantasy, Standard) | CC0 |
| Iron Breaker body | Quaternius Male_Ranger, uniform 1.15x scale | CC0 |
| Clips | Quaternius UAL1 Standard (already in game) + UAL2 Standard (`assets-src/quaternius/ual2/`, via series-ai/jam-ready-assets) | CC0 |
| Armour, masks, weapons | Procedural, bone-attached (same method as protagonist/mentor) | Original |

## Ash Runner

| Move | Clip | Hit | Open from | Recovery |
|---|---|---|---|---|
| Quick slash | Sword_Regular_A + A_Rec | 0.27 s | 0.33 s | 1.0 s |
| Second slash | Sword_Regular_B + B_Rec | 0.27 s | 0.37 s | 1.0 s |
| Three-hit flurry | Sword_Regular_Combo | 0.27 / 0.73 / 1.57 s | 1.70 s | 1.3 s |
| Heavy finisher | Sword_Regular_C | 0.67 s | 0.80 s | 1.2 s |
| Lunge | Sword_Dash | 0.33 s | 0.43 s | 1.2 s |
| Pommel strike | Melee_Hook + Melee_Hook_Rec | 0.27 s | 0.30 s | 0.6 s |
| Parry | Sword_Block | guard by 0.10 s | — | — |
| Dodge (roll / hop) | Roll (UAL1) / NinjaJump_Start+Land | — | — | — |
| Flinch | Hit_Chest / Hit_Head (UAL1) | — | — | — |
| Knockdown + get up | Hit_Knockback + LayToIdle | — | — | — |
| Death A | Death01 (UAL1) | — | — | — |
| Locomotion | Walk_Loop, Jog_Fwd_Loop, Sprint_Loop (UAL1) | — | — | — |

Weapons: a blade on each hand; the left blade follows the clips' counter-swing (visual only unless a mirrored hit is added).

**Custom still needed:** dual-blade ready stance (idle), spin cut, side-step dodge, Death B (spun-around collapse).

## Iron Breaker

| Move | Clip (two-handed adjusted) | Hit(s) | Open from | Recovery |
|---|---|---|---|---|
| Three-hit sweep | Sword_Heavy_Combo 0–2.0 s | 0.50 s (low swipe), 1.17 s (upswing), 1.83 s (horizontal) — all three deal damage | 1.9 s | blend out to guard |
| Overhead smash | Sword_Heavy_Combo 2.0–4.3 s (40° wind-up tilt peaking 2.5 s) | 2.63 s (ground impact) | 2.67 s | 1.6 s |
| Shoulder charge | Shield_Dash + game-driven forward motion (clip travels only 0.4 m) | burst at 0.07 s | — | 1.1 s |
| Guard / block | Idle_Shield_Loop (two-handed IK) | — | — | — |
| Guard broken | Idle_Shield_Break | — | — | 1.1 s |
| Light-hit shudder | Hit_Chest at low weight | — | — | — |
| Death A (falls back) | Death01 | — | — | — |
| Locomotion | Walk_Loop slowed to about half speed | — | — | — |

**Custom still needed:** ground stamp, knee-drop stagger (stagger-meter break), Death B (slumps over the club).

## Custom animation total

7 clips, all hand-keyed as bone poses layered on the shared skeleton:
Runner — ready stance, spin cut, side-step, Death B. Breaker — ground stamp, knee-drop stagger, Death B.
