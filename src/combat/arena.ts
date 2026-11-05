import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Enemy } from '../enemies/enemy';
import { AttackDirector } from './director';
import { EnemyBrain, type PlayerView, type WorldQuery } from './brain';
import { mulberry32 } from '../core/noise';
import { loadWardenAssets } from '../player/mentorNpc';
import { segSegDistance, type Capsule } from './hits';

/**
 * Dev-only behaviour test arena (?combat=r2b1 : two Runners and one Breaker): spawns enemies ahead of the
 * player and runs their brains with the attack director. Not an encounter: no waves, no damage.
 */
export class CombatArena {
  readonly brains: EnemyBrain[] = [];
  private spawns: { p: THREE.Vector3; yaw: number }[] = [];
  readonly director: AttackDirector;
  time = 0;

  private constructor(visible: (pts: { x: number; y: number; z: number }[], requester: string) => boolean) { this.director = new AttackDirector(visible); }

  static async create(spec: string, scene: THREE.Scene, base: string, world: WorldQuery & { lineBlocked(a: THREE.Vector3, b: THREE.Vector3): boolean }, camera: THREE.PerspectiveCamera, origin: THREE.Vector3, facing: number, seed = 1,
    occluders: () => Capsule[] = () => []) {
    // Genuine visibility of a warning: every point clearly inside the view (inset from the edges, in front of the
    // camera) AND an unobstructed line from the camera to it (walls, buildings and other colliders block it).
    const INSET = 0.85;
    // Characters also block the view: other living enemies and extra bodies such as the mentor.
    const visible = (pts: { x: number; y: number; z: number }[], requester: string) => {
      camera.updateMatrixWorld();
      const eye = camera.getWorldPosition(new THREE.Vector3());
      const bodies: Capsule[] = [
        ...a.brains.filter((b) => b.id !== requester && !b.dead && !b.removed).map((b) => ({ base: b.effective(), radius: b.p.radius, bottom: 0.1, top: b.e.cls === 'breaker' ? 2.0 : 1.75 })),
        ...occluders(),
      ];
      return pts.every((pt) => {
        const p = new THREE.Vector3(pt.x, pt.y, pt.z);
        const q = p.clone().project(camera);
        if (q.z <= -1 || q.z >= 1 || Math.abs(q.x) > INSET || Math.abs(q.y) > INSET) return false;
        if (world.lineBlocked(eye, p)) return false;
        // Blocked if the camera-to-point line passes through a body (0.85 x radius, so a graze doesn't count).
        return !bodies.some((c) => segSegDistance(eye, p, c.base.clone().setY(c.base.y + c.bottom), c.base.clone().setY(c.base.y + c.top)).dist < c.radius * 0.85);
      });
    };
    // eslint-disable-next-line prefer-const
    let a: CombatArena;
    a = new CombatArena(visible);
    const gl = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const [lib, ranger] = await Promise.all([gl.loadAsync(`${base}assets/models/enemies.glb`), gl.loadAsync(`${base}assets/models/ranger.glb`)]);
    const runners = +(spec.match(/r(\d)/)?.[1] ?? 0), breakers = +(spec.match(/b(\d)/)?.[1] ?? 0), wardens = +(spec.match(/w(\d)/)?.[1] ?? 0);
    const warden = wardens ? await loadWardenAssets(base) : null;
    const rnd = mulberry32(seed);
    const kinds = [...Array(wardens).fill('warden'), ...Array(breakers).fill('breaker'), ...Array(runners).fill('runner')] as ('runner' | 'breaker' | 'warden')[];
    kinds.forEach((kind, i) => {
      const e = kind === 'warden' ? new Enemy(kind, warden!.body, lib.animations, warden!.scan) : new Enemy(kind, kind === 'runner' ? lib : ranger, lib.animations);
      const spread = (i - (kinds.length - 1) / 2) * 2.2;
      const f = new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing)), r = new THREE.Vector3(f.z, 0, -f.x);
      const p = origin.clone().addScaledVector(f, kind !== 'runner' ? 5.5 : 6.2).addScaledVector(r, spread);
      // Nudge the spawn out of any obstacle.
      [p.x, p.z] = world.resolve(p.x, p.z, world.height(p.x, p.z), kind !== 'runner' ? 0.6 : 0.5);
      p.y = world.height(p.x, p.z);
      e.object.position.copy(p); e.object.rotation.y = facing + Math.PI;
      scene.add(e.object);
      a.brains.push(new EnemyBrain(e, `${kind}${i}`, a.director, world, rnd));
      a.spawns.push({ p: p.clone(), yaw: facing + Math.PI });
    });
    return a;
  }

  /** Respawn every enemy at its spawn point (after the player's defeat). */
  reset() { this.brains.forEach((b, i) => b.revive(this.spawns[i].p, this.spawns[i].yaw)); }

  update(dt: number, player: PlayerView) {
    this.time += dt;
    for (const b of this.brains) if (!b.removed) b.update(dt, this.time, player, this.brains);
  }
}
