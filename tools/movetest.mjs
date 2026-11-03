// Movement & collision tests: drives the real Player/camera code with simulated input (no rendering)
// and asserts on the resulting positions. usage: node tools/movetest.mjs
import { createRequire } from 'module';
import { pathX, SITES, BRIDGE_Z, streamX, valleyAxis, waterY, PLAY } from '../src/world/heightfield.ts';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 320, height: 180 } });
p.setDefaultTimeout(600000);
const errors = [];
p.on('pageerror', (e) => errors.push(e.message));
await p.goto('http://localhost:5173/?quality=low');
await p.waitForFunction(() => window.__tlc?.ready, null, { polling: 1000 });
await p.evaluate(() => { window.__tlc.pause(true); window.__tlc.start(); });

const yawFor = (dx, dz) => Math.atan2(-dx, -dz);
async function run(name, { x, z, dir, keys = ['KeyW'], frames = 90 }) {
  return p.evaluate(({ x, z, yaw, keys, frames }) => {
    const g = window.__tlc;
    g.teleport(x, z);
    g.view(yaw, -0.05);
    g.step(2, 1 / 30, false);
    const p0 = g.player.position.clone();
    const ys = [];
    keys.forEach((k) => g.input.keys.add(k));
    for (let i = 0; i < frames; i++) { g.step(1, 1 / 30, false); ys.push(g.player.position.y); }
    g.input.keys.clear();
    const q = g.player.position;
    return { start: [p0.x, p0.y, p0.z], end: [q.x, q.y, q.z], dist: Math.hypot(q.x - p0.x, q.z - p0.z), minY: Math.min(...ys), maxY: Math.max(...ys), ground: g.ground(q.x, q.z) };
  }, { x, z, yaw: yawFor(...dir), keys, frames });
}
const results = [];
const check = (name, ok, info) => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${info}`); };
const f = (v) => v.map((n) => n.toFixed(2)).join(', ');

// 1. Jog forward 3s on open ground (~4.3 m/s).
let r = await run('jog', { x: PLAY.start.x, z: PLAY.start.z, dir: [0, -1] });
check('jog 3s covers ~11-13.5m and stays on terrain', r.dist > 11 && r.dist < 13.5 && Math.abs(r.end[1] - r.ground) < 0.1, `dist=${r.dist.toFixed(2)} y=${r.end[1].toFixed(2)} ground=${r.ground.toFixed(2)}`);
// 2. Sprint.
r = await run('sprint', { x: PLAY.start.x, z: PLAY.start.z, dir: [0, -1], keys: ['KeyW', 'ShiftLeft'] });
check('sprint 3s covers ~18-22m', r.dist > 18 && r.dist < 22, `dist=${r.dist.toFixed(2)}`);
// 3. Walk.
r = await run('walk', { x: PLAY.start.x, z: PLAY.start.z, dir: [0, -1], keys: ['KeyW', 'KeyC'] });
check('walk 3s covers ~4-5m', r.dist > 4 && r.dist < 5.2, `dist=${r.dist.toFixed(2)}`);
// 4. Column collision (colonnade): walk into the first column on the road's right side.
const col = await p.evaluate(() => window.__tlc.colliders.all.filter((c) => c.kind === 'circle' && c.r === 0.75).map((c) => [c.x, c.z]));
const [cx, cz] = col[0];
r = await run('column', { x: cx + 4, z: cz, dir: [-1, 0], frames: 60 });
const dCol = Math.hypot(r.end[0] - cx, r.end[2] - cz);
check('column blocks the player (stops ~1.1m from centre)', dCol > 1.0 && dCol < 1.4, `end dist to column=${dCol.toFixed(2)}`);
// 5. Terrace stairs: approach from the road (west), climb onto the platform.
const T = SITES.terrace;
r = await run('stairs', { x: T.x - 24, z: T.z + 1, dir: [1, 0], frames: 120 });
check('stairs lead up onto the terrace (+~2.4m)', r.end[1] - r.start[1] > 2.0 && r.end[0] > T.x - 12, `rise=${(r.end[1] - r.start[1]).toFixed(2)} end=(${f(r.end)})`);
// 6. Terrace side wall is not climbable without stairs.
r = await run('terrace wall', { x: T.x, z: T.z - 14, dir: [0, 1], frames: 60 });
check('terrace retaining wall blocks from the side', r.end[2] < T.z - 8.4 && r.end[1] - r.start[1] < 0.5, `end=(${f(r.end)})`);
// 7. Bridge: cross from bank to bank on the deck, rising above the water.
const bx = streamX(BRIDGE_Z);
r = await run('bridge', { x: bx - 16, z: BRIDGE_Z, dir: [1, 0], frames: 210 });
check('bridge crossing (deck carries the player over the stream)', r.end[0] > bx + 8 && r.maxY > waterY(BRIDGE_Z) + 1.2, `end=(${f(r.end)}) maxY=${r.maxY.toFixed(2)} water=${waterY(BRIDGE_Z).toFixed(2)}`);
// 8. Steep valley wall: try to run straight up it.
const wz = 100, wx = valleyAxis(wz) + 260;
r = await run('slope', { x: wx - 60, z: wz, dir: [1, 0], frames: 240, keys: ['KeyW', 'ShiftLeft'] });
check('steep valley walls stop the climb', r.end[0] < wx + 120, `end=(${f(r.end)}) climbed ${(r.end[1] - r.start[1]).toFixed(1)}m`);
// 9. Wading through the stream is slower.
const sz = 60, sx = streamX(sz);
r = await run('wade', { x: sx - 12, z: sz, dir: [1, 0], frames: 270 });
check('stream can be waded (player crosses, dips below bank level)', r.end[0] > sx + 5 && r.minY < waterY(sz), `end=(${f(r.end)}) minY=${r.minY.toFixed(2)} water=${waterY(sz).toFixed(2)}`);
// 10. Play bounds near the Colossus.
r = await run('bounds', { x: pathX(-440), z: -440, dir: [0, -1], frames: 240, keys: ['KeyW', 'ShiftLeft'] });
check('cannot leave the explorable area toward the Colossus', r.end[2] >= PLAY.minZ - 0.01, `end z=${r.end[2].toFixed(2)} (limit ${PLAY.minZ})`);

console.log(`\n${results.filter(Boolean).length}/${results.length} passed; page errors: ${errors.length ? errors.join(' | ') : 'none'}`);
await b.close();
