import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Enemy } from './enemy';

/**
 * Development showcase (temple scene with ?enemies): an Ash Runner and an Iron Breaker in the courtyard,
 * cycling through their moves in place. Not an encounter: no AI, no combat.
 */
const PLAYLIST = {
  runner: ['idle', 'walk', 'jog', 'slash', 'flurry', 'lunge', 'spin', 'parry', 'stepL', 'stepR', 'roll', 'hop', 'flinchChest', 'knockdown', 'deathA', 'deathB'],
  breaker: ['idle', 'walk', 'guard', 'sweep', 'smash', 'charge', 'stamp', 'shudder', 'guardBreak', 'stagger', 'deathA', 'deathB'],
} as const;

export class EnemyShowcase {
  readonly enemies: Enemy[] = [];
  private homes: { p: THREE.Vector3; yaw: number }[] = [];
  private idx: number[] = [];
  private hold: number[] = [];
  auto = true;

  static async create(scene: THREE.Scene, base: string, height: (x: number, z: number) => number, spots: { x: number; z: number; yaw: number }[]) {
    const gl = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const [lib, ranger] = await Promise.all([gl.loadAsync(`${base}assets/models/enemies.glb`), gl.loadAsync(`${base}assets/models/ranger.glb`)]);
    const s = new EnemyShowcase();
    const kinds = ['runner', 'breaker'] as const;
    spots.forEach((sp, i) => {
      const kind = kinds[i % 2];
      const e = new Enemy(kind, kind === 'runner' ? lib : ranger, lib.animations);
      const y = height(sp.x, sp.z);
      e.object.position.set(sp.x, y, sp.z); e.object.rotation.y = sp.yaw; e.groundY = y;
      scene.add(e.object);
      s.enemies.push(e); s.homes.push({ p: e.object.position.clone(), yaw: sp.yaw }); s.idx.push(0); s.hold.push(0);
    });
    return s;
  }

  update(dt: number) {
    this.enemies.forEach((e, i) => {
      if (this.auto) {
        const list = PLAYLIST[e.cls];
        const loopMove = e.moves[e.move].loop || e.moves[e.move].hold;
        this.hold[i] += dt;
        const finished = loopMove ? this.hold[i] > 3 : e.time >= e.duration(e.move) - 0.02;
        if (finished) {
          this.idx[i] = (this.idx[i] + 1) % list.length; this.hold[i] = 0;
          this.reset(i);
          e.play(list[this.idx[i]] as never, 0.2);
        }
      }
      e.update(dt);
    });
  }
  private reset(i: number) {
    const e = this.enemies[i];
    e.pivot.position.set(0, 0, 0); e.pivot.rotation.y = 0;
    e.object.position.copy(this.homes[i].p); e.object.rotation.y = this.homes[i].yaw;
  }
  /** Deterministic pose for screenshots: enemy i at move/time. */
  set(i: number, move: string, time: number) {
    this.auto = false;
    const e = this.enemies[i];
    this.reset(i);
    e.play(move as never, 0);
    e.time = time;
    e.pose();
    return { grip: e.lastGrip, hits: e.activeHits() };
  }
}
