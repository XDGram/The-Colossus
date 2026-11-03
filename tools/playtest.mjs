// Automated playtest: loads the game in headless Chromium (software GL), drives the player and camera,
// captures frames from the canvas, and logs stats/errors.
// usage: VIEWS='[...]' node tools/playtest.mjs <outDir> [w h] [quality]
//   view: { name, x?, z?, yaw, pitch, dist?, face?, walk?: {keys:[...], frames}, frames? }
import { createRequire } from 'module';
import fs from 'fs';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const [out = 'shots', w = 1280, h = 720, quality = 'high'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
// Software GL can only survive one heavy frame per browser, so each view runs in a fresh browser.
const errors = [];
async function session(fn) {
  const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-watchdog'] });
  const p = await b.newPage({ viewport: { width: +w, height: +h } });
  p.setDefaultTimeout(900000);
  p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  p.on('pageerror', (e) => errors.push('PAGEERROR ' + e.message));
  const t0 = Date.now();
  await p.goto(`http://localhost:5173/?debug&quality=${quality}`);
  await p.waitForFunction(() => window.__tlc?.ready || /wrong/.test(document.getElementById('status')?.textContent || ''), null, { timeout: 900000, polling: 1000 });
  const load = ((Date.now() - t0) / 1000).toFixed(1);
  if (!(await p.evaluate(() => !!window.__tlc))) { console.log('FAILED', errors.join('\n')); process.exit(1); }
  try { await fn(p, load); } finally { await b.close().catch(() => {}); }
}
if (process.env.TITLE) await session(async (p) => {
  // Render one frame, then show it as a still behind the real HTML title overlay and screenshot the page.
  await p.evaluate(() => {
    const g = window.__tlc; g.pause(true);
    const { url } = g.step(10);
    const img = document.createElement('img');
    img.src = url; img.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;object-fit:cover;z-index:0';
    document.body.prepend(img);
    document.getElementById('title').style.zIndex = '1';
  });
  await p.waitForTimeout(1600);
  await p.screenshot({ path: `${out}/00_title.png` });
});
for (const v of JSON.parse(process.env.VIEWS || '[]')) {
  await session(async (p, load) => {
    await p.evaluate(() => { window.__tlc.pause(true); window.__tlc.start(); });
    const r = await p.evaluate((v) => {
      const g = window.__tlc;
      if (v.x !== undefined) g.teleport(v.x, v.z);
      if (v.yaw !== undefined) g.view(v.yaw, v.pitch ?? -0.05, v.dist);
      if (v.face !== undefined) g.player.setFacing(v.face);
      if (v.cam) g.debugCam(v.cam, v.look);
      g.input.keys.clear();
      for (const k of v.keys || []) g.input.keys.add(k);
      const res = g.step(v.frames ?? 45);
      g.input.keys.clear();
      const q = g.player.position;
      return { ...res, stats: { ...g.stats }, pos: [q.x.toFixed(1), q.y.toFixed(2), q.z.toFixed(1)].join(',') };
    }, v);
    fs.writeFileSync(`${out}/${v.name}.jpg`, Buffer.from(r.url.split(',')[1], 'base64'));
    console.log(`${v.name}: load ${load}s, ${r.stats.calls} draws, ${(r.stats.tris / 1e6).toFixed(2)}M tris, player ${r.pos}`);
  });
}
console.log('errors:', errors.length ? [...new Set(errors)].slice(0, 15).join('\n') : 'none');
