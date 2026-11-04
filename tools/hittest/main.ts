// Controlled hit-detection cases for src/combat/hits.ts (dev tool, not part of the game).
import * as THREE from 'three';
import { HitWorld, BODY, MAX_STEP, type HitEvent } from '../../src/combat/hits';
import { Colliders } from '../../src/world/colliders';

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
type Res = { name: string; pass: boolean; detail: string };
const results: Res[] = [];
const check = (name: string, pass: boolean, detail: string) => results.push({ name, pass, detail });

/** A target dummy whose feet follow `pos` (mutable). */
function dummy(world: HitWorld, id: string, pos: THREE.Vector3, shape = BODY.runner) {
  world.addTarget({ id, capsule: () => ({ base: pos.clone(), ...shape }) });
  return pos;
}
/** A katana swing: blade (0.07-0.77 m from a pivot at chest height) rotating about +Y from a0 to a1 over `frames`. */
function swing(world: HitWorld, key: string, pivot: THREE.Vector3, a0: number, a1: number, frames: number, onFrame?: (f: number) => void) {
  const hits: HitEvent[] = [];
  const at = (a: number, r: number) => pivot.clone().add(V(Math.sin(a) * r, 0, Math.cos(a) * r));
  let maxStepTip = 0;
  for (let f = 0; f <= frames; f++) {
    onFrame?.(f);
    world.beginFrame();
    const a = a0 + (a1 - a0) * (f / frames);
    const prevA = a0 + (a1 - a0) * (Math.max(0, f - 1) / frames);
    world.lastSubsteps = 0;
    hits.push(...world.sweepWeapon(key, 'attacker', { hilt: at(a, 0.4), tip: at(a, 1.1), radius: 0.03 }, pivot, { hilt: at(prevA, 0.4), tip: at(prevA, 1.1) }));
    const tipMove = at(a, 1.1).distanceTo(at(prevA, 1.1));
    if (world.lastSubsteps) maxStepTip = Math.max(maxStepTip, tipMove / world.lastSubsteps);
  }
  return { hits, maxStepTip };
}

// 1. Basic hit and hit-once across repeated contact frames: slow swing through a standing target.
{
  const w = new HitWorld(null); dummy(w, 'T', V(0, 0, 1.2));
  const { hits } = swing(w, 'atk1', V(0, 1.2, 0), -1.2, 1.2, 30); // blade overlaps the target for many frames
  check('Repeated contact frames hit once', hits.length === 1, `${hits.length} hit(s) over 31 frames of a slow swing`);
  const again = swing(w, 'atk2', V(0, 1.2, 0), -1.2, 1.2, 30).hits;
  check('A new attack instance can hit again', again.length === 1, `${again.length} hit(s) for a second attack key`);
}
// 2. Very fast swing (anti-tunnelling): 150 deg in ONE frame. A single end-of-frame check would miss the target.
{
  const w = new HitWorld(null); dummy(w, 'T', V(0, 0, 1.0));
  const r = swing(w, 'fast', V(0, 1.2, 0), -1.3, 1.3, 1);
  // Endpoint-only check for comparison.
  const endOnly = [-1.3, 1.3].some((a) => Math.abs(Math.sin(a)) * 1.0 < 0.41);
  check('Fast swing (150 deg in one frame) still hits', r.hits.length === 1 && !endOnly, `swept: ${r.hits.length} hit; endpoint-only check would ${endOnly ? 'hit' : 'miss'}`);
  check('Sub-steps keep the tip under 10 cm per step', r.maxStepTip <= MAX_STEP + 1e-6, `max tip travel per sub-step ${(r.maxStepTip * 100).toFixed(1)} cm (tip moved ${(2.6 * 1.1).toFixed(2)} m arc in one frame)`);
}
// 3. Missed attacks: swing on the far side, and a swing out of reach.
{
  const w = new HitWorld(null); dummy(w, 'T', V(0, 0, 1.2));
  const behind = swing(w, 'miss1', V(0, 1.2, 0), Math.PI - 0.8, Math.PI + 0.8, 20).hits;
  const w2 = new HitWorld(null); dummy(w2, 'T', V(0, 0, 1.6));
  const far = swing(w2, 'miss2', V(0, 1.2, 0), -1.2, 1.2, 20).hits;
  check('Swing away from the target misses', behind.length === 0, `${behind.length} hits`);
  check('Target just out of reach is missed', far.length === 0, `target edge at ${(1.6 - 0.38).toFixed(2)} m, blade tip at 1.10 m + 0.03: ${far.length} hits`);
}
// 4. Moving target: a target crossing through a held blade at 12 m/s (0.2 m per frame); and one retreating out of reach.
{
  const w = new HitWorld(null); const p = dummy(w, 'T', V(-3, 0, 0.9));
  const r = swing(w, 'held', V(0, 1.2, 0), 0, 0, 30, (f) => p.set(-3 + f * 0.2, 0, 0.9));
  check('Moving target crossing a still blade is hit', r.hits.length === 1, `${r.hits.length} hit; contact at x=${r.hits[0]?.point.x.toFixed(2)}`);
  const w2 = new HitWorld(null); const q = dummy(w2, 'T', V(0, 0, 1.2));
  const r2 = swing(w2, 'chase', V(0, 1.2, 0), -1.2, 1.2, 12, (f) => q.set(0, 0, 1.2 + f * 0.12));
  check('Target retreating faster than the swing is missed', r2.hits.length === 0, `${r2.hits.length} hits (target backed off 1.4 m during the swing)`);
  // Teleport-fast target: 3 m in a single frame straight through the blade.
  const w3 = new HitWorld(null); const t = dummy(w3, 'T', V(-1.5, 0, 0.9));
  const r3 = swing(w3, 'dash', V(0, 1.2, 0), 0, 0, 1, (f) => t.set(-1.5 + f * 3, 0, 0.9));
  check('Target dashing 3 m through the blade in one frame is hit', r3.hits.length === 1, `${r3.hits.length} hit`);
}
// 5. Lunge: attacker (and blade, held forward) travels 2.0 m in 0.33 s at 60 fps.
{
  const run = (targetZ: number) => {
    const w = new HitWorld(null); dummy(w, 'T', V(0, 0, targetZ));
    const hits: HitEvent[] = []; let z = 0, prev: { hilt: THREE.Vector3; tip: THREE.Vector3 } | undefined;
    for (let f = 0; f <= 20; f++) {
      w.beginFrame(); z = Math.min(2.0, f * 0.1);
      const cur = { hilt: V(0.15, 1.1, z + 0.3), tip: V(0.1, 1.1, z + 1.0), radius: 0.03 };
      hits.push(...w.sweepWeapon('lunge', 'attacker', cur, V(0, 1.3, z), prev)); prev = cur;
    }
    return hits.length;
  };
  check('Lunge reaches a target 2.8 m ahead', run(2.8) === 1, `${run(2.8)} hit`);
  check('Lunge misses a target 3.6 m ahead', run(3.6) === 0, `${run(3.6)} hits`);
}
// 6. Wall obstruction: a 0.3 m wall between attacker and target; and an open-air control.
{
  const cols = new Colliders(); cols.addBox(0, 0.7, 4, 0.3, 0, 0, 3); // wall across z = 0.7
  const w = new HitWorld(cols); dummy(w, 'T', V(0, 0, 1.25));
  const blocked = swing(w, 'wall', V(0, 1.2, 0), -1.2, 1.2, 30).hits;
  const w2 = new HitWorld(new Colliders()); dummy(w2, 'T', V(0, 0, 1.25));
  const open = swing(w2, 'open', V(0, 1.2, 0), -1.2, 1.2, 30).hits;
  check('Wall between attacker and target blocks the hit', blocked.length === 0, `${blocked.length} hits through the wall`);
  check('Same swing without the wall hits', open.length === 1, `${open.length} hit`);
  // A low wall (0.5 m) does not block a chest-height cut.
  const cols3 = new Colliders(); cols3.addBox(0, 0.7, 4, 0.3, 0, 0, 0.5);
  const w3 = new HitWorld(cols3); dummy(w3, 'T', V(0, 0, 1.25));
  const low = swing(w3, 'low', V(0, 1.2, 0), -1.2, 1.2, 30).hits;
  check('Waist-low obstacle does not block a chest-height cut', low.length === 1, `${low.length} hit`);
}
// 7. Attacker never hits itself; dead/inactive targets are skipped.
{
  const w = new HitWorld(null);
  w.addTarget({ id: 'attacker', capsule: () => ({ base: V(0, 0, 0), ...BODY.player }) });
  w.addTarget({ id: 'dead', capsule: () => ({ base: V(0, 0, 1.2), ...BODY.runner }), active: () => false });
  const h = swing(w, 'self', V(0, 1.2, 0), -1.2, 1.2, 20).hits;
  check('No self-hits; inactive targets skipped', h.length === 0, `${h.length} hits`);
}
// 8. Charge (body sweep): Breaker capsule travels 4 m in 0.6 s; target in the path is hit once, target beside it is not.
{
  const run = (x: number) => {
    const w = new HitWorld(null); dummy(w, 'T', V(x, 0, 3));
    let n = 0;
    for (let f = 0; f <= 36; f++) { w.beginFrame(); n += w.sweepBody('charge', 'attacker', V(0, 0, Math.min(4, f * (4 / 36))), { radius: 0.5, bottom: 0.1, top: 1.75 }).length; }
    return n;
  };
  check('Charge hits a target in its path once', run(0.5) === 1, `${run(0.5)} hit`);
  check('Charge misses a target 1.2 m to the side', run(1.2) === 0, `${run(1.2)} hits`);
}
// 9. Stamp ring: expands 0 -> 2.2 m over 0.15 s; hits grounded targets in range, not airborne or distant ones.
{
  const run = (d: number, y: number) => {
    const w = new HitWorld(null); dummy(w, 'T', V(d, y, 0));
    let n = 0, r0 = 0;
    for (let f = 1; f <= 9; f++) { w.beginFrame(); const r1 = 2.2 * f / 9; n += w.sweepRing('stamp', 'attacker', V(0, 0, 0), r0, r1).length; r0 = r1; }
    return n;
  };
  check('Stamp ring hits a grounded target at 1.8 m', run(1.8, 0) === 1, `${run(1.8, 0)} hit`);
  check('Stamp ring misses an airborne target', run(1.8, 0.6) === 0, `${run(1.8, 0.6)} hits`);
  check('Stamp ring misses a target at 3.5 m', run(3.5, 0) === 0, `${run(3.5, 0)} hits`);
}
(window as any).results = results;
document.title = 'done';
