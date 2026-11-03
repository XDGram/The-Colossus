import * as THREE from 'three';
import { ground } from '../world/ground';
import type { Input } from '../core/input';

/** Third-person orbit camera with smoothing, zoom, shoulder offset and terrain collision. */
export class ThirdPersonCamera {
  yaw = 0;
  pitch = -0.08;
  distance = 4.6;
  private targetDistance = 4.6;
  private pivot = new THREE.Vector3();
  private currentDist = 4.6;
  sensitivity = 0.0023;

  constructor(readonly camera: THREE.PerspectiveCamera) {}

  snap(target: THREE.Vector3) {
    this.pivot.copy(target).add(new THREE.Vector3(0, 1.6, 0));
    this.currentDist = this.distance;
  }

  update(dt: number, input: Input, target: THREE.Vector3, speed: number) {
    const look = input.consumeLook();
    this.yaw -= look.x * this.sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch - look.y * this.sensitivity, -1.1, 0.55);
    this.targetDistance = THREE.MathUtils.clamp(this.targetDistance + look.zoom * 0.6, 2.4, 9);
    this.distance = THREE.MathUtils.lerp(this.distance, this.targetDistance, 1 - Math.exp(-8 * dt));

    // Pivot trails the player slightly; a touch of extra distance when sprinting sells speed.
    const desiredPivot = target.clone().add(new THREE.Vector3(0, 1.6, 0));
    this.pivot.lerp(desiredPivot, 1 - Math.exp(-14 * dt));
    const dist = this.distance + Math.max(0, speed - 4.5) * 0.18;

    const dir = new THREE.Vector3(Math.sin(this.yaw) * Math.cos(this.pitch), -Math.sin(this.pitch), Math.cos(this.yaw) * Math.cos(this.pitch));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const base = this.pivot.clone().addScaledVector(right, 0.42);

    // Terrain collision: march along the boom and stop short of the ground.
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
    this.camera.lookAt(this.pivot.clone().addScaledVector(right, 0.42).add(new THREE.Vector3(0, 0.05, 0)));
  }
}
