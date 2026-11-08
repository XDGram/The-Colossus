// Reveal trailer: captures scripted cinematic shots from the real game, frame by frame (dev tool, not part of the game).
// usage: npm run dev   (another terminal)
//        node tools/trailer/shoot.mjs <set> <outDir> [shot,...]
// Sets: arena (temple duel shots), intro (the game's own opening cinematic), realm (the Warden's valley shots).
import fs from 'fs';
import { createRequire } from 'module';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const [set, OUT, only] = process.argv.slice(2);
const W = +(process.env.TW || 854), H = Math.round(W / 2.39);   // 2.39:1
const Q = process.env.TQ || 'low';
const URL = { arena: `/?combat=r3b1w1&quality=${Q}&seed=3`, intro: `/?quality=${Q}&norealm`, realm: `/?quality=${Q}` }[set];

const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: W, height: H } }); p.setDefaultTimeout(3600000);
p.on('pageerror', (e) => { if (!/Pointer/.test(e.message)) console.log('PAGEERR', e.message); });
await p.goto(`http://localhost:5173${URL}`);
await p.waitForFunction(() => window.__tlc?.ready, null, { polling: 500 });

// ------------------------------------------------------------------ in-page library and shot definitions
await p.evaluate((set) => {
  const g = window.__tlc; g.pause(true);
  // A fake clock: performance.now advances exactly with the simulated frames (the opening cinematic and other
  // real-time logic would otherwise race ahead while each frame takes seconds to render).
  let fake = performance.now(); const realNow = performance.now.bind(performance);
  performance.now = () => fake; window.__tick = (dt) => { fake += dt * 1000; };
  const step0 = g.step; g.step = (n, dt = 1 / 30, cap = true) => { let r; for (let i = 0; i < n; i++) { window.__tick(dt); r = step0(1, dt, cap && i === n - 1); } return r ?? { url: '' }; };
  void realNow;
  g.start();
  document.querySelectorAll('#loader,#title,#hint,#quality,#fps,#touch,#hud,#spirit-hud,#flash,.threat').forEach((e) => (e.style.display = 'none'));
  const P = g.player, C = g.combat(), A = g.arena(), I = g.input, S = g.combatSystem(), V = P.position.constructor;
  const v = (x, y, z) => new V(x, y, z);
  const L = window.L = { g, P, C, A, I, S, v };
  L.boss = () => A.brains.find((x) => x.e.kind === 'warden');
  L.runners = () => A.brains.filter((x) => x.e.cls === 'runner' && x.e.kind !== 'warden' && !x.dead);
  L.brk = () => A.brains.find((x) => x.e.kind === 'breaker');
  L.held = new Map();
  /** Park every enemy not listed (far away, frozen); bring the listed back to life. */
  L.only = (list) => {
    for (const x of A.brains) {
      if (list.includes(x)) { if (L.held.has(x)) { x.update = L.held.get(x); L.held.delete(x); } x.e.object.visible = true; continue; }
      if (!L.held.has(x)) L.held.set(x, x.update);
      x.update = () => {}; x.e.object.visible = false; x.e.object.position.set(500 + Math.random() * 50, -50, 500);
    }
  };
  L.place = (x, px, pz, yaw) => { x.e.pivot.position.set(0, 0, 0); x.e.object.position.set(px, P.position.y, pz); x.e.object.rotation.y = yaw; x.set?.('hold'); };
  L.freeze = (x, pose) => { if (!L.held.has(x)) L.held.set(x, x.update); x.update = (d) => x.e.update(d); if (pose) x.e.play(pose, 0); };
  L.calm = (x) => { x.decide = () => {}; x.tryAttack = () => {}; x.dodgeCool = 1e9; };
  L.pv = () => ({ position: P.position, facing: P.facing, radius: 0.38, attackKey: null, mash: 0 });
  L.bossDo = (a) => { const w = L.boss(); for (const k of Object.keys(w.cool)) w.cool[k] = 0; w.lastAction = null; A.director.lastStart = -1e9; A.director.exclusive = null; w.startAction(a, L.pv(), A.time); };
  L.keep = () => { C.hp = 100; };
  L.face = (q) => P.setFacing(Math.atan2(q.x - P.position.x, q.z - P.position.z));
  L.dust = (k, dir) => {
    const vfx = g.vfx(); if (!vfx) return;
    for (let i = 0; i < 9 * k; i++) {
      const side = v(dir.z, 0, -dir.x), q = P.position.clone().addScaledVector(dir, -6 + Math.random() * 4).addScaledVector(side, (Math.random() - 0.5) * 14).add(v(0, 0.2 + Math.random() * 2.8, 0));
      vfx.spawn('smoke_04', q, { color: new (g.scene.fog.color.constructor)(0.62, 0.56, 0.48), life: 0.8, size: 1.1, size1: 3, vel: dir.clone().multiplyScalar(14).add(v(0, 0.5, 0)), alpha: 0.5 * k, normal: true });
    }
  };
  const orbit = (c, a, r, h, look) => [[c.x + Math.sin(a) * r, c.y + h, c.z + Math.cos(a) * r], look];
  const at = (q, dy = 0) => [q.x, q.y + dy, q.z];

  // Each shot: setup(), then per frame act(f) and cam(f) -> [pos, look] (null: the game's own camera); dt(f).
  const SH = window.SH = {};
  if (set === 'arena') {
    const Z = 36;
    // Memory: master and student facing each other in the courtyard, golden and still (graded warm later).
    SH.memory = { n: 96, setup() {
      const w = L.boss(); L.only([w]); g.teleport(0, Z); P.setFacing(Math.PI); C.setDrawn(true);
      L.place(w, 0, Z - 2.4, 0); L.freeze(w, 'guard');
    }, act(f) { L.keep(); if (f === 40) I.attackQ++; },
    cam(f) { const k = f / 96, c = P.position.clone().add(v(0, 0, -1.2)); return [[c.x - 4.2 + 1.2 * k, c.y + 0.5 + 0.2 * k, c.z + 0.6], at(c, 1.3)]; } };
    // Combo: the five-cut chain into a crowd of Ash Runners (cut 3 to the leap in slow motion).
    SH.combo = { n: 96, setup() {
      const rs = L.runners().slice(0, 3); L.only(rs); g.teleport(0, Z); P.setFacing(Math.PI); C.setDrawn(true);
      rs.forEach((r, i) => { L.place(r, -1.6 + 1.6 * i, Z - 2.0 - (i % 2) * 0.5, 0); L.calm(r); });
    }, act(f) {
      L.keep(); const t = L.runners().filter((r) => r.e.object.visible).sort((a2, b2) => a2.effective().distanceTo(P.position) - b2.effective().distanceTo(P.position))[0];
      if (t) L.face(t.effective()); if (f % 9 === 0 && f < 80) I.attackQ++;
    }, dt: (f) => (f > 52 && f < 84 ? 1 / 75 : 1 / 30),
    cam(f) { const q = P.position, a = 2.3 - f * 0.012; return orbit(q, a, 3.6, 1.3, at(q, 1.0)); } };
    // Parry: a Runner's slash turned aside (slow motion).
    SH.parry = { n: 70, setup() {
      const r = L.runners()[0]; L.only([r]); g.teleport(0, Z); P.setFacing(Math.PI); C.setDrawn(true); L.place(r, 0, Z - 1.3, 0); L.calm(r);
    }, act(f) {
      L.keep(); const r = L.runners()[0]; if (!r) return;
      if (f === 3) { A.director.lastStart = -1e9; r.attack = 'slash'; r.beginTell(); }
      if (r.state === 'attack' && r.e.time > 0.12 && !this.done) { this.done = true; I.blockPressQ++; I.blockMouse = true; }
      if (f > 40) I.blockMouse = false; if (f === 46) I.attackQ++;
    }, dt: (f) => (f > 10 && f < 50 ? 1 / 90 : 1 / 30),
    cam(f) { const q = P.position; return [[q.x + 2.2, q.y + 1.35, q.z - 0.7], at(q.clone().add(v(0, 0, -0.7)), 1.3)]; } };
    // The giant: heavy blows drive an Iron Breaker back and down to one knee.
    SH.giant = { n: 76, setup() {
      const k = L.brk(); L.only([k]); g.teleport(0, Z); P.setFacing(Math.PI); C.setDrawn(true); L.place(k, 0, Z - 2.1, 0); L.calm(k); k.move = () => {};
    }, act(f) {
      L.keep(); const k = L.brk(); if (f === 6 || f === 30) I.attackQ++;
      if (f === 14) S.playerHits('heavy', k.id); if (f === 40) S.playerHits('kick', k.id); if (f === 58) S.playerHits('rupture', k.id);
      if (f === 52) I.injectSpirit('rupture');
    }, dt: (f) => (f > 56 && f < 74 ? 1 / 70 : 1 / 30),
    cam(f) { const q = P.position, k = f / 84; return [[q.x + 3.0 - 0.8 * k, q.y + 0.5, q.z - 0.6], at(q.clone().add(v(0, 0, -1.6)), 1.5)]; } };
    // Phantom Step: through the Runners in a cyan streak.
    SH.phantom = { n: 50, setup() {
      const rs = L.runners().slice(0, 2); L.only(rs); g.teleport(0, Z); P.setFacing(Math.PI); C.setDrawn(true);
      rs.forEach((r, i) => { L.place(r, -0.7 + 1.4 * i, Z - 3.2, 0); L.calm(r); });
    }, act(f) { L.keep(); if (f === 6) I.injectSpirit('phantom'); }, dt: (f) => (f > 6 && f < 26 ? 1 / 60 : 1 / 30),
    cam(f) { const c = v(0, P.position.y, Z - 2.5); return [[c.x + 4.4, c.y + 1.2, c.z + 1.6], at(c, 1.0)]; } };
    // Colossus Rift: the charge (aura, motes) and the crescent tearing across the courtyard.
    SH.rift = { n: 72, setup() {
      const rs = L.runners().slice(0, 3); L.only(rs); g.teleport(0, Z); P.setFacing(Math.PI); C.setDrawn(true);
      rs.forEach((r, i) => { L.place(r, -2 + 2 * i, Z - 8 - i, 0); L.calm(r); });
    }, act(f) { L.keep(); if (f === 2) I.injectSpirit('rift'); if (f === 40) I.injectSpirit('riftUp'); }, dt: (f) => (f > 40 && f < 60 ? 1 / 60 : 1 / 30),
    cam(f) { const q = P.position, k = f / 80; return f < 40 ? [[q.x - 1.4 + 0.3 * k, q.y + 1.2, q.z - 1.9], at(q, 1.35)] : [[q.x + 1.0, q.y + 1.7, q.z + 2.8], at(q.clone().add(v(0, 0, -6)), 1.0)]; } };
    // Gravity Rupture: the ground breaks, Runners thrown into the air (slow motion at the top).
    SH.rupture = { n: 80, setup() {
      g.abilities()?.reset();   // ready again (and the earlier craters cleared)
      const rs = L.runners().slice(0, 3); L.only(rs); g.teleport(0, Z); P.setFacing(Math.PI); C.setDrawn(true);
      rs.forEach((r, i) => { const a = -1 + i; L.place(r, Math.sin(a) * 2.4, Z + Math.cos(a) * -2.4, 0); L.calm(r); });
    }, act(f) { L.keep(); if (f === 4) I.injectSpirit('rupture'); }, dt: (f) => (f > 24 && f < 64 ? 1 / 80 : 1 / 30),
    cam(f) { const q = P.position, a = 0.5 + f * 0.005; return orbit(q, a, 4.4, 0.9, at(q.clone().add(v(0, 0, -1)), 1.3)); } };
    // The Warden: his combo against the student's guard, then the teleport strike.
    SH.duel = { n: 90, setup() {
      const w = L.boss(); L.only([w]); g.teleport(0, Z); P.setFacing(Math.PI); C.setDrawn(true); L.place(w, 0, Z - 1.8, 0); w.choose = () => {};
    }, act(f) {
      L.keep(); const w = L.boss(); L.face(w.effective());
      if (f === 4) L.bossDo('combo'); I.blockMouse = f > 8 && f < 60; if (f === 60) L.bossDo('teleport');
    }, cam(f) { const q = P.position, w = L.boss().effective(), m = q.clone().lerp(w, 0.5); return f < 60 ? [[m.x + 3.2, m.y + 1.4, m.z + 0.4], at(m, 1.2)] : orbit(q, 1.2 + f * 0.01, 4.2, 1.6, at(q, 1.1)); } };
    // The strike: lightning hits the Warden, he vanishes in smoke, his soldiers burst out of it.
    SH.strike = { n: 50, setup() {
      const w = L.boss(); L.only([w]); g.teleport(0, Z + 4); P.setFacing(Math.PI); L.place(w, 0, Z - 3, 0); L.freeze(w, 'guard');
    }, act(f) {
      L.keep(); const w = L.boss(), wp = w.effective(), vfx = g.vfx(), Cc = g.scene.fog.color.constructor;
      if (f === 8) { vfx.bolt(wp, 22, 2.6); vfx.bolt(wp.clone().add(v(0.5, 0, 0.3)), 20, 1.8); vfx.bolt(wp.clone().add(v(-0.6, 0, -0.2)), 18, 1.4);
        vfx.spawn('star_06', wp.clone().setY(wp.y + 1.2), { color: new Cc(0.93, 0.88, 1.0), life: 0.35, size: 7, size1: 2, alpha: 1, rot: 0 });
        vfx.burst('smoke_07', wp.clone().setY(wp.y + 0.6), { count: 14, color: new Cc(0.1, 0.08, 0.12), life: 1.4, size: 1.6, size1: 3.4, speed: 3, up: 0.6, alpha: 0.9, drag: 2 }); }
      if (f === 12) { vfx.puff(wp, false); w.e.object.visible = false; }
      for (let i = 0; i < 3; i++) if (f === 18 + i * 5) {
        const a2 = (i - 1) * 0.9, q = wp.clone().add(v(Math.sin(a2) * 2.2, 0, Math.cos(a2) * 2.2 + 1.2));
        const r = A.spawn('runner', q, 0); L.calm(r); L.freeze(r, 'idle'); vfx.puff(r.e.object.position, true);
      }
    }, cam(f) { const c = v(0, P.position.y, Z - 3), k = f / 50; return [[c.x + 2.2, c.y + 0.5, c.z + 4.6 - 0.6 * k], at(c, 2.0 - 0.4 * k)]; } };
    // The turn: he raises his blade; wind and darkness rise.
    SH.turn = { n: 66, setup() {
      const w = L.boss(); L.only([w]); g.teleport(0, Z); P.setFacing(Math.PI); C.setDrawn(true); L.place(w, 0, Z - 5, 0); L.freeze(w, 'raise');
    }, act(f) { L.keep(); const k = Math.min(1, f / 60); g.post.dark = 0.85 * k * k; L.dust(0.3 + k, v(0, 0, 1)); },
    cam(f) { const w = L.boss().effective(), k = f / 66; return [[w.x + 1.1, w.y + 1.0, w.z + 3.4 - 0.9 * k], at(w, 1.9)]; } };
  }
  if (set === 'intro') {
    // The game's own opening (its cameras): doors swing open; the Warden, close; the lightning.
    const E = g.encounter();
    SH.gate = { n: 72, skip: 0.35, setup() {}, act() {}, cam: () => null };
    SH.warden = { n: 54, skip: 5.15, setup() {}, act() {}, cam: () => null };
    SH.strike = { n: 46, skip: 7.3, setup() {}, act() {}, cam: () => null };
    L.introT = () => E.t;
  }
  if (set === 'realm') {
    L.toRealm = async () => {
      const E = g.encounter(); for (let i = 0; i < 2000 && E.phase === 'intro'; i++) g.step(1, 1 / 30, false);
      E.queue = []; for (const x of A.brains) if (x.e.kind !== 'warden') x.kill();
      E.realm.preload(); E.realm.build();
      while (!E.realm.ready) await new Promise((r) => setTimeout(r, 1000));
      E.startWarden(); for (let i = 0; i < 1200 && E.realmStage !== 'inside'; i++) g.step(1, 1 / 30, false);
      E.realmT = -1e5;   // stay in the valley for the whole shoot
    };
    const reset = (dz = 7) => {
      const w = L.boss(); g.arena().bossCtx.spells?.clear(); C.reset?.(); g.teleport(68, 148 + dz / 2); P.setFacing(Math.PI); C.setDrawn(true);
      w.relocate(v(68, 0, 148 - dz / 2), 0); w.unleashed = true; w.choose = () => {};
    };
    // Crane over the valley: the faint Colossus in the haze behind the two of them.
    SH.valley = { n: 78, setup() { reset(9); L.freeze(L.boss(), 'guard'); }, act() { L.keep(); },
      cam(f) { const k = f / 84, e = k * k * (3 - 2 * k), q = P.position; return [[q.x + 6 - 4 * e, q.y + 16 - 13 * e, q.z + 14 - 9 * e], [q.x, q.y + 2 - 0.6 * e, q.z - 30 + 20 * e]]; } };
    // The wall of fire rolls at the student; at the last instant a Phantom Step carries him through it.
    SH.inferno = { n: 84, setup() { reset(8); }, act(f) {
      L.keep(); if (f === 2) L.bossDo('inferno'); if (f === 58) { P.setFacing(Math.PI); I.injectSpirit('phantom'); }
    }, dt: (f) => (f > 52 && f < 74 ? 1 / 70 : 1 / 30),
      cam(f) { const q = P.position, w = L.boss().effective(); return [[q.x + 1.9, q.y + 0.55, q.z + 2.6], at(q.clone().lerp(w, 0.6), 1.3)]; } };
    // He leaps into the sky; the meteor comes down on the student, who answers with the Gravity Rupture.
    SH.meteor = { n: 90, setup() { reset(7); }, act(f) { L.keep(); if (f === 2) L.bossDo('meteor'); if (f === 66) I.injectSpirit('rupture'); },
      dt: (f) => (f > 58 && f < 84 ? 1 / 70 : 1 / 30),
      cam(f) { const q = P.position, k = Math.min(1, f / 60); return [[q.x + 3.6, q.y + 0.7 + 0.5 * k, q.z + 3.2], at(q, 4.5 - 3.3 * k)]; } };
    SH.wrath = { n: 66, setup() { reset(8); }, act(f) {
      L.keep(); if (f === 2) L.bossDo('wrath'); I.keys.clear(); if (f > 10 && f < 60) { I.keys.add(f < 34 ? 'KeyD' : 'KeyA'); I.keys.add('ShiftLeft'); }
      g.tpc.yaw = Math.PI * 2; if (f === 62) I.injectSpirit('rift'); if (f === 76) I.injectSpirit('riftUp');
    }, dt: (f) => (f > 14 && f < 40 ? 1 / 50 : 1 / 30),
    cam(f) { const q = P.position; return [[q.x - 3.0, q.y + 0.6, q.z + 2.6], at(q.clone().add(v(0.4, 0, -1.5)), 1.8)]; } };
    SH.thunder = { n: 54, setup() { reset(8); }, act(f) { L.keep(); if (f === 2) L.bossDo('thunderstep'); I.blockMouse = f > 18; },
      cam(f) { const q = P.position; return orbit(q, 2.2 - f * 0.012, 4.6, 1.7, at(q, 1.1)); } };
    SH.tempest = { n: 54, setup() { reset(9); }, act(f) { L.keep(); if (f === 2) L.bossDo('tempest'); if (f === 4) I.injectSpirit('rift'); if (f === 40) I.injectSpirit('riftUp'); },
      dt: (f) => (f > 38 ? 1 / 80 : 1 / 30),
      cam(f) { const q = P.position, w = L.boss().effective(), m = q.clone().lerp(w, 0.5); return [[m.x + 5.2, m.y + 0.8, m.z + 0.5], at(m, 1.3)]; } };
  }
}, set);
if (set === 'realm') await p.evaluate(() => window.L.toRealm());

const names = await p.evaluate(() => Object.keys(window.SH));
for (const name of names) {
  if (only && !only.split(',').includes(name)) continue;
  const dir = `${OUT}/${name}`; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const n = await p.evaluate((name) => {
    const { g } = window.L, s = window.SH[name];
    g.post.dark = 0; g.debugCam(null);
    if (s.skip !== undefined) {   // intro: run the opening up to the shot's start
      const E = g.encounter(); for (let i = 0; i < 2000 && window.L.introT() < s.skip; i++) g.step(1, 1 / 30, false);
    } else { s.setup(); g.step(10, 1 / 30, false); }
    s.f = 0;
    window.__frame = () => {
      s.act(s.f);
      const c = s.cam(s.f);
      g.debugCam(c ? c[0] : null, c ? c[1] : undefined);
      g.step(1, s.dt ? s.dt(s.f) : 1 / 30, false);
      g.post.render(); g.renderer.getContext().finish();
      s.f++;
      return g.renderer.domElement.toDataURL('image/jpeg', 0.92);
    };
    return s.n;
  }, name);
  const t0 = Date.now();
  const N = +(process.env.TN || n);
  for (let i = 0; i < Math.min(n, N); i++) {
    const u = await p.evaluate(() => window.__frame());
    fs.writeFileSync(`${dir}/${String(i).padStart(4, '0')}.jpg`, Buffer.from(u.split(',')[1], 'base64'));
  }
  console.log('shot', name, n, 'frames', ((Date.now() - t0) / 1000).toFixed(0), 's');
}
await b.close();
