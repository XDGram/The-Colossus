// Mentor preview harness (not part of the game): renders the mentor, optionally beside the protagonist.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { dressMentor, type HeadScan } from '../../src/player/mentor';
import { dressWarrior } from '../../src/player/armour';

const W = 700, H = 900;
{ const q = new URLSearchParams(location.search); if (q.get('curl')) (globalThis as any).__curl = +q.get('curl')!; if (q.get('axis')) (globalThis as any).__curlAxis = q.get('axis')!.split(',').map(Number); }
const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
r.setSize(W, H); r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 0.95;
r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(r.domElement);
const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(30, W / H, 0.05, 100);
const hdr = await new RGBELoader().loadAsync('/assets/hdri/sky_2k.hdr');
hdr.mapping = THREE.EquirectangularReflectionMapping;
scene.environment = new THREE.PMREMGenerator(r).fromEquirectangular(hdr).texture;
scene.environmentIntensity = 0.55;
scene.background = new THREE.Color(0x8d9aa3);
// Low, warm key from the front-side so the face reads beneath the hat brim.
const sun = new THREE.DirectionalLight(0xffe0b8, 3.4);
sun.position.set(2.2, 2.6, 3.2); sun.castShadow = true; sun.shadow.mapSize.setScalar(2048); sun.shadow.bias = -0.0003;
Object.assign(sun.shadow.camera, { left: -2.5, right: 2.5, top: 2.5, bottom: -2.5 });
scene.add(sun);
const ground = new THREE.Mesh(new THREE.CircleGeometry(5, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3d4a2c, roughness: 1 }));
ground.receiveShadow = true; scene.add(ground);

const gl = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const enc = (p: string) => encodeURI(p).replace(/\[/g, '%5B').replace(/\]/g, '%5D');
const [peasant, lib, ranger] = await Promise.all([
  gl.loadAsync(enc('/assets-src/quaternius/outfits/Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Male_Peasant.gltf')),
  gl.loadAsync(enc('/assets-src/quaternius/ual/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb')),
  gl.loadAsync('/assets/models/ranger.glb'),
]);
const setup = (m: THREE.Object3D) => m.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = o.receiveShadow = true; (o as THREE.Mesh).frustumCulled = false; } });

// Scanned head (Lee Perry-Smith / Infinite-Realities, CC BY 3.0), aged in the shader: greyer, sun-worn skin.
const tl = new THREE.TextureLoader();
const base = '/assets-src/heads/lee-perry-smith/';
const [col, nor] = await Promise.all([tl.loadAsync(base + 'Map-COL.jpg'), tl.loadAsync(base + 'Infinite-Level_02_Tangent_SmoothUV.jpg')]);
col.colorSpace = THREE.SRGBColorSpace; col.flipY = false; nor.flipY = false;
const headGltf = await gl.loadAsync(base + 'LeePerrySmith.glb');
let headGeo: THREE.BufferGeometry | null = null;
headGltf.scene.traverse((o) => { if ((o as THREE.Mesh).isMesh) headGeo = (o as THREE.Mesh).geometry; });
const headMat = new THREE.MeshStandardMaterial({ map: col, normalMap: nor, normalScale: new THREE.Vector2(1.6, 1.6), roughness: 0.62 });
headMat.onBeforeCompile = (sh) => {
  sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
    { float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
      // Dark hair, brows and stubble in the scan turn grey; skin weathered toward a sun-worn tan.
      float hairMask = 1.0 - smoothstep(0.1, 0.26, l);
      vec3 skin = mix(diffuseColor.rgb, vec3(l) * vec3(1.1, 0.82, 0.64), 0.4) * vec3(0.86, 0.74, 0.64);
      diffuseColor.rgb = mix(skin, vec3(0.5, 0.49, 0.47), hairMask * 0.85); }`);
};
const scan: HeadScan | undefined = new URLSearchParams(location.search).has('procedural') ? undefined : { geometry: headGeo!, material: headMat };
const mentor = clone(peasant.scene); setup(mentor); scene.add(mentor);
const rig = dressMentor(mentor, scan);
const mixer = new THREE.AnimationMixer(mentor);
const hero = clone(ranger.scene); setup(hero); dressWarrior(hero); hero.visible = false; scene.add(hero);
const heroMixer = new THREE.AnimationMixer(hero);

(window as any).shot = (clip: string, time: number, yaw: number, dist = 3.6, h = 1.0, look = 0.95, drawn = false, lineup = false) => {
  mixer.stopAllAction(); heroMixer.stopAllAction();
  const guard = clip === 'GUARD';
  const a = mixer.clipAction(lib.animations.find((c) => c.name === (guard ? 'Idle_Loop' : clip))!);
  a.play(); mixer.setTime(time);
  rig.applyPosture();
  rig.setDrawn(drawn);
  if (guard) rig.applyGuard();

  hero.visible = lineup;
  mentor.position.x = lineup ? -0.55 : 0;
  if (lineup) { hero.position.x = 0.55; heroMixer.clipAction(ranger.animations.find((c) => c.name === 'Idle_Loop')!).play(); heroMixer.setTime(0.5); }
  cam.position.set(Math.sin(yaw) * dist, h, Math.cos(yaw) * dist);
  cam.lookAt(0, look, 0);
  r.render(scene, cam);
  return r.domElement.toDataURL('image/jpeg', 0.92);
};
(window as any).dbg = () => {
  mixer.stopAllAction(); const a = mixer.clipAction(lib.animations.find((c) => c.name === 'Idle_Loop')!); a.play(); mixer.setTime(0.5);
  rig.applyPosture(); rig.applyGuard(); mentor.updateMatrixWorld(true);
  const out: Record<string, number[]> = {};
  mentor.traverse((o) => { if (/^(hand_[lr]|upperarm_[lr]|lowerarm_[lr])$/.test(o.name)) out[o.name] = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).toArray().map((v) => +v.toFixed(3)); });
  // Blade tip vs grip in world: find the longest metal mesh under hand_r.
  mentor.traverse((o) => { if (o.name === 'hand_r') o.traverse((m: any) => { if (m.isMesh && m.geometry) { m.geometry.computeBoundingBox(); const bb = m.geometry.boundingBox; const a = bb.min.clone().applyMatrix4(m.matrixWorld), b = bb.max.clone().applyMatrix4(m.matrixWorld); out['bb_' + m.material.name + '_' + m.id] = [...a.toArray(), ...b.toArray()].map((v) => +v.toFixed(2)); } }); });
  return out;
};
document.title = 'ready';
