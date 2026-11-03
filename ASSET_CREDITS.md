# Asset Credits — The Last Colossus: The First Awakening

Every third-party asset used in the game is listed here. All are released under **CC0 1.0 (public domain)**: attribution is not legally required, but we credit the creators anyway.

Original downloads are kept out of the repository (`assets-src/`, git-ignored). `tools/build-assets.mjs` converts them into the optimized runtime files in `public/assets/`.

| Asset | Source | Creator | License | Attribution | Original File | Runtime File | Modifications |
|---|---|---|---|---|---|---|---|
| Island Tree 02 | [Poly Haven](https://polyhaven.com/a/island_tree_02) | Rob Tuytel, Rico Cilliers | CC0 1.0 | Not required (credited) | `island_tree_02_1k.gltf` + `island_tree_02_leaves_alpha_1k.png`, `island_tree_02_leaves_diff_1k.jpg` | `public/assets/models/tree_hero.glb` | Leaf alpha map baked into the leaf texture (alpha-tested); every second leaf card rebuilt as a single quad (UVs fitted by least squares), scaled 1.22×; trunk and branches decimated by vertex clustering; textures resized to 1K WebP; Meshopt compression. 1.07M → 45k triangles. Distant trees are runtime impostors rendered from this mesh. |
| Rock Moss Set 01 | [Poly Haven](https://polyhaven.com/a/rock_moss_set_01) | Kless Gyzen | CC0 1.0 | Not required (credited) | `rock_moss_set_01_1k.gltf` | `public/assets/models/rock_moss_set_01{,_lod1,_lod2}.glb` | Three LODs by vertex clustering; 1K/512 WebP textures; Meshopt; desaturated slightly at runtime to match the palette. |
| Rock Moss Set 02 | [Poly Haven](https://polyhaven.com/a/rock_moss_set_02) | Kless Gyzen | CC0 1.0 | Not required (credited) | `rock_moss_set_02_1k.gltf` | `public/assets/models/rock_moss_set_02{,_lod1,_lod2}.glb` | As above. |
| Boulder 01 | [Poly Haven](https://polyhaven.com/a/boulder_01) | Rico Cilliers | CC0 1.0 | Not required (credited) | `boulder_01_1k.gltf` | `public/assets/models/boulder_01{,_lod1,_lod2}.glb` | Three LODs; used both as valley boulders and, scaled up and embedded, as bedrock outcrops on the valley walls; warm sandstone tone pulled toward grey-green at runtime. |
| Fern 02 | [Poly Haven](https://polyhaven.com/a/fern_02) | Rob Tuytel, Rico Cilliers | CC0 1.0 | Not required (credited) | `fern_02_1k.gltf` + `fern_02_Alpha_1k.png`, `fern_02_Diffuse_1k.png` | `public/assets/models/fern_02{,_lod1}.glb` | Alpha map baked in; LOD1 rebuilds each frond as one quad (6,232 → 106 triangles); 512 WebP textures. |
| Root Cluster 01 | [Poly Haven](https://polyhaven.com/a/root_cluster_01) | Jenelle van Heerden, Rico Cilliers | CC0 1.0 | Not required (credited) | `root_cluster_01_1k.gltf` | `public/assets/models/root_cluster_01{,_lod1}.glb` | Two LODs by vertex clustering; WebP; Meshopt. |
| Tree Stump 01 | [Poly Haven](https://polyhaven.com/a/tree_stump_01) | Rob Tuytel | CC0 1.0 | Not required (credited) | `tree_stump_01_1k.gltf` | `public/assets/models/tree_stump_01{,_lod1}.glb` | Two LODs; 512 WebP. |
| Dead Tree Trunk 02 | [Poly Haven](https://polyhaven.com/a/dead_tree_trunk_02) | Jenelle van Heerden, Rico Cilliers | CC0 1.0 | Not required (credited) | `dead_tree_trunk_02_1k.gltf` | `public/assets/models/dead_tree_trunk_02{,_lod1}.glb` | Two LODs; 512 WebP. Used as fallen logs. |
| Dry Branches Medium 01 | [Poly Haven](https://polyhaven.com/a/dry_branches_medium_01) | Rico Cilliers | CC0 1.0 | Not required (credited) | `dry_branches_medium_01_1k.gltf` | `public/assets/models/dry_branches_medium_01{,_lod1}.glb` | Two LODs; 512 WebP. |
| Kloofendal 28d Misty (Pure Sky) HDRI | [Poly Haven](https://polyhaven.com/a/kloofendal_28d_misty_puresky) | Greg Zaal, Jenelle van Heerden | CC0 1.0 | Not required (credited) | `kloofendal_28d_misty_puresky_2k.hdr` | `public/assets/hdri/sky_2k.hdr` | Unmodified file. At runtime: sun direction extracted from the image, sky rotated for the art-directed sun angle, horizon blended into the fog. |
| Ground 037 | [ambientCG](https://ambientcg.com/a/Ground037) | ambientCG (Lennart Demes) | CC0 1.0 | Not required (credited) | `Ground037_1K-JPG.zip` | `public/assets/textures/ground037/` | Colour/normal converted to WebP; AO, roughness and height packed into one RGB texture (`arh.webp`). Mossy valley floor; also moss on stone. |
| Grass 004 | [ambientCG](https://ambientcg.com/a/Grass004) | ambientCG (Lennart Demes) | CC0 1.0 | Not required (credited) | `Grass004_1K-JPG.zip` | `public/assets/textures/grass004/` | As above. Meadow patches. |
| Ground 067 | [ambientCG](https://ambientcg.com/a/Ground067) | ambientCG (Lennart Demes) | CC0 1.0 | Not required (credited) | `Ground067_1K-JPG.zip` | `public/assets/textures/ground067/` | As above. Old road and stream banks. |
| Rock 051 | [ambientCG](https://ambientcg.com/a/Rock051) | ambientCG (Lennart Demes) | CC0 1.0 | Not required (credited) | `Rock051_1K-JPG.zip` | `public/assets/textures/rock051/` | As above. Cliffs/steep slopes; carved ruin stone; Colossus carapace plates. |
| Rock 030 | [ambientCG](https://ambientcg.com/a/Rock030) | ambientCG (Lennart Demes) | CC0 1.0 | Not required (credited) | `Rock030_1K-JPG.zip` | `public/assets/textures/rock030/` | As above. The Colossus's stone hide. |
| Rock 064 | [ambientCG](https://ambientcg.com/a/Rock064) | ambientCG (Lennart Demes) | CC0 1.0 | Not required (credited) | `Rock064_1K-JPG.zip` | `public/assets/textures/rock064/` | As above. Ruin masonry. |
| Bark 014 | [ambientCG](https://ambientcg.com/a/Bark014) | ambientCG (Lennart Demes) | CC0 1.0 | Not required (credited) | `Bark014_1K-JPG.zip` | `public/assets/textures/bark014/` | As above. The Colossus's root sinews. |
| Modular Character Outfits – Fantasy (Male Ranger) | [Quaternius](https://quaternius.com/packs/modularcharacteroutfitsfantasy.html) ([itch.io](https://quaternius.itch.io/modular-character-outfits-fantasy)) | Quaternius | CC0 1.0 (per `License_Standard.txt` in the pack) | Not required (credited) | `Outfits/Male_Ranger.gltf` (free Standard pack) | `public/assets/models/ranger.glb` | Merged with four animation clips (below); textures to 1K WebP. Outfit colours muted toward the game palette at runtime. |
| Universal Animation Library | [Quaternius](https://quaternius.com/packs/universalanimationlibrary.html) ([itch.io](https://quaternius.itch.io/universal-animation-library)) | Quaternius | CC0 1.0 (per `License.txt` in the pack) | Not required (credited) | `UAL1_Standard.glb` | inside `public/assets/models/ranger.glb` | Only `Idle_Loop`, `Walk_Loop`, `Jog_Fwd_Loop` and `Sprint_Loop` kept and retargeted by bone name onto the Ranger (identical 65-bone skeleton); resampled. |

## Original work (made for this game)

These are built procedurally in code and are not third-party assets:

- **The Colossus** (`src/world/colossus.ts`): an original creature design sculpted from displaced ellipsoids and swept tubes, dressed with carapace plates, root sinews and hanging roots. It is textured with the ambientCG materials listed above.
- **Ruins** (`src/world/ruins.ts`, `src/world/stone.ts`): gateway, colonnade, terrace hall, arched bridge, standing-stone shrine and ring of arches, all eroded procedurally.
- **Terrain, distant mountains, stream and pool, grass, water normal map, dust motes.**

## Sources checked but not used

- **Kenney, Pixabay, Poly Pizza:** these sites refuse automated downloads (HTTP 403). We did not try to get around this.
- **Poly Haven rock faces and mountainside:** downloaded and evaluated, but rejected. They are open, one-sided scans that look like floating cards when scattered across slopes.
- **Poly Haven Jacaranda tree:** rejected; its purple blossom is off-palette.
