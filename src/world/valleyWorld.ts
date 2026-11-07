import * as THREE from 'three';
import type { Assets } from '../core/assets';
import type { Atmosphere } from './atmosphere';
import { Terrain, buildFarTerrain } from './terrain';
import { Water } from './water';
import type { Colliders } from './colliders';
import { Ruins } from './ruins';
import { Colossus } from './colossus';
import { ScatterLayer, TreeImpostor, TreeField, Motes, partsOf, placeVegetation } from './vegetation';
import { CardField, crossedCards, flowerCard, grassGenerator, flowerGenerator, bushGeometry, vineGeometry, Birds } from './foliage';
import { COLOSSUS_POS, SITES } from './heightfield';

/**
 * The Forgotten Valley world (terrain, stream, ruins, the Colossus, forest, scatter, foliage). Built as the valley
 * scene at startup, or on demand inside the temple fight as the Warden's realm (src/world/realm.ts), where it lives
 * in its own group with its own colliders and is swapped in and out.
 */
export const VALLEY_MODELS = [
  ...['rock_moss_set_01', 'rock_moss_set_02', 'boulder_01'].flatMap((m) => [m, `${m}_lod1`, `${m}_lod2`]),
  ...['fern_02', 'root_cluster_01', 'tree_stump_01', 'dead_tree_trunk_02', 'dry_branches_medium_01'].flatMap((m) => [m, `${m}_lod1`]),
];
export const VALLEY_TEXTURES = ['ground037', 'grass004', 'ground067', 'rock051', 'rock030', 'rock064', 'bark014'];

export interface ValleyOpts {
  renderer: THREE.WebGLRenderer; assets: Assets; sun: THREE.DirectionalLight; atmo: Atmosphere; colliders: Colliders;
  quality: 'high' | 'low'; parent: THREE.Object3D;
  /** Where the terrain is first built around. */
  center: { x: number; z: number };
  /** Lighter build (realm on Low graphics): no flowers, bushes, ivy or birds, sparser grass. */
  light?: boolean;
  /** Valley scene: tune every loaded model (the realm only tunes the valley's own models). */
  tuneAll?: boolean;
  status?: (s: string) => void;
  /** Build the terrain in small time slices (built while the game runs). */
  sliced?: boolean;
  /** Yield between build steps (keeps the page responsive while it builds). */
  yieldFrame: () => Promise<unknown>;
}

export async function buildValley(o: ValleyOpts) {
  const { renderer, assets, sun, atmo, colliders, quality, parent } = o;
  const hq = quality === 'high' && !o.light;
  const texLoader = new THREE.TextureLoader();
  const foliageTex = async (f: string) => {
    const t = await texLoader.loadAsync(`${import.meta.env.BASE_URL}assets/textures/foliage/${f}`);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  };
  const [grassAtlas, flowerAtlas] = await Promise.all([foliageTex('grass_atlas.webp'), o.light ? Promise.resolve(null) : foliageTex('flowers.webp')]);

  o.status?.('Raising stone');
  await o.yieldFrame();
  const terrain = new Terrain(assets.textures, quality);
  if (o.sliced) await terrain.buildAllAsync(o.center.x, o.center.z, o.yieldFrame); else terrain.buildAll(o.center.x, o.center.z);
  await o.yieldFrame();
  parent.add(terrain.group);
  parent.add(buildFarTerrain(terrain.material));
  const water = new Water();
  parent.add(water.group);
  await o.yieldFrame();
  const ruins = new Ruins(colliders, assets.textures);
  parent.add(ruins.group);

  o.status?.('Waking the giant');
  await o.yieldFrame();
  const colossus = new Colossus(assets.textures);
  parent.add(colossus.root);
  colossus.root.updateMatrixWorld(true);
  parent.add(colossus.buildLandRoots(colliders));

  o.status?.('Growing the forest');
  await o.yieldFrame();
  const impostor = new TreeImpostor(renderer, assets.models.tree_hero, sun, atmo.envMap);
  const veg = placeVegetation(ruins.footprints, colliders);
  const trees = new TreeField(assets.models.tree_hero, impostor, [...veg.trees, ...colossus.backTreeSpots], quality === 'high' ? 95 : 60, quality === 'high' ? 10 : 5, veg.tints);
  parent.add(trees.group);
  await o.yieldFrame();
  const layers: ScatterLayer[] = [];
  const layer = (model: string, nLods: number, mats: THREE.Matrix4[], maxDist: number, lodDist: number[], castShadow = false, chunk = 40) => {
    if (!mats.length) return;
    const names = [model, `${model}_lod1`, `${model}_lod2`].slice(0, nLods);
    const l = new ScatterLayer(names.map((n) => partsOf(assets.models[n])), mats, { maxDist, lodDist, castShadow, chunk });
    layers.push(l);
    parent.add(l.group);
  };
  layer('root_cluster_01', 2, veg.roots, 260, [hq ? 45 : 25], true, 40);
  layer('fern_02', 2, veg.ferns, hq ? 110 : 70, [hq ? 20 : 12], false, 18);
  layer('rock_moss_set_01', 3, veg.rockSets[0], 500, [hq ? 30 : 18, 120], true, 30);
  layer('rock_moss_set_02', 3, veg.rockSets[1], 500, [hq ? 30 : 18, 120], true, 30);
  layer('boulder_01', 3, veg.boulders, 1600, [hq ? 45 : 25, 260], true, 60);
  layer('boulder_01', 3, veg.outcrops, 3000, [hq ? 80 : 50, 500], true, 150);
  layer('dead_tree_trunk_02', 2, veg.logs, 260, [hq ? 30 : 18], true, 40);
  layer('tree_stump_01', 2, veg.stumps, 200, [hq ? 25 : 15], true, 40);
  if (!o.light) layer('dry_branches_medium_01', 2, veg.branches, 70, [hq ? 15 : 8], false, 20);
  const own = new Set([...VALLEY_MODELS, 'tree_hero']);
  for (const [name, m] of Object.entries(assets.models)) {
    if (!o.tuneAll && !own.has(name)) continue;
    if (!o.tuneAll && name === 'tree_hero') continue; // shared with the temple's trees
    m.scene.traverse((ob) => {
      const mesh = ob as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const mat of [mesh.material].flat() as THREE.MeshStandardMaterial[]) {
        mat.envMapIntensity = 0.8;
        if (/boulder|rock_moss|root_cluster|stump|trunk/.test(name)) harmonise(mat, /boulder/.test(name) ? 0.55 : 0.3);
      }
    });
  }
  await o.yieldFrame();
  let leafMat: THREE.MeshStandardMaterial | null = null;
  assets.models.tree_hero.scene.traverse((ob) => { const m = ob as THREE.Mesh; if (m.isMesh && /leaves/i.test((m.material as THREE.Material).name)) leafMat = m.material as THREE.MeshStandardMaterial; });
  const leaf = leafMat as unknown as THREE.MeshStandardMaterial;
  // Bushes: built from the tree's own leaf cards, two LODs.
  if (!o.light) {
    const bushMat = leaf.clone();
    bushMat.onBeforeCompile = () => {};
    bushMat.color = new THREE.Color(0.78, 0.86, 0.66);
    const id = new THREE.Matrix4();
    const lod = (q: number) => [{ geometry: bushGeometry(assets.models.tree_hero, q, 11), material: bushMat, local: id }];
    const l = new ScatterLayer([lod(hq ? 700 : 420), lod(160)], veg.bushes, { maxDist: hq ? 260 : 160, lodDist: [hq ? 40 : 22], castShadow: true, chunk: 40 });
    layers.push(l);
    parent.add(l.group);
  }
  const foliageOpts = { sunDir: atmo.sunDir, sunColor: sun.color, alphaToCoverage: false };
  const grass = new CardField(crossedCards(2), { ...foliageOpts, map: grassAtlas, slots: 4, radius: hq ? 60 : o.light ? 28 : 38, density: hq ? 3.2 : o.light ? 1.3 : 1.8, gen: grassGenerator(ruins.footprints), key: 'grass', wind: 0.35 });
  parent.add(grass.mesh);
  const flowers = flowerAtlas ? new CardField(flowerCard(), { ...foliageOpts, map: flowerAtlas, slots: 4, radius: hq ? 45 : 28, density: hq ? 0.9 : 0.5, gen: flowerGenerator(ruins.footprints), key: 'flowers', wind: 0.12 }) : null;
  if (flowers) parent.add(flowers.mesh);
  const birds = o.light ? null : new Birds([{ x: COLOSSUS_POS.x, z: COLOSSUS_POS.z + 120, y: 230 }, { x: SITES.terrace.x, z: SITES.terrace.z, y: 70 }, { x: SITES.gate.x, z: SITES.gate.z - 80, y: 85 }]);
  if (birds) parent.add(birds.mesh);
  // Ivy on the ruins, from the tree's leaf cards.
  if (!o.light) {
    const ivyMat = leaf.clone();
    ivyMat.onBeforeCompile = () => {};
    ivyMat.color = new THREE.Color(0.62, 0.74, 0.5);
    const ivy = new THREE.Mesh(vineGeometry(assets.models.tree_hero, ruins.vineAnchors), ivyMat);
    ivy.castShadow = true; ivy.receiveShadow = true;
    parent.add(ivy);
  }
  const motes = new Motes();
  parent.add(motes.points);

  return {
    terrain, colossus,
    update(t: number, cp: THREE.Vector3, pp: THREE.Vector3) {
      terrain.update(cp.x, cp.z);
      trees.update(cp);
      for (const l of layers) l.update(cp);
      grass.update(cp);
      flowers?.update(cp);
      colossus.update(t);
      water.update(t);
      birds?.update(t);
      motes.update(t, pp);
    },
  };
}

/** Pulls a scanned asset's albedo toward the valley's muted grey-green stone palette. */
function harmonise(mat: THREE.MeshStandardMaterial, amount: number) {
  if (mat.userData.harmonised) return;
  mat.userData.harmonised = true;
  mat.onBeforeCompile = (sh) => {
    sh.fragmentShader = sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
      {
        float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(l) * vec3(0.93, 0.97, 0.9), ${amount.toFixed(2)});
      }`);
  };
  mat.customProgramCacheKey = () => `harmonise-${amount}`;
}
