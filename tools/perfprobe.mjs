// Performance probe (dev tool, not part of the game): load cost and per-frame cost of the temple fight.
//
// usage: npm run dev   (another terminal)
//        node tools/perfprobe.mjs [low|high] [url]
//
// Reports: bytes fetched and time until the game is ready, JS heap, draw calls / triangles from the opening view
// and in a busy fight moment (enemies + a particle burst), simulation (update) time per frame, and render time per
// frame. Headless Chromium renders with SwiftShader (CPU), so absolute render times are much slower than a GPU;
// compare runs of the same probe against each other.
import { createRequire } from 'module';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const quality = process.argv[2] || 'low';
const BASE = process.argv[3] || process.env.TLC_URL || 'http://localhost:5173';

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'] });
const p = await b.newPage({ viewport: { width: 960, height: 540 } });
p.setDefaultTimeout(900000);
const t0 = Date.now();
await p.goto(`${BASE}/?quality=${quality}&seed=1`);
await p.waitForFunction(() => window.__tlc?.ready, null, { polling: 250 });
const readyMs = Date.now() - t0;
const r = await p.evaluate(async () => {
  const g = window.__tlc, out = {};
  const res = performance.getEntriesByType('resource');
  out.bytes = res.reduce((a, e) => a + (e.encodedBodySize || e.transferSize || 0), 0);
  out.requests = res.length;
  out.heapMB = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : -1;
  g.pause(true);
  const info = g.renderer.info;
  const render = (n) => {
    // One untimed frame first: new shaders and buffers are prepared on first use.
    info.reset(); g.post.render(); g.renderer.getContext().finish();
    let ms = 0;
    for (let i = 0; i < n; i++) { const a = performance.now(); info.reset(); g.post.render(); g.renderer.getContext().finish(); ms += performance.now() - a; }
    return { calls: info.render.calls, tris: info.render.triangles, ms: ms / n };
  };
  g.step(2, 1 / 60, false);
  out.opening = render(3);
  // Start the fight and let the first wave arrive.
  g.start();
  const u0 = performance.now(); g.step(600, 1 / 60, false); out.updateMs = (performance.now() - u0) / 600;
  const A = g.arena(); out.enemies = A ? A.brains.filter((x) => !x.dead).length : 0;
  // Busy moment: camera on the nearest enemies, plus a particle burst (pooled effects).
  const P = g.player.position; const near = A.brains.map((x) => x.effective()).sort((a, b) => a.distanceTo(P) - b.distanceTo(P))[0];
  if (near) g.teleport(near.x, near.z + 4);
  g.step(30, 1 / 60, false);
  const fx = A?.bossCtx?.vfx;
  if (fx) for (let i = 0; i < 6; i++) fx.bolt(g.player.position.clone().add({ x: (i - 3) * 1.2, y: 0, z: -2, isVector3: true }));
  g.step(2, 1 / 60, false);
  out.fight = render(3);
  const u1 = performance.now(); g.step(240, 1 / 60, false); out.updateFightMs = (performance.now() - u1) / 240;
  out.heapAfterMB = performance.memory ? performance.memory.usedJSHeapSize / 1048576 : -1;
  out.programs = g.renderer.info.programs?.length ?? -1;
  out.textures = g.renderer.info.memory.textures; out.geometries = g.renderer.info.memory.geometries;
  return out;
});
await b.close();
const f = (x) => x.toFixed(2);
console.log(JSON.stringify({ quality, readyMs, ...r }));
console.log(`[${quality}] ready ${(readyMs / 1000).toFixed(1)} s · ${(r.bytes / 1048576).toFixed(1)} MB in ${r.requests} requests · heap ${f(r.heapMB)} → ${f(r.heapAfterMB)} MB`);
console.log(`  opening view: ${r.opening.calls} draws, ${(r.opening.tris / 1e6).toFixed(2)}M tris, render ${f(r.opening.ms)} ms`);
console.log(`  fight (${r.enemies} enemies + 6 lightning bursts): ${r.fight.calls} draws, ${(r.fight.tris / 1e6).toFixed(2)}M tris, render ${f(r.fight.ms)} ms`);
console.log(`  update: ${f(r.updateMs)} ms/frame (wave arriving), ${f(r.updateFightMs)} ms/frame (fight) · programs ${r.programs} · textures ${r.textures} · geometries ${r.geometries}`);
