import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Enemy } from '../enemies/enemy';
import { AttackDirector } from './director';
import { EnemyBrain, type PlayerView, type WorldQuery } from './brain';
import { mulberry32 } from '../core/noise';

/**
 * Dev-only behaviour test arena (?combat=r2b1 : two Runners and one Breaker): spawns enemies ahead of the
 * player and runs their brains with the attack director. Not an encounter: no waves, no damage.
 */
export class CombatArena {
  readonly brains: EnemyBrain[] = [];
  readonly director: AttackDirector;
  time = 0;

  private constructor(visible: (p: { x: number; y: number; z: number }) => boolean) { this.director = new AttackDirector(visible); }

  static async create(spec: string, scene: THREE.Scene, base: string, world: WorldQuery, camera: THREE.PerspectiveCamera, origin: THREE.Vector3, facing: number, seed = 1) {
    const frustum = new THREE.Frustum(), m = new THREE.Matrix4();
    const visible = (p: { x: number; y: number; z: number }) => {
      camera.updateMatrixWorld(); m.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(m);
      return frustum.containsPoint(new THREE.Vector3(p.x, p.y, p.z));
    };
    const a = new CombatArena(visible);
    const gl = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const [lib, ranger] = await Promise.all([gl.loadAsync(`${base}assets/models/enemies.glb`), gl.loadAsync(`${base}assets/models/ranger.glb`)]);
    const runners = +(spec.match(/r(\d)/)?.[1] ?? 0), breakers = +(spec.match(/b(\d)/)?.[1] ?? 0);
    const rnd = mulberry32(seed);
    const kinds = [...Array(breakers).fill('breaker'), ...Array(runners).fill('runner')] as ('runner' | 'breaker')[];
    kinds.forEach((kind, i) => {
      const e = new Enemy(kind, kind === 'runner' ? lib : ranger, lib.animations);
      const spread = (i - (kinds.length - 1) / 2) * 2.2;
      const f = new THREE.Vector3(Math.sin(facing), 0, Math.cos(facing)), r = new THREE.Vector3(f.z, 0, -f.x);
      const p = origin.clone().addScaledVector(f, kind === 'breaker' ? 5.5 : 6.2).addScaledVector(r, spread);
      // Nudge the spawn out of any obstacle.
      [p.x, p.z] = world.resolve(p.x, p.z, world.height(p.x, p.z), kind === 'breaker' ? 0.6 : 0.5);
      p.y = world.height(p.x, p.z);
      e.object.position.copy(p); e.object.rotation.y = facing + Math.PI;
      scene.add(e.object);
      a.brains.push(new EnemyBrain(e, `${kind}${i}`, a.director, world, rnd));
    });
    return a;
  }

  update(dt: number, player: PlayerView) {
    this.time += dt;
    for (const b of this.brains) if (!b.removed) b.update(dt, this.time, player, this.brains);
  }
}
