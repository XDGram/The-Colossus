import * as THREE from 'three';
import { Dresser, F, flat, handMount, makeMaterials, paint, rngFor } from '../enemies/kit';

/**
 * The protagonist's drawn katana: built at true size on a right-hand mount (local +Y = toward the tip),
 * hidden until drawn. `hilt` and `tip` mark the blade segment for the swept hit test (later stages).
 */
export function buildKatana(model: THREE.Object3D) {
  const rnd = rngFor(5151);
  const d = new Dresser(model, makeMaterials('katana'));
  const mount = handMount(d, 'r');
  const parts: [THREE.BufferGeometry, 'metal' | 'hard' | 'wood'][] = [];
  // Blade: 0.70 m, gentle curve toward the back edge, tapering to a kissaki.
  const bl = new THREE.BoxGeometry(0.0065, 0.7, 0.03, 1, 30, 1).translate(0, 0.07 + 0.35, 0);
  const p = bl.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const y = p.getY(i), t = (y - 0.07) / 0.7;
    const taper = t > 0.9 ? 1 - ((t - 0.9) / 0.1) * 0.8 : 1 - t * 0.15;
    p.setXYZ(i, p.getX(i) * (1 - t * 0.4), y, p.getZ(i) * taper - t * t * 0.03);
  }
  bl.computeVertexNormals();
  parts.push([paint(bl, (q) => (q.z > 0.006 - ((q.y - 0.07) / 0.7) ** 2 * 0.03 ? F.steel : F.iron2), rnd, 0.03), 'metal']);
  parts.push([paint(new THREE.CylinderGeometry(0.042, 0.042, 0.008, 16).translate(0, 0.065, 0), flat(F.iron), rnd), 'metal']);                 // tsuba
  parts.push([paint(new THREE.CylinderGeometry(0.016, 0.017, 0.25, 10).translate(0, -0.06, 0), (q) => (Math.sin(q.y * 120) > 0 ? F.cord.clone().multiplyScalar(0.5) : F.soot2), rnd, 0.04), 'wood']); // tsuka
  parts.push([paint(new THREE.SphereGeometry(0.019, 8, 6).translate(0, -0.19, 0), flat(F.iron), rnd), 'metal']);                               // kashira
  const g = new THREE.Group();
  for (const [geo, m] of parts) { const mesh = new THREE.Mesh(geo, d.mats[m]); mesh.castShadow = true; g.add(mesh); }
  mount.add(g);
  const hilt = new THREE.Object3D(); hilt.position.y = 0.07; mount.add(hilt);
  const tip = new THREE.Object3D(); tip.position.y = 0.77; mount.add(tip);
  mount.visible = false;
  return { mount, hilt, tip };
}
