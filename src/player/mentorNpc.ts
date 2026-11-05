// The mentor as he appears in the temple opening: the approved preview model, standing in his
// two-handed guard over the idle animation. Static NPC only (no AI, combat or dialogue yet).
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { dressMentor, type MentorRig } from './mentor';
import type { Colliders } from '../world/colliders';

/** Loads the older warrior's body (Peasant + idle) and his aged head scan. Shared by the mentor NPC and the Temple Warden. */
export async function loadWardenAssets(base: string) {
  const gl = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const tl = new THREE.TextureLoader();
  const [body, head, col, nor] = await Promise.all([
    gl.loadAsync(`${base}assets/models/mentor.glb`),
    gl.loadAsync(`${base}assets/models/mentor_head/head.glb`),
    tl.loadAsync(`${base}assets/models/mentor_head/color.webp`),
    tl.loadAsync(`${base}assets/models/mentor_head/normal.webp`),
  ]);
  col.colorSpace = THREE.SRGBColorSpace; col.flipY = false; nor.flipY = false;
  let geometry: THREE.BufferGeometry | null = null;
  head.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) geometry = (o as THREE.Mesh).geometry; });
  // Scan aged in the shader: hair and stubble grey, skin weathered (same as the approved preview).
  const material = new THREE.MeshStandardMaterial({ map: col, normalMap: nor, normalScale: new THREE.Vector2(1.6, 1.6), roughness: 0.62 });
  material.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      { float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        float hairMask = 1.0 - smoothstep(0.1, 0.26, l);
        vec3 skin = mix(diffuseColor.rgb, vec3(l) * vec3(1.1, 0.82, 0.64), 0.4) * vec3(0.86, 0.74, 0.64);
        diffuseColor.rgb = mix(skin * 0.92, vec3(0.5, 0.49, 0.47), hairMask * 0.85); }`);
  };
  return { body, scan: { geometry: geometry!, material } };
}

export class Mentor {
  readonly object = new THREE.Group();
  private mixer!: THREE.AnimationMixer;
  private rig!: MentorRig;

  static async load(base: string) {
    const { body, scan } = await loadWardenAssets(base);
    const m = new Mentor();
    const model = clone(body.scene);
    m.object.add(model);
    m.rig = dressMentor(model, scan);
    model.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = o.receiveShadow = true; (o as THREE.Mesh).frustumCulled = false; } });
    m.mixer = new THREE.AnimationMixer(model);
    const idle = m.mixer.clipAction(body.animations.find((a) => a.name === 'Idle_Loop')!);
    idle.play();
    // Offset his breathing from the protagonist's so the two don't move in lockstep.
    m.mixer.setTime(1.3);
    m.rig.setDrawn(true);
    m.pose();
    return m;
  }

  place(x: number, y: number, z: number, yaw: number, colliders: Colliders) {
    this.object.position.set(x, y, z);
    this.object.rotation.y = yaw;
    colliders.addCircle(x, z, 0.42, y - 0.5, y + 2.0);
  }

  private pose() {
    this.rig.applyPosture();
    this.rig.applyGuard();
  }

  update(dt: number) {
    this.mixer.update(dt);
    this.object.updateMatrixWorld(true);
    this.pose();
  }
}
