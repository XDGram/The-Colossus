import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/**
 * Performance: binds a character's rigid bone-attached parts (armour plates, straps, hat, scanned head…) into ONE
 * skinned mesh per material on the character's own skeleton, with rigid weights (each vertex follows the bone it hung
 * from). The result looks and animates exactly the same, but a fully dressed character costs one draw call per
 * material instead of one per (bone, material) piece, in the colour pass and again in the shadow pass.
 *
 * Kept as separate objects (untouched): anything not directly under a bone (weapon mounts, blades, katana groups),
 * hidden meshes, multi-material or morphing meshes, and parts whose visibility the game toggles (`skip`).
 *
 * Bind space: a vertex v of a rigid mesh under bone B ends up at  boneWorld(B) · local(mesh) · v. A skinned vertex p
 * (bindMatrix = identity, attached mode) ends up at  boneWorld(B) · boneInverse(B) · p, so p = inverse(boneInverse(B)) ·
 * local(mesh) · v.
 */
export function skinRigidParts(model: THREE.Object3D, skip?: (o: THREE.Object3D) => boolean) {
  model.updateMatrixWorld(true);
  let skeleton: THREE.Skeleton | null = null, host: THREE.Object3D | null = null;
  model.traverse((o) => { const m = o as THREE.SkinnedMesh; if (!skeleton && m.isSkinnedMesh && m.visible) { skeleton = m.skeleton; host = m.parent; } });
  if (!skeleton || !host) return { before: 0, after: 0 };
  const sk = skeleton as THREE.Skeleton;
  const index = new Map<THREE.Object3D, number>(sk.bones.map((b, i) => [b, i]));
  const groups = new Map<string, { mat: THREE.Material; geos: THREE.BufferGeometry[]; meshes: THREE.Mesh[]; cast: boolean; recv: boolean }>();
  model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh || !m.visible || !m.parent || !index.has(m.parent)) return;
    if (Array.isArray(m.material) || skip?.(m)) return;
    const g = m.geometry;
    if (Object.keys(g.morphAttributes).length) return;
    const bi = index.get(m.parent)!;
    m.updateMatrix();
    const M = new THREE.Matrix4().copy(sk.boneInverses[bi]).invert().multiply(m.matrix);
    const gg = g.clone().applyMatrix4(M);
    const n = gg.getAttribute('position').count;
    const si = new Uint16Array(n * 4), sw = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { si[i * 4] = bi; sw[i * 4] = 1; }
    gg.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(si, 4));
    gg.setAttribute('skinWeight', new THREE.Float32BufferAttribute(sw, 4));
    const key = `${m.material.uuid}|${Object.keys(gg.attributes).sort().join(',')}|${gg.index ? 'i' : 'n'}`;
    const grp = groups.get(key) ?? groups.set(key, { mat: m.material, geos: [], meshes: [], cast: false, recv: false }).get(key)!;
    grp.geos.push(gg); grp.meshes.push(m); grp.cast ||= m.castShadow; grp.recv ||= m.receiveShadow;
  });
  let after = 0;
  const done = new Set<THREE.Mesh>();
  for (const [key, grp] of groups) {
    const geo = mergeGeometries(grp.geos, false);
    if (!geo) continue;     // incompatible attributes: leave these parts as they were
    const sm = new THREE.SkinnedMesh(geo, grp.mat);
    sm.name = `skinned-parts:${key.split('|')[0].slice(0, 8)}`;
    sm.bind(sk, new THREE.Matrix4());
    sm.castShadow = grp.cast; sm.receiveShadow = grp.recv; sm.frustumCulled = false;
    (host as THREE.Object3D).add(sm);
    after++;
    for (const m of grp.meshes) done.add(m);
  }
  for (const m of done) { m.parent?.remove(m); m.geometry.dispose(); }
  return { before: done.size, after };
}

/**
 * Performance: inside rigid groups (weapons: the Breaker's studded club, blades, katanas), merges sibling meshes
 * that share a material into one mesh in the group's own space. The group keeps its transform and visibility toggles,
 * so drawing / sheathing and grip IK are unaffected; a studded club goes from dozens of draw calls to one per material.
 * Bones are skipped (their pieces are handled by skinRigidParts), as are skinned, hidden and multi-material meshes.
 */
export function mergeStaticSiblings(root: THREE.Object3D) {
  let before = 0, after = 0;
  const visit = (node: THREE.Object3D) => {
    for (const c of [...node.children]) visit(c);
    if ((node as THREE.Bone).isBone) return;
    const groups = new Map<string, THREE.Mesh[]>();
    for (const c of node.children) {
      const m = c as THREE.Mesh;
      if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh || !m.visible || Array.isArray(m.material) || m.children.length || Object.keys(m.geometry.morphAttributes).length) continue;
      const key = `${m.material.uuid}|${Object.keys(m.geometry.attributes).sort().join(',')}|${m.geometry.index ? 'i' : 'n'}|${m.name}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(m);
    }
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const geo = mergeGeometries(list.map((m) => { m.updateMatrix(); return m.geometry.clone().applyMatrix4(m.matrix); }), false);
      if (!geo) continue;
      const first = list[0], mesh = new THREE.Mesh(geo, first.material);
      mesh.name = first.name; mesh.castShadow = list.some((m) => m.castShadow); mesh.receiveShadow = list.some((m) => m.receiveShadow);
      mesh.frustumCulled = list.every((m) => m.frustumCulled); mesh.renderOrder = first.renderOrder;
      node.add(mesh);
      for (const m of list) { node.remove(m); m.geometry.dispose(); }
      before += list.length; after++;
    }
  };
  visit(root);
  return { before, after };
}
