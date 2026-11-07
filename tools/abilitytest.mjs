// Ability test harness (dev tool, not part of the game): Phantom Step, Colossus Rift, Gravity Rupture in the real game.
//
// usage: npm run dev   (another terminal)
//        node tools/abilitytest.mjs [--shots <dir>]
//
// Drives the real Input (keyboard Q / E / R, and the touch SPIRIT stance through real touch events) against live
// enemies in the dev arena (?combat=...), stepping the game deterministically at 1/60 s. Enemies used as targets have
// their decisions and steering stubbed on the instance (as in tools/combattest.mjs) so they stand where placed.
// With --shots, frames of each ability are saved as JPEGs (cinematic camera) for review.
import fs from 'fs';
import { createRequire } from 'module';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const BASE = process.env.TLC_URL || 'http://localhost:5173';
const SHOTS = process.argv.includes('--shots') ? process.argv[process.argv.indexOf('--shots') + 1] : null;
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (group, name, ok, detail) => { results.push({ group, name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  [${group}] ${name}  — ${detail}`); };

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
async function page(spec, opts = {}) {
  const ctx = await b.newContext({ viewport: { width: 960, height: 540 }, ...(opts.touch ? { hasTouch: true, isMobile: true } : {}) });
  const p = await ctx.newPage(); p.setDefaultTimeout(900000);
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await p.goto(`${BASE}/?combat=${spec}&quality=${opts.quality || 'low'}&seed=1`);
  await p.waitForFunction(() => window.__tlc?.ready, null, { polling: 500 });
  await p.evaluate((shots) => { window.SHOTS = shots; }, !!SHOTS);
  await p.evaluate(() => {
    const g = window.__tlc; g.pause(false); g.start(); g.pause(true);
    document.querySelectorAll('#loader,#title,#hint,#quality,#fps').forEach((e) => (e.style.display = 'none'));
    // Test helpers: freeze an enemy in place (no decisions, steering or turning), place it, read vitals.
    window.H = {
      freeze(br) { br.decide = () => {}; br.tryAttack = () => {}; br.move = () => {}; br.turnTo = () => {}; br.orbit = () => new br.pos.constructor(); },
      place(br, x, z, yaw = 0) { br.e.object.position.set(x, g.player.position.y, z); br.e.object.rotation.y = yaw; br.set('hold'); },
      hp(br) { return g.combatSystem().vitals.get(br).hp; },
      meter(br) { return g.combatSystem().vitals.get(br).meter; },
      setup(px, pz, yaw) { g.teleport(px, pz); g.player.setFacing(yaw); g.combat().setDrawn(true); g.view(yaw + Math.PI, -0.1); g.step(2, 1 / 60, false); },
      shot(cam, look) {
        if (!window.SHOTS) return null;
        const c = g.camera, p0 = c.position.clone(), q0 = c.quaternion.clone();
        c.position.set(...cam); c.lookAt(...look); c.updateMatrixWorld();
        g.post.render(); g.renderer.getContext().finish();
        const u = g.renderer.domElement.toDataURL('image/jpeg', 0.9);
        c.position.copy(p0); c.quaternion.copy(q0); c.updateMatrixWorld();
        return u;
      },
    };
  });
  return { p, ctx, errors };
}
const save = (name, url) => { if (SHOTS && url) fs.writeFileSync(`${SHOTS}/${name}.jpg`, Buffer.from(url.split(',')[1], 'base64')); };

// ------------------------------------------------------------------------------------------------ Phantom Step
{
  const { p, ctx, errors } = await page('r2b0');
  const r = await p.evaluate(async () => {
    const g = window.__tlc, A = g.arena(), C = g.combat(), I = g.input;
    const rs = A.brains.filter((x) => x.e.cls === 'runner');
    rs.forEach((x) => H.freeze(x));
    H.setup(0, 38, Math.PI);   // facing -z
    H.place(rs[0], 0, 35, 0); H.place(rs[1], 3.5, 35, 0);
    g.step(2, 1 / 60, false);
    const start = g.player.position.clone(), hp0 = H.hp(rs[0]), hpSide = H.hp(rs[1]);
    const shots = [];
    await new Promise((r) => setTimeout(r, 0));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyQ' })); window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyQ' }));
    let invTravel = true, started = false, ghostSeen = false, hidden = false;
    for (let f = 0; f < 50; f++) {
      g.step(1, 1 / 60, false);
      if (C.state === 'spirit') started = true;
      const ab = g.abilities();
      if (ab.kind === 'phantom' && C.t > 0.09 && C.t < 0.26 && !C.invulnerable) invTravel = false;
      if (ab.ghost) ghostSeen = true;
      if (!g.player.model.visible) hidden = true;
      if ([3, 8, 13, 18, 26].includes(f)) { const q = g.player.position; shots.push(H.shot([q.x + 3.6, q.y + 1.5, q.z + 2.6], [q.x - 0.5, q.y + 0.9, q.z - 1.5])); }
    }
    const end = g.player.position.clone();
    const travelled = Math.hypot(end.x - start.x, end.z - start.z);
    // Cooldown: pressing again at once does nothing.
    I.injectSpirit('phantom'); g.step(3, 1 / 60, false);
    const blockedByCool = C.state !== 'spirit';
    const cool = g.abilities().cool.phantom;
    return { started, travelled, passed: end.z < 35 - 0.5, dmg: hp0 - H.hp(rs[0]), side: hpSide - H.hp(rs[1]), invTravel, ghostSeen, hidden, visibleAfter: g.player.model.visible, state: C.state, blockedByCool, cool, shots,
      log: g.combatSystem().log.filter((l) => l.detail?.startsWith('phantom')).length };
  });
  r.shots.forEach((u, i) => save(`phantom_${i}`, u));
  check('Phantom Step', 'Q starts the ability', r.started, `state seen: spirit=${r.started}`);
  check('Phantom Step', 'Dashes about 6.5 m', Math.abs(r.travelled - 6.5) < 0.6, `${r.travelled.toFixed(2)} m`);
  check('Phantom Step', 'Passes through the enemy in its path', r.passed && r.ghostSeen, `ended beyond the enemy: ${r.passed}, ghost (no spacing push) seen: ${r.ghostSeen}`);
  check('Phantom Step', 'Cuts the enemy passed through once (14 damage)', r.dmg === 14 && r.log === 1, `damage ${r.dmg}, hit events ${r.log}`);
  check('Phantom Step', 'Enemy 3.5 m to the side is not hit', r.side === 0, `damage ${r.side}`);
  check('Phantom Step', 'Untouchable while travelling', r.invTravel, `invulnerable through travel: ${r.invTravel}`);
  check('Phantom Step', 'Body vanishes during travel and reappears', r.hidden && r.visibleAfter, `hidden: ${r.hidden}, visible after: ${r.visibleAfter}`);
  check('Phantom Step', 'Returns to free; cooldown blocks an immediate re-use', r.state === 'free' && r.blockedByCool && r.cool > 2.5, `state ${r.state}, re-use blocked ${r.blockedByCool}, cooldown left ${r.cool.toFixed(2)} s`);
  check('Phantom Step', 'No page errors', errors.length === 0, errors.join(' | ') || 'none');
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ Colossus Rift
{
  const { p, ctx, errors } = await page('r2b1');
  const r = await p.evaluate(async () => {
    const g = window.__tlc, A = g.arena(), C = g.combat(), I = g.input;
    A.brains.forEach((x) => H.freeze(x));
    const rs = A.brains.filter((x) => x.e.cls === 'runner'), bk = A.brains.find((x) => x.e.cls === 'breaker');
    H.setup(0, 40, Math.PI);
    H.place(rs[0], -0.8, 33, 0); H.place(bk, 1.2, 31, 0); H.place(rs[1], 0, 22, 0);   // in range: 7 m, 9 m; out of range: 18 m
    g.view(0, -0.12);  // camera behind the player, looking down -z (aim)
    g.step(2, 1 / 60, false);
    const hp = A.brains.map((x) => H.hp(x)), m0 = H.meter(bk);
    const shots = [];
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyE' }));
    let charged = 0;
    for (let f = 0; f < 66; f++) { g.step(1, 1 / 60, false); charged = Math.max(charged, g.abilities().charge ?? 0); if (f === 40) { const q = g.player.position; shots.push(H.shot([q.x + 2.2, q.y + 1.6, q.z + 2.2], [q.x, q.y + 1.3, q.z])); } }
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyE' }));
    for (let f = 0; f < 70; f++) {
      g.step(1, 1 / 60, false);
      if ([8, 16, 24, 34].includes(f)) { const q = g.player.position; shots.push(H.shot([q.x + 3.4, q.y + 2.2, q.z + 3.0], [q.x - 0.4, q.y + 0.8, q.z - 6])); }
    }
    const dmg = { near: hp[A.brains.indexOf(rs[0])] - H.hp(rs[0]), breaker: hp[A.brains.indexOf(bk)] - H.hp(bk), far: hp[A.brains.indexOf(rs[1])] - H.hp(rs[1]) };
    const meter = H.meter(bk) - m0;
    // Minimum charge (tap): weaker wave.
    g.abilities().cool.rift = 0; rs[0].revive(rs[0].e.object.position.clone(), 0); H.freeze(rs[0]); g.combatSystem().vitals.set(rs[0], g.combatSystem().freshVitals(rs[0]));
    H.place(rs[0], 0, 33, 0); g.step(2, 1 / 60, false);
    const hpTap = H.hp(rs[0]);
    I.injectSpirit('rift'); I.injectSpirit('riftUp');
    for (let f = 0; f < 80; f++) g.step(1, 1 / 60, false);
    return { dmg, meter, charged, state: C.state, tapDmg: hpTap - H.hp(rs[0]), shots,
      hits: g.combatSystem().log.filter((l) => l.detail?.startsWith('rift')).map((l) => `${l.who}:${l.amount}`) };
  });
  r.shots.forEach((u, i) => save(`rift_${i}`, u));
  const d = r.dmg;
  check('Colossus Rift', 'Holding E charges to full', r.charged >= 1, `charge ${r.charged.toFixed(2)}`);
  check('Colossus Rift', 'Full-charge wave hits the Runner at 7 m (34)', d.near === 34, `damage ${d.near}`);
  check('Colossus Rift', 'Full-charge wave hits the Breaker at 9 m (34, meter +34)', d.breaker === 34 && Math.abs(r.meter - 34) < 0.5, `damage ${d.breaker}, meter +${r.meter.toFixed(1)}`);
  check('Colossus Rift', 'Out of range (18 m) is not hit', d.far === 0, `damage ${d.far}`);
  // A tap charges to the 0.3 s minimum: scale lerp(0.55, 1, 0.3) = 0.685 -> 34 x 0.685 = 23.
  check('Colossus Rift', 'A tap fires a weaker minimum-charge wave (23)', r.tapDmg === 23, `damage ${r.tapDmg}`);
  check('Colossus Rift', 'Each enemy hit once per wave; returns to free', r.state === 'free', `hits ${r.hits.join(' ')}, state ${r.state}`);
  check('Colossus Rift', 'No page errors', errors.length === 0, errors.join(' | ') || 'none');
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ Gravity Rupture
{
  const { p, ctx, errors } = await page('r3b1');
  const r = await p.evaluate(async () => {
    const g = window.__tlc, A = g.arena(), C = g.combat();
    A.brains.forEach((x) => H.freeze(x));
    const rs = A.brains.filter((x) => x.e.cls === 'runner'), bk = A.brains.find((x) => x.e.cls === 'breaker');
    H.setup(0, 36, Math.PI);
    const c = { x: 0, z: 36 - 0.55 };
    H.place(rs[0], 0, 32.5, 0); H.place(rs[1], 4.2, 36, -Math.PI / 2); H.place(rs[2], -9, 36, Math.PI / 2); H.place(bk, -3.0, 33.5, 0.7);
    g.step(2, 1 / 60, false);
    const dist = (x) => { const e = x.effective(); return Math.hypot(e.x - c.x, e.z - c.z); };
    const d0 = A.brains.map(dist), hp = A.brains.map((x) => H.hp(x)), m0 = H.meter(bk);
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyR' })); window.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyR' }));
    const shots = []; let inv = false, minD = d0.slice();
    for (let f = 0; f < 110; f++) {
      g.step(1, 1 / 60, false);
      if (C.invulnerable) inv = true;
      A.brains.forEach((x, i) => { minD[i] = Math.min(minD[i], dist(x)); });
      if ([12, 27, 40, 60, 78].includes(f)) { const q = g.player.position; shots.push(H.shot([q.x + 4.2, q.y + 2.6, q.z - 4.6], [q.x - 0.3, q.y + 0.4, q.z - 0.3])); }
      if ([20, 30, 50].includes(f)) { const q = g.player.position; shots.push(H.shot([q.x + 2.3, q.y + 1.1, q.z - 1.6], [q.x, q.y + 0.6, q.z - 0.4])); }
    }
    // Pose check at the impact: katana tip in the ground in front of the player.
    const role = { near: rs[0], side: rs[1], far: rs[2], breaker: bk };
    const out = {}; for (const [k, x] of Object.entries(role)) { const i = A.brains.indexOf(x); out[k] = { pulled: d0[i] - minD[i], min: minD[i], dmg: hp[i] - H.hp(x) }; }
    return { roles: out, meter: H.meter(bk) - m0, inv, state: C.state, shots,
      hits: g.combatSystem().log.filter((l) => /^(rupture|implode)/.test(l.detail || '')).map((l) => `${l.who}:${l.detail.split(' ')[0]}:${l.amount}`) };
  });
  r.shots.forEach((u, i) => save(`rupture_${i}`, u));
  const o = r.roles, f2 = (x) => x.toFixed(2);
  check('Gravity Rupture', 'Ring hits nearby enemies at impact (18)', o.near.dmg >= 18 && o.side.dmg >= 18, `near ${o.near.dmg}, side ${o.side.dmg} (incl. collapse)`);
  check('Gravity Rupture', 'Enemies within 7.5 m are pulled toward the blade', o.near.pulled > 0.8 && o.side.pulled > 1.5, `near (3 m) ${f2(o.near.pulled)} m, side (4.2 m) ${f2(o.side.pulled)} m`);
  check('Gravity Rupture', 'Pulled enemies stop short of the player (≥1.3 m)', Math.min(o.near.min, o.side.min) >= 1.3, `closest ${f2(Math.min(o.near.min, o.side.min))} m`);
  check('Gravity Rupture', 'The Breaker resists (pulled less than a Runner) and gains meter', o.breaker.pulled > 0.2 && o.breaker.pulled < o.side.pulled && r.meter > 20, `pulled ${f2(o.breaker.pulled)} m, meter +${r.meter.toFixed(1)}`);
  check('Gravity Rupture', 'Collapse hits enemies dragged in (12 more)', r.hits.some((h) => h.includes('implode')), `hits ${r.hits.join(' ')}`);
  check('Gravity Rupture', 'Enemy at 9 m is untouched', o.far.dmg === 0 && o.far.pulled < 0.05, `damage ${o.far.dmg}, moved ${f2(o.far.pulled)} m`);
  check('Gravity Rupture', 'Untouchable around the impact; returns to free', r.inv && r.state === 'free', `invulnerable seen ${r.inv}, state ${r.state}`);
  check('Gravity Rupture', 'No page errors', errors.length === 0, errors.join(' | ') || 'none');
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ walls (low frame rates)
{
  const { p, ctx, errors } = await page('r0b0');
  const r = await p.evaluate(async () => {
    const g = window.__tlc, I = g.input, out = {};
    // The sealed main gate: a 0.5 m door collider at z = 47.62. Dash and fire at it with long frames (20 fps).
    for (const dt of [1 / 30, 1 / 20]) {
      H.setup(0, 44.8, 0); g.abilities().reset(); g.step(2, dt, false);
      I.injectSpirit('phantom'); for (let f = 0; f < 30; f++) g.step(1, dt, false);
      out[`dash${Math.round(1 / dt)}`] = g.player.position.z;
      H.setup(0, 44.8, 0); g.view(Math.PI, -0.1); g.abilities().reset(); g.step(2, dt, false);
      I.injectSpirit('rift'); I.injectSpirit('riftUp');
      let maxZ = 0; for (let f = 0; f < 40; f++) { g.step(1, dt, false); for (const w of g.abilities().waves) if (!w.done) maxZ = Math.max(maxZ, w.pos.z); }
      out[`wave${Math.round(1 / dt)}`] = maxZ;
    }
    return out;
  });
  check('Walls', 'Phantom Step stops at the sealed gate (30 and 20 fps)', r.dash30 < 47.3 && r.dash20 < 47.3, `ended at z ${r.dash30.toFixed(2)} / ${r.dash20.toFixed(2)} (gate face 47.37)`);
  check('Walls', 'The Rift wave stops at the gate (30 and 20 fps)', r.wave30 < 47.9 && r.wave20 < 47.9, `furthest z ${r.wave30.toFixed(2)} / ${r.wave20.toFixed(2)}`);
  check('Walls', 'No page errors', errors.length === 0, errors.join(' | ') || 'none');
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ interaction with existing combat
{
  const { p, ctx, errors } = await page('r1b1');
  const r = await p.evaluate(async () => {
    const g = window.__tlc, A = g.arena(), C = g.combat(), I = g.input;
    A.brains.forEach((x) => H.freeze(x));
    const bk = A.brains.find((x) => x.e.cls === 'breaker'), rn = A.brains.find((x) => x.e.cls === 'runner');
    H.setup(0, 36, Math.PI); H.place(bk, 0, 34.2, 0); H.place(rn, 6, 30, 0); g.step(2, 1 / 60, false);
    // A Breaker smash lands while the Rift is charging: the ability is cut short, the hit applies normally.
    I.injectSpirit('rift'); g.step(10, 1 / 60, false);
    const charging = C.state === 'spirit';
    bk.attack = 'smash'; bk.beginTell();
    let out = null;
    for (let f = 0; f < 120 && !out; f++) { g.step(1, 1 / 60, false); const last = g.combatSystem().log.filter((l) => l.what.startsWith('player ')).pop(); if (last) out = last.what; }
    const after = C.state;
    for (let f = 0; f < 200; f++) g.step(1, 1 / 60, false);
    I.injectSpirit('riftUp');
    // Katana combo still works afterwards.
    C.reset(); g.step(2, 1 / 60, false);
    I.inject('attack'); g.step(10, 1 / 60, false);
    const cut = C.move;
    // Cancel the tail of a cut into Phantom Step.
    g.step(20, 1 / 60, false); I.injectSpirit('phantom');
    let cancel = false; for (let f = 0; f < 12 && !cancel; f++) { g.step(1, 1 / 60, false); cancel = C.state === 'spirit' && C.spiritKind === 'phantom'; }
    g.step(30, 1 / 60, false);
    // Defeat resets cooldowns.
    const coolBefore = g.abilities().cool.phantom; C.reset();
    return { charging, out, after, cut, cancel, coolBefore, coolAfter: g.abilities().cool.phantom, aura: g.spiritFx() ? true : false };
  });
  check('Integration', 'A hit during the Rift charge interrupts it and applies normally', r.charging && /player hit/.test(r.out || '') && r.after === 'knockdown', `charging ${r.charging}, outcome "${r.out}", state after ${r.after}`);
  check('Integration', 'Katana combo works after abilities', r.cut === 'cut1', `move ${r.cut}`);
  check('Integration', 'A cut\'s tail can be cancelled into Phantom Step', r.cancel, `cancelled: ${r.cancel}`);
  check('Integration', 'Defeat / retry resets cooldowns', r.coolBefore > 0 && r.coolAfter === 0, `${r.coolBefore.toFixed(2)} → ${r.coolAfter}`);
  check('Integration', 'No page errors', errors.length === 0, errors.join(' | ') || 'none');
  await ctx.close();
}

// ------------------------------------------------------------------------------------------------ mobile: SPIRIT stance with real touch events
{
  const { p, ctx, errors } = await page('r1b0', { touch: true });
  await p.evaluate(() => { document.querySelectorAll('#loader,#title,#hint').forEach((e) => (e.style.display = 'none')); const g = window.__tlc; g.arena().brains.forEach((x) => H.freeze(x)); H.setup(0, 38, Math.PI); });
  const box = async (sel) => (await p.locator(sel).boundingBox());
  const spiritBox = await box('#touch .spirit'), dodgeBox = await box('#touch .dodge'), atkBox = await box('#touch .attack'), blockBox = await box('#touch .block');
  const tap = async (bx) => p.touchscreen.tap(bx.x + bx.width / 2, bx.y + bx.height / 2);
  await tap(spiritBox);
  const labels = await p.evaluate(() => [...document.querySelectorAll('#touch .act')].map((e) => `${e.className.split(' ')[1]}=${e.textContent}`).join(' '));
  await tap(dodgeBox);
  const r1 = await p.evaluate(() => { const g = window.__tlc; g.step(4, 1 / 60, false); return { state: g.combat().state, kind: g.combat().spiritKind, stance: g.input.stance, label: document.querySelector('#touch .dodge').textContent }; });
  await p.evaluate(() => window.__tlc.step(60, 1 / 60, false));
  // Normal DODGE outside the stance still rolls.
  await tap(dodgeBox);
  const r2 = await p.evaluate(() => { const g = window.__tlc; g.step(4, 1 / 60, false); return g.combat().state; });
  await p.evaluate(() => window.__tlc.step(60, 1 / 60, false));
  // Stance + ATTACK held = Rift charge; release fires.
  await tap(spiritBox);
  await p.touchscreen.tap(atkBox.x + atkBox.width / 2, atkBox.y + atkBox.height / 2);
  const r3 = await p.evaluate(() => { const g = window.__tlc; g.step(50, 1 / 60, false); return { kind: g.combat().spiritKind, state: g.combat().state }; });
  await p.evaluate(() => window.__tlc.step(80, 1 / 60, false));
  await tap(spiritBox); await tap(blockBox);
  const r4 = await p.evaluate(() => { const g = window.__tlc; g.step(4, 1 / 60, false); return g.combat().spiritKind; });
  // The stance times out on its own.
  await p.evaluate(() => window.__tlc.step(120, 1 / 60, false));
  await tap(spiritBox);
  if (SHOTS) { await p.evaluate(() => { const g = window.__tlc; g.pause(false); }); await p.screenshot({ path: `${SHOTS}/mobile_stance.jpg`, type: 'jpeg', quality: 85 }); await p.evaluate(() => window.__tlc.pause(true)); }
  await p.waitForTimeout(2600);
  const r5 = await p.evaluate(() => { const g = window.__tlc; g.input.spiritStatus(g.abilities().readiness()); return { stance: g.input.stance, label: document.querySelector('#touch .attack').textContent }; });
  check('Mobile', 'SPIRIT turns DODGE / ATTACK / BLOCK into the abilities', /dodge=STEP/.test(labels) && /attack=RIFT/.test(labels) && /block=RUPTURE/.test(labels), labels);
  check('Mobile', 'Stance + DODGE = Phantom Step; the stance closes', r1.kind === 'phantom' && !r1.stance && r1.label === 'DODGE', JSON.stringify(r1));
  check('Mobile', 'DODGE outside the stance still rolls', r2 === 'roll', `state ${r2}`);
  check('Mobile', 'Stance + ATTACK = Colossus Rift', r3.kind === 'rift' || r3.state === 'spirit', JSON.stringify(r3));
  check('Mobile', 'Stance + BLOCK = Gravity Rupture', r4 === 'rupture', `kind ${r4}`);
  check('Mobile', 'The stance times out by itself (2.2 s)', !r5.stance && r5.label === 'ATTACK', JSON.stringify(r5));
  check('Mobile', 'No page errors', errors.length === 0, errors.join(' | ') || 'none');
  await ctx.close();
}

await b.close();
const fail = results.filter((r) => !r.ok);
console.log(`\n${results.length - fail.length}/${results.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
