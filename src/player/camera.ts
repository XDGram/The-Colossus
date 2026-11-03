import * as THREE from 'three';
import { ground } from '../world/ground';
import type { Input } from '../core/input';

export interface CameraRig {
  distance: number;
  pitch: number;
  pivotHeight: number;
  shoulder: number;
  fov: number;
  /** Framing used while the player is indoors (shorter boom, looking down into the room). */
  indoor?: { distance: number; minPitch: number };
}

/** Original framing, still used by the Forgotten Valley. */
export const VALLEY_RIG: CameraRig = { distance: 4.6, pitch: -0.08, pivotHeight: 1.6, shoulder: 0.42, fov: 55 };

/** Temple framing: player smaller and lower in frame, more ground ahead, full rooflines visible. */
export const TEMPLE_RIG: CameraRig = {
  distance: 5.6, pitch: THREE.MathUtils.degToRad(-12), pivotHeight: 1.75, shoulder: 0.35, fov: 58,
  indoor: { distance: 3.8, minPitch: THREE.MathUtils.degToRad(-25) },
};

/** Third-person orbit camera with smoothing, zoom, shoulder offset and terrain/wall collision. */
export class ThirdPersonCamera {
  yaw = 0;
  pitch = -0.08;
  distance = 4.6;
  private targetDistance = 4.6;
  private pivot = new THREE.Vector3();
  private currentDist = 4.6;
  private indoorBlend = 0;
  sensitivity = 0.0023;
  rig: CameraRig = VALLEY_RIG;
  /** Returns true when the player is inside a building (set by the active scene). */
  isIndoors: (() => boolean) | null = null;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  setRig(rig: CameraRig) {
    this.rig = rig;
    this.pitch = rig.pitch;
    this.distance = this.targetDistance = this.currentDist = rig.distance;
    this.applyFov();
  }

  /** Narrow landscape (phones) gets a slightly wider lens so the player doesn't dominate. */
  applyFov() {
    const narrow = innerHeight < 500 && innerWidth > innerHeight;
    this.camera.fov = this.rig.fov + (narrow && this.rig !== VALLEY_RIG ? 4 : 0);
    this.camera.updateProjectionMatrix();
  }

  snap(target: THREE.Vector3) {
    this.pivot.copy(target).add(new THREE.Vector3(0, this.rig.pivotHeight, 0));
    this.currentDist = this.distance;
  }

  update(dt: number, input: Input, target: THREE.Vector3, speed: number) {
    const look = input.consumeLook();
    this.yaw -= look.x * this.sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch - look.y * this.sensitivity, -1.1, 0.55);
    this.targetDistance = THREE.MathUtils.clamp(this.targetDistance + look.zoom * 0.6, 2.4, 9);
    this.distance = THREE.MathUtils.lerp(this.distance, this.targetDistance, 1 - Math.exp(-8 * dt));

    // Indoors: ease to a shorter boom and a steeper look-down (without overriding the player's own look).
    const ind = this.rig.indoor;
    const inside = !!ind && !!this.isIndoors?.();
    this.indoorBlend = THREE.MathUtils.lerp(this.indoorBlend, inside ? 1 : 0, 1 - Math.exp(-4 * dt));
    const pitch = ind ? Math.min(this.pitch, THREE.MathUtils.lerp(this.pitch, ind.minPitch, this.indoorBlend)) : this.pitch;
    const boom = ind ? THREE.MathUtils.lerp(this.distance, Math.min(this.distance, ind.distance), this.indoorBlend) : this.distance;

    // Pivot trails the player slightly; a touch of extra distance when sprinting sells speed.
    const desiredPivot = target.clone().add(new THREE.Vector3(0, this.rig.pivotHeight, 0));
    this.pivot.lerp(desiredPivot, 1 - Math.exp(-14 * dt));
    const dist = boom + Math.max(0, speed - 4.5) * 0.18;

    const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(this.yaw) * Math.cos(pitch));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const base = this.pivot.clone().addScaledVector(right, this.rig.shoulder);

    // Collision: march along the boom and stop short of the ground and solid walls.
    let allowed = dist;
    for (let i = 1; i <= 16; i++) {
      const d = (dist * i) / 16;
      const p = base.clone().addScaledVector(dir, d);
      if (p.y < ground.height(p.x, p.z) + 0.35 || ground.solid?.(p.x, p.y, p.z)) { allowed = Math.max(0.8, d - dist / 16); break; }
    }
    this.currentDist = allowed < this.currentDist ? allowed : THREE.MathUtils.lerp(this.currentDist, allowed, 1 - Math.exp(-4 * dt));
    const pos = base.clone().addScaledVector(dir, this.currentDist);
    pos.y = Math.max(pos.y, ground.height(pos.x, pos.z) + 0.3);
    this.camera.position.copy(pos);
    this.camera.lookAt(this.pivot.clone().addScaledVector(right, this.rig.shoulder).add(new THREE.Vector3(0, 0.05, 0)));
  }
}
