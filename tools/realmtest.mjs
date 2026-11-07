// Warden realm + unleashed powers test (dev tool, not part of the game).
//
// Drives the real temple encounter: skips to the Warden, waits for the valley realm to build in the background, then
// checks the glitch transition, the world swap (ground, colliders, visibility, music), each of the five powers
// (they must fire, warn first, and be avoidable), the timed return to the temple, and captures stills.
//
// usage: npm run dev   (another terminal; http://localhost:5173)
//        node tools/realmtest.mjs [--out <dir>] [--quality high|low]
import { createRequire } from 'module';
import fs from 'fs';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const OUT = arg('--out', 'realm-shots'), Q = arg('--quality', 'high');
const BASE = process.env.TLC_URL || 'http://localhost:5173';
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const check = (name, pass, detail = '') => { results.push({ name, pass: !!pass }); console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => { if (/Pointer Lock/.test(e.message)) return; errors.push(e.message); console.log('PAGE ERROR', e.message); });
page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') console.log('console:', m.text().slice(0, 300)); });
await page.goto(`${BASE}/?quality=${Q}`, { timeout: 240000 });
await page.waitForFunction(() => window.__tlc?.ready, null, { timeout: 240000 });
const shot = async (name) => {
  const url = await page.evaluate(() => window.__tlc.step(1, 1 / 60, true).url);
  fs.writeFileSync(`${OUT}/${name}.jpg`, Buffer.from(url.split(',')[1], 'base64'));
};
await page.evaluate(() => {
  const g = window.__tlc; g.pause(true); g.start();
  const E = g.encounter();
  window.H = {
    steps: (n) => { for (let i = 0; i < n; i++) { g.step(1, 1 / 60, false); const C = g.combat(); if (C.hp < 40) C.hp = 100; } },
    E, g,
  };
});
// Through the opening.
await page.evaluate(() => { const { E, steps } = window.H; for (let i = 0; i < 900 && E.phase === 'intro'; i++) steps(1); });
check('Opening ends in wave 1', await page.evaluate(() => window.H.E.phase === 'wave1'));
// The valley builds while the menu / opening run.
const tl = Date.now();
for (let i = 0; i < 150; i++) { const st = await page.evaluate(() => [window.H.E.realm.ready, window.H.g.realm().stage]); if (st[0]) break; await new Promise((r) => setTimeout(r, 2000)); }
console.log('realm ready after', Date.now() - tl, 'ms more');
check('Valley realm built in the background', await page.evaluate(() => window.H.E.realm.ready));
const vis = await page.evaluate(() => { const r = window.H.g.realm(); return { root: r.root.visible, kids: r.root.children.length }; });
check('Valley hidden until the raid', !vis.root && vis.kids > 5, JSON.stringify(vis));
// Wave 1 plays until every soldier is in the field, then the player cuts it down to three.
await page.evaluate(() => {
  const { E, g, steps } = window.H;
  for (let i = 0; i < 60 * 20 && E.queue.length; i++) steps(1);
  const alive = E.wave.filter((b) => !b.dead);
  for (const b of alive.slice(3)) b.kill();
  steps(2);
});
const arrive = await page.evaluate(() => { const { E, steps } = window.H; for (let i = 0; i < 120 && E.realmStage !== 'arrive'; i++) steps(1); return [E.realmStage, E.phase]; });
check('The Warden raids near the end of wave 1', arrive[0] === 'arrive' && arrive[1] === 'wave1', arrive.join());
const ret = await page.evaluate(() => window.H.g.player.position.toArray());
await page.evaluate(() => window.H.steps(20));
await shot('01-warden-arrives');
await page.evaluate(() => window.H.steps(70));
await shot('02-glitch-in');
await page.evaluate(() => window.H.steps(28));
await shot('03-glitch-peak');
await page.evaluate(() => { const { E, steps } = window.H; for (let i = 0; i < 200 && E.realmStage !== 'inside'; i++) steps(1); });
const inside = await page.evaluate(() => {
  const { E, g } = window.H; const r = g.realm(), P = g.player.position, B = g.arena().brains.find((b) => b.e.kind === 'warden');
  const sol = E.wave.filter((b) => !b.dead).map((b) => Math.hypot(b.pos.x - 68, b.pos.z - 148));
  return { stage: E.realmStage, phase: E.phase, active: r.active, x: P.x, z: P.z, unleashed: B.unleashed, inFight: !!g.combatSystem().vitals.get(B), py: P.y, gy: g.ground(P.x, P.z), sol };
});
check('Inside the valley mid-wave', inside.stage === 'inside' && inside.phase === 'wave1' && inside.active && Math.hypot(inside.x - 68, inside.z - 148) < 10, JSON.stringify(inside));
check('Player stands on valley ground', Math.abs(inside.py - inside.gy) < 0.3);
check('The surviving soldiers came through', inside.sol.length === 3 && inside.sol.every((d) => d < 20), JSON.stringify(inside.sol));
check('The Warden fights (unleashed, hittable)', inside.unleashed && inside.inFight);
await page.evaluate(() => window.H.steps(90));
await shot('04-valley-raid');
// Clear his soldiers so the powers can be forced one by one.
await page.evaluate(() => { const { E } = window.H; for (const b of E.wave) if (!b.dead) b.kill(); });

// Each power, forced in turn (other actions on cooldown).
const POWERS = ['inferno', 'meteor', 'thunderstep', 'wrath', 'tempest'];
for (const pw of POWERS) {
  const r = await page.evaluate(async (pw) => {
    const { g, steps, E } = window.H; const B = g.arena().brains.find((b) => b.e.kind === 'warden'), C = g.combat(), S = g.combatSystem();
    E.realmT = 0;
    const all = ['combo', 'lunge', 'cleave', 'stepslash', 'flamecut', 'firewave', 'fireballs', 'lightning', 'storm', 'teleport', 'inferno', 'meteor', 'thunderstep', 'wrath', 'tempest'];
    // Wait until he is free, then leave only this power available.
    for (let i = 0; i < 600 && !['hold', 'approach', 'reposition'].includes(B.state); i++) steps(1);
    for (const a of all) B.cool[a] = a === pw ? 0 : 99;
    B.lastAction = null; B.decideIn = 0;
    const n0 = B.actionLog.length, hits = [], log0 = S.log.length;
    let used = false, frames = 0, sawWarn = false;
    for (let i = 0; i < 60 * 9; i++) {
      steps(1); frames++;
      if (!used && B.actionLog.length > n0 && B.actionLog[B.actionLog.length - 1][1] === pw) used = true;
      if (used && g.vfx().decals?.some?.((d) => d.alive)) sawWarn = true;
      if (used && i > 60 * 5 && ['hold', 'approach', 'reposition'].includes(B.state)) break;
    }
    for (const e of S.log.slice(log0)) { const j = JSON.stringify(e); const m = j.match(/warden\.[a-z0-9]+/); if (m) hits.push(`${e.what}:${m[0]}`); }
    return { used, frames, hits: hits.slice(0, 6), sawWarn, state: B.state, last: B.actionLog.slice(-3), excl: B.director.exclusive, live: B.ctx.spells.active(B), log: S.log.slice(-3).map((e) => JSON.stringify(e).slice(0, 120)) };
  }, pw);
  check(`Power ${pw} is used`, r.used, JSON.stringify(r));
  await shot(`05-${pw}`);
}
// A capture mid-power for each (the effect at its peak).
for (const [pw, at, extra] of [['inferno', 92, 14], ['meteor', 118, 8], ['wrath', 70, 0], ['tempest', 60, 0], ['thunderstep', 40, 0]]) {
  await page.evaluate((pw) => {
    const { g, steps, E } = window.H; const B = g.arena().brains.find((b) => b.e.kind === 'warden');
    E.realmT = 0;
    const all = ['combo', 'lunge', 'cleave', 'stepslash', 'flamecut', 'firewave', 'fireballs', 'lightning', 'storm', 'teleport', 'inferno', 'meteor', 'thunderstep', 'wrath', 'tempest'];
    for (let i = 0; i < 600 && !['hold', 'approach', 'reposition'].includes(B.state); i++) steps(1);
    for (const a of all) B.cool[a] = a === pw ? 0 : 99;
    B.lastAction = null; B.decideIn = 0;
    const n0 = B.actionLog.length;
    for (let i = 0; i < 400 && B.actionLog.length === n0; i++) steps(1);
  }, pw);
  await page.evaluate((n) => window.H.steps(n), at);
  await shot(`06-${pw}-peak`);
  if (extra) { await page.evaluate((n) => window.H.steps(n), extra); await shot(`06-${pw}-peak2`); }
  await page.evaluate(() => window.H.steps(240));
}
// He withdraws: back to the temple, where the wave is finished.
await page.evaluate(() => { const { E } = window.H; E.realmT = 999; });
await page.evaluate(() => { const { E, steps } = window.H; for (let i = 0; i < 400 && E.realmStage !== 'done'; i++) steps(1); });
const back = await page.evaluate(() => {
  const { E, g } = window.H; const r = g.realm(), P = g.player.position, B = g.arena().brains.find((b) => b.e.kind === 'warden');
  return { stage: E.realmStage, phase: E.phase, active: r.active, root: r.root.visible, x: P.x, z: P.z, wardenVisible: B.e.object.visible, inFight: !!g.combatSystem().vitals.get(B), hp: E.wardenHp };
});
check('Back in the temple where the player left', back.stage === 'done' && !back.active && !back.root && Math.hypot(back.x - ret[0], back.z - ret[2]) < 1.5, JSON.stringify(back));
check('The Warden has withdrawn (keeps his wounds)', !back.wardenVisible && !back.inFight);
await page.evaluate(() => window.H.steps(40));
await shot('07-temple-again');
const w2 = await page.evaluate(() => { const { E, steps } = window.H; for (let i = 0; i < 60 * 4 && E.phase === 'wave1'; i++) steps(1); return E.phase; });
check('Wave 2 follows', w2 === 'wave2', w2);
// The final fight goes through the realm too.
const fin = await page.evaluate(() => {
  const { E, g, steps } = window.H; E.queue = []; for (const b of E.wave) if (!b.dead) b.kill(); E.visited.add(2); E.visited.add(3);
  E.startWarden(); for (let i = 0; i < 60 * 8 && E.realmStage !== 'inside'; i++) steps(1);
  return [E.phase, E.realmStage, g.realm().active];
});
check('Final fight: the realm again', fin[0] === 'warden' && fin[1] === 'inside' && fin[2], fin.join());
await page.evaluate(() => { const { E, steps } = window.H; E.realmT = 999; for (let i = 0; i < 400 && E.realmStage !== 'done'; i++) steps(1); });
check('Final fight returns to the temple', await page.evaluate(() => !window.H.g.realm().active && window.H.E.realmStage === 'done'));
check('No page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(`\n${results.filter((r) => r.pass).length}/${results.length} passed`);
await browser.close();
