import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { terrainHeight, terrainNormal, waterY, PLAY, valleyAxis } from '../world/heightfield';
import type { Colliders } from '../world/colliders';
import type { Input } from '../core/input';
import { dressWarrior } from './armour';

const SPEED = { walk: 1.6, jog: 4.3, sprint: 7.2 };
// Native ground speeds of the in-place clips, used to scale playback and avoid foot sliding.
const CLIP_SPEED = { walk: 1.45, jog: 3.9, sprint: 6.4 };
const RADIUS = 0.38;
const MAX_SLOPE_Y = Math.cos(THREE.MathUtils.degToRad(40));

export class Player {
  readonly object = new THREE.Group();
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  private vy = 0;
  private yaw = Math.PI;
  private mixer: THREE.AnimationMixer;
  private actions: Record<'idle' | 'walk' | 'jog' | 'sprint', THREE.AnimationAction>;
  inWater = 0;

  constructor(gltf: GLTF, private colliders: Colliders, start: { x: number; z: number }) {
    const model = cloneSkinned(gltf.scene);
    // Armour is built in the rest pose and parented to bones, before any animation runs.
    dressWarrior(model);
    const seen = new Set<THREE.Material>();
    model.traverse((o) => {
      const m = o as THREE.SkinnedMesh;
      if (!m.isMesh) return;
      m.castShadow = true;
      m.receiveShadow = true;
      m.frustumCulled = false;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats as THREE.MeshStandardMaterial[]) if (!seen.has(mat)) { seen.add(mat); addSunRim(mat); }
    });
    this.object.add(model);
    this.mixer = new THREE.AnimationMixer(model);
    const clip = (n: string) => this.mixer.clipAction(gltf.animations.find((a) => a.name === n)!);
    this.actions = { idle: clip('Idle_Loop'), walk: clip('Walk_Loop'), jog: clip('Jog_Fwd_Loop'), sprint: clip('Sprint_Loop') };
    for (const a of Object.values(this.actions)) { a.play(); a.setEffectiveWeight(0); }
    this.actions.idle.setEffectiveWeight(1);
    this.position.set(start.x, terrainHeight(start.x, start.z), start.z);
    this.object.position.copy(this.position);
    this.object.rotation.y = this.yaw;
  }

  get facing() { return this.yaw; }
  setFacing(yaw: number) { this.yaw = yaw; this.object.rotation.y = yaw; }

  teleport(x: number, z: number) {
    this.position.set(x, terrainHeight(x, z), z);
    this.velocity.set(0, 0, 0);
  }

  update(dt: number, input: Input, camYaw: number, enabled: boolean) {
    const ax = enabled ? input.axis() : { x: 0, y: 0, mag: 0 };
    // Camera-relative intent: camera looks along -Z rotated by camYaw.
    const fwd = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw));
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x);
    const wish = fwd.multiplyScalar(ax.y).add(right.multiplyScalar(ax.x));
    const moving = wish.lengthSq() > 0;
    if (moving) wish.normalize();

    let speed = input.sprint ? SPEED.sprint : input.walk ? SPEED.walk : SPEED.jog;
    if (ax.mag < 1) speed = THREE.MathUtils.lerp(SPEED.walk, speed, THREE.MathUtils.smoothstep(ax.mag, 0.35, 0.9));
    // Wading through the stream slows you down.
    const wy = waterY(this.position.z);
    const depth = Math.max(0, wy - this.position.y);
    this.inWater = depth;
    if (depth > 0.05) speed *= THREE.MathUtils.lerp(0.75, 0.45, Math.min(1, depth / 0.8));

    const target = wish.multiplyScalar(speed);
    const accel = moving ? (input.sprint ? 12 : 16) : 20;
    const k = 1 - Math.exp(-accel * dt * 0.5);
    this.velocity.x += (target.x - this.velocity.x) * k;
    this.velocity.z += (target.z - this.velocity.z) * k;

    // Proposed move, with slope limiting: you can't walk up anything steeper than MAX_SLOPE.
    let nx = this.position.x + this.velocity.x * dt;
    let nz = this.position.z + this.velocity.z * dt;
    const n = terrainNormal(nx, nz, 0.5);
    if (n[1] < MAX_SLOPE_Y) {
      const uphill = -(this.velocity.x * n[0] + this.velocity.z * n[2]);
      if (uphill > 0) {
        // Remove the uphill component (slide along the contour).
        const l = Math.hypot(n[0], n[2]);
        const ux = -n[0] / l, uz = -n[2] / l;
        const along = this.velocity.x * ux + this.velocity.z * uz;
        this.velocity.x -= ux * along;
        this.velocity.z -= uz * along;
        nx = this.position.x + this.velocity.x * dt;
        nz = this.position.z + this.velocity.z * dt;
      }
    }
    [nx, nz] = this.colliders.resolve(nx, nz, this.position.y, RADIUS);
    // Soft bounds of the explorable area.
    nz = THREE.MathUtils.clamp(nz, PLAY.minZ, PLAY.maxZ);
    const ax0 = valleyAxis(nz);
    nx = THREE.MathUtils.clamp(nx, ax0 - 380, ax0 + 380);

    // Ground: terrain or a walkable stone surface.
    const ground = Math.max(terrainHeight(nx, nz), this.colliders.surfaceAt(nx, nz, this.position.y, RADIUS));
    const actual = (nx - this.position.x) / Math.max(dt, 1e-4);
    const actualZ = (nz - this.position.z) / Math.max(dt, 1e-4);
    this.velocity.x = actual; this.velocity.z = actualZ;
    this.position.x = nx; this.position.z = nz;
    if (ground >= this.position.y - 0.05) {
      // Step up smoothly onto higher ground.
      this.position.y = THREE.MathUtils.lerp(this.position.y, ground, 1 - Math.exp(-25 * dt));
      if (ground - this.position.y < 0.02) this.position.y = ground;
      this.vy = 0;
    } else {
      // Fall (or follow the slope down) under gravity.
      this.vy -= 22 * dt;
      this.position.y = Math.max(ground, this.position.y + this.vy * dt);
      if (this.position.y === ground) this.vy = 0;
    }

    // Face movement direction.
    const hs = Math.hypot(this.velocity.x, this.velocity.z);
    if (hs > 0.3) {
      const targetYaw = Math.atan2(this.velocity.x, this.velocity.z);
      let d = targetYaw - this.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.yaw += d * (1 - Math.exp(-12 * dt));
    }
    this.object.position.copy(this.position);
    this.object.rotation.y = this.yaw;
    this.animate(dt, hs);
  }

  private animate(dt: number, s: number) {
    // Blend weights across the locomotion speed axis: idle -> walk -> jog -> sprint.
    const pts: [keyof typeof this.actions, number][] = [['idle', 0], ['walk', SPEED.walk], ['jog', SPEED.jog], ['sprint', SPEED.sprint]];
    const w: Record<string, number> = { idle: 0, walk: 0, jog: 0, sprint: 0 };
    if (s <= 0.15) w.idle = 1;
    else if (s >= SPEED.sprint) w.sprint = 1;
    else for (let i = 0; i < pts.length - 1; i++) {
      const [a, va] = pts[i], [b, vb] = pts[i + 1];
      if (s >= va && s <= vb) { const t = (s - va) / (vb - va); w[a] = 1 - t; w[b] = t; }
    }
    for (const k of Object.keys(this.actions) as (keyof typeof this.actions)[]) {
      const a = this.actions[k];
      a.setEffectiveWeight(THREE.MathUtils.lerp(a.getEffectiveWeight(), w[k], 1 - Math.exp(-14 * dt)));
      if (k !== 'idle') a.setEffectiveTimeScale(THREE.MathUtils.clamp(s / CLIP_SPEED[k], 0.6, 1.5));
    }
    // Keep moving clips phase-synchronised so blends don't scissor the legs.
    const lead = w.sprint > 0.5 ? this.actions.sprint : w.jog > 0.5 ? this.actions.jog : this.actions.walk;
    const phase = lead.time / lead.getClip().duration;
    for (const k of ['walk', 'jog', 'sprint'] as const) {
      const a = this.actions[k];
      if (a !== lead) a.time = phase * a.getClip().duration;
    }
    this.mixer.update(dt);
  }
}

/** Chains a warm "catching the sun" rim onto a material's existing shader patch (outfit recolour, armour). */
function addSunRim(mat: THREE.MeshStandardMaterial) {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey();
  mat.onBeforeCompile = (sh, r) => {
    prev.call(mat, sh, r);
    sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      #ifdef USE_FOG
      {
        vec3 sunV = normalize((viewMatrix * vec4(ATMO_SUN_DIR, 0.0)).xyz);
        vec3 nV = normalize(vNormal);
        float rim = pow(1.0 - max(dot(nV, normalize(vViewPosition)), 0.0), 2.5);
        float facing = max(dot(nV, sunV), 0.0);
        float lit = smoothstep(0.5, 0.95, cloudLight(vFogWorldPos));
        totalEmissiveRadiance += max(diffuseColor.rgb, vec3(0.03)) * vec3(1.0, 0.78, 0.5) * (rim * (0.35 + 0.9 * facing) * 1.4 + facing * 0.12) * lit;
      }
      #endif`);
  };
  mat.customProgramCacheKey = () => `${prevKey}|sunrim`;
}
