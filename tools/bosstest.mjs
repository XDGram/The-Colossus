// Temple Warden boss test harness (dev tool, not part of the game).
//
// Drives the real game in the dev boss arena (/?combat=w1: the Warden alone; no encounter or waves) at fixed 1/60 s
// steps and checks the approved boss values (docs/boss.md, src/combat/tables.ts 'warden.*'): damage, blocking,
// parrying, warnings, spells and their counterplay, phases, the summon, posture, fairness under the real AI, and an
// estimate of fight duration with a scripted player.
//
// usage: npm run dev   (another terminal; http://localhost:5173)
//        node tools/bosstest.mjs [--only <group,…>]
import { createRequire } from 'module';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null;
const BASE = process.env.TLC_URL || 'http://localhost:5173';
const want = (g) => !ONLY || ONLY.includes(g);

// Expected values (docs/boss.md, written out here rather than imported).
const DOC = {
  hp: 450, posture: 150, kneeDrop: 2.5, phase2: 0.65, phase3: 0.30,
  combo: [10, 10, 14], comboBlk: [3, 3, 4], lunge: 14, cleave: 22, cleaveBlk: 11, stepslash: 12, flamecut: 10,
  storm: [12, 24], stormBlk2: 12, tpstrike: 14, firewave: 14, firewaveBlk: 4, fireball: 10, flame: 5, lightning: 22,
  tellSword: 0.45, groundWarn: 0.9, lightningWarn: 1.0, flameArm: 0.25, flameTick: 0.5, vanish: 0.45,
};
const FRAME = 1 / 60, TOL = { frame: FRAME * 1.01, t: 0.06 };

const results = []; let group = '';
const check = (name, pass, detail = '') => { results.push({ group, name, pass: !!pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'}  [${group}] ${name}${detail ? `  — ${detail}` : ''}`); };
const f2 = (n) => (n === undefined || n === null ? String(n) : (+n).toFixed(2));

// ------------------------------------------------------------------------------------------------ page library
function pageLib() {
  const g = window.__tlc, A = g.arena(), C = g.combat(), S = g.combatSystem(), P = g.player, I = g.input;
  const V = P.position.constructor;
  const B = A.brains.find((b) => b.e.kind === 'warden');
  const H = { g, A, C, S, P, I, B, V, frame: 0, events: [] };
  H.step = (n = 1) => { for (let i = 0; i < n; i++) { g.step(1, 1 / 60, false); H.frame++; H.onFrame?.(); } };
  H.secs = (s) => H.step(Math.round(s * 60));
  const snap = () => ({ f: H.frame, st: +S.time.toFixed(4), p: { state: C.state, t: +C.t.toFixed(3), hp: C.hp, x: P.position.x, z: P.position.z }, b: { state: B.state, move: B.e.move, time: +B.e.time.toFixed(3), phase: B.phase } });
  const push = S.log.push.bind(S.log);
  S.log.push = (e) => { H.events.push({ ...e, ...snap() }); return push(e); };
  H.begin = () => { H.events = []; H.frame = 0; };
  H.sys = () => H.events;
  H.hits = () => H.events.filter((e) => /^player /.test(e.what));
  H.view = () => ({ position: P.position, facing: P.facing, radius: 0.38, attackKey: null, mash: 0 });
  H.clearInput = () => { I.keys.clear(); I.attackQ = 0; I.dodgeQ = 0; I.blockPressQ = 0; I.attackDown = false; I.blockMouse = false; };
  /** The boss as a controlled target: no decisions of his own (test-side stub); other enemies parked and frozen. */
  H.freeze = () => { B.choose = () => {}; };
  H.unfreeze = () => { delete B.choose; delete B.turnTo; };
  H.fresh = (phase = 1) => {
    H.clearInput(); A.bossCtx.spells?.clear(); C.reset(); C.setDrawn(true);
    for (const b of [...A.brains]) if (b !== B) { A.director.release(b.id); b.e.object.visible = false; b.removed = true; S.drop(b); A.brains.splice(A.brains.indexOf(b), 1); }
    B.revive(B.e.object.position.clone(), B.e.object.rotation.y); S.vitals.set(B, S.freshVitals(B));
    B.phase = phase; B.summoned = phase >= 2; A.director.exclusive = null;
    H.step(2);
  };
  /** Player at (0, 36) in the open courtyard, facing -z; the boss `d` m in front, facing him. */
  H.Z = 36;
  H.setup = (d = 1.6, phase = 1) => {
    H.fresh(phase); H.freeze();
    for (const b of A.brains) A.director.release(b.id);
    A.director.lastStart = -Infinity; A.director.exclusive = null;
    g.teleport(0, H.Z); P.setFacing(Math.PI); g.tpc.yaw = Math.PI * 2; g.tpc.pitch = -0.12;
    B.e.pivot.position.set(0, 0, 0); B.e.pivot.rotation.y = 0; B.e.object.position.set(0, P.position.y, H.Z - d); B.e.object.rotation.y = 0;
    B.e.play('guard', 0); B.set('hold'); B.attack = null; B.e.object.visible = true;
    H.step(2); H.begin();
  };
  H.force = (move) => { B.attack = move; B.beginTell(); };
  H.action = (a) => B.startAction(a, H.view(), A.time);
  H.atk = () => { I.attackQ++; };
  H.dodge = () => { I.dodgeQ++; };
  H.blockDown = () => { I.blockMouse = true; I.blockPressQ++; };
  H.blockUp = () => { I.blockMouse = false; };
  /** Keep the camera looking at the boss over the player's shoulder (as a player would during the fight). */
  H.lookAtBoss = () => { const e = B.effective(); g.tpc.yaw = Math.atan2(e.x - P.position.x, e.z - P.position.z) + Math.PI; };
  H.dist = () => { const e = B.effective(); return Math.hypot(P.position.x - e.x, P.position.z - e.z); };
  window.H = H;
}
const SCEN = {
  /** Force a boss move against an idle (or blocking) player; re-place the player after each hit (isolates values). */
  move(move, d, mode = 'idle', phase = 1, secs = 3.5, replace = true) {
    H.setup(d, phase);
    if (mode === 'block') { H.blockDown(); H.secs(0.3); H.begin(); }
    const start = { x: H.P.position.x, z: H.P.position.z };
    let tellLen = null, t0 = H.frame; H.force(move);
    let n = 0;
    for (let f = 0; f < secs * 60; f++) {
      H.step(1);
      if (tellLen === null && H.B.state !== 'tell') tellLen = (H.frame - t0) / 60;
      const hs = H.hits();
      if (replace && hs.length > n) { n = hs.length; H.step(24); H.g.teleport(start.x, start.z); H.P.setFacing(Math.PI); if (mode === 'block') H.blockDown(); }
    }
    return { tellLen, hits: H.hits().map((e) => ({ what: e.what, amount: e.amount, table: (e.detail || '').split(' ')[0], bt: e.b.time, pstate: e.p.state })), glint: H.B.cue.material.color.getHexString() };
  },
};

// ------------------------------------------------------------------------------------------------ run
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const pageErrors = [];
const p = await browser.newPage({ viewport: { width: 640, height: 360 } });
p.setDefaultTimeout(1800000);
p.on('pageerror', (e) => pageErrors.push(e.message));
await p.goto(`${BASE}/?combat=w1&quality=low&seed=1`);
await p.waitForFunction(() => window.__tlc?.ready, null, { polling: 500 });
await p.evaluate(() => { window.__tlc.pause(true); window.__tlc.start(); });
await p.evaluate(pageLib);
await p.evaluate(`window.SCEN = {${Object.entries(SCEN).map(([k, fn]) => `${k}: function ${fn.toString().slice(fn.toString().indexOf('('))}`).join(',')}}`);
const S = (name, ...args) => p.evaluate(([n, a]) => window.SCEN[n](...a), [name, args]);
const E = (fn, arg) => p.evaluate(fn, arg);
const dmg = (r) => r.hits.map((h) => `${h.what} ${h.amount}`).join(', ');

if (want('sword')) {
  group = 'Sword moves';
  let r = await S('move', 'combo', 1.6);
  check('Combo: 3 hits of 10 / 10 / 14', r.hits.length === 3 && r.hits.every((h, i) => h.what === 'player hit' && h.amount === DOC.combo[i]), dmg(r));
  check('Combo: 0.45 s pale (parryable) warning', Math.abs(r.tellLen - DOC.tellSword) <= TOL.frame * 2 && r.glint === 'fff2d8', `tell ${f2(r.tellLen)} s, glint #${r.glint}`);
  r = await S('move', 'lunge', 3.4);
  check('Lunge from 3.4 m: 14', r.hits.length === 1 && r.hits[0].amount === DOC.lunge, dmg(r));
  r = await S('move', 'cleave', 1.6);
  check('Overhead cleave: 22 and knockdown, red (unparryable) warning', r.hits.length === 1 && r.hits[0].amount === DOC.cleave && r.hits[0].pstate === 'knockdown' && r.glint === 'ff3a22', `${dmg(r)} (${r.hits[0]?.pstate}); glint #${r.glint}`);
  r = await S('move', 'flamecut', 1.6, 'idle', 2);
  check('Flame-line cut: the slash deals 10', r.hits[0]?.table === 'warden.flamecut' && r.hits[0].amount === DOC.flamecut, dmg(r));
  r = await S('move', 'storm', 1.6, 'idle', 3);
  check('Storm combo (phase 3): 12 then 24', r.hits.length === 2 && r.hits[0].amount === 12 && r.hits[1].amount === 24, dmg(r));
  const st = await E(() => {
    H.setup(1.6, 3); H.force('storm'); let redFrom = -1, hit2 = -1;
    let n = 0;
    for (let f = 0; f < 200; f++) { H.step(1); const c = H.B.cue; if (redFrom < 0 && c.visible && c.material.color.getHexString() === 'ff3a22' && H.B.state === 'attack') redFrom = H.B.e.time; const hs = H.hits(); if (hs.length >= 2 && hit2 < 0) hit2 = hs[1].b.time; if (hs.length === 1 && n === 0) { n = 1; H.step(24); H.g.teleport(0, H.Z); H.P.setFacing(Math.PI); } }
    return { redFrom, hit2 };
  });
  check('Storm combo: red warning shown at least 0.45 s before the unparryable second hit', st.redFrom >= 0 && st.hit2 - st.redFrom >= 0.45 - TOL.frame, `red from ${f2(st.redFrom)} s, hit 2 at ${f2(st.hit2)} s`);
  const ss = await E(() => {
    H.setup(2.2, 1); H.action('stepslash'); let tell = -1;
    for (let f = 0; f < 240; f++) { H.step(1); if (tell < 0 && H.B.state === 'tell' && H.B.attack === 'stepslash') tell = H.frame; }
    const h = H.hits()[0];
    return { amount: h?.amount, table: (h?.detail || '').split(' ')[0], warn: h ? (h.f - tell) / 60 : null };
  });
  check('Side-step roll then slash: 12, with at least a 0.45 s warning after the roll', ss.table === 'warden.stepslash' && ss.amount === DOC.stepslash && ss.warn >= DOC.tellSword - TOL.frame, JSON.stringify(ss));
}

if (want('block')) {
  group = 'Block and parry';
  let r = await S('move', 'combo', 1.6, 'block');
  check('Combo vs block: 3 / 3 / 4', r.hits.length === 3 && r.hits.every((h, i) => h.what === 'player blocked' && h.amount === DOC.comboBlk[i]), dmg(r));
  r = await S('move', 'cleave', 1.6, 'block');
  check('Cleave vs block: guard break, 11', r.hits[0]?.what === 'player guardBreak' && r.hits[0].amount === DOC.cleaveBlk, dmg(r));
  r = await S('move', 'storm', 1.6, 'block', 3);
  check('Storm combo vs block: 3, then guard break 12', r.hits.length === 2 && r.hits[0].what === 'player blocked' && r.hits[0].amount === 3 && r.hits[1].what === 'player guardBreak' && r.hits[1].amount === DOC.stormBlk2, dmg(r));
  const pr = await E(() => {
    H.setup(1.6, 1); H.force('combo'); let c = null;
    for (let f = 0; f < 120 && c === null; f++) { H.step(1); const h = H.hits()[0]; if (h) c = h.b.time; }
    H.setup(1.6, 1); H.force('combo'); let pressed = false;
    for (let f = 0; f < 70; f++) { if (!pressed && H.B.state === 'attack' && H.B.e.time >= c - 0.08) { H.blockDown(); pressed = true; } else if (pressed) H.blockUp(); H.step(1); }
    return { first: H.hits()[0]?.what, amount: H.hits()[0]?.amount, posture: +H.S.vitals.get(H.B).meter.toFixed(1) };
  });
  check('Combo hit 1 vs a timed parry: 0 damage, posture +35', pr.first === 'player parried' && pr.amount === 0 && pr.posture === 35, JSON.stringify(pr));
}

if (want('spells')) {
  group = 'Spells';
  const fw = await E(() => {
    H.setup(3.5, 2); const t0 = H.frame; H.force('plunge'); let first = null;
    for (let f = 0; f < 200; f++) { H.step(1); const h = H.hits()[0]; if (h && first === null) first = h; }
    return { warn: first ? (first.f - t0) / 60 : null, amount: first?.amount, table: (first?.detail || '').split(' ')[0], pstate: first?.p.state, n: H.hits().length };
  });
  check('Fire wave: 14, after a ground warning of at least 0.9 s', fw.table === 'warden.firewave' && fw.amount === DOC.firewave && fw.warn >= DOC.groundWarn, JSON.stringify(fw));
  let r = await S('move', 'plunge', 3.5, 'block', 2, 3.5, false);
  check('Fire wave vs block: 4', r.hits[0]?.what === 'player blocked' && r.hits[0].amount === DOC.firewaveBlk, dmg(r));
  const roll = await E(() => {
    // Roll through: the ring (from 1.0 m in front of him, 7.5 m/s from radius 0.6) reaches the player's body ≈ (d - 1.0 - 0.6 - 0.73) / 7.5 s
    // after it spawns; press the roll 0.2 s before that, so the i-frames (0.12-0.45 s) cover it.
    // The roll is pressed just before the ring spawns (0.55 s into the plunge): it carries him through the ring's edge
    // while the i-frames (0.12-0.45 s) are up.
    H.setup(3.5, 2); H.force('plunge'); let pressed = false;
    for (let f = 0; f < 200; f++) {
      if (!pressed && H.B.state === 'attack' && H.B.e.move === 'plunge' && H.B.e.time >= 0.55) { H.dodge(); pressed = true; }
      H.step(1);
    }
    return H.hits().map((e) => e.what);
  });
  check('Fire wave: rolling through it avoids it', roll.length === 1 && roll[0] === 'player dodged', roll.join(', '));
  r = await S('move', 'palm', 6, 'idle', 2, 3.5, true);
  // An orb that arrives while the player is still in a hit flinch (0.35 s, untouchable) is avoided ('dodged').
  check('Fireball volley at an idle player: 3 orbs; each one that lands deals 10', r.hits.length === 3 && r.hits.every((h) => h.table === 'warden.fireball' && (h.what === 'player dodged' || h.amount === DOC.fireball)) && r.hits.some((h) => h.amount === DOC.fireball), dmg(r));
  const wall = await E(() => {
    // Player north of the solid wall at z 47.6; the boss south of it.
    H.setup(3, 2); H.g.teleport(0, 49.5); H.P.setFacing(Math.PI); H.B.e.object.position.set(0, H.P.position.y, 44.5); H.B.e.object.rotation.y = 0; H.step(2); H.begin();
    H.force('palm'); H.secs(3);
    return H.hits().length;
  });
  check('Fireballs are stopped by a wall', wall === 0, `${wall} hits`);
  const fl = await E(() => {
    H.setup(1.6, 2); H.force('flamecut'); let slash = -1;
    for (let f = 0; f < 240; f++) {
      H.step(1);
      const hs = H.hits();
      if (slash < 0 && hs[0]) { slash = hs[0].f; H.g.teleport(0, H.B.effective().z + 2.6); H.P.setFacing(Math.PI); }
      else if (slash >= 0) { H.g.teleport(0, H.B.effective().z + 2.6); }
    }
    const ticks = H.hits().filter((e) => (e.detail || '').startsWith('warden.flame ') && e.what === 'player hit');
    return { first: ticks[0] ? (ticks[0].f - slash) / 60 : null, gaps: ticks.slice(1).map((t, i) => +((t.f - ticks[i].f) / 60).toFixed(2)), amounts: ticks.map((t) => t.amount), n: ticks.length };
  });
  check('Burning strip: no damage for the first 0.25 s, then 5 every 0.5 s', fl.n >= 2 && fl.first >= DOC.flameArm - TOL.frame && fl.amounts.every((a) => a === DOC.flame) && fl.gaps.every((g) => Math.abs(g - DOC.flameTick) <= TOL.frame * 1.5), JSON.stringify(fl));
  const lt = await E(() => {
    const out = {};
    for (const mode of ['idle', 'move']) {
      H.setup(4, 3); const t0 = H.frame; H.force('raise');
      // Moving player: sprints back, then right, then forward (never doubling back over a warning circle).
      for (let f = 0; f < 60 * 3.2; f++) { if (mode === 'move') { H.I.keys.clear(); H.I.keys.add(f < 66 ? 'KeyS' : f < 120 ? 'KeyD' : 'KeyW'); H.I.keys.add('ShiftLeft'); } H.step(1); }
      H.clearInput();
      const hs = H.hits();
      out[mode] = { n: hs.length, amounts: hs.map((e) => e.amount), first: hs[0] ? (hs[0].f - t0) / 60 : null, pstates: hs.map((e) => e.p.state) };
    }
    return out;
  });
  check('Lightning at a player who stands still: 3 strikes of 22 (knockdown)', lt.idle.n === 3 && lt.idle.amounts.every((a) => a === DOC.lightning), JSON.stringify(lt.idle));
  check('Lightning: the first strike lands 1.0 s after its warning appears', lt.idle.first >= 0.3 + 0.25 + DOC.lightningWarn - TOL.frame, `first strike ${f2(lt.idle.first)} s after the cast began (tell 0.3 + marker at 0.25 + 1.0 warning)`);
  check('Lightning: a player who keeps moving is not hit', lt.move.n === 0, JSON.stringify(lt.move));
  r = await S('move', 'raise', 4, 'block', 3, 3.2, true);
  check('Lightning vs block: cannot be blocked (full 22 and knockdown even when blocking)', r.hits.length >= 1 && r.hits.every((h) => h.what === 'player hit' && h.amount === DOC.lightning && h.pstate === 'knockdown'), dmg(r));
}

if (want('teleport')) {
  group = 'Teleport';
  const tp = await E(() => {
    H.setup(5, 3); H.action('teleport'); let vanishAt = H.frame, back = -1, untouchable = true;
    for (let f = 0; f < 200; f++) {
      if (H.B.state === 'vanish' && H.B.invulnerable !== true) untouchable = false;
      H.step(1);
      if (back < 0 && H.B.e.object.visible && H.B.state === 'tell') back = H.frame;
    }
    const h = H.hits()[0];
    return { hidden: (back - vanishAt) / 60, untouchable, dist: null, warn: h ? (h.f - back) / 60 : null, amount: h?.amount, table: (h?.detail || '').split(' ')[0] };
  });
  check('Teleport: hidden and untouchable for 0.45 s', Math.abs(tp.hidden - DOC.vanish) <= 0.05 && tp.untouchable, JSON.stringify(tp));
  check('Teleport strike: 14, at least 0.45 s after he reappears', tp.table === 'warden.tpstrike' && tp.amount === DOC.tpstrike && tp.warn >= DOC.tellSword - TOL.frame, JSON.stringify(tp));
  const near = await E(() => {
    const d = [];
    for (let i = 0; i < 6; i++) { H.setup(6, 3); H.action('teleport'); for (let f = 0; f < 40 && H.B.state !== 'tell'; f++) H.step(1); d.push(+H.dist().toFixed(2)); }
    return d;
  });
  check('Teleport: he reappears 1.4-1.9 m from the player (behind or beside)', near.every((x) => x >= 1.3 && x <= 1.95), near.join(', '));
}

if (want('phases')) {
  group = 'Phases, summon, posture';
  const ph = await E(() => {
    H.setup(1.6, 1); H.unfreeze(); const v = H.S.vitals.get(H.B); const out = { runners0: H.A.brains.length };
    v.hp = 0.64 * 450; H.B.set('hold');
    let sawTransition = false, dodgedInTransition = false, px0 = H.P.position.clone(), pushed = 0, hp0 = H.C.hp;
    for (let f = 0; f < 120; f++) {
      if (H.B.state === 'transition' && !sawTransition) { sawTransition = true; H.atk(); }
      H.step(1);
      if (H.B.state === 'transition' && H.hits().length === 0 && H.sys().some((e) => e.what === 'dodged')) dodgedInTransition = true;
      pushed = Math.max(pushed, Math.hypot(H.P.position.x - px0.x, H.P.position.z - px0.z));
    }
    out.phase = H.B.phase; out.sawTransition = sawTransition; out.pushed = +pushed.toFixed(2); out.dmgTaken = hp0 - H.C.hp;
    out.runners = H.A.brains.filter((b) => b.e.cls === 'runner').length;
    out.dodged = H.sys().filter((e) => e.what === 'dodged').length;
    v.hp = 0.29 * 450; H.B.set('hold'); H.secs(2.5);
    out.phase3 = H.B.phase; out.runners3 = H.A.brains.filter((b) => b.e.cls === 'runner').length;
    return out;
  });
  check('Below 65 %: phase 2 begins with a transition (shockwave pushes the player, no damage)', ph.phase === 2 && ph.sawTransition && ph.pushed >= 1.0 && ph.dmgTaken === 0, JSON.stringify(ph));
  check('Untouchable during the transition', ph.dodged >= 1, `${ph.dodged} cut(s) avoided`);
  check('Phase 2 summons exactly two Ash Runners, once', ph.runners === 2 && ph.runners3 === 2, `after phase 2: ${ph.runners}; after phase 3: ${ph.runners3}`);
  check('Below 30 %: phase 3', ph.phase3 === 3, `phase ${ph.phase3}`);
  const ps = await E(() => {
    H.setup(1.6, 1); const v = H.S.vitals.get(H.B);
    H.B.turnTo = () => {}; v.meter = 145; v.lastMeter = H.S.time; H.B.e.object.rotation.y = Math.PI / 2; H.atk();
    let len = 0, started = false, open = false;
    for (let f = 0; f < 300; f++) { H.step(1); if (H.B.state === 'stagger') { started = true; len++; open = open || H.B.isOpen(); } else if (started) break; }
    return { knee: H.sys().some((e) => e.what === 'KNEE-DROP'), len: len / 60, open, hp: v.hp };
  });
  check('Posture 150: a break drops him to his knee for 2.5 s, open to punishment', ps.knee && Math.abs(ps.len - DOC.kneeDrop) <= 0.05 && ps.open, JSON.stringify(ps));
  const hp = await E(() => { H.setup(1.6, 1); return H.S.vitals.get(H.B).hp; });
  check('Boss health 450', hp === DOC.hp, String(hp));
}

if (want('fair')) {
  group = 'Fairness (real AI, phase 2 with the two summoned Runners, 90 s)';
  // Runs in 1 s slices (long single evaluations make headless Chromium hoard memory; the game itself doesn't leak).
  await E(() => {
    H.setup(3, 1); H.unfreeze(); const v = H.S.vitals.get(H.B);
    v.hp = 0.6 * 450; H.B.set('hold');
    const st = window.__fair = { maxAtk: 0, maxHeavy: 0, exclViol: 0, spellsAtStart: 0, starts0: H.A.director.starts.length, lastStarts: H.A.director.starts.length, f: 0 };
    const orig = H.B.startAction.bind(H.B);
    H.B.startAction = (a, view, now) => { if (['firewave', 'fireballs', 'lightning', 'teleport'].includes(a) && H.A.bossCtx.spells.active(H.B) > 0) st.spellsAtStart++; return orig(a, view, now); };
  });
  for (let c = 0; c < 90; c++) await E(() => {
    const st = window.__fair, v = H.S.vitals.get(H.B);
    for (let k = 0; k < 60; k++, st.f++) {
      if (st.f % 60 === 0) { H.C.hp = 100; v.hp = Math.max(v.hp, 0.31 * 450); }
      H.lookAtBoss(); H.step(1);
      const holders = H.A.brains.filter((b) => H.A.director.holds(b.id));
      st.maxAtk = Math.max(st.maxAtk, holders.length); st.maxHeavy = Math.max(st.maxHeavy, holders.filter((b) => b.e.cls === 'breaker').length);
      const ns = H.A.director.starts.slice(st.lastStarts); st.lastStarts = H.A.director.starts.length;
      for (const [, id] of ns) if (id !== H.B.id && (H.A.bossCtx.spells.active(H.B) > 0 || H.B.state === 'vanish')) st.exclViol++;
    }
  });
  const fr = await E(() => {
    const st = window.__fair;
    const sameFrame = {}; for (const e of H.hits()) sameFrame[e.f] = (sameFrame[e.f] || 0) + 1;
    const starts = H.A.director.starts.slice(st.starts0).map(([t]) => t), gaps = starts.slice(1).map((t, i) => t - starts[i]);
    return { maxAtk: st.maxAtk, maxHeavy: st.maxHeavy, exclViol: st.exclViol, spellsAtStart: st.spellsAtStart, minGap: gaps.length ? Math.min(...gaps) : null, same: Object.values(sameFrame).filter((n) => n > 1).length,
      runners: H.A.brains.filter((b) => b.e.cls === 'runner').length, actions: H.B.actionLog.slice(-40).map((x) => x[1]), hits: H.hits().length };
  });
  // Attack permissions (docs/combat.md §7, revised: 3 attackers, 0.4 s apart, so enemies press the player).
  check('At most 3 attackers at once, at most 1 of them the Warden', fr.maxAtk <= 3 && fr.maxHeavy <= 1, `max ${fr.maxAtk} attackers, ${fr.maxHeavy} heavy`);
  check('At least 0.4 s between attack starts', fr.minGap === null || fr.minGap >= 0.4 - 1e-6, `min gap ${f2(fr.minGap)} s`);
  check('No Runner starts an attack while the Warden\'s spells or teleport are live', fr.exclViol === 0, `${fr.exclViol} violations`);
  check('He never starts a new spell while one of his spells is live', fr.spellsAtStart === 0, `${fr.spellsAtStart} violations`);
  check('No two hits on the player in the same frame', fr.same === 0, `${fr.hits} hits, ${fr.same} same-frame`);
  const kinds = new Set(fr.actions);
  check('Varied attack patterns (at least 6 different actions, no action twice in a row)', kinds.size >= 6 && fr.actions.every((a, i) => i === 0 || a !== fr.actions[i - 1]), [...kinds].join(', '));
}

// 'duration' = survival without top-ups; 'ttk' = time to kill with health top-ups (separate runs: memory).
for (const [grp, topUp] of [['duration', false], ['ttk', true]]) if (want(grp)) {
  group = 'Fight duration (scripted player, estimate)';
  {
    // A simple, reasonably competent scripted player: blocks and faces him; runs and rolls away from fire waves, fireball
    // casts and lightning; punishes with a full combo when he is open (recovering or knelt). Runs in 1 s slices.
    await E((topUp) => {
      H.setup(3, 1); H.unfreeze();
      window.__bot = { topUp, t: 0, phases: [], lastPh: 1, mode: 'guard', comboT: 0, damageTaken: 0 };
    }, topUp);
    let done = false;
    for (let c = 0; c < 300 && !done; c++) done = await E(() => {
      const st = window.__bot;
      for (let k = 0; k < 60 && !H.B.dead && H.C.state !== 'dead'; k++) {
        const f = st.t;
        if (st.topUp && f % 60 === 0) { st.damageTaken += 100 - H.C.hp; H.C.hp = 100; }
        const e = H.B.effective(), dx = e.x - H.P.position.x, dz = e.z - H.P.position.z, dist = Math.hypot(dx, dz);
        H.P.setFacing(Math.atan2(dx, dz)); H.g.tpc.yaw = Math.atan2(dx, dz) + Math.PI;
        const open = H.B.isOpen() || H.B.state === 'stagger';
        H.I.keys.clear();
        if (open && dist < 2.4) { if (st.mode !== 'punish') { st.mode = 'punish'; H.blockUp(); st.comboT = 0; } if (st.comboT % 16 === 0 && st.comboT < 48) H.atk(); st.comboT++; }
        else {
          st.mode = 'guard';
          const mv = H.B.e.move, threat = (mv === 'plunge' && H.B.state !== 'transition' && H.B.e.time > 0.4 && H.B.e.time < 0.9) || mv === 'raise' || mv === 'palm';
          if (threat) { H.blockUp(); H.I.keys.add('KeyD'); H.I.keys.add('ShiftLeft'); if (f % 50 === 0) H.dodge(); }
          else if (dist > 2.6) { H.blockUp(); H.I.keys.add('KeyW'); }
          else if (!H.I.blockMouse) H.blockDown();
        }
        H.step(1); st.t++;
        if (H.B.phase !== st.lastPh) { st.phases.push([+(st.t / 60).toFixed(1), H.B.phase]); st.lastPh = H.B.phase; }
      }
      return H.B.dead || H.C.state === 'dead';
    });
    const d = await E(() => {
      const st = window.__bot, v = H.S.vitals.get(H.B);
      return { secs: +(st.t / 60).toFixed(1), bossDead: H.B.dead, playerHp: H.C.hp, playerDead: H.C.state === 'dead', bossHpLeft: Math.round(v.hp), phases: st.phases, damageTaken: st.damageTaken + (100 - H.C.hp) };
    });
    check(topUp ? 'Time to kill him (scripted player, health topped up; report only)' : 'Survival without top-ups (scripted player; report only)', true, JSON.stringify(d));
  }
}

await browser.close();
if (pageErrors.length) { group = 'Page errors'; for (const e of pageErrors) check('No page errors', false, e); }
const fails = results.filter((r) => !r.pass);
console.log(`\n${results.length - fails.length}/${results.length} passed, ${fails.length} failed`);
if (process.env.TLC_JSON) (await import('fs')).writeFileSync(process.env.TLC_JSON, JSON.stringify(results, null, 1));
process.exit(fails.length ? 1 : 0);
