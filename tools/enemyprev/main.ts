// Enemy preview (not part of the game): the real game Enemy classes on a plain stage, for animation
// strips and grip/clipping/hit-reach checks.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { Enemy } from '../../src/enemies/enemy';

const W = 640, H = 800;
const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
r.setSize(W, H); r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping;
r.shadowMap.enabled = true;
document.body.appendChild(r.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x9aa3a8);
scene.add(new THREE.HemisphereLight(0xdfe6ee, 0x4a4036, 1.3));
const sun = new THREE.DirectionalLight(0xffe6c8, 2.6); sun.position.set(2, 5, 4); sun.castShadow = true;
Object.assign(sun.shadow.camera, { left: -3, right: 3, top: 3, bottom: -3 }); sun.shadow.mapSize.setScalar(2048); scene.add(sun);
const floor = new THREE.Mesh(new THREE.CircleGeometry(8, 48).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x6b6862, roughness: 1 }));
floor.receiveShadow = true; scene.add(floor);
scene.add(new THREE.GridHelper(8, 16, 0x555555, 0x777777));
const cam = new THREE.PerspectiveCamera(35, W / H, 0.05, 100);

const gl = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
const [lib, ranger] = await Promise.all([gl.loadAsync('/assets/models/enemies.glb'), gl.loadAsync('/assets/models/ranger.glb')]);
const E = { runner: new Enemy('runner', lib, lib.animations), breaker: new Enemy('breaker', ranger, lib.animations) };
for (const e of Object.values(E)) scene.add(e.object);

const show = (k: string) => { E.runner.object.visible = k === 'runner' || k === 'both'; E.breaker.object.visible = k === 'breaker' || k === 'both'; };
const place = (k: string) => {
  E.runner.object.position.set(k === 'both' ? -0.7 : 0, 0, 0); E.breaker.object.position.set(k === 'both' ? 0.8 : 0, 0, 0);
  for (const e of Object.values(E)) { e.object.rotation.y = 0; e.pivot.position.set(0, 0, 0); e.pivot.rotation.y = 0; }
};
const poseAt = (e: Enemy, move: string, t: number) => { place(''); e.play(move as never, 0); e.time = t; e.pose(); };

(window as any).shot = (k: 'runner' | 'breaker' | 'both', move: string, t: number, yaw = 0, dist = 4.4, h = 1.3, look = 1.0, move2?: string, t2?: number) => {
  show(k);
  if (k === 'both') { place('both'); for (const [e, m, tt] of [[E.runner, move, t], [E.breaker, move2 ?? move, t2 ?? t]] as const) { e.play(m as never, 0); e.time = tt; e.pose(); } }
  else poseAt(E[k], move, t);
  cam.position.set(Math.sin(yaw) * dist, h, Math.cos(yaw) * dist); cam.lookAt(0, look, 0);
  r.render(scene, cam); return r.domElement.toDataURL('image/jpeg', 0.9);
};
/** Per frame at 30 fps: grip error, club penetration, club tip height (Breaker), and weapon-tip reach for hits. */
(window as any).analyse = (k: 'runner' | 'breaker', move: string) => {
  const e = E[k], n = Math.round(e.duration(move) * 30), out: any[] = [];
  const tips: THREE.Object3D[] = [];
  e.model.traverse((o) => { if (o.type === 'Object3D' && o.parent && (o.parent as any).type === 'Group' && o.position.y > 0.4 && !o.children.length) tips.push(o); });
  for (let f = 0; f <= n; f++) {
    poseAt(e, move, f / 30);
    e.object.updateMatrixWorld(true);
    const row: any = { f, t: +(f / 30).toFixed(3) };
    if (e.lastGrip) Object.assign(row, { err: +e.lastGrip.err.toFixed(4), pen: +e.lastGrip.pen.toFixed(4), tipY: +e.lastGrip.tipY.toFixed(3), pull: +e.lastGrip.pull.toFixed(2) });
    row.reach = +Math.max(...tips.map((tp) => { const p = new THREE.Vector3().setFromMatrixPosition(tp.matrixWorld); return Math.hypot(p.x, p.z); })).toFixed(2);
    row.ang = tips.map((tp) => { const p = new THREE.Vector3().setFromMatrixPosition(tp.matrixWorld); return +(Math.atan2(p.x, p.z) * 180 / Math.PI).toFixed(0); });
    row.minY = +Math.min(...tips.map((tp) => new THREE.Vector3().setFromMatrixPosition(tp.matrixWorld).y)).toFixed(2);
    out.push(row);
  }
  return out;
};
(window as any).bone = (k: 'runner' | 'breaker', move: string, t: number, names: string[]) => { const e = E[k]; poseAt(e, move, t); e.object.updateMatrixWorld(true); return names.map((n) => new THREE.Vector3().setFromMatrixPosition(e.bones[n].matrixWorld).toArray().map((v) => +v.toFixed(3))); };
/** Transition test: play `a` for 0.6 s, cross-fade into `b`, step at 30 fps; report grip/penetration and any NaN. */
(window as any).transition = (k: 'runner' | 'breaker', a: string, b: string, steps = 30) => {
  const e = E[k]; place(''); e.play(a as never, 0); for (let i = 0; i < 18; i++) e.update(1 / 30);
  e.play(b as never, 0.2); const out: any[] = [];
  for (let i = 0; i < steps; i++) {
    e.update(1 / 30); let nan = false;
    for (const bn of Object.values(e.bones)) if (!isFinite(bn.quaternion.x + bn.position.x)) nan = true;
    out.push({ i, move: e.move, err: e.lastGrip ? +(e.lastGrip.err * 1000).toFixed(1) : null, pen: e.lastGrip ? +(e.lastGrip.pen * 1000).toFixed(1) : null, nan });
  }
  return out;
};
(window as any).info = () => ({ runner: Object.keys(E.runner.moves), breaker: Object.keys(E.breaker.moves) });
document.title = 'ready';
