import * as THREE from 'three';
import type { Assets } from '../core/assets';
import type { Atmosphere } from './atmosphere';
import { Colliders } from './colliders';
import { ground } from './ground';
import { terrainHeight, terrainNormal, waterY } from './heightfield';
import { buildValley, VALLEY_MODELS, VALLEY_TEXTURES } from './valleyWorld';
import type { ThirdPersonCamera } from '../player/camera';
import type { SpiritFx } from '../fx/spirit';

/**
 * The Warden's realm: the boss fight glitches out of the temple into the Forgotten Valley and back. The valley is
 * the existing valley world (src/world/valleyWorld.ts), loaded and built in the background while the waves are
 * fought, kept hidden in its own group with its own colliders, and swapped in by exchanging the shared collider set,
 * the ground functions and which world's objects are visible. The two worlds share coordinates, so only one is ever
 * shown.
 */
export interface RealmDeps {
  scene: THREE.Scene; renderer: THREE.WebGLRenderer; camera: THREE.Camera; assets: Assets; sun: THREE.DirectionalLight;
  atmo: Atmosphere; colliders: Colliders; quality: 'high' | 'low';
  /** Everything the temple put in the scene (hidden while in the valley). */
  temple: THREE.Object3D[];
  tpc: ThirdPersonCamera; spiritFx: SpiritFx | null;
}

/** The duelling ground: an open meadow on the east slope (no ruins, trees or water within 26 m), facing the Colossus. */
export const REALM = { x: 68, z: 148, radius: 22 };

export class WardenRealm {
  readonly root = new THREE.Group();
  ready = false;
  active = false;
  private cols = new Colliders();
  private valley: Awaited<ReturnType<typeof buildValley>> | null = null;
  private saved: { ground: typeof ground; indoors: (() => boolean) | null } | null = null;
  private craterUse: number[] = [];
  private loading: Promise<void> | null = null;
  /** Build progress (tests, diagnostics). */
  stage = 'idle';
  longest = 0;
  readonly steps: number[] = [];

  constructor(private d: RealmDeps) {
    this.root.visible = false;
    this.root.name = 'valley-realm';
  }

  /** Download the valley's models and textures in the background (called when the waves start). Safe to call again. */
  preload() {
    if (!this.fetching) this.fetching = this.d.assets.load(VALLEY_MODELS, VALLEY_TEXTURES).catch((e) => { console.warn('valley assets unavailable', e); throw e; });
    return this.fetching;
  }
  /**
   * Build the valley (CPU heavy: terrain, scatter): done in a lull between waves, when a short hitch can't cost the
   * player anything. Safe to call again.
   */
  build() {
    if (!this.loading) this.loading = this.construct().catch((e) => { console.warn('valley realm unavailable', e); });
    return this.loading;
  }
  private fetching: Promise<void> | null = null;
  private async construct() {
    const d = this.d;
    let mark = performance.now();
    /** Longest main-thread block between yields while building (ms; diagnostics). */
    const idle = async () => { this.longest = Math.max(this.longest, performance.now() - mark); this.steps.push(Math.round(performance.now() - mark)); await new Promise((r) => setTimeout(r, 30)); mark = performance.now(); };
    this.stage = 'assets';
    await this.preload();
    mark = performance.now();
    this.stage = 'build';
    this.d.scene.add(this.root);
    this.valley = await buildValley({ renderer: d.renderer, assets: d.assets, sun: d.sun, atmo: d.atmo, colliders: this.cols, quality: d.quality, parent: this.root,
      center: REALM, light: d.quality === 'low', sliced: true, yieldFrame: idle, status: (m) => { this.stage = m; } });
    this.stage = 'prime';
    // Prime the terrain and scatter around the duelling ground, then compile its shaders while it stays hidden.
    const c = new THREE.Vector3(REALM.x, terrainHeight(REALM.x, REALM.z) + 2, REALM.z);
    this.valley.update(0, c, c);
    await idle();
    this.stage = 'compile';
    this.root.visible = true;
    let done: Promise<unknown> | null = null;
    try { done = d.renderer.compileAsync(this.root, d.camera, d.scene); } catch { /* compiled on first use */ }
    this.root.visible = this.active;
    await done?.catch(() => {});
    this.ready = true;
  }

  /** Swap into the valley. Returns where the player and the Warden stand. */
  enter() {
    if (!this.ready || this.active) return null;
    const d = this.d;
    this.active = true;
    d.colliders.swapWith(this.cols);
    this.saved = { ground: { ...ground }, indoors: d.tpc.isIndoors };
    ground.height = terrainHeight; ground.normal = terrainNormal; ground.water = waterY;
    // The fight stays on the terrace: an invisible edge holds the player in.
    ground.clamp = (x, z) => {
      const dx = x - REALM.x, dz = z - REALM.z, r = Math.hypot(dx, dz);
      return r > REALM.radius ? [REALM.x + (dx / r) * REALM.radius, REALM.z + (dz / r) * REALM.radius] : [x, z];
    };
    ground.solid = (x, y, z) => d.colliders.blocks(x, y, z);
    d.tpc.isIndoors = () => false;
    for (const o of d.temple) o.userData.realmVis = o.visible, o.visible = false;
    this.craterUse = d.spiritFx?.craters.map((c) => c.used) ?? [];
    for (const c of d.spiritFx?.craters ?? []) { c.group.visible = false; c.debris.mesh.visible = false; }
    this.root.visible = true;
    const y = (x: number, z: number) => terrainHeight(x, z);
    return {
      player: new THREE.Vector3(REALM.x, y(REALM.x, REALM.z + 7), REALM.z + 7),
      boss: new THREE.Vector3(REALM.x, y(REALM.x, REALM.z - 6), REALM.z - 6),
    };
  }

  /** Back to the temple: the temple's world, ground and craters return exactly as they were. */
  exit() {
    if (!this.active || !this.saved) return;
    const d = this.d;
    this.active = false;
    d.colliders.swapWith(this.cols);
    Object.assign(ground, this.saved.ground);
    d.tpc.isIndoors = this.saved.indoors;
    for (const o of d.temple) o.visible = o.userData.realmVis ?? true;
    this.root.visible = false;
    // Craters made in the valley stay there; the temple's own come back.
    (d.spiritFx?.craters ?? []).forEach((c, i) => {
      const keep = c.used >= 0 && c.used === this.craterUse[i];
      c.group.visible = keep; c.debris.mesh.visible = keep;
    });
    this.saved = null;
  }

  update(t: number, cp: THREE.Vector3, pp: THREE.Vector3) { if (this.active) this.valley?.update(t, cp, pp); }
}
