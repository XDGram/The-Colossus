import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Enemy } from '../enemies/enemy';
import { AttackDirector } from './director';
import { EnemyBrain, type PlayerView, type WorldQuery } from './brain';
import { WardenBrain, type BossCtx } from '../boss/warden';
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
  // Kept for spawning enemies later (encounter waves).
  private assets!: { lib: import('three/examples/jsm/loaders/GLTFLoader.js').GLTF; ranger: import('three/examples/jsm/loaders/GLTFLoader.js').GLTF; warden: Awaited<ReturnType<typeof loadWardenAssets>> | null };
  private scene!: THREE.Scene; private world!: WorldQuery; private rnd!: () => number; private serial = 0;
  /** Called when an enemy is spawned / cleared (the combat system registers targets). */
  onSpawn: ((b: EnemyBrain) => void) | null = null;
  onClear: ((b: EnemyBrain) => void) | null = null;

  private constructor(visible: (pts: { x: number; y: number; z: number }[], requester: string) => boolean) { this.director = new AttackDirector(visible); }

  static async create(spec: string, scene: THREE.Scene, base: string, world: WorldQuery & { lineBlocked(a: THREE.Vector3, b: THREE.Vector3): boolean }, camera: THREE.PerspectiveCamera, origin: THREE.Vector3, facing: number, seed = 1,
    occluders: () => Capsule[] = () => [],
    /** Models the game has already loaded (the animation library and the base body): not fetched or parsed again. */
    preloaded?: { lib?: import('three/examples/jsm/loaders/GLTFLoader.js').GLTF; ranger?: import('three/examples/jsm/loaders/GLTFLoader.js').GLTF }) {
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
    const [lib, ranger] = await Promise.all([preloaded?.lib ?? gl.loadAsync(`${base}assets/models/enemies.glb`), preloaded?.ranger ?? gl.loadAsync(`${base}assets/models/ranger.glb`)]);
    const runners = +(spec.match(/r(\d)/)?.[1] ?? 0), breakers = +(spec.match(/b(\d)/)?.[1] ?? 0), wardens = +(spec.match(/w(\d)/)?.[1] ?? 0);
    const warden = wardens || spec === 'encounter' ? await loadWardenAssets(base) : null;
    const rnd = mulberry32(seed);
    a.assets = { lib, ranger, warden }; a.scene = scene; a.world = world; a.rnd = rnd;
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
      a.brains.push(a.brainFor(e, `${kind}${i}`));
      a.spawns.push({ p: p.clone(), yaw: facing + Math.PI });
    });
    return a;
  }

  /** Spawn one enemy at a position, facing `yaw` (encounter waves). */
  spawn(kind: 'runner' | 'breaker' | 'warden', p: THREE.Vector3, yaw: number) {
    const { lib, ranger, warden } = this.assets;
    const e = kind === 'warden' ? new Enemy(kind, warden!.body, lib.animations, warden!.scan) : new Enemy(kind, kind === 'runner' ? lib : ranger, lib.animations);
    const q = p.clone(); q.y = this.world.height(q.x, q.z);
    e.object.position.copy(q); e.object.rotation.y = yaw; e.groundY = q.y;
    this.scene.add(e.object);
    const b = this.brainFor(e, `${kind}#${++this.serial}`);
    this.brains.push(b); this.spawns.push({ p: q.clone(), yaw });
    this.onSpawn?.(b);
    return b;
  }
  /** Shared services for the Temple Warden boss (spells, effects, summons, sound); filled in by the game. */
  readonly bossCtx: BossCtx = { spells: null, vfx: null, summon: null, sound: null };
  /** The Warden gets the boss brain; everyone else the standard one. */
  private brainFor(e: Enemy, id: string) {
    if (e.kind !== 'warden') return new EnemyBrain(e, id, this.director, this.world, this.rnd);
    const w = new WardenBrain(e, id, this.director, this.world, this.rnd); w.ctx = this.bossCtx; return w;
  }
  /** Remove every enemy (encounter restart). */
  clear() {
    for (const b of this.brains) { this.director.release(b.id); this.scene.remove(b.e.object); b.removed = true; this.onClear?.(b); b.dispose(); }
    this.brains.length = 0; this.spawns.length = 0;
  }

  /** Respawn every enemy at its spawn point (after the player's defeat). */
  reset() { this.brains.forEach((b, i) => b.revive(this.spawns[i].p, this.spawns[i].yaw)); }

  update(dt: number, player: PlayerView) {
    this.time += dt;
    for (const b of this.brains) if (!b.removed) b.update(dt, this.time, player, this.brains);
  }
}
