# The Last Colossus — The First Awakening

A third-person action-adventure vertical slice for the browser (Vite + Three.js + TypeScript).

**Current scope: Scene 1 — The Forgotten Valley.** You can explore an ancient valley on foot. The Colossus rests in the distance, and reaching it is the adventure to come. Combat, enemies and climbing are deliberately not part of this scene.

## Run

```bash
npm install
npm run dev          # http://localhost:5173
npm run build        # type-check + production build into dist/
```

| Control | Action |
|---|---|
| W A S D | Move (camera-relative) |
| Mouse | Look (click the game to capture the mouse; Esc releases it) |
| Mouse wheel | Camera zoom |
| Shift | Run |
| Ctrl / C | Walk |
| G | Toggle graphics quality (High / Low; the page reloads) |
| F3 | Performance overlay (FPS, draw calls, triangles) |

Add `?quality=low` or `?quality=high` to the URL to force a preset, and `?debug` to show the performance overlay on load.

## Project layout

```
src/
  main.ts               bootstrap, loading flow, lighting/shadows, game loop, test hooks
  core/                 asset loading, input, noise
  world/
    heightfield.ts      the valley's shape: terrain height, stream, road, ruin sites (single source of truth)
    terrain.ts          chunked LOD terrain + splat-blended material; far-landscape mesh
    atmosphere.ts       HDRI sky, sun extraction, analytic height fog + aerial haze
    water.ts            stream ribbon and pool with flowing procedural normals
    ruins.ts, stone.ts  procedural weathered ruins and triplanar stone/moss material
    colossus.ts         the Colossus (original procedural design) and its idle motion
    vegetation.ts       LOD scatter, tree impostors, GPU grass, dust motes, placement rules
    colliders.ts        2.5D collision (circles/oriented boxes, walkable tops)
  player/               Ranger controller and animation blending; third-person camera
tools/
  build-assets.mjs      converts downloaded sources (assets-src/, git-ignored) into public/assets
  playtest.mjs          headless screenshot capture from scripted viewpoints
  movetest.mjs          movement and collision assertions
  profile.mjs           per-object triangle and draw-call breakdown
```

## Assets

All third-party assets are CC0 (Poly Haven, ambientCG, Quaternius). See [ASSET_CREDITS.md](ASSET_CREDITS.md) for the full list. To rebuild the runtime assets, download the originals into `assets-src/` as described there, then run `npm run assets`.
