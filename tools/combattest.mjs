// Stage 2C combat test harness (dev tool, not part of the game).
//
// Drives the real game in headless Chromium against the dev server and checks combat against the approved values
// in docs/combat.md. Expected values are written out here from the document (not imported from src/combat/tables.ts),
// so a wrong number in the implementation cannot make its own test pass.
//
// usage: npm run dev   (in another terminal; http://localhost:5173)
//        node tools/combattest.mjs [--only <group>]
//
// Isolation: every page is loaded with ?combat=<spec> (dev arena: no encounter, no waves, no Warden) and
// ?quality=low&seed=1. The game is paused and stepped deterministically at 1/60 s through window.__tlc.step.
// Player input goes through the real Input queues (taps only: Attack is never held, so the unapproved heavy slash
// cannot start, and Attack is never pressed while blocking, so the unapproved kick cannot start).
//
// Test-side controls (no game source is modified): enemies used as controlled targets have their decision,
// steering and turning methods stubbed on the instance (H.freeze), and specific enemy attacks are started through
// the brain's own beginTell (H.force). Behaviour tests (2B regression, multi-enemy) use unmodified brains.
import { createRequire } from 'module';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');

const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1].split(',') : null;
const BASE = process.env.TLC_URL || 'http://localhost:5173';
const FRAME = 1 / 60;

// ------------------------------------------------------------------------------------------------ expected (docs/combat.md)
const DOC = {
  health: { player: 100, runner: 40, breaker: 120 },
  player: { // §1.1, §2.1, table C
    cut1: { dmg: 8, poise: 10, meter: 6, active: [0.24, 0.30] },
    cut2: { dmg: 8, poise: 10, meter: 6, active: [0.24, 0.30] },
    cut3: { dmg: 16, poise: 25, meter: 15, active: [0.62, 0.72] },
    lunge: { dmg: 14, poise: 20, meter: 10, active: [0.28, 0.40] },
    riposte: { dmg: 30, meter: 30, active: [0.54, 0.63] },
  },
  open: 1.5, openMeter: 2, behindMeter: 1.5,
  // Table A / B: per-hit damage, blocked damage, parryable, reaction, hit time (move time).
  runner: {
    slash: [{ dmg: 8, blk: 2, parry: true, react: 'flinch', push: 0.3, t: 0.27 }],
    slash2: [{ dmg: 8, blk: 2, parry: true, react: 'flinch', push: 0.3, t: 0.27 }],
    flurry: [0.27, 0.73, 1.57].map((t) => ({ dmg: 6, blk: 2, parry: true, react: 'flinch', push: 0.3, t })),
    finisher: [{ dmg: 12, blk: 3, parry: true, react: 'flinch', push: 0.8, t: 0.67 }],
    lunge: [{ dmg: 12, blk: 3, parry: true, react: 'flinch', push: 0.8, t: 0.33 }],
    pommel: [{ dmg: 5, blk: 1, parry: true, react: 'flinch', push: 0.3, t: 0.27 }],
    spin: [{ dmg: 10, blk: 3, parry: false, react: 'flinch', push: 0.3, t: 0.45 }],
  },
  breaker: {
    sweep: [{ dmg: 12, blk: 3, t: 0.50 }, { dmg: 12, blk: 3, t: 1.17 }, { dmg: 14, blk: 4, t: 1.83 }].map((h) => ({ ...h, parry: true, react: 'flinch', push: 0.8 })),
    smash: [{ dmg: 28, blk: 14, parry: false, react: 'knockdown', t: 0.63 }],
    charge: [{ dmg: 20, blk: 10, parry: false, react: 'knockdown', t: [0.05, 0.65] }],
    stamp: [{ dmg: 10, blk: 5, parry: false, react: 'knockdown', t: [0.75, 0.90] }],
  },
  block: { raise: 0.10, moveScale: 0.5, push: 0.3, guardBreakStun: 0.8 },
  parry: { window: 0.18, lockout: 0.5, riposte: 1.0, runnerStagger: 1.0, breakerMeter: 35 },
  poise: { runner: 20, reset: 1.5 },
  meter: { max: 100, decay: 10, decayDelay: 2, kneeDrop: 2.2, immunity: 4 },
  react: { flinch: 0.35, knockdown: 2.0, knockdownInvulnFrom: 0.6 },
  roll: { dist: 2.4, dur: 0.75, inv: [0.12, 0.45], cooldown: 0.8 },
  chain: { buffer: 0.15, mashLock: 0.25, cut1Window: [0.33, 0.43] },
  director: { maxAttackers: 2, maxBreakers: 1, gap: 0.6 },
  behaviour: { runnerRing: [3, 5], breakerHold: [2.0, 2.5], breakerSpeed: 0.92 },
  death: { bodyStays: 8, restart: 3 },
};
// Tolerances (stated in the results document).
const TOL = { time: 0.1, frame: FRAME * 1.01, dur: 0.05, dist: 0.1 };

// ------------------------------------------------------------------------------------------------ reporting
const results = [];
let group = '';
const check = (name, pass, detail = '') => {
  results.push({ group, name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'}  [${group}] ${name}${detail ? `  — ${detail}` : ''}`);
};
const near = (a, b, tol) => a !== undefined && a !== null && Math.abs(a - b) <= tol;
const f2 = (n) => (n === undefined || n === null ? String(n) : (+n).toFixed(2));

// ------------------------------------------------------------------------------------------------ page library
// Runs inside the page. Instrumentation only: it reads game state and drives the public test hooks.
function pageLib() {
  const g = window.__tlc, A = g.arena(), C = g.combat(), S = g.combatSystem(), P = g.player, I = g.input;
  const V = P.position.constructor;
  const H = { g, A, C, S, P, I };
  H.step = (n = 1) => { for (let i = 0; i < n; i++) { g.step(1, 1 / 60, false); H.frame++; H.onFrame?.(); } };
  H.frame = 0;
  H.secs = (s) => H.step(Math.round(s / (1 / 60)));
  H.brain = (q) => A.brains.find((b) => b.id === q) ?? A.brains.find((b) => b.e.cls === q);

  // Every combat-log entry and player trace entry is captured with a snapshot of the moment it was written.
  H.events = [];
  H.snap = () => ({
    f: H.frame, st: +S.time.toFixed(4), p: { state: C.state, t: +C.t.toFixed(4), move: C.move, hp: C.hp, x: P.position.x, z: P.position.z },
    b: Object.fromEntries(A.brains.map((b) => [b.id, { state: b.state, move: b.e.move, time: +b.e.time.toFixed(4), hp: S.vitals.get(b)?.hp, meter: S.vitals.get(b)?.meter, poise: S.vitals.get(b)?.poise }])),
  });
  const logPush = S.log.push.bind(S.log);
  S.log.push = (e) => { H.events.push({ src: 'sys', ...e, ...H.snap() }); return logPush(e); };
  const trPush = C.trace.push.bind(C.trace);
  C.trace.push = (e) => { H.events.push({ src: 'player', what: e[1], ...H.snap() }); return trPush(e); };
  H.begin = () => { H.events = []; H.frame = 0; };

  // Controlled targets: stub the brain's decision/steering/turning on the instance only.
  H.freeze = (b, { turn = false } = {}) => {
    b.decide = () => {}; b.orbit = () => new V(); b.holdLine = () => new V(); b.tryAttack = () => {}; b.move = () => {};
    b.dodgeCool = 1e9; if (!turn) b.turnTo = () => {};
  };
  H.unfreeze = (b) => { for (const k of ['decide', 'orbit', 'holdLine', 'tryAttack', 'move', 'turnTo']) delete b[k]; b.dodgeCool = 0; };
  H.park = (b) => { H.placeEnemy(b, 30 + A.brains.indexOf(b) * 3, 20, 0); };

  H.placePlayer = (x, z, yaw) => {
    I.keys.clear(); I.attackQ = 0; I.dodgeQ = 0; I.blockPressQ = 0; I.attackDown = false; I.blockMouse = false;
    g.teleport(x, z); P.setFacing(yaw); P.velocity?.set?.(0, 0, 0); g.tpc.yaw = yaw + Math.PI; g.tpc.pitch = -0.12;
  };
  H.placeEnemy = (b, x, z, yaw) => {
    A.director.release(b.id); b.attack = null; b.e.pivot.position.set(0, 0, 0); b.e.pivot.rotation.y = 0;
    b.e.object.position.set(x, P.position.y, z); b.e.object.rotation.y = yaw; b.e.rate = 1; b.e.frozen = false;
    b.e.play(b.e.cls === 'runner' ? 'idle' : 'guard', 0); b.set('hold');
  };
  /** Full health both sides, player free and drawn, enemies alive, ready. */
  H.fresh = () => {
    I.keys.clear(); I.attackQ = 0; I.dodgeQ = 0; I.blockPressQ = 0; I.attackDown = false; I.blockMouse = false;
    C.reset(); C.setDrawn(true);
    for (const b of A.brains) {
      if (b.dead || b.removed) b.revive(b.e.object.position.clone(), b.e.object.rotation.y);
      S.vitals.set(b, S.freshVitals(b));
    }
    H.step(2);
  };
  // Standard layout: player at (0, 44) facing -z; enemy `d` m in front. side: 'front' | 'side' | 'behind' is
  // where the PLAYER is relative to the enemy's facing.
  H.setup = (b, d, side = 'front') => {
    for (const o of A.brains) if (o !== b) { H.freeze(o); H.park(o); }
    H.freeze(b); H.fresh();
    H.placePlayer(0, 44, Math.PI);
    H.placeEnemy(b, 0, 44 - d, side === 'front' ? 0 : side === 'side' ? Math.PI / 2 : Math.PI);
    H.step(1); H.begin();
  };
  // Inputs (taps).
  H.atk = () => { I.attackQ++; };
  H.dodge = () => { I.dodgeQ++; };
  H.blockDown = () => { I.blockMouse = true; I.blockPressQ++; };
  H.blockUp = () => { I.blockMouse = false; };
  /** Start a specific enemy attack (bypasses the AI's choice; the tell and attack then run as normal). */
  H.force = (b, name) => { b.attack = name; b.beginTell(); };
  /** Start an attack with no tell entry (the finisher is defined but never chosen by the AI). */
  H.forceNoTell = (b, name) => { b.attack = name; b.e.play(name, 0.05); b.e.time = 0; b.set('attack'); };
  H.sys = () => H.events.filter((e) => e.src === 'sys');
  H.ptrace = () => H.events.filter((e) => e.src === 'player');
  /** Step until the player is free again (end of a move and its recovery), max `max` s. */
  H.untilFree = (max = 3) => { for (let f = 0; f < max * 60; f++) { H.step(1); if (H.C.state === 'free') return; } };
  H.dist = (b) => Math.hypot(P.position.x - b.effective().x, P.position.z - b.effective().z);
  window.H = H;
}

// ------------------------------------------------------------------------------------------------ scenarios (page side)
// Each returns plain data; assertions happen in Node against DOC.
const SCEN = {
  /** Player move(s) against an enemy: `plan` is a list of [seconds, action]. */
  playerVs(id, d, side, plan, secs, prep) {
    const b = H.brain(id); H.setup(b, d, side);
    if (prep) new Function('H', 'b', prep)(H, b);
    const hp0 = H.S.vitals.get(b).hp, frames = Math.round(secs * 60);
    let i = 0;
    for (let f = 0; f < frames; f++) {
      while (i < plan.length && plan[i][0] <= f / 60 + 1e-6) { H[plan[i][1]](); i++; }
      H.step(1);
    }
    return { hp0, hp: H.S.vitals.get(b).hp, ev: H.sys().map(({ what, amount, detail, p, b: bb }) => ({ what, amount, detail, p, e: bb[b.id] })), trace: H.ptrace().map((e) => [e.st, e.what, e.p.t]) };
  },
  /**
   * Enemy attack against the player. `mode`: 'idle' | 'block' (guard held from before the tell) | 'parryAt' (tap
   * Block when the attack's move time reaches `at`) | 'pressAt' (hold Block from move time `at`).
   * `replace`: put the player back after each hit (isolates per-hit values from push-back).
   */
  enemyVs(id, name, d, mode = 'idle', at = 0, replace = false, noTell = false, secs = 3.2, side = 'front') {
    const b = H.brain(id);
    if (typeof at === 'string') { // 'contact-0.08': press that long before this layout's first contact (found by a dry run)
      H.setup(b, d, side); if (noTell) H.forceNoTell(b, name); else H.force(b, name);
      let c = null; for (let f = 0; f < 240 && c === null; f++) { H.step(1); const e = H.sys().find((x) => /^player /.test(x.what)); if (e) c = e.b[b.id].time; }
      at = (c ?? 0) - parseFloat(at.split('-')[1]);
    }
    H.setup(b, d, side);
    const P = H.P, start = { x: P.position.x, z: P.position.z };
    if (mode === 'block') { H.blockDown(); H.secs(0.3); }
    H.begin();
    const hp0 = H.C.hp;
    if (noTell) H.forceNoTell(b, name); else H.force(b, name);
    let pressed = false, released = false, lastN = 0;
    const timeline = [], pushes = [];
    // secs < 0: run until the first hit outcome on the player (max 3 s), then return (the scene keeps going).
    const untilHit = secs < 0;
    for (let f = 0; f < (untilHit ? 180 : secs * 60); f++) {
      if (untilHit && H.sys().some((e) => /^player /.test(e.what))) break;
      const inAttack = b.state === 'attack' && b.e.move === name;
      if (!pressed && inAttack && b.e.time >= at && (mode === 'parryAt' || mode === 'pressAt')) { H.blockDown(); pressed = true; }
      else if (pressed && !released && mode === 'parryAt') { H.blockUp(); released = true; }
      if (untilHit && pressed) H.blockUp();
      H.step(1);
      timeline.push([+(f / 60).toFixed(4), H.C.state, +H.C.t.toFixed(3), +P.position.x.toFixed(3), +P.position.z.toFixed(3), b.state, b.e.move, +b.e.time.toFixed(3)]);
      const hits = H.sys().filter((e) => /^player /.test(e.what));
      if (replace && hits.length > lastN) {
        lastN = hits.length; const x0 = P.position.x, z0 = P.position.z; H.step(18);
        pushes.push(Math.hypot(P.position.x - x0, P.position.z - z0)); H.step(6);
        H.placePlayer(start.x, start.z, Math.PI); if (mode === 'block') H.blockDown();
      }
    }
    return {
      hp0, hp: H.C.hp, start,
      ev: H.sys().map(({ what, amount, detail, p, b: bb, st, f }) => ({ what, amount, detail, st, f, p, e: bb[b.id] })),
      trace: H.ptrace().map((e) => [e.st, e.what, e.p.t]), timeline, pushes, pressedAt: at, meter: H.S.vitals.get(b).meter, bstate: b.state,
    };
  },
};

// ------------------------------------------------------------------------------------------------ browser
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const pageErrors = [];
async function open(spec) {
  const p = await browser.newPage({ viewport: { width: 640, height: 360 } });
  p.setDefaultTimeout(900000);
  p.on('pageerror', (e) => pageErrors.push(`${spec}: ${e.message}`));
  await p.goto(`${BASE}/?combat=${spec}&quality=low&seed=1`);
  await p.waitForFunction(() => window.__tlc?.ready, null, { polling: 500 });
  await p.evaluate(() => { window.__tlc.pause(true); window.__tlc.start(); });
  await p.evaluate(pageLib);
  await p.evaluate(`window.SCEN = {${Object.entries(SCEN).map(([k, fn]) => `${k}: function ${fn.toString().slice(fn.toString().indexOf('('))}`).join(',')}}`);
  return p;
}
const want = (g) => !ONLY || ONLY.includes(g);
const hitsOf = (r, re = /^player (hit|blocked|guardBreak|parried|killed|dodged)$/) => r.ev.filter((e) => re.test(e.what));
const durState = (timeline, state, from = 0) => {
  // Length of the first run of `state` in the player timeline at or after `from` (s).
  let s = -1, e = -1;
  for (const [t, st] of timeline) { if (t < from) continue; if (st === state && s < 0) s = t; else if (s >= 0 && st !== state) { e = t; break; } }
  return s < 0 ? null : (e < 0 ? null : e - s);
};
const pushAfter = (r, hitIndex = 0) => {
  // Horizontal distance the player moved from the frame of the hit to 0.3 s later (push-back length).
  if (r.pushes?.length) return r.pushes[hitIndex] ?? null;
  const h = hitsOf(r)[hitIndex]; if (!h) return null;
  const t0 = Math.max(0, h.f - 1), a = r.timeline[t0], b2 = r.timeline[Math.min(r.timeline.length - 1, t0 + 36)];
  return Math.hypot(b2[3] - a[3], b2[4] - a[4]);
};

// ================================================================================================ RUNNER PAGE
if (['p2r', 'r2p', 'block', 'parry', 'poise', 'death', 'wall', 'moving', 'stage1'].some(want)) {
  const p = await open('r1b0');
  const S = (name, ...args) => p.evaluate(([n, a]) => window.SCEN[n](...a), [name, args]);
  const E = (fn, arg) => p.evaluate(fn, arg);

  // ---------------------------------------------------------------- 1. Player attacks → Ash Runner
  if (want('p2r')) {
    group = '1 Player → Runner';
    let r = await S('playerVs', 'runner', 1.3, 'front', [[0, 'atk']], 0.8);
    let h = r.ev.filter((e) => e.what === 'hit');
    check('Cut 1 deals 8', h.length === 1 && h[0].amount === DOC.player.cut1.dmg && r.hp === 40 - 8, `hits ${h.map((x) => x.amount)}, hp ${r.hp0}→${r.hp}`);
    check('Cut 1 lands inside its active window 0.24–0.30 s', h[0] && h[0].p.move === 'cut1' && h[0].p.t >= 0.24 - TOL.frame && h[0].p.t <= 0.30 + TOL.frame, `at move time ${f2(h[0]?.p.t)}`);

    r = await S('playerVs', 'runner', 1.3, 'front', [[0, 'atk'], [0.25, 'atk'], [0.25 + 0.45, 'atk']], 2.4);
    h = r.ev.filter((e) => e.what === 'hit');
    const seq = h.map((x) => `${x.p.move}:${x.amount}@${f2(x.p.t)}`);
    check('Combo Cut 1-2-3 deals 8 / 8 / 16 = 32', h.length === 3 && h[0].amount === 8 && h[1].amount === 8 && h[2].amount === 16 && r.hp0 - r.hp === 32, seq.join(' '));
    check('Cut 2 lands inside 0.24–0.30 s, Cut 3 inside 0.62–0.72 s', h[1]?.p.move === 'cut2' && h[1].p.t >= 0.24 - TOL.frame && h[1].p.t <= 0.30 + TOL.frame && h[2]?.p.move === 'cut3' && h[2].p.t >= 0.62 - TOL.frame && h[2].p.t <= 0.72 + TOL.frame, seq.join(' '));

    // Sprint lunge: sprint from 9 m, attack once moving faster than 5.5 m/s and within 3 m.
    r = await S('playerVs', 'runner', 9, 'front', [], 0.01);
    const lg = await E(() => {
      const b = H.brain('runner'); H.begin(); H.I.keys.add('KeyW'); H.I.keys.add('ShiftLeft');
      let pressed = false;
      for (let f = 0; f < 240; f++) {
        if (!pressed && H.dist(b) < 3.0) { H.atk(); pressed = true; } else if (pressed) H.I.keys.clear();
        H.step(1);
      }
      H.I.keys.clear();
      return { ev: H.sys().map(({ what, amount, p }) => ({ what, amount, p })), hp: H.S.vitals.get(b).hp, moves: H.ptrace().map((e) => e.what).filter((w) => /start/.test(w)) };
    });
    h = lg.ev.filter((e) => e.what === 'hit');
    check('Sprint lunge deals 14', h.length === 1 && h[0].amount === DOC.player.lunge.dmg && h[0].p.move === 'lunge', `moves ${lg.moves.join(',')}; hits ${h.map((x) => `${x.p.move}:${x.amount}`)}`);
    check('Sprint lunge lands inside 0.28–0.40 s', h[0] && h[0].p.t >= 0.28 - TOL.frame && h[0].p.t <= 0.40 + TOL.frame, `at ${f2(h[0]?.p.t)}`);

    // Riposte: parry a forced slash, then attack while the Runner is staggered (open) → 30 × 1.5 = 45.
    r = await S('enemyVs', 'runner', 'slash', 1.0, 'parryAt', 'contact-0.08', false, false, -1);
    const rp = await E(() => {
      const b = H.brain('runner'); H.begin();
      for (let f = 0; f < 90; f++) { if (f === 3) H.atk(); H.step(1); }
      return { ev: H.sys().map(({ what, amount, p, b: bb }) => ({ what, amount, p, e: bb[b.id] })), hp: H.S.vitals.get(b).hp };
    });
    const parried = r.ev.find((e) => e.what === 'player parried');
    h = rp.ev.filter((e) => e.what === 'hit');
    check('Riposte after a parry, Runner staggered (open): 30 × 1.5 = 45', parried && h.length === 1 && h[0].p.move === 'riposte' && h[0].amount === 45, `parry ${!!parried}; ${h.map((x) => `${x.p.move}:${x.amount} (enemy ${x.e.state})`)}`);
    check('Riposte lands inside 0.54–0.63 s', h[0] && h[0].p.t >= 0.54 - TOL.frame && h[0].p.t <= 0.63 + TOL.frame, `at ${f2(h[0]?.p.t)}`);
    check('Riposte of 45 kills a 40 HP Runner', rp.ev.some((e) => e.what === 'killed'), `hp ${rp.hp}`);

    // Riposte after the stagger has ended (not open) → 30. Attack 0.5 s after the parry: lands ~1.05 s after it.
    r = await S('enemyVs', 'runner', 'slash', 1.0, 'parryAt', 'contact-0.08', false, false, -1);
    const rp2 = await E(() => {
      const b = H.brain('runner'); H.begin();
      for (let f = 0; f < 120; f++) { if (f === 26) H.atk(); H.step(1); }
      return { ev: H.sys().map(({ what, amount, p, b: bb }) => ({ what, amount, p, e: bb[b.id] })) };
    });
    h = rp2.ev.filter((e) => e.what === 'hit');
    check('Riposte after the Runner\'s 1.0 s stagger has ended deals 30', h.length === 1 && h[0].p.move === 'riposte' && h[0].amount === DOC.player.riposte.dmg, `${h.map((x) => `${x.p.move}:${x.amount} (enemy ${x.e.state})`)}`);

    // Open bonus during recovery: Runner slash out of reach of the player, player cut lands in its recovery.
    r = await S('playerVs', 'runner', 1.8, 'front', [], 0.01);
    const op = await E(() => {
      const b = H.brain('runner'); H.begin(); H.force(b, 'slash');
      let done = false;
      for (let f = 0; f < 120; f++) { if (!done && b.state === 'attack' && b.e.time >= 0.12) { H.atk(); done = true; } H.step(1); }
      return { ev: H.sys().map(({ what, amount, detail, p, b: bb }) => ({ what, amount, detail, p, e: bb[b.id] })) };
    });
    h = op.ev.filter((e) => e.what === 'hit');
    check('Cut 1 on a Runner in recovery (open) deals 8 × 1.5 = 12', h.length === 1 && h[0].amount === 12 && /open/.test(h[0].detail), `${h.map((x) => `${x.amount} ${x.detail} (enemy ${x.e.state} t=${x.e.time})`)}`);
    check('Open hit doubles poise (10 → 20): poise break', op.ev.some((e) => /poise broken|flinched/.test(e.what)), op.ev.map((e) => e.what).join(', '));
    check('…but the slash had already landed: no interrupt', op.ev.some((e) => e.what === 'poise broken, attack already landed: no interrupt'), op.ev.map((e) => e.what).join(', '));
  }

  // ---------------------------------------------------------------- 8. Runner poise
  if (want('poise')) {
    group = '8 Runner poise';
    let r = await S('playerVs', 'runner', 1.3, 'front', [[0, 'atk'], [0.25, 'atk']], 1.2);
    check('Cut 1 + Cut 2 (10 + 10 = 20) breaks poise: flinch', r.ev.some((e) => e.what === 'flinched'), r.ev.map((e) => `${e.what}${e.amount ? ' ' + e.amount : ''}`).join(', '));
    // Flinch duration (enemy state 'flinch').
    const fd = await E(() => {
      const b = H.brain('runner'); H.setup(b, 1.3, 'front'); b.react('flinch'); let n = 0;
      for (let f = 0; f < 60 && b.state === 'flinch'; f++) { H.step(1); n++; }
      return n / 60;
    });
    check('Runner flinch length ≈ 0.35 s', near(fd, DOC.react.flinch, TOL.dur), `${f2(fd)} s`);

    // Interrupt before the hit lands: start Cut 1 → Cut 2; when Cut 1 lands, force a Runner lunge (tell 0.4 s + hit 0.33 s);
    // Cut 2 breaks poise while the lunge is still in its tell.
    const it = await E(() => {
      const b = H.brain('runner'); H.setup(b, 1.3, 'front');
      let forced = false; H.atk();
      for (let f = 0; f < 120; f++) {
        if (f === 15) H.atk();
        const hits = H.sys().filter((e) => e.what === 'hit').length;
        if (!forced && hits === 1) { H.force(b, 'lunge'); forced = true; }
        H.step(1);
      }
      return { ev: H.sys().map(({ what, amount, b: bb }) => ({ what, amount, e: bb[b.id] })), hp: H.C.hp };
    });
    const fi = it.ev.findIndex((e) => e.what === 'flinched'), pre = it.ev[fi - 1];
    check('Poise break during the tell interrupts the attack (flinch)', fi > 0 && pre.what === 'hit' && pre.e.state === 'tell', it.ev.map((e) => `${e.what} [${e.e.state}/${e.e.move}]`).join(', '));
    check('Interrupted attack never lands on the player', !it.ev.some((e) => /^player (hit|blocked)/.test(e.what)) && it.hp === 100, `player hp ${it.hp}`);

    // Reset after 1.5 s: Cut 1, wait 1.6 s, Cut 1 → poise 10 (no flinch). And within 1.4 s → 20 (flinch).
    const rs = await E(() => {
      const out = {};
      for (const gap of [1.6, 1.0]) {
        const b = H.brain('runner'); H.setup(b, 1.3, 'front');
        H.atk(); H.secs(0.5); H.secs(gap - 0.5); H.atk(); H.secs(0.6);
        out[gap] = { flinched: H.sys().some((e) => e.what === 'flinched'), poiseLog: H.sys().filter((e) => e.what === 'hit').map((e) => e.b[b.id].poise) };
      }
      return out;
    });
    check('Poise resets 1.5 s after the last hit (second Cut 1 after 1.6 s: no flinch)', !rs['1.6'].flinched, JSON.stringify(rs['1.6']));
    check('Within the reset time poise accumulates (second Cut 1 after 1.0 s: flinch)', rs['1'].flinched, JSON.stringify(rs['1']));
  }

  // ---------------------------------------------------------------- 3. Runner attacks → player
  if (want('r2p')) {
    group = '3 Runner → player';
    for (const [name, hits] of Object.entries(DOC.runner)) {
      const d = name === 'lunge' ? 2.6 : 1.0;
      const r = await S('enemyVs', 'runner', name, d, 'idle', 0, hits.length > 1, name === 'finisher', 3.2);
      const got = hitsOf(r);
      const dm = got.map((e) => e.amount);
      check(`${name}: ${hits.length} hit(s) of ${hits.map((x) => x.dmg).join('/')}`, got.length === hits.length && got.every((e, i) => e.what === 'player hit' && e.amount === hits[i].dmg), `got ${got.map((e) => `${e.what} ${e.amount}`).join(', ')}`);
      check(`${name}: hit time(s) ${hits.map((x) => x.t).join('/')} s (±${TOL.time})`, got.length === hits.length && got.every((e, i) => near(e.e.time, hits[i].t, TOL.time)), `at ${got.map((e) => f2(e.e.time)).join('/')}`);
      check(`${name}: reaction ${hits[0].react}`, got.length > 0 && got.every((e) => e.p.state === hits[0].react), got.map((e) => e.p.state).join('/'));
      if (name !== 'flurry') {
        const push = pushAfter(r);
        check(`${name}: push-back ${hits[0].push} m`, near(push, hits[0].push, TOL.dist), `${f2(push)} m`);
      }
      void dm;
    }
    // Runner lunge connects thanks to the 1.8 m drive (documented in moves.ts): hits once from 2.6 m.
    const r = await S('enemyVs', 'runner', 'lunge', 2.6, 'idle', 0, false, false, 2);
    check('Runner lunge (1.8 m drive) connects from 2.6 m, exactly once', hitsOf(r).length === 1, `${hitsOf(r).length} hit(s)`);
  }

  // ---------------------------------------------------------------- 5. Block (Runner attacks)
  if (want('block')) {
    group = '5 Block';
    for (const [name, hits] of Object.entries(DOC.runner)) {
      const d = name === 'lunge' ? 2.6 : 1.0;
      const r = await S('enemyVs', 'runner', name, d, 'block', 0, hits.length > 1, name === 'finisher', 3.2);
      const got = hitsOf(r);
      check(`${name} blocked: ${hits.map((x) => x.blk).join('/')} damage`, got.length === hits.length && got.every((e, i) => e.what === 'player blocked' && e.amount === hits[i].blk), got.map((e) => `${e.what} ${e.amount}`).join(', '));
      if (name === 'slash') check('Blocked hit pushes back 0.3 m (settled distance)', near(pushAfter(r), DOC.block.push, TOL.dist), `${f2(pushAfter(r))} m`);
    }
    // Guard raise time and movement while blocking.
    const g = await E(() => {
      const b = H.brain('runner'); H.setup(b, 8, 'front');
      H.blockDown(); const s = [];
      for (let f = 0; f < 12; f++) { H.step(1); s.push([H.C.t, H.C.guardUp]); }
      H.blockUp(); H.secs(0.5);
      // Walk speed: free vs blocking (same input, 1 s each).
      const run = (block) => {
        H.placePlayer(0, 44, Math.PI); H.secs(0.3);
        if (block) { H.blockDown(); H.secs(0.2); }
        const x0 = H.P.position.clone(); H.I.keys.add('KeyW'); H.secs(1.0); H.I.keys.delete('KeyW');
        const d = Math.hypot(H.P.position.x - x0.x, H.P.position.z - x0.z); H.blockUp(); H.secs(0.4); return d;
      };
      return { s, free: run(false), blocking: run(true) };
    });
    const first = g.s.find(([, up]) => up);
    check('Guard is up 0.10 s after pressing Block (±1 frame)', first && near(first[0], DOC.block.raise, TOL.frame), `first guarded frame at ${first?.[0].toFixed(4)} s`);
    check('Walking while blocking is 50% speed', near(g.blocking / g.free, DOC.block.moveScale, 0.06), `${f2(g.free)} m vs ${f2(g.blocking)} m in 1 s (×${f2(g.blocking / g.free)})`);
  }

  // ---------------------------------------------------------------- 6. Parry (Runner)
  if (want('parry')) {
    group = '6 Parry';
    for (const name of ['slash', 'slash2', 'lunge', 'pommel', 'flurry']) {
      const d = name === 'lunge' ? 2.6 : 1.0;
      const r = await S('enemyVs', 'runner', name, d, 'parryAt', 'contact-0.08', false, false, 1.4);
      const first = hitsOf(r)[0];
      check(`${name}: parried (first hit), 0 damage`, first?.what === 'player parried' && first.amount === 0, `${hitsOf(r).map((e) => `${e.what} ${e.amount}`).join(', ')}; press at move time ${f2(r.pressedAt)}`);
    }
    // Stagger length and riposte window after a parry.
    const st = await E(() => {
      const b = H.brain('runner'); H.setup(b, 1.0, 'front'); H.force(b, 'slash');
      let pressed = false, tParry = -1, tStag = -1, tEnd = -1, ripoff = -1;
      for (let f = 0; f < 200; f++) {
        if (!pressed && b.state === 'attack' && b.e.time >= 0.12) { H.blockDown(); pressed = true; } else if (pressed) H.blockUp();
        H.step(1);
        if (tParry < 0 && H.sys().some((e) => e.what === 'player parried')) tParry = f / 60;
        if (tParry >= 0 && tStag < 0 && b.state === 'stagger') tStag = f / 60;
        if (tStag >= 0 && tEnd < 0 && b.state !== 'stagger') tEnd = f / 60;
        if (tParry >= 0 && ripoff < 0 && !H.C.riposteReady) ripoff = f / 60;
      }
      return { tParry, stag: tEnd - tStag, ripWin: ripoff - tParry };
    });
    check('Parried Runner is staggered 1.0 s', near(st.stag, DOC.parry.runnerStagger, TOL.dur), `${f2(st.stag)} s`);
    check('A parry opens a 1.0 s riposte window', near(st.ripWin, DOC.parry.riposte, TOL.dur), `${f2(st.ripWin)} s`);

    // Parry window 0.18 s: a press 0.25 s before the hit misses (hit lands), a press 0.10 s before parries.
    const w = await E(() => {
      const out = {};
      for (const lead of [0.10, 0.25]) {
        const b = H.brain('runner'); H.setup(b, 1.0, 'front'); H.force(b, 'slash');
        let contact = null; for (let f = 0; f < 90; f++) { H.step(1); const c = H.sys().find((e) => /^player /.test(e.what)); if (c) { contact = c.b[b.id].time; break; } }
        // Re-run with the press `lead` s before that contact time.
        H.setup(b, 1.0, 'front'); H.force(b, 'slash'); let pressed = false;
        for (let f = 0; f < 90; f++) {
          if (!pressed && b.state === 'attack' && b.e.time >= contact - lead) { H.blockDown(); pressed = true; } else if (pressed) H.blockUp();
          H.step(1);
        }
        out[lead] = { contact, res: H.sys().filter((e) => /^player /.test(e.what)).map((e) => e.what) };
      }
      return out;
    });
    check('Press 0.10 s before the hit (inside 0.18 s): parried', w['0.1'].res[0] === 'player parried', JSON.stringify(w['0.1']));
    check('Press 0.25 s before the hit (outside 0.18 s): not parried', w['0.25'].res[0] && w['0.25'].res[0] !== 'player parried', JSON.stringify(w['0.25']));

    // Miss lockout 0.5 s.
    const lk = await E(() => {
      const b = H.brain('runner'); H.setup(b, 8, 'front');
      const opens = [];
      const tap = () => { H.blockDown(); H.step(1); H.blockUp(); };
      tap(); opens.push(H.ptrace().filter((e) => e.what === 'parry window open').length);
      H.secs(0.18 + 0.2); tap(); opens.push(H.ptrace().filter((e) => e.what === 'parry window open').length);
      H.secs(0.6); tap(); opens.push(H.ptrace().filter((e) => e.what === 'parry window open').length);
      return { opens, missed: H.ptrace().some((e) => e.what === 'parry window missed (lockout)') };
    });
    check('Missed parry: 0.5 s lockout (press 0.2 s after the miss does not open a window; 0.6 s after does)', lk.missed && lk.opens[0] === 1 && lk.opens[1] === 1 && lk.opens[2] === 2, JSON.stringify(lk));

    // Unparryable spin: parry press from neutral → full 10 + light flinch. Active block → 3.
    let r = await S('enemyVs', 'runner', 'spin', 1.0, 'parryAt', 'contact-0.08', false, false, 1.4);
    let hh = hitsOf(r);
    check('Spin vs a parry press from neutral: full 10 damage and a light flinch', hh.length === 1 && hh[0].what === 'player hit' && hh[0].amount === 10 && hh[0].p.state === 'flinch', hh.map((e) => `${e.what} ${e.amount} (${e.p.state})`).join(', '));
    r = await S('enemyVs', 'runner', 'spin', 1.0, 'block', 0, false, false, 1.4);
    hh = hitsOf(r);
    check('Spin vs an active block: 3 damage', hh.length === 1 && hh[0].what === 'player blocked' && hh[0].amount === 3, hh.map((e) => `${e.what} ${e.amount}`).join(', '));
  }

  // ---------------------------------------------------------------- 12. Death (Runner, player)
  if (want('death')) {
    group = '12 Death';
    const dr = await E(() => {
      const b = H.brain('runner'); H.setup(b, 1.3, 'front'); H.S.vitals.get(b).hp = 8;
      H.atk(); H.secs(0.6);
      const killed = H.sys().some((e) => e.what === 'killed'), move = b.e.move, ticket = H.A.director.holds(b.id);
      const log = H.events.map((e) => `${e.src}:${e.what}${e.amount !== undefined ? ' ' + e.amount : ''}`);
      const y0 = b.e.object.position.y; H.secs(7.5); const y75 = b.e.object.position.y; H.secs(1.5); const y9 = b.e.object.position.y; H.secs(1.5);
      return { killed, state: b.state, move, ticket, y0, y75, y9, removed: b.removed, log };
    });
    check('Runner at 0 HP dies (Death A or B)', dr.killed && dr.state === 'dead' && /death[AB]/.test(dr.move), JSON.stringify({ state: dr.state, move: dr.move, log: dr.log.slice(0, 12) }));
    check('Dead enemy holds no attack ticket', !dr.ticket);
    check('Body stays 8 s, then sinks and is removed', near(dr.y75, dr.y0, 1e-6) && dr.y9 < dr.y0 && dr.removed, `y ${f2(dr.y0)} @0s, ${f2(dr.y75)} @7.5s, ${f2(dr.y9)} @9s, removed ${dr.removed}`);

    const dp = await E(() => {
      const b = H.brain('runner'); H.setup(b, 1.0, 'front');
      H.C.hp = 5; H.S.vitals.get(b).hp = 17; H.force(b, 'slash');
      let tDead = -1, tBack = -1;
      for (let f = 0; f < 60 * 5; f++) {
        H.step(1);
        if (tDead < 0 && H.C.state === 'dead') tDead = f / 60;
        if (tDead >= 0 && tBack < 0 && H.C.state !== 'dead') tBack = f / 60;
      }
      return { tDead, restart: tBack - tDead, hp: H.C.hp, ehp: H.S.vitals.get(b).hp, log: H.sys().map((e) => e.what) };
    });
    check('Player at 0 HP dies', dp.tDead >= 0 && dp.log.includes('player killed'), dp.log.join(', '));
    check('Restart after 3 s with full health on both sides', near(dp.restart, DOC.death.restart, 0.1) && dp.hp === 100 && dp.ehp === 40, `restart after ${f2(dp.restart)} s; player ${dp.hp}, runner ${dp.ehp}`);
  }

  // ---------------------------------------------------------------- 14. Wall obstruction
  if (want('wall')) {
    group = '14 Wall obstruction';
    // Solid temple wall: x ∈ [-2.8, 2.8], z ∈ [47.37, 47.87]. Player south of it facing +z, Runner north of it facing -z.
    const wl = await E(() => {
      const b = H.brain('runner'); const out = {};
      // 1.35 m apart (the closest two bodies can stand either side of the 0.5 m wall); Runner uses slash2 (reach 1.45 m).
      // Open control: the same layout in the courtyard (z 41 → 42.35), clear of every collider.
      for (const [label, pz, ez, wz] of [['wall', 46.95, 48.3, 47.62], ['open', 41, 42.35, 41.68]]) {
        H.freeze(b); H.fresh(); H.placePlayer(0, pz, 0); H.placeEnemy(b, 0, ez, Math.PI); H.step(1); H.begin();
        H.atk(); H.secs(0.7);
        const pl = H.sys().filter((e) => e.what === 'hit').length;
        H.fresh(); H.placePlayer(0, pz, 0); H.placeEnemy(b, 0, ez, Math.PI); H.step(1); H.begin();
        H.force(b, 'slash2'); H.secs(1.0);
        const en = H.sys().filter((e) => /^player /.test(e.what)).length;
        out[label] = { playerHits: pl, enemyHits: en, blocked: H.g.colliders.blocks(0, 1.2, wz) };
      }
      return out;
    });
    check('Wall between them: the player\'s cut does not hit', wl.wall.blocked && wl.wall.playerHits === 0, JSON.stringify(wl.wall));
    check('Wall between them: the Runner\'s slash 2 does not hit', wl.wall.enemyHits === 0, JSON.stringify(wl.wall));
    check('Same distance in the open: both hit', !wl.open.blocked && wl.open.playerHits === 1 && wl.open.enemyHits === 1, JSON.stringify(wl.open));
  }

  // ---------------------------------------------------------------- 15. Moving targets
  if (want('moving')) {
    group = '15 Moving targets';
    const mv = await E(() => {
      const out = {};
      // Roll timing: find this layout's slash contact time, then roll so contact falls inside / before the i-frames.
      const b = H.brain('runner'); H.setup(b, 1.0, 'front'); H.force(b, 'slash');
      let contact = null; for (let f = 0; f < 90 && contact === null; f++) { H.step(1); const c = H.sys().find((e) => /^player /.test(e.what)); if (c) contact = c.b[b.id].time; }
      for (const [label, rollAt] of [['inside', contact - 0.25], ['before', contact - 0.03]]) {
        H.setup(b, 1.0, 'front'); H.I.keys.clear(); H.force(b, 'slash'); let pressed = false;
        for (let f = 0; f < 90; f++) {
          if (!pressed && b.state === 'attack' && b.e.time >= rollAt) { H.I.keys.add('KeyW'); H.dodge(); pressed = true; }
          H.step(1); if (pressed) H.I.keys.clear();
        }
        out[label] = { res: H.sys().filter((e) => /^player /.test(e.what)).map((e) => `${e.what}@roll t=${e.p.t.toFixed(3)} (${e.p.state})`), trace: H.ptrace().map((e) => e.what).filter((w) => /avoided/.test(w)) };
      }
      // A Runner side-stepping (dodge state) is untouchable.
      H.setup(b, 1.3, 'front'); b.react('dodge'); H.atk(); H.secs(0.6);
      out.dodging = H.sys().map((e) => e.what);
      // A Runner moving sideways at 1.6 m/s is still hit by Cut 1.
      H.setup(b, 1.3, 'front'); const V = H.P.position.constructor;
      b.move = function (v, dt) { this.e.object.position.x += 1.6 * dt; }; // test-side steering stub: lateral walk
      H.atk(); H.secs(0.6);
      out.lateral = { hits: H.sys().filter((e) => e.what === 'hit').length, moved: b.e.object.position.x };
      void V;
      return out;
    });
    check('Roll: hit arriving inside the 0.12–0.45 s i-frames is avoided', mv.inside.res.length > 0 && mv.inside.res.every((s) => /player dodged/.test(s)), JSON.stringify(mv.inside));
    check('Roll: hit arriving before the i-frames (roll t < 0.12 s) lands', mv.before.res.some((s) => /player hit/.test(s)), JSON.stringify(mv.before));
    check('A dodging Runner is untouchable', mv.dodging.includes('dodged') && !mv.dodging.includes('hit'), mv.dodging.join(', '));
    check('A Runner moving sideways at 1.6 m/s is hit once by Cut 1', mv.lateral.hits === 1, JSON.stringify(mv.lateral));
  }

  // ---------------------------------------------------------------- 16. Stage 1 regression
  if (want('stage1')) {
    group = '16 Stage 1 regression';
    const s1 = await E(() => {
      const b = H.brain('runner'); H.setup(b, 20, 'front'); const out = {};
      // Roll distance, duration, i-frames.
      const x0 = H.P.position.clone(); H.dodge(); const inv = []; let end = -1;
      for (let f = 0; f < 60; f++) { H.step(1); inv.push([+H.C.t.toFixed(3), H.C.invulnerable, H.C.state]); if (end < 0 && H.C.state !== 'roll') end = f; }
      out.rollDist = Math.hypot(H.P.position.x - x0.x, H.P.position.z - x0.z);
      out.rollDur = inv.filter(([, , s]) => s === 'roll').length / 60;
      const iv = inv.filter(([, i, s]) => i && s === 'roll'); out.invFrom = iv[0]?.[0]; out.invTo = iv[iv.length - 1]?.[0];
      // Cooldown 0.8 s from the roll start: a press at 0.76 s is refused, at 0.82 s accepted.
      H.secs(1); H.begin(); H.dodge(); H.step(Math.round(0.76 * 60)); H.dodge(); H.step(2); out.at076 = H.C.state;
      H.secs(1); H.begin(); H.dodge(); H.step(Math.round(0.82 * 60)); H.dodge(); H.step(2); out.at082 = H.C.state;
      // Chain buffer: Cut 1, then a press at 0.17 s (before the 0.18 s buffer) drops the chain; at 0.20 s it queues.
      H.secs(1); H.begin(); H.atk(); H.step(Math.round(0.17 * 60)); H.atk();
      for (let f = 0; f < 120; f++) { H.step(1); if (f > 5 && H.C.state === 'free') break; }
      out.early = H.ptrace().map((e) => e.what).filter((w) => /cut|chain|mash/.test(w));
      // Mash lock: right after the dropped chain's recovery, Cut 1 is refused for 0.25 s.
      H.atk(); H.step(2); out.mashLock = H.ptrace().map((e) => e.what).filter((w) => /refused|start cut1/.test(w)).slice(-1)[0];
      H.secs(0.3); H.atk(); H.step(2); out.afterLock = H.ptrace().map((e) => e.what).filter((w) => /refused|start cut1/.test(w)).slice(-1)[0];
      H.secs(1); H.begin(); H.atk(); H.step(Math.round(0.20 * 60)); H.atk(); H.secs(1.0);
      out.buffered = H.ptrace().map((e) => e.what).filter((w) => /cut|chain/.test(w));
      return out;
    });
    check('Roll travels 2.4 m', near(s1.rollDist, DOC.roll.dist, TOL.dist), `${f2(s1.rollDist)} m`);
    check('Roll lasts 0.75 s', near(s1.rollDur, DOC.roll.dur, TOL.frame * 2), `${f2(s1.rollDur)} s`);
    check('Roll invulnerable 0.12–0.45 s', near(s1.invFrom, DOC.roll.inv[0], TOL.frame) && near(s1.invTo, DOC.roll.inv[1], TOL.frame), `${f2(s1.invFrom)}–${f2(s1.invTo)} s`);
    check('Roll cooldown 0.8 s: press at 0.76 s refused', s1.at076 !== 'roll', `state ${s1.at076}`);
    check('Roll cooldown 0.8 s: press at 0.82 s accepted', s1.at082 === 'roll', `state ${s1.at082}`);
    check('Attack press before the 0.15 s buffer drops the chain (mash)', s1.early.includes('cut1 chain dropped (mash)') && !s1.early.includes('start cut2'), s1.early.join(', '));
    check('Mash lock: Cut 1 refused right after a dropped chain, allowed 0.25 s later', /refused/.test(s1.mashLock || '') && s1.afterLock === 'start cut1', `${s1.mashLock} → ${s1.afterLock}`);
    check('Attack press inside the buffer queues Cut 2', s1.buffered.includes('cut1 chain queued') && s1.buffered.includes('start cut2'), s1.buffered.join(', '));
  }
  await p.close();
}

// ================================================================================================ BREAKER PAGE
if (['p2b', 'b2p', 'blockB', 'parryB', 'meter', 'knock', 'deathB'].some(want)) {
  const p = await open('r0b1');
  const S = (name, ...args) => p.evaluate(([n, a]) => window.SCEN[n](...a), [name, args]);
  const E = (fn, arg) => p.evaluate(fn, arg);

  // ---------------------------------------------------------------- 2. Player attacks → Iron Breaker
  if (want('p2b')) {
    group = '2 Player → Breaker';
    let r = await S('playerVs', 'breaker', 1.5, 'side', [[0, 'atk']], 0.8);
    let h = r.ev.filter((e) => e.what === 'hit'), m = r.ev.filter((e) => e.what === 'meter');
    check('Cut 1 from the side: 8 damage, meter +6', h.length === 1 && h[0].amount === 8 && m[0]?.amount === 6, `${h.map((x) => x.amount)} / meter ${m.map((x) => x.amount)}`);
    r = await S('playerVs', 'breaker', 1.5, 'side', [[0, 'atk'], [0.25, 'atk'], [0.7, 'atk']], 2.4);
    h = r.ev.filter((e) => e.what === 'hit'); m = r.ev.filter((e) => e.what === 'meter');
    check('Combo from the side: 8 / 8 / 16, meter 6 / 6 / 15', h.map((x) => x.amount).join() === '8,8,16' && m.map((x) => x.amount).join() === '6,6,15', `${h.map((x) => `${x.p.move}:${x.amount}`)} / meter ${m.map((x) => x.amount)}`);
    r = await S('playerVs', 'breaker', 1.5, 'behind', [[0, 'atk']], 0.8);
    m = r.ev.filter((e) => e.what === 'meter');
    check('Cut 1 from behind: meter 6 × 1.5 = 9', m[0]?.amount === 9, `meter ${m.map((x) => `${x.amount} (${x.detail})`)}`);
    r = await S('playerVs', 'breaker', 1.5, 'front', [[0, 'atk']], 0.8);
    const gb = r.ev.find((e) => e.what === 'guard blocked');
    check('Frontal Cut 1 against his guard: 0 damage, guard blocked', gb && !r.ev.some((e) => e.what === 'hit') && r.hp === 120, r.ev.map((e) => e.what).join(', '));

    // Sprint lunge from the side.
    await S('playerVs', 'breaker', 9, 'side', [], 0.01);
    const lg = await E(() => {
      const b = H.brain('breaker'); H.placeEnemy(b, 0, 35, Math.PI / 2); H.begin(); H.I.keys.add('KeyW'); H.I.keys.add('ShiftLeft');
      let pressed = false;
      for (let f = 0; f < 240; f++) { if (!pressed && H.dist(b) < 3.0) { H.atk(); pressed = true; } else if (pressed) H.I.keys.clear(); H.step(1); }
      H.I.keys.clear();
      return H.sys().map(({ what, amount, p }) => ({ what, amount, move: p.move }));
    });
    const lh = lg.filter((e) => e.what === 'hit'), lm = lg.filter((e) => e.what === 'meter');
    check('Sprint lunge: 14 damage, meter +10', lh.length === 1 && lh[0].amount === 14 && lh[0].move === 'lunge' && lm[0]?.amount === 10, JSON.stringify(lg));

    // Riposte after parrying sweep hit 1 (Breaker not staggered, not open) → 30, meter +35 then +30.
    r = await S('enemyVs', 'breaker', 'sweep', 1.6, 'parryAt', 'contact-0.08', false, false, -1);
    const rp = await E(() => {
      const b = H.brain('breaker'); H.begin();
      for (let f = 0; f < 70; f++) { if (f === 3) H.atk(); H.step(1); if (H.sys().some((e) => e.what === 'hit')) break; }
      return H.sys().map(({ what, amount, detail, p, b: bb }) => ({ what, amount, detail, move: p.move, e: bb[b.id].state }));
    });
    const parried = r.ev.find((e) => e.what === 'player parried'), pm = r.ev.find((e) => e.what === 'meter');
    check('Sweep parry adds 35 meter', parried && pm?.amount === 35, r.ev.map((e) => `${e.what} ${e.amount ?? ''}`).join(', '));
    const rh = rp.filter((e) => e.what === 'hit'), rm = rp.filter((e) => e.what === 'meter');
    check('Riposte on a (non-open) Breaker: 30 damage, meter +30', rh.length === 1 && rh[0].move === 'riposte' && rh[0].amount === 30 && rm[0]?.amount === 30, JSON.stringify(rp));

    // Ordinary hits never interrupt his attacks: cut him from behind during his smash.
    const ni = await E(() => {
      const b = H.brain('breaker'); H.setup(b, 1.5, 'behind'); H.force(b, 'smash');
      const states = []; for (let f = 0; f < 90; f++) { if (f === 30 || f === 50) H.atk(); H.step(1); states.push(b.state); }
      return { hits: H.sys().filter((e) => e.what === 'hit').length, interrupted: states.slice(0, 60).some((s) => s !== 'tell' && s !== 'attack'), move: b.e.move };
    });
    check('Ordinary hits do not interrupt a Breaker attack', ni.hits >= 1 && !ni.interrupted, JSON.stringify(ni));
  }

  // ---------------------------------------------------------------- 4. Breaker attacks → player
  if (want('b2p')) {
    group = '4 Breaker → player';
    for (const [name, hits] of Object.entries(DOC.breaker)) {
      const d = name === 'charge' ? 4.0 : name === 'stamp' ? 1.5 : 1.6;
      const r = await S('enemyVs', 'breaker', name, d, 'idle', 0, hits.length > 1, false, name === 'sweep' ? 3.6 : 3.2);
      const got = hitsOf(r);
      check(`${name}: ${hits.length} hit(s) of ${hits.map((x) => x.dmg).join('/')}`, got.length === hits.length && got.every((e, i) => e.what === 'player hit' && e.amount === hits[i].dmg), got.map((e) => `${e.what} ${e.amount}`).join(', '));
      check(`${name}: hit time(s) ${hits.map((x) => [].concat(x.t).join('–')).join('/')} s`, got.length === hits.length && got.every((e, i) => Array.isArray(hits[i].t) ? e.e.time >= hits[i].t[0] - TOL.frame && e.e.time <= hits[i].t[1] + TOL.frame : near(e.e.time, hits[i].t, TOL.time)), `at ${got.map((e) => f2(e.e.time)).join('/')}`);
      check(`${name}: reaction ${hits[0].react}`, got.length > 0 && got.every((e) => e.p.state === hits[0].react), got.map((e) => e.p.state).join('/'));
      if (name === 'sweep') check('sweep: push-back 0.8 m (measured 0.3 s after hit 1)', near(pushAfter(r), 0.8, TOL.dist), `${f2(pushAfter(r))} m`);
    }
    // Unaided (no re-placing): how many sweep hits land on a player who just takes them (informational).
    const r = await S('enemyVs', 'breaker', 'sweep', 1.6, 'idle', 0, false, false, 3.0);
    console.log(`      info: unaided player takes ${hitsOf(r).length} of 3 sweep hits (${hitsOf(r).map((e) => e.amount).join('/')}) — push-back moves him out of later arcs`);
  }

  // ---------------------------------------------------------------- 5/6. Block and parry vs Breaker
  if (want('blockB')) {
    group = '5 Block (Breaker)';
    for (const [name, hits] of Object.entries(DOC.breaker)) {
      const d = name === 'charge' ? 4.0 : name === 'stamp' ? 1.5 : 1.6;
      const r = await S('enemyVs', 'breaker', name, d, 'block', 0, hits.length > 1, false, name === 'sweep' ? 3.6 : 3.2);
      const got = hitsOf(r);
      const heavy = !hits[0].parry;
      check(`${name} vs active block: ${hits.map((x) => x.blk).join('/')} damage${heavy ? ' + guard break' : ''}`, got.length === hits.length && got.every((e, i) => e.what === (heavy ? 'player guardBreak' : 'player blocked') && e.amount === hits[i].blk), got.map((e) => `${e.what} ${e.amount}`).join(', '));
      if (heavy) {
        const i = got[0] ? r.timeline.findIndex(([, st]) => st === 'stun') : -1;
        const stun = i < 0 ? null : r.timeline.slice(i).findIndex(([, st]) => st !== 'stun') / 60;
        check(`${name}: guard break stuns 0.8 s`, near(stun, DOC.block.guardBreakStun, TOL.dur), `${f2(stun)} s`);
      }
    }
  }
  if (want('parryB')) {
    group = '6 Parry (Breaker)';
    for (const name of ['smash', 'charge', 'stamp']) {
      const d = name === 'charge' ? 4.0 : name === 'stamp' ? 1.5 : 1.6;
      const r = await S('enemyVs', 'breaker', name, d, 'parryAt', 'contact-0.08', false, false, 2.6);
      const got = hitsOf(r), exp = DOC.breaker[name][0];
      check(`${name} vs a parry press from neutral: full ${exp.dmg} damage and knockdown`, got.length === 1 && got[0].what === 'player hit' && got[0].amount === exp.dmg && got[0].p.state === 'knockdown', got.map((e) => `${e.what} ${e.amount} (${e.p.state}; parry press at move time ${f2(r.pressedAt)})`).join(', '));
    }
    // Parryable sweep: a timed press parries it (0 damage, meter +35).
    const r = await S('enemyVs', 'breaker', 'sweep', 1.6, 'parryAt', 'contact-0.08', false, false, 1.2);
    const got = hitsOf(r), pm = r.ev.find((e) => e.what === 'meter');
    check('Sweep hit 1 vs a timed parry: 0 damage, meter +35', got[0]?.what === 'player parried' && got[0].amount === 0 && pm?.amount === DOC.parry.breakerMeter, `${got.map((e) => `${e.what} ${e.amount}`).join(', ')}; meter ${pm?.amount}`);
  }

  // ---------------------------------------------------------------- 9/10/7. Meter, knee-drop, immunity, multipliers
  if (want('meter')) {
    group = '9-10 Breaker meter and knee-drop';
    const mt = await E(() => {
      const b = H.brain('breaker'); H.setup(b, 1.5, 'side'); const v = () => H.S.vitals.get(b);
      const combo = () => { H.atk(); H.step(15); H.atk(); H.step(27); H.atk(); H.untilFree(); };
      const meters = [];
      for (let i = 0; i < 4; i++) { v().hp = 120; combo(); meters.push(+v().meter.toFixed(1)); if (H.sys().some((e) => e.what === 'KNEE-DROP')) break; }
      const kd = H.sys().find((e) => e.what === 'KNEE-DROP');
      const pre = H.sys().filter((e) => e.what === 'meter').map((e) => e.detail);
      return { meters, kneeAt: kd ? kd.b[b.id].meter : null, pre };
    });
    check('Meter fills by 27 per side combo (27 → 54 → 81); knee-drop on reaching 100 in the 4th combo', mt.kneeAt !== null && mt.meters.length === 4 && mt.meters.slice(0, 3).join() === '27,54,81', `after each combo ${mt.meters.join(' → ')} (reset to 0 at the knee-drop); gains: ${mt.pre.join(' | ')}`);
    const kl = await E(() => {
      const b = H.brain('breaker'); H.setup(b, 1.5, 'side'); const v = H.S.vitals.get(b);
      v.meter = 95; v.lastMeter = H.S.time; H.atk(); let n = 0, started = false, len = 0, open = false;
      for (let f = 0; f < 240; f++) { H.step(1); if (b.state === 'stagger') { started = true; len++; open = open || b.isOpen(); } else if (started) break; }
      // Hit during the knee-drop: open ×1.5.
      H.setup(b, 1.5, 'side'); const v2 = H.S.vitals.get(b); v2.meter = 95; v2.lastMeter = H.S.time; H.atk(); H.untilFree(); const inKnee = b.state === 'stagger'; H.atk(); H.secs(0.7);
      const hits = H.sys().filter((e) => e.what === 'hit').map((e) => `${e.amount} ${e.detail}`);
      return { len: len / 60, open, hits, n, inKnee };
    });
    check('Knee-drop lasts 2.2 s', near(kl.len, DOC.meter.kneeDrop, TOL.dur), `${f2(kl.len)} s`);
    check('Knee-drop counts as open (a Cut 1 during it: 8 × 1.5 = 12)', kl.open && kl.inKnee && kl.hits.some((s) => /^12 /.test(s)), `${kl.hits.join(' | ')}; second cut started during the knee-drop: ${kl.inKnee}`);

    const im = await E(() => {
      const b = H.brain('breaker'); H.setup(b, 1.5, 'side'); const v = H.S.vitals.get(b);
      v.meter = 95; v.lastMeter = H.S.time; H.atk(); H.step(20); const t0 = H.S.time;
      const probe = (at) => { while (H.S.time - t0 < at) H.step(1); v.hp = 120; const before = v.meter; H.atk(); H.secs(0.6); return { at, gain: +(v.meter - before).toFixed(2), log: H.sys().slice(-2).map((e) => e.what) }; };
      return [probe(3.0), probe(5.5), probe(6.6)];
    });
    check('No meter gain during the 4 s immunity after the knee-drop (2.2 + 4 = 6.2 s)', im[0].gain === 0 && im[1].gain === 0, JSON.stringify(im.slice(0, 2)));
    check('Meter gain resumes after the immunity', im[2].gain > 0, JSON.stringify(im[2]));

    const dc = await E(() => {
      const b = H.brain('breaker'); H.setup(b, 1.5, 'side'); const v = H.S.vitals.get(b);
      H.atk(); H.step(15); H.atk(); H.step(27); H.atk(); H.step(50);
      const m0 = v.meter, t0 = v.lastMeter, at = (s) => { while (H.S.time - t0 < s) H.step(1); return +v.meter.toFixed(2); };
      return { m0, at19: at(1.9), at25: at(2.5), at30: at(3.0) };
    });
    check('Meter holds for 2 s after the last gain', near(dc.at19, dc.m0, 0.01), JSON.stringify(dc));
    check('Then decays at 10 / s', near(dc.at30, dc.m0 - 10, 0.35) && near(dc.at25, dc.m0 - 5, 0.35), JSON.stringify(dc));

    group = '7 Open and positional multipliers (Breaker)';
    const om = await E(() => {
      const out = {};
      for (const side of ['behind', 'side']) {
        const b = H.brain('breaker'); H.setup(b, 1.5, side); H.force(b, 'smash');
        let done = false; for (let f = 0; f < 120; f++) { if (!done && b.state === 'attack' && b.e.time >= 0.72) { H.atk(); done = true; } H.step(1); }
        out[side] = H.sys().filter((e) => e.what === 'hit' || e.what === 'meter').map((e) => `${e.what} ${e.amount} ${e.detail ?? ''}`);
      }
      return out;
    });
    check('Cut 1 on an open Breaker from the side: 12 damage, meter 6 × 2 = 12', om.side.some((s) => /^hit 12 /.test(s)) && om.side.some((s) => /^meter 12 /.test(s)), om.side.join(' | '));
    check('Cut 1 on an open Breaker from behind: meter 6 × 2 × 1.5 = 18', om.behind.some((s) => /^meter 18 /.test(s)), om.behind.join(' | '));
  }

  // ---------------------------------------------------------------- 11. Knockdowns
  if (want('knock')) {
    group = '11 Knockdowns';
    const kd = await E(() => {
      const b = H.brain('breaker'); H.setup(b, 1.6, 'front'); H.force(b, 'smash');
      let t0 = -1, end = -1; const inv = [];
      for (let f = 0; f < 240; f++) { H.step(1); if (t0 < 0 && H.C.state === 'knockdown') t0 = f; if (t0 >= 0) { inv.push([+H.C.t.toFixed(3), H.C.invulnerable]); if (end < 0 && H.C.state !== 'knockdown') end = f; } }
      const firstInv = inv.find(([, i]) => i);
      return { len: (end - t0) / 60, invFrom: firstInv?.[0] };
    });
    check('Knockdown lasts 2.0 s', near(kd.len, DOC.react.knockdown, TOL.dur), `${f2(kd.len)} s`);
    check('Invulnerable from 0.6 s into the knockdown', near(kd.invFrom, DOC.react.knockdownInvulnFrom, TOL.frame), `from ${f2(kd.invFrom)} s`);
    const ch = await E(() => {
      const b = H.brain('breaker'); H.setup(b, 4.0, 'front'); const pz = H.P.position.z; H.force(b, 'charge');
      let minZ = Infinity; for (let f = 0; f < 120; f++) { H.step(1); minZ = Math.min(minZ, b.effective().z); }
      return { pz, bz: b.effective().z, minZ, hits: H.sys().filter((e) => /^player /.test(e.what)).length };
    });
    // Breaker comes from z = 40 toward the player at z = 44; he must not pass through (stays below the player's z).
    check('Charge stops on contact (does not pass through the player)', ch.hits === 1 && ch.bz < ch.pz, JSON.stringify(ch));
  }

  // ---------------------------------------------------------------- 12. Breaker death
  if (want('deathB')) {
    group = '12 Death';
    const db = await E(() => {
      const b = H.brain('breaker'); H.setup(b, 1.5, 'side'); H.S.vitals.get(b).hp = 8; H.atk(); H.secs(0.6);
      return { killed: H.sys().some((e) => e.what === 'killed'), state: b.state, move: b.e.move, ticket: H.A.director.holds(b.id) };
    });
    check('Breaker at 0 HP dies (Death A or B), ticket released', db.killed && db.state === 'dead' && /death[AB]/.test(db.move) && !db.ticket, JSON.stringify(db));
  }
  await p.close();
}

// ================================================================================================ MULTI-ENEMY PAGE (unmodified AI)
if (want('multi')) {
  const p = await open('r2b1');
  const E = (fn, arg) => p.evaluate(fn, arg);
  {
    group = '13 Multiple enemies (AI, 60 s, seed 1)';
    const mf = await E(() => {
      // The player stands at the start, facing the arena, and keeps full health (topped up each second) so the run
      // isn't cut short by restarts. Enemies are completely unmodified.
      H.placePlayer(0, 44, Math.PI); H.fresh(); H.begin();
      let maxAtk = 0, maxBrk = 0; const frameHits = new Map();
      for (let f = 0; f < 60 * 60; f++) {
        H.step(1);
        if (f % 60 === 0) H.C.hp = 100;
        const holders = H.A.brains.filter((b) => H.A.director.holds(b.id));
        maxAtk = Math.max(maxAtk, holders.length); maxBrk = Math.max(maxBrk, holders.filter((b) => b.e.cls === 'breaker').length);
      }
      for (const e of H.sys().filter((e) => /^player /.test(e.what))) frameHits.set(e.f, (frameHits.get(e.f) || 0) + 1);
      const starts = H.A.director.starts.map(([t]) => t);
      const gaps = starts.slice(1).map((t, i) => t - starts[i]);
      return { maxAtk, maxBrk, starts: starts.length, minGap: gaps.length ? Math.min(...gaps) : null, sameFrame: [...frameHits.values()].filter((n) => n > 1).length, hitsOnPlayer: H.sys().filter((e) => /^player /.test(e.what)).length };
    });
    check('Never more than 2 enemies attacking at once', mf.maxAtk <= DOC.director.maxAttackers, `max ${mf.maxAtk}`);
    check('Never more than 1 Breaker attacking at once', mf.maxBrk <= DOC.director.maxBreakers, `max ${mf.maxBrk}`);
    check('At least 0.6 s between attack starts', mf.minGap === null || mf.minGap >= DOC.director.gap - 1e-6, `${mf.starts} starts, min gap ${f2(mf.minGap)} s`);
    check('No two enemy hits land on the player in the same frame', mf.sameFrame === 0, `${mf.hitsOnPlayer} hits on the player, ${mf.sameFrame} same-frame pairs`);
    check('The fight produced attacks (sanity)', mf.starts >= 10 && mf.hitsOnPlayer >= 5, `${mf.starts} starts, ${mf.hitsOnPlayer} hits`);
  }
  await p.close();
}
if (want('stage2b')) {
  // Fresh page: behaviour sampled from the arena's own spawn layout (independent of earlier tests).
  const p = await open('r2b1');
  const E = (fn, arg) => p.evaluate(fn, arg);
  {
    group = '18 Stage 2B regression';
    const bh = await E(() => {
      // Fresh positions; unmodified AI; player still. Sample spacing while enemies hold.
      H.placePlayer(0, 44, Math.PI); H.fresh(); H.begin();
      const rd = [], bd = [], bs = []; let last = null;
      for (let f = 0; f < 60 * 30; f++) {
        H.step(1); if (f % 60 === 0) H.C.hp = 100;
        for (const b of H.A.brains) {
          const d = H.dist(b);
          if (b.e.cls === 'runner' && b.state === 'hold' && b.stateT > 1.5) rd.push(d);
          if (b.e.cls === 'breaker' && b.state === 'hold' && b.stateT > 2.5) bd.push(d);
          if (b.e.cls === 'breaker') {
            const p = b.e.object.position.clone();
            if (last && (b.state === 'approach' || b.state === 'hold') && d < 8 && d > 2.8) bs.push(Math.hypot(p.x - last.x, p.z - last.z) * 60);
            last = p;
          }
        }
      }
      const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
      const pct = (a, lo, hi) => a.length ? a.filter((x) => x >= lo && x <= hi).length / a.length : null;
      // Visibility gate: turn the camera away from every enemy; no new attack may start for 5 s.
      // (debug camera straight up at the sky: every warning point is off-screen.)
      H.placePlayer(0, 44, Math.PI); H.g.debugCam([0, 1.7, 44], [0, 60, 44.01]); H.step(1);
      const n0 = H.A.director.starts.length, before = H.A.brains.map((b) => b.state);
      for (let f = 0; f < 300; f++) { H.step(1); if (f % 60 === 0) H.C.hp = 100; }
      const startedHidden = H.A.director.starts.length - n0; H.g.debugCam(null);
      // Wall gate: the director's visibility check for a point just behind the solid wall at z 47.62.
      H.placePlayer(0, 44, 0); H.g.tpc.yaw = Math.PI; H.step(2);
      const behindWall = H.A.director.visible([{ x: 0, y: 1.3, z: 49.0 }], 'probe'), inOpen = H.A.director.visible([{ x: 0, y: 1.3, z: 46.5 }], 'probe');
      return { runnerMed: med(rd), runnerIn: pct(rd, 3, 5), runnerN: rd.length, brkMed: med(bd), brkIn: pct(bd, 1.95, 2.55), brkN: bd.length, brkSpeedMax: bs.length ? Math.max(...bs) : null, brkSpeedMed: med(bs), startedHidden, behindWall, inOpen, before };
    });
    check('Runners hold a 3–5 m ring', bh.runnerN > 0 && bh.runnerMed >= 3 && bh.runnerMed <= 5 && bh.runnerIn >= 0.8, `median ${f2(bh.runnerMed)} m, ${Math.round(bh.runnerIn * 100)}% of ${bh.runnerN} samples inside 3–5 m`);
    check('Breaker holds 2.0–2.5 m (±0.05 m)', bh.brkN > 0 && bh.brkMed >= 1.95 && bh.brkMed <= 2.55 && bh.brkIn >= 0.8, `median ${bh.brkMed?.toFixed(3)} m, ${Math.round((bh.brkIn ?? 0) * 100)}% of ${bh.brkN} samples inside 1.95–2.55 m`);
    check('Breaker walks at about 0.9 m/s within 8 m', bh.brkSpeedMed !== null && bh.brkSpeedMed <= DOC.behaviour.breakerSpeed + 0.1, `median ${f2(bh.brkSpeedMed)} m/s, max ${f2(bh.brkSpeedMax)} m/s`);
    const bc = await E(() => {
      // A Breaker that starts close (1.8 m, inside his 2.0–2.5 m band) — where does he settle? Attacks stubbed off.
      const b = H.brain('breaker'); for (const o of H.A.brains) if (o !== b) { H.freeze(o); H.park(o); }
      H.unfreeze(b); b.decide = () => {}; b.tryAttack = () => {};
      H.fresh(); H.placePlayer(0, 44, Math.PI); H.placeEnemy(b, 0, 42.2, 0); H.secs(4);
      return H.dist(b);
    });
    check('Breaker starting at 1.8 m settles inside 2.0–2.5 m', bc >= 1.95 && bc <= 2.55, `settled at ${bc.toFixed(3)} m after 4 s`);
    check('No attack starts while every warning is off-screen (camera turned away, 5 s)', bh.startedHidden === 0, `${bh.startedHidden} starts`);
    check('A warning behind a wall is not visible; the same in the open is', bh.behindWall === false && bh.inOpen === true, `behind wall ${bh.behindWall}, open ${bh.inOpen}`);
  }
  await p.close();
}

// ================================================================================================ STAGE 2A (existing harness, unchanged)
if (want('stage2a')) {
  group = '17 Stage 2A regression';
  const p = await browser.newPage();
  p.setDefaultTimeout(300000);
  await p.goto(`${BASE}/tools/hittest/index.html`);
  await p.waitForFunction(() => document.title === 'done', null, { polling: 500 });
  const r = await p.evaluate(() => window.results);
  for (const x of r) check(x.name, x.pass, x.detail);
  await p.close();
}

await browser.close();
if (pageErrors.length) { group = 'Page errors'; for (const e of pageErrors) check('No page errors', false, e); }
const fails = results.filter((r) => !r.pass);
console.log(`\n${results.length - fails.length}/${results.length} passed, ${fails.length} failed`);
if (process.env.TLC_JSON) (await import('fs')).writeFileSync(process.env.TLC_JSON, JSON.stringify(results, null, 1));
process.exit(fails.length ? 1 : 0);
