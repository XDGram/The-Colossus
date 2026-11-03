// Enemy animation preview (not part of the game): UAL2 combat clips on the Peasant (Ash Runner) and
// Ranger (Iron Breaker) bodies, with placeholder weapons, plus per-frame weapon-tip speed analysis.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { adjustTwoHand, captureHands, smashTilt, DBG, type AdjustInfo } from './twohand';

const W = 640, H = 800;
const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
r.setSize(W, H); r.outputColorSpace = THREE.SRGBColorSpace; r.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(r.domElement);
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x9aa3a8);
scene.add(new THREE.HemisphereLight(0xdfe6ee, 0x4a4036, 1.4));
const sun = new THREE.DirectionalLight(0xffe6c8, 2.4); sun.position.set(2, 4, 3); scene.add(sun);
const grid = new THREE.GridHelper(8, 16, 0x555555, 0x777777); scene.add(grid);
const cam = new THREE.PerspectiveCamera(35, W / H, 0.05, 100);

const gl = new GLTFLoader();
const enc = (p: string) => encodeURI(p).replace(/\[/g, '%5B').replace(/\]/g, '%5D');
const O = '/assets-src/quaternius/outfits/Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/';
const [peasant, ranger, ual2, ual1] = await Promise.all([
  gl.loadAsync(enc(O + 'Male_Peasant.gltf')), gl.loadAsync(enc(O + 'Male_Ranger.gltf')),
  gl.loadAsync('/assets-src/quaternius/ual2/UAL2_Standard.glb'),
  gl.loadAsync(enc('/assets-src/quaternius/ual/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb')),
]);
const clips = [...ual2.animations, ...ual1.animations];
const clipNamed = (n: string) => clips.find((c) => c.name === n)!;

const metal = new THREE.MeshStandardMaterial({ color: 0xc8ccd0, metalness: 0.8, roughness: 0.3 });
const wood = new THREE.MeshStandardMaterial({ color: 0x3d2e22, roughness: 0.8 });
const iron = new THREE.MeshStandardMaterial({ color: 0x3a3a3c, metalness: 0.5, roughness: 0.6 });

type Rig = { adj?: ((clip: string, t: number)=>AdjustInfo); model: THREE.Object3D; mixer: THREE.AnimationMixer; bones: Record<string, THREE.Bone>; tips: { side: 'l' | 'r'; tip: THREE.Object3D }[]; haft?: [THREE.Object3D, THREE.Object3D] };
function makeRig(src: THREE.Object3D, kind: 'runner' | 'breaker'): Rig {
  const model = clone(src); scene.add(model);
  if (kind === 'breaker') model.scale.setScalar(1.15); // uniform: non-uniform scale breaks arm IK lengths
  model.updateMatrixWorld(true);
  const bones: Record<string, THREE.Bone> = {};
  model.traverse((o) => { if ((o as THREE.Bone).isBone) bones[o.name] = o as THREE.Bone; if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).frustumCulled = false; });
  const wp = (n: string) => new THREE.Vector3().setFromMatrixPosition(bones[n].matrixWorld);
  const tips: Rig['tips'] = [];
  // Weapon frame per hand, captured at rest: grip axis runs across the knuckles (index -> pinky).
  const mount = (side: 'l' | 'r') => {
    const hb = bones[`hand_${side}`];
    const ix = wp(`index_01_${side}`), pk = wp(`pinky_01_${side}`), w = wp(`hand_${side}`), md = wp(`middle_01_${side}`);
    const sign = (globalThis as any).__sign ?? 1;
    const axis = ix.clone().sub(pk).normalize().multiplyScalar(sign);
    const grip = ix.clone().add(pk).multiplyScalar(0.5).lerp(md, 0.3).add(w.clone().sub(md).normalize().multiplyScalar(-0.02));
    const g = new THREE.Group(); g.position.copy(grip);
    g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
    scene.add(g); hb.attach(g); return g;
  };
  if (kind === 'runner') {
    // Placeholder head (the Peasant body is headless).
    const hd = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), new THREE.MeshStandardMaterial({ color: 0xddd4c2 }));
    hd.position.copy(wp('Head')).add(new THREE.Vector3(0, 0.09, 0.02)); scene.add(hd); bones['Head'].attach(hd);
    for (const side of ['l', 'r'] as const) {
      const g = mount(side);
      const blade = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.44, 0.035).translate(0, 0.3, 0), metal);
      const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.14).translate(0, 0.01, 0), wood);
      const tip = new THREE.Object3D(); tip.position.y = 0.52;
      g.add(blade, grip, tip); tips.push({ side, tip });
    }
  } else {
    const hands = captureHands(bones);
    const g = mount('r');
    g.scale.setScalar(1 / 1.15); // club at its true size, not the body's scale
    const haft = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.022, 0.85).translate(0, 0.2, 0), wood);
    const head = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.045, 0.9, 8).translate(0, 1.07, 0), iron);
    const tip = new THREE.Object3D(); tip.position.y = 1.5;
    const a = new THREE.Object3D(); a.position.y = -0.2; const b = new THREE.Object3D(); b.position.y = 0.55;
    g.add(haft, head, tip, a, b); tips.push({ side: 'r', tip });
    const rigAdj = { bones, mount: g, tipLen: 1.5, pommelLen: 0.22, clubR: 0.075, spacing: 0.17 };
    return { model, mixer: new THREE.AnimationMixer(model), bones, tips, haft: [a, b], adj: (clip: string, t: number) => adjustTwoHand(rigAdj, hands, 0, (globalThis as any).__noTilt ? 0 : smashTilt(clip, t)), hands } as any;
  }
  return { model, mixer: new THREE.AnimationMixer(model), bones, tips };
}
const rigs = { runner: makeRig(peasant.scene, 'runner'), breaker: makeRig(ranger.scene, 'breaker') };

function pose(rig: Rig, clip: string, t: number) {
  rig.mixer.stopAllAction();
  const a = rig.mixer.clipAction(clipNamed(clip)); a.play(); rig.mixer.setTime(t);
  rig.model.updateMatrixWorld(true);
  lastAdj = rig.adj && !(globalThis as any).__orig ? rig.adj(clip, t) : null;
}
let lastAdj: AdjustInfo | null = null;
{ const q = new URLSearchParams(location.search); if (q.has('orig')) (globalThis as any).__orig = true; }
const show = (which: string) => { rigs.runner.model.visible = which === 'runner'; rigs.breaker.model.visible = which === 'breaker'; };

(window as any).clipNames = () => clips.map((c) => `${c.name}:${c.duration.toFixed(2)}`);
(window as any).shot = (which: 'runner' | 'breaker', clip: string, t: number, yaw = 0, dist = 4.2, h = 1.2, look = 1.0) => {
  show(which); pose(rigs[which], clip, t);
  cam.position.set(Math.sin(yaw) * dist, h, Math.cos(yaw) * dist); cam.lookAt(0, look, 0);
  r.render(scene, cam); return r.domElement.toDataURL('image/jpeg', 0.9);
};
/** Per-frame (30 fps) weapon tip speeds (m/s), tip height, and for the club the left hand's distance from the haft. */
(window as any).analyse = (which: 'runner' | 'breaker', clip: string) => {
  const rig = rigs[which], c = clipNamed(clip), fps = 30, n = Math.round(c.duration * fps);
  const prev: Record<string, THREE.Vector3> = {}, out: any[] = [];
  for (let f = 0; f <= n; f++) {
    pose(rig, clip, f / fps);
    const row: any = { f };
    for (const { side, tip } of rig.tips) {
      const p = new THREE.Vector3().setFromMatrixPosition(tip.matrixWorld);
      row['v' + side] = prev[side] ? +(p.distanceTo(prev[side]) * fps).toFixed(2) : 0; row['y' + side] = +p.y.toFixed(2); prev[side] = p;
    }
    if (rig.haft) {
      const A = new THREE.Vector3().setFromMatrixPosition(rig.haft[0].matrixWorld), B = new THREE.Vector3().setFromMatrixPosition(rig.haft[1].matrixWorld);
      const hl = rig.bones['hand_l']; const L = hl.localToWorld((rig as any).hands.l.off.clone());
      const line = new THREE.Line3(A.clone().lerp(B, -0.1), B), q = new THREE.Vector3(); line.closestPointToPoint(L, true, q);
      row.lgap = +L.distanceTo(q).toFixed(2);
      // Can the left arm reach a grip 15-30 cm below the right hand? (shoulder-to-grip vs arm length)
      const S = new THREE.Vector3().setFromMatrixPosition(rig.bones['upperarm_l'].matrixWorld), E = new THREE.Vector3().setFromMatrixPosition(rig.bones['lowerarm_l'].matrixWorld);
      const reach = S.distanceTo(E) + E.distanceTo(L);
      const G = new THREE.Vector3().lerpVectors(A, B, 0.1);
      row.need = +(S.distanceTo(G) / reach).toFixed(2);
      // Left grip point vs the haft line (the attachment check).
      if (lastAdj) Object.assign(row, lastAdj);
    }
    out.push(row);
  }
  return out;
};
(window as any).dbg = (t: number) => { pose(rigs.breaker, 'Sword_Heavy_Combo', t); return JSON.parse(JSON.stringify({ DBG, lastAdj })); };
document.title = 'ready';
