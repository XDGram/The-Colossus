// Character preview harness (not part of the game): renders the dressed protagonist in poses.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { dressWarrior } from '../../src/player/armour';

const W = 700, H = 900;
const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
r.setSize(W, H); r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping; r.toneMappingExposure = 0.95;
r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(r.domElement);
const scene = new THREE.Scene();
const cam = new THREE.PerspectiveCamera(30, W / H, 0.1, 100);
const hdr = await new RGBELoader().loadAsync('/assets/hdri/sky_2k.hdr');
hdr.mapping = THREE.EquirectangularReflectionMapping;
const pm = new THREE.PMREMGenerator(r);
scene.environment = pm.fromEquirectangular(hdr).texture;
scene.environmentIntensity = 0.55;
scene.background = new THREE.Color(0x8d9aa3);
const sun = new THREE.DirectionalLight(0xffe0b8, 3.4);
sun.position.set(3, 4, 2.5); sun.castShadow = true; sun.shadow.mapSize.setScalar(2048);
Object.assign(sun.shadow.camera, { left: -2, right: 2, top: 2, bottom: -2 });
scene.add(sun);
const ground = new THREE.Mesh(new THREE.CircleGeometry(4, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x3d4a2c, roughness: 1 }));
ground.receiveShadow = true; scene.add(ground);

const gltf = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync('/assets/models/ranger.glb');
const model = clone(gltf.scene);
scene.add(model);
model.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; (o as THREE.Mesh).frustumCulled = false; } });
const plain = new URLSearchParams(location.search).has('plain');
if (!plain) dressWarrior(model);
const mixer = new THREE.AnimationMixer(model);

(window as any).shot = (clip: string, time: number, yaw: number, dist = 3.4, h = 1.0, look = 0.95) => {
  mixer.stopAllAction();
  const a = mixer.clipAction(gltf.animations.find((c) => c.name === clip)!);
  a.play(); mixer.setTime(time);
  cam.position.set(Math.sin(yaw) * dist, h, Math.cos(yaw) * dist);
  cam.lookAt(0, look, 0);
  r.render(scene, cam);
  return r.domElement.toDataURL('image/jpeg', 0.92);
};
document.title = 'ready';
