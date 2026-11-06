# Supernatural abilities — design (direction approved; not implemented)

Three supernatural abilities for the protagonist: **Phantom Step**, **Colossus Rift** and **Gravity Rupture**.

**Status:** the direction and the decisions below are approved. Implementation waits for:
1. Stage 2C testing and its approval (`docs/combat.md`).
2. Explicit approval to start this work.

Until then nothing in the game changes: combat, animations, controls and assets stay as they are.

**Not decided yet (do not invent):** damage, poise/meter values, cooldowns, any resource or mana system, and ranges and durations
beyond the visual beats proposed here. Those values go into `docs/combat.md` when they are approved.

## Decisions (approved)

| Area | Decision |
|---|---|
| Animations | Reuse existing clips only where they genuinely fit. Phantom Step may use `Sword_Dash` if the movement reads correctly. Colossus Rift uses a suitable existing charge + release combination. **Gravity Rupture gets a custom katana ground-stab animation.** Existing approved combat animations are not modified. |
| Visual identity | Cyan-blue energy with a bright white core. It must stay clearly distinct from enemy warning glints (pale cream = parryable) and the red unparryable indicators. Readable on Low quality, where there is no bloom. |
| Audio | Approved: a lightweight audio system for these abilities. Priority: distinctive charge, release, impact and environmental sounds. |
| Mobile controls | No three permanent buttons. Use a layout that keeps the joystick, RUN, ATTACK, DODGE and BLOCK exactly as they are (see section 6). |
| Order | Stage 2C testing and approval first. No ability work before that. |

## 1. How the abilities fit the existing architecture

| Existing system | How the abilities use it |
|---|---|
| `src/combat/hits.ts` (Stage 2A) | Phantom Step: swept body capsule (the same test as the Breaker's charge). Colossus Rift: the crescent's two tips act as one wide swept segment (the same test as weapon swings). Gravity Rupture: the expanding ground ring (the same test as the Breaker's stamp). The once-per-target and wall-obstruction rules come for free. |
| `src/combat/system.ts` (Stage 2C) | Abilities feed in as extra attack sources, alongside the katana's `activeAttack`. Existing moves and values are untouched. |
| `src/combat/brain.ts` | Phantom Step must suspend the enemy-vs-player separation push (`constrain`) for its duration, or the player cannot pass through. Gravity Rupture moves enemies through the existing collision resolve, so nobody is pulled into a wall. |
| `src/player/combat.ts` | Abilities run as player states that block other input until recovery (the same pattern as roll and cuts). |
| `src/core/post.ts` | HDR + bloom on **High only**. Effects are authored to read without bloom (glow baked into textures, additive cores). A heat-distortion pass is High-only. |
| Shader warm-up | All ability materials are compiled during loading (`renderer.compileAsync`), so the first use does not hitch. |
| Effects pooling | Every mesh, particle buffer and sound is created once at load and reused. Nothing is allocated mid-fight. |

## 2. Visual identity

- **Palette:** a white core (#FFFFFF) graded through ice (#C8F4FF) to cyan (#4FD8FF) to deep blue edges (#1E5BFF).
  - The cool palette contrasts with the warm golden-hour temple light.
  - On High, cores are pushed above 1.0 so bloom catches them. On Low, the texture's soft falloff provides the glow.
- **Distinct from enemy warnings:**
  - Enemy glints are warm cream-white and red.
  - Player energy always carries a cyan tint, even in its brightest parts (no neutral or cream whites).
  - No red anywhere in ability effects.
  - Ability effects never draw over an active enemy warning glint.
- **Readability:** one strong silhouette per beat (a ring, a crescent, a trail), then a fast fade. Short particle lifetimes, no lingering haze over enemies.
- **Budgets (simultaneous):**
  - Particles: about 400 on High, about 200 on Low.
  - Afterimages: 3–4 on High, 2 on Low.
  - Debris chunks: 12–20 on High, 8–10 on Low.
  - Draw calls: about 3–6 per ability.

## 3. Abilities

Timings are proposed visual beats for review, not approved gameplay values.

### 3.1 Phantom Step

A supernatural dash that passes through enemies.

| Beat | Visuals | Sound |
|---|---|---|
| Anticipation (about 0.1 s) | Low crouch. Cyan motes drawn into the body. A brief streak along the katana. | Short inhale or charge swell |
| Vanish | Armour dissolves feet-first with a glowing cyan edge. An inward-collapsing ring and a flash at the start point. | Whoosh plus a "time" morph |
| Travel | Body hidden. Afterimages (frozen pose copies, fresnel cyan) every few frames, fading over about 0.25 s. A ribbon trail along the chest line. Sparks where enemies are passed. | Air rush |
| Reappear | Reverse dissolve. Star flare plus a short mote burst. | Bright reappear accent |
| Recovery | Trail and afterimages fade. Back to ready. | — |

- **Animation:** `Sword_Dash` (already loaded; also used by the sprint lunge). Use it only if the motion reads correctly during the visible parts (anticipation and reappear).
  - If it does not, evaluate `Roll` or `NinjaJump_Start` + `NinjaJump_Land` before proposing anything custom.
  - The clip itself is not modified; travel uses a game-driven drive, like the existing lunge and roll.
- **Combat hook:** a swept body capsule along the path, once per enemy. The player is untouchable during travel. Enemy separation is suspended during the step.

### 3.2 Colossus Rift

Charge the katana, then release a large crescent energy wave that travels forward.

| Beat | Visuals | Sound |
|---|---|---|
| Charge | The blade's emissive ramps up. Particles spiral into the blade (inward twirl). A light pool grows on the ground under the player. A faint vortex at the guard. | Katana ring plus a rising energy drone |
| Release | The crescent forms at the blade's angle: a curved, tapered ribbon with a white core, cyan edges and scrolling energy noise inside, plus two fainter crescents trailing behind. A flash at the release point. | Heavy release whoosh |
| Travel | Crescent sweeps forward (proposed about 10–12 m). A scorch or trace line on the ground along its path. | Travelling hum |
| Impact | Sparks and a short flash on each enemy hit. The crescent dissipates into motes at its range limit or on a wall. | Blast impact per enemy hit |
| Recovery | Blade glow cools. Ground pool fades. | — |

- **Animation:** an existing charge + release combination, to be evaluated in the animation preview tool before implementation.
  - Charge candidates: the held guard pose of `Sword_Block` (blade raised), or `Sword_Idle`.
  - Release candidates: `Sword_Regular_C` (big cut) as the release swing.
  - Do not reuse the heavy slash's `Sword_Heavy_Combo` opening, so the Rift doesn't look like the heavy slash.
  - Existing clips are played as they are, never edited.
- **Combat hook:** the crescent is a moving wide segment, swept every frame. Hits each enemy once. Walls stop it.

### 3.3 Gravity Rupture

Drive the katana into the ground, creating an expanding gravitational shockwave.

| Beat | Visuals | Sound |
|---|---|---|
| Anticipation | Blade lifted two-handed, point down. Dust lifts off the ground. A pull vortex begins under the player. | Low rising pull |
| Impact | Katana stabbed into the ground. Glowing cracks race outward from the blade. The glyph ring flares and rotates. A shockwave ring expands (heat shimmer on High). Dust and dirt burst. | Deep gravity boom plus earth impact |
| Suspension | Paving chunks lift and hover, slowly rotating. Enemies pulled inward or knocked off balance. | Sub-bass hum and stone grinding |
| Recovery | Debris falls with dust puffs. Cracks cool from cyan to ember to dark. Glyphs fade. Blade pulled free. | Stone impacts plus an earthquake tail |

- **Animation: a custom katana ground-stab (new work, needs approval of the poses).**
  - Built the same way as the approved enemy custom animations: hand-keyed bone poses layered on the shared 65-bone skeleton, with hand IK keeping both hands on the hilt.
  - Proposed key poses, for review:
    1. **Lift:** both hands raise the katana, point down, to chest height. Weight shifts up.
    2. **Drive:** the body drops into a deep crouch (or one knee), and the blade is driven point-first into the ground about 0.5 m in front. This is the impact frame.
    3. **Hold:** head up, both hands on the hilt, blade in the ground during the suspension.
    4. **Withdraw:** pull the blade free and return to the ready stance.
  - No existing clip is modified.
- **Combat hook:** expanding ground ring (the existing stamp test). The pull or knock-off-balance acts on enemies through the existing collision resolve.

## 4. Visual effects: procedural vs asset

| Element | Built with | Ability |
|---|---|---|
| Glows, crescent shape, rings, sparks, flares, dust | Kenney Particle Pack sprites, tinted in shader | All |
| Afterimages | Code: freeze the current skinned pose into a ghost copy with a fresnel cyan material | Phantom Step |
| Dissolve out / in | Code: noise-threshold mask with a glowing edge, applied to the protagonist's materials only for the effect's duration | Phantom Step |
| Energy trails | Code: ribbon mesh along the body or blade path, textured with `trace_*` | Phantom Step, Rift |
| Crescent wave | Code: curved, tapered ribbon mesh. `slash_*` for its shape, scrolling noise for its energy | Rift |
| Ground cracks | Code: radial branching cracks from the impact point, glowing then cooling. Noise texture for fine detail. | Rupture |
| Ancient glyph ring | Code: original glyphs drawn on canvas in the temple's visual culture | Rupture |
| Floating debris | Code: broken paving chunks with the existing cobblestone and rock textures, one instanced mesh | Rupture |
| Heat distortion | Code: small screen-space distortion pass, High only | Rift, Rupture |

## 5. Asset references

All are CC0: commercial use allowed, attribution not required. Licences were checked on the source page, and inside the archive where one exists.
Each asset is added to `ASSET_CREDITS.md` (name, source, creator, licence, files used, modifications) when it is integrated, not before.

### Visual

| Asset | Source | Creator | Format | Use |
|---|---|---|---|---|
| Particle Pack (80+ sprites) | [OpenGameArt](https://opengameart.org/content/particle-pack-80-sprites) (original: kenney.nl/assets/particle-pack) | Kenney | PNG 512×512 greyscale, alpha | `slash_01–04` crescent; `trace_01–07` trails; `circle_01/03` rings; `twirl_01–03` vortex; `light_01–03` ground glow; `scorch_01–03` bursts and scorch; `spark_01/04/06` crackle; `star_06`, `flare_01` flashes; `smoke_*` dust; `dirt_01/02` debris spray. The licence file in the zip was checked. |
| 700+ Noise Textures | [OpenGameArt](https://opengameart.org/content/700-noise-textures) | Screaming Brain Studios | PNG seamless greyscale, 128–512 px | Dissolve mask, crescent energy scroll, crack detail ("cracks" set) |
| Smoke particle assets (optional) | [OpenGameArt](https://opengameart.org/content/smoke-particle-assets) | Kenney | PNG | Extra dust for Rupture. Contents not yet reviewed. |
| Existing project textures (reuse) | `ASSET_CREDITS.md` | Poly Haven / ambientCG | WebP | Cobblestone Floor 03, Rock 051/030/064 for debris chunks. No new download. |

Rejected:
- Weapon Slash Effect (Cethiel): low resolution and pre-coloured.
- Encircled Runes (ztn): icon-badge style. The glyphs will be original and procedural instead.
- Quaternius ruin kits: stylised low-poly, which clashes with the photographic PBR look.
- ambientCG decals: none suitable.

### Audio

Every clip must be auditioned before use. Ship in a format iOS Safari plays (e.g. MP3 or AAC), converted from the originals.

| Asset | Source | Creator | Format | Use |
|---|---|---|---|---|
| 150 Combat Sound Effects | [OpenGameArt](https://opengameart.org/content/150-combat-sound-effects) | untamedpixels (sources: Kenney, CoMiGo, Kronbits, lentikula; all CC0 per the bundled `LICENSES.txt`) | WAV | `GravityBomb_01–03`, `Earth Spell Impact`: Rupture. `BlastImpact_01–03`, Kenney `impact_punch_heavy_*`: Rift hits. `Wind Spell Impact`: Phantom Step |
| 80 CC0 RPG SFX | [OpenGameArt](https://opengameart.org/content/80-cc0-rpg-sfx) | rubberduck | OGG | `blade_01–03` katana ring (Rift charge); `stones_01–04` debris; `spell_01/02` |
| Swishes Sound Pack | [OpenGameArt](https://opengameart.org/content/swishes-sound-pack) | artisticdude | zip | Phantom Step whoosh, Rift release |
| Air whoosh | [OpenGameArt](https://opengameart.org/content/air-whoosh) | pyranostudios | WAV/OGG | Phantom Step travel |
| Wind, hit, time morph | [OpenGameArt](https://opengameart.org/content/wind-hit-time-morph) | qubodup | zip | Phantom Step vanish and reappear |
| Energy Drain | [OpenGameArt](https://opengameart.org/content/energy-drain) | qubodup | OGG | Rift charge drone, Rupture pull |
| Earth Element Magic Spell | [OpenGameArt](https://opengameart.org/content/earth-element-magic-spell) | qubodup | FLAC/OGG | Rupture impact layer |
| Earthquake ("shake") | [OpenGameArt](https://opengameart.org/content/earthquake-and-open-sesame) | mieki256 | FLAC/OGG | Rupture rumble tail |
| 75 breaking / falling / hit sfx | [OpenGameArt](https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx) | rubberduck | OGG | Debris landing |

Rejected: Light Sabre Sounds (too recognisable).

Not reachable from the development environment: kenney.nl (covered by the OpenGameArt mirror), Freesound (also needs an account to
download), Poly Pizza and Pixabay.

### Audio system (lightweight, approved)

- One shared `AudioContext`, unlocked on the first user input. This is required on mobile browsers.
- Sounds are decoded at load and cached. A small pool of voices plays them, with a per-sound cap so repeated hits don't stack.
- Volume buses: abilities, impacts, environment, plus a master volume.
- Simple distance attenuation and stereo pan from the camera (no full 3D audio).
- Layering per beat: each ability beat can play more than one layer, e.g. Rupture impact = boom + earth + debris.
- Scope: ability sounds only, unless approved otherwise. Existing combat stays silent until a separate decision.

## 6. Controls (proposed, for approval)

### Desktop (proposed keys)

| Ability | Key | Behaviour |
|---|---|---|
| Phantom Step | Q | Tap: dash toward the movement direction (or facing when standing still) |
| Colossus Rift | E | Hold to charge, release to fire |
| Gravity Rupture | R | Tap |

Existing bindings are unchanged: Left Mouse = Attack, Right Mouse = Block/Parry, Space = Dodge, Shift = Sprint.

### Mobile: one SPIRIT button with a "spirit stance" (recommended)

The current right-hand cluster stays exactly as it is:
- RUN in the corner.
- ATTACK to its left.
- BLOCK above RUN.
- DODGE diagonally above ATTACK.

The joystick stays on the left.

**One** new small button (about 52 px), **SPIRIT**, sits above the cluster in free space, above BLOCK/DODGE and clear of the safe-area insets.

1. **Tap SPIRIT** to enter spirit stance for a short window (about 2 s, or until an ability is used; tap SPIRIT again to cancel).
2. During the stance, the three existing combat buttons **temporarily act as the abilities**:
   - They get a cyan rim and their labels change.
   - Their positions and sizes do not change, so muscle memory carries over.

   | Button | In spirit stance | Why it maps there |
   |---|---|---|
   | DODGE | Phantom Step | It is a dash |
   | ATTACK | Colossus Rift: hold to charge, release to fire | It is an attack, and hold-to-charge fits a press-and-hold |
   | BLOCK | Gravity Rupture | A planted, grounded move |

3. When the stance ends (window expires or an ability is used), the buttons return to normal at once.

Why this layout:
- Only one new target on screen.
- No two-thumb chords: the left thumb stays on the joystick.
- No accidental abilities during normal combat.
- The existing controls are not moved, resized or restyled.
- It also leaves room for a future resource or cooldown display on the SPIRIT button, without designing one now.

Alternative (if the stance tests poorly):
- Hold SPIRIT to open a small radial with three slots (up = Rift, left = Phantom Step, down = Rupture).
- Slide to a slot and release to cast; release in the centre to cancel.
- Also one button, but slower in a fast fight, and the radial covers part of the view.

## 7. Implementation order (after Stage 2C approval, and only when approved)

1. Audio system and asset import (with `ASSET_CREDITS.md` entries).
2. Shared effects layer: pooled sprites, ribbons, particles, dissolve and afterimage materials, Low and High variants.
3. Gravity Rupture custom ground-stab animation: preview tool first, then poses for approval.
4. Phantom Step, then Colossus Rift, then Gravity Rupture: visuals, then combat hooks.
5. Controls: desktop keys, then the mobile SPIRIT stance.
6. Tests: the abilities run against the Stage 2C harness, plus Low-quality readability and performance checks on mobile.
