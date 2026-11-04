import * as THREE from 'three';
import { Assets } from './core/assets';
import { Input } from './core/input';
import { loadAtmosphere, installFogChunks, FOG } from './world/atmosphere';
import { Terrain, buildFarTerrain } from './world/terrain';
import { Water } from './world/water';
import { Colliders } from './world/colliders';
import { Ruins } from './world/ruins';
import { Colossus } from './world/colossus';
import { ScatterLayer, TreeImpostor, TreeField, Motes, partsOf, placeVegetation, setVegetationTime } from './world/vegetation';
import { Player } from './player/player';
import { Post } from './core/post';
import { mulberry32 } from './core/noise';
import { buildTemple, templeHeight } from './temple/compound';
import { applyTempleMaterials } from './temple/materials';
import { SunBeams } from './temple/light';
import { CardField, crossedCards, flowerCard, grassGenerator, flowerGenerator, bushGeometry, vineGeometry, Birds, setFoliageTime } from './world/foliage';
import { ThirdPersonCamera, TEMPLE_RIG } from './player/camera';
import { Mentor } from './player/mentorNpc';
import type { PlayerCombat } from './player/combat';
import { ground } from './world/ground';
import { PLAY, COLOSSUS_POS, SITES, terrainHeight } from './world/heightfield';

type Quality = 'high' | 'low';
const params = new URLSearchParams(location.search);
const quality: Quality = (params.get('quality') as Quality) || (localStorage.getItem('tlc-quality') as Quality) || 'high';
const debug = params.has('debug');
// The temple compound is in development; the valley stays the default until it is approved.
const sceneName = params.get('scene') === 'temple' ? 'temple' : 'valley';

const ui = {
  loader: document.getElementById('loader')!,
  bar: document.getElementById('bar') as HTMLElement,
  status: document.getElementById('status')!,
  title: document.getElementById('title')!,
  hint: document.getElementById('hint')!,
  fps: document.getElementById('fps')!,
  quality: document.getElementById('quality')!,
};

async function main() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, quality === 'high' ? 1.5 : 1));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  renderer.shadowMap.enabled = true;
  renderer.info.autoReset = false;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  document.getElementById('app')!.appendChild(renderer.domElement);

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.25, 9500);
  const scene = new THREE.Scene();

  // ---- loading ----
  let pHdr = 0, pAssets = 0;
  const progress = () => {
    const p = pHdr * 0.25 + pAssets * 0.65;
    ui.bar.style.width = `${(p * 100).toFixed(0)}%`;
  };
  ui.status.textContent = 'Gathering the sky';
  const atmo = await loadAtmosphere(renderer, `${import.meta.env.BASE_URL}assets/hdri/sky_2k.hdr`, (p) => { pHdr = p; progress(); }, sceneName === 'temple' ? 22 : undefined,
    // Temple: sun low behind the main hall (north-east), backlighting the roofs and throwing long shadows
    // down the courtyard toward the gate.
    sceneName === 'temple' ? Math.atan2(-0.82, 0.57) : undefined);
  pHdr = 1; progress();
  // Clear-day aerial perspective: soft sky-blue haze, warming toward the sun.
  atmo.fogColor.lerp(new THREE.Color(0.55, 0.68, 0.86), 0.35).multiplyScalar(0.85);
  const sunFog = atmo.fogColor.clone().lerp(new THREE.Color(1.0, 0.84, 0.62), 0.5);
  installFogChunks(atmo.sunDir, sunFog, atmo.fogColor);

  ui.status.textContent = 'Unearthing the valley';
  const assets = new Assets(renderer, (p) => { pAssets = p; progress(); });
  await assets.load(
    [
      'tree_hero', 'ranger',
      ...['rock_moss_set_01', 'rock_moss_set_02', 'boulder_01'].flatMap((m) => [m, `${m}_lod1`, `${m}_lod2`]),
      ...['fern_02', 'root_cluster_01', 'tree_stump_01', 'dead_tree_trunk_02', 'dry_branches_medium_01'].flatMap((m) => [m, `${m}_lod1`]),
    ],
    ['ground037', 'grass004', 'ground067', 'rock051', 'rock030', 'rock064', 'bark014',
      ...(sceneName === 'temple' ? ['ceramic_roof_01', 'brown_planks_07', 'clay_plaster', 'cobblestone_floor_03', 'wood_planks_grey'] : [])],
  );
  const texLoader = new THREE.TextureLoader();
  const foliageTex = async (f: string) => {
    const t = await texLoader.loadAsync(`${import.meta.env.BASE_URL}assets/textures/foliage/${f}`);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  };
  const [grassAtlas, flowerAtlas] = await Promise.all([foliageTex('grass_atlas.webp'), foliageTex('flowers.webp')]);

  // ---- sky & light ----
  scene.background = atmo.background;
  // three.js inverts background/environment rotation internally for render-target cube maps.
  scene.backgroundRotation.set(0, -atmo.backgroundRotationY, 0);
  scene.backgroundIntensity = 0.95;
  scene.environment = atmo.envMap;
  scene.environmentRotation.set(0, -atmo.backgroundRotationY, 0);
  scene.environmentIntensity = 0.55;
  // Linear Fog used as a per-frame uniform carrier: near = height-fog density, far = time (see atmosphere.ts).
  const fog = new THREE.Fog(atmo.fogColor.getHex(), FOG.density, 0);
  fog.color.copy(atmo.fogColor);
  scene.fog = fog;

  // Warm key light; the sky supplies cool blue fill in the shadows.
  const sun = new THREE.DirectionalLight(atmo.sunColor.clone().lerp(new THREE.Color(1, 0.84, 0.64), 0.5), 4.4);
  sun.castShadow = true;
  const SH = quality === 'high' ? 70 : 50;
  sun.shadow.mapSize.setScalar(quality === 'high' ? 4096 : 2048);
  Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 600 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  // ---- world ----
  const colliders = new Colliders();
  let worldUpdate: (t: number, cam: THREE.Vector3, pl: THREE.Vector3) => void;
  let startPos: { x: number; z: number };
  let startYaw: number;
  let configureCamera: (c: ThirdPersonCamera, p: Player) => void = () => {};
  sun.position.copy(atmo.sunDir).multiplyScalar(300);
  sun.target.position.set(0, 0, 0);
  const templeLayers: ScatterLayer[] = [];
  if (sceneName === 'temple') {
    ui.status.textContent = 'Raising the temple';
    await frame();
    applyTempleMaterials(assets.textures);
    // Golden-hour key light for the temple: warmer and stronger, with cooler sky fill.
    sun.color.setRGB(1.0, 0.8, 0.52);
    sun.intensity = 5.0;
    scene.environmentIntensity = 0.62;
    renderer.toneMappingExposure = 1.0;
    const temple = buildTemple(colliders, quality);
    fog.near = FOG.density * 0.45; // crisper, brighter air than the valley
    scene.add(temple.group);
    const impostor = new TreeImpostor(renderer, assets.models.tree_hero, sun, atmo.envMap);
    // Over-range tint (instance colours are floats): leaf luminance x 2.6 x this lands on bright ginkgo gold.
    const GINKGO = new THREE.Color(2.7, 1.95, 0.32);
    const trees = new TreeField(assets.models.tree_hero, impostor, temple.treeSpots, quality === 'high' ? 95 : 60, quality === 'high' ? 10 : 5, temple.treeGold.map((g) => (g ? GINKGO : null)));
    trees.enableTint();
    scene.add(trees.group);
    const motes = new Motes();
    scene.add(motes.points);
    startPos = temple.start;
    configureCamera = (c, p) => { c.setRig(TEMPLE_RIG); c.isIndoors = () => temple.isInside(p.position); };
    startYaw = temple.startYaw;
    // Volumetric sun beams through the gaps: beside the courtyard trees, between the hall and corridors,
    // through the gate and across the side paths.
    const beams = new SunBeams(atmo.sunDir, [
      { x: -20, y: 0, z: -30, r: 2.6 }, { x: 20, y: 0, z: -40, r: 3.2 }, { x: -22, y: 0, z: 36, r: 2.4 }, { x: 24, y: 0, z: 33, r: 2.8 },
      { x: -8, y: 0, z: -14, r: 1.8 }, { x: 10, y: 0, z: 2, r: 2.2 }, { x: -4, y: 0, z: 20, r: 1.6 }, { x: 16, y: 0, z: 18, r: 2.0 },
      { x: 0, y: 0, z: 49, r: 2.2 }, { x: -30, y: 0, z: -6, r: 1.8 }, { x: 28, y: 0, z: -20, r: 2.4 }, { x: 6, y: 0, z: -30, r: 1.6 },
    ]);
    scene.add(beams.mesh);
    // Rock outcrops breaking the hillsides around the settlement.
    {
      const rocks: THREE.Matrix4[] = [];
      const rr = mulberry32(5150);
      for (let i = 0; i < 400 && rocks.length < 110; i++) {
        const a = rr() * Math.PI * 2, d = 140 + rr() * 420, x = Math.cos(a) * d * 1.2, z = -20 + Math.sin(a) * d;
        const n = (() => { const e = 3, hx = templeHeight(x + e, z) - templeHeight(x - e, z), hz = templeHeight(x, z + e) - templeHeight(x, z - e); return 2 * e / Math.hypot(hx, 2 * e, hz); })();
        if (n > 0.93) continue;
        const sc = 4 + rr() * 14;
        rocks.push(new THREE.Matrix4().compose(new THREE.Vector3(x, templeHeight(x, z) - sc * 0.45, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rr() * 0.4, rr() * 6, rr() * 0.4)), new THREE.Vector3(sc, sc * 0.8, sc)));
      }
      const l = new ScatterLayer(['boulder_01', 'boulder_01_lod1', 'boulder_01_lod2'].map((n) => partsOf(assets.models[n])), rocks, { maxDist: 2000, lodDist: [60, 300], castShadow: false, chunk: 120 });
      scene.add(l.group);
      templeLayers.push(l);
    }
    scene.backgroundIntensity = 1.05;
    let lastT = 0;
    worldUpdate = (t, cp, pp) => {
      trees.update(cp); temple.update(cp, pp); beams.update(t);
      for (const l of templeLayers) l.update(cp);
      temple.falling.update(Math.min(0.1, t - lastT), t, pp, templeHeight);
      lastT = t;
    };
  } else {
  ui.status.textContent = 'Raising stone';
  await frame();
  const terrain = new Terrain(assets.textures, quality);
  terrain.buildAll(PLAY.start.x, PLAY.start.z);
  scene.add(terrain.group);
  scene.add(buildFarTerrain(terrain.material));
  const water = new Water();
  scene.add(water.group);
  const ruins = new Ruins(colliders, assets.textures);
  scene.add(ruins.group);

  ui.status.textContent = 'Waking the giant';
  await frame();
  const colossus = new Colossus(assets.textures);
  scene.add(colossus.root);
  colossus.root.updateMatrixWorld(true);
  scene.add(colossus.buildLandRoots(colliders));

  ui.status.textContent = 'Growing the forest';
  await frame();
  const impostor = new TreeImpostor(renderer, assets.models.tree_hero, sun, atmo.envMap);
  const veg = placeVegetation(ruins.footprints, colliders);
  const trees = new TreeField(assets.models.tree_hero, impostor, [...veg.trees, ...colossus.backTreeSpots], quality === 'high' ? 95 : 60, quality === 'high' ? 10 : 5, veg.tints);
  scene.add(trees.group);
  const layers: ScatterLayer[] = [];
  const layer = (model: string, nLods: number, mats: THREE.Matrix4[], maxDist: number, lodDist: number[], castShadow = false, chunk = 40) => {
    if (!mats.length) return;
    const names = [model, `${model}_lod1`, `${model}_lod2`].slice(0, nLods);
    const l = new ScatterLayer(names.map((n) => partsOf(assets.models[n])), mats, { maxDist, lodDist, castShadow, chunk });
    layers.push(l);
    scene.add(l.group);
  };
  const hq = quality === 'high';
  layer('root_cluster_01', 2, veg.roots, 260, [hq ? 45 : 25], true, 40);
  layer('fern_02', 2, veg.ferns, hq ? 110 : 70, [hq ? 20 : 12], false, 18);
  layer('rock_moss_set_01', 3, veg.rockSets[0], 500, [hq ? 30 : 18, 120], true, 30);
  layer('rock_moss_set_02', 3, veg.rockSets[1], 500, [hq ? 30 : 18, 120], true, 30);
  layer('boulder_01', 3, veg.boulders, 1600, [hq ? 45 : 25, 260], true, 60);
  layer('boulder_01', 3, veg.outcrops, 3000, [hq ? 80 : 50, 500], true, 150);
  layer('dead_tree_trunk_02', 2, veg.logs, 260, [hq ? 30 : 18], true, 40);
  layer('tree_stump_01', 2, veg.stumps, 200, [hq ? 25 : 15], true, 40);
  layer('dry_branches_medium_01', 2, veg.branches, 70, [hq ? 15 : 8], false, 20);
  for (const [name, m] of Object.entries(assets.models)) m.scene.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const mat of [mesh.material].flat() as THREE.MeshStandardMaterial[]) {
      mat.envMapIntensity = 0.8;
      if (/boulder|rock_moss|root_cluster|stump|trunk/.test(name)) harmonise(mat, /boulder/.test(name) ? 0.55 : 0.3);
    }
  });
  // Bushes: built from the tree's own leaf cards, two LODs.
  {
    let leafMat: THREE.MeshStandardMaterial | null = null;
    assets.models.tree_hero.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && /leaves/i.test((m.material as THREE.Material).name)) leafMat = m.material as THREE.MeshStandardMaterial; });
    const bushMat = (leafMat as unknown as THREE.MeshStandardMaterial).clone();
    bushMat.onBeforeCompile = () => {};
    bushMat.color = new THREE.Color(0.78, 0.86, 0.66);
    const id = new THREE.Matrix4();
    const lod = (q: number) => [{ geometry: bushGeometry(assets.models.tree_hero, q, 11), material: bushMat, local: id }];
    const l = new ScatterLayer([lod(hq ? 700 : 420), lod(160)], veg.bushes, { maxDist: hq ? 260 : 160, lodDist: [hq ? 40 : 22], castShadow: true, chunk: 40 });
    layers.push(l);
    scene.add(l.group);
  }
  const foliageOpts = { sunDir: atmo.sunDir, sunColor: sun.color, alphaToCoverage: false };
  const grass = new CardField(crossedCards(2), { ...foliageOpts, map: grassAtlas, slots: 4, radius: hq ? 60 : 38, density: hq ? 3.2 : 1.8, gen: grassGenerator(ruins.footprints), key: 'grass', wind: 0.35 });
  const flowers = new CardField(flowerCard(), { ...foliageOpts, map: flowerAtlas, slots: 4, radius: hq ? 45 : 28, density: hq ? 0.9 : 0.5, gen: flowerGenerator(ruins.footprints), key: 'flowers', wind: 0.12 });
  scene.add(grass.mesh, flowers.mesh);
  const birds = new Birds([{ x: COLOSSUS_POS.x, z: COLOSSUS_POS.z + 120, y: 230 }, { x: SITES.terrace.x, z: SITES.terrace.z, y: 70 }, { x: SITES.gate.x, z: SITES.gate.z - 80, y: 85 }]);
  scene.add(birds.mesh);
  // Ivy on the ruins, from the tree's leaf cards.
  {
    let leafMat: THREE.MeshStandardMaterial | null = null;
    assets.models.tree_hero.scene.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && /leaves/i.test((m.material as THREE.Material).name)) leafMat = m.material as THREE.MeshStandardMaterial; });
    const ivyMat = (leafMat as unknown as THREE.MeshStandardMaterial).clone();
    ivyMat.onBeforeCompile = () => {};
    ivyMat.color = new THREE.Color(0.62, 0.74, 0.5);
    const ivy = new THREE.Mesh(vineGeometry(assets.models.tree_hero, ruins.vineAnchors), ivyMat);
    ivy.castShadow = true;
    ivy.receiveShadow = true;
    scene.add(ivy);
  }
  const motes = new Motes();
  scene.add(motes.points);

    startPos = PLAY.start;
    startYaw = Math.atan2(-(COLOSSUS_POS.x - PLAY.start.x), -(COLOSSUS_POS.z - PLAY.start.z));
    worldUpdate = (t, cp, pp) => {
      terrain.update(cp.x, cp.z);
      trees.update(cp);
      for (const l of layers) l.update(cp);
      grass.update(cp);
      flowers.update(cp);
      colossus.update(t);
      water.update(t);
      birds.update(t);
      motes.update(t, pp);
    };
  }

  // ---- player ----
  const input = new Input(renderer.domElement);
  const player = new Player(assets.models.ranger, colliders, startPos);
  scene.add(player.object);
  const tpc = new ThirdPersonCamera(camera);
  configureCamera(tpc, player);
  tpc.yaw = startYaw;
  if (sceneName !== 'temple') tpc.pitch = -0.02;
  player.setFacing(tpc.yaw + Math.PI);
  tpc.snap(player.position);

  // The mentor exists only in the temple opening: at the protagonist's right shoulder, a half step
  // ahead, both facing the main gate as the invasion comes in. Not a companion; no other scene loads him.
  let mentor: Mentor | null = null;
  if (sceneName === 'temple') {
    ui.status.textContent = 'Summoning the mentor';
    await frame();
    mentor = await Mentor.load(import.meta.env.BASE_URL);
    // Facing +z (the gate); right of the player as seen from behind is -x.
    const mx = startPos.x - 2.0, mz = startPos.z + 0.6;
    const my = Math.max(ground.height(mx, mz), colliders.floorAt(mx, mz, ground.height(mx, mz) + 2.5));
    mentor.place(mx, my, mz, -0.12, colliders);
    scene.add(mentor.object);
  }
  // Player combat kit (temple only; the valley keeps exploration-only controls).
  let combat: PlayerCombat | null = null;
  if (sceneName === 'temple') {
    const [{ PlayerCombat }, { GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
      import('./player/combat'), import('three/examples/jsm/loaders/GLTFLoader.js'), import('three/examples/jsm/libs/meshopt_decoder.module.js')]);
    const lib = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(`${import.meta.env.BASE_URL}assets/models/enemies.glb`);
    combat = new PlayerCombat(player, lib.animations);
  }
  // Shared hit detection (Stage 2A): the player is a target; the player's katana sweeps every frame of an active cut.
  // Nothing consumes hit events yet (enemy reactions and damage come in later stages).
  let hitWorld: import('./combat/hits').HitWorld | null = null;
  const hitEvents: import('./combat/hits').HitEvent[] = [];
  if (combat) {
    const { HitWorld, BODY } = await import('./combat/hits');
    hitWorld = new HitWorld(colliders);
    hitWorld.addTarget({ id: 'player', capsule: () => ({ base: player.position.clone(), ...BODY.player }), active: () => combat!.state !== 'dead' });
  }
  // Dev-only behaviour arena (temple, ?combat=r2b1): enemy movement, spacing and attack permissions. No damage.
  let arena: import('./combat/arena').CombatArena | null = null;
  if (sceneName === 'temple' && params.has('combat')) {
    const { CombatArena } = await import('./combat/arena');
    arena = await CombatArena.create(params.get('combat') || 'r2b1', scene, import.meta.env.BASE_URL,
      { height: (x, z) => Math.max(ground.height(x, z), colliders.floorAt(x, z, ground.height(x, z) + 0.6)), resolve: (x, z, y, r) => colliders.resolve(x, z, y, r),
        // Line of sight for warnings: sampled every 0.15 m against colliders (and the camera's solid test, e.g. roofs).
        lineBlocked: (a, b) => {
          const d = a.distanceTo(b), dir = b.clone().sub(a).normalize();
          for (let s = 0.2; s < d - 0.25; s += 0.15) { const p = a.clone().addScaledVector(dir, s); if (colliders.blocks(p.x, p.y, p.z) || ground.solid?.(p.x, p.y, p.z)) return true; }
          return false;
        } },
      camera, player.position.clone(), player.facing, +(params.get('seed') || 1),
      () => (mentor ? [{ base: mentor.object.position.clone(), radius: 0.42, bottom: 0.1, top: 1.85 }] : []));
  }
  // Combat loop (Stage 2C): hits, damage, health and reactions between the player and the arena's enemies.
  let combatSystem: import('./combat/system').CombatSystem | null = null;
  if (arena && combat && hitWorld) {
    const { CombatSystem } = await import('./combat/system');
    combatSystem = new CombatSystem(hitWorld, player, combat, arena.brains);
    const home = player.position.clone(), homeYaw = player.facing;
    combatSystem.onRestart = () => { player.teleport(home.x, home.z); player.setFacing(homeYaw); arena!.reset(); };
  }
  // Development showcase of the invaders (temple only, ?enemies): no AI or combat.
  let enemyShowcase: import('./enemies/showcase').EnemyShowcase | null = null;
  if (sceneName === 'temple' && params.has('enemies')) {
    const { EnemyShowcase } = await import('./enemies/showcase');
    enemyShowcase = await EnemyShowcase.create(scene, import.meta.env.BASE_URL, (x, z) => ground.height(x, z), [
      { x: startPos.x - 1.2, z: startPos.z + 5.0, yaw: Math.PI }, { x: startPos.x + 2.4, z: startPos.z + 5.6, yaw: Math.PI },
    ]);
  }

  ui.status.textContent = 'Preparing shaders';
  await frame();
  const updateWorld = (t: number) => worldUpdate(t, camera.position, player.position);
  const post = new Post(renderer, scene, camera, quality, atmo.sunDir);
  if (sceneName === 'temple') {
    post.rays.uniforms.uIntensity.value = 0.5;
    if (post.bloom) { post.bloom.strength = 0.22; post.bloom.threshold = 0.95; }
  }
  tpc.update(0.016, input, player.position, 0);
  updateWorld(0);
  await renderer.compileAsync(scene, camera);

  // ---- loop ----
  ui.loader.classList.add('done');
  ui.title.classList.add('show');
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    ui.title.classList.remove('show');
    ui.hint.classList.add('show');
    setTimeout(() => ui.hint.classList.remove('show'), 9000);
    input.lock();
  };
  renderer.domElement.addEventListener('click', () => (started ? input.lock() : start()));
  ui.title.addEventListener('click', start);
  addEventListener('keydown', (e) => {
    if (!started && (e.code === 'Enter' || e.code === 'Space')) start();
    if (e.code === 'KeyG') {
      localStorage.setItem('tlc-quality', quality === 'high' ? 'low' : 'high');
      location.reload();
    }
    if (e.code === 'F3') { ui.fps.classList.toggle('show'); e.preventDefault(); }
  });
  ui.quality.textContent = `Graphics: ${quality === 'high' ? 'High' : 'Low'} (G to change)`;
  if (debug) ui.fps.classList.add('show');

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    post.resize(innerWidth, innerHeight);
    tpc.applyFov();
  });

  const clock = new THREE.Clock();
  let t = 0, frames = 0, fpsTime = 0, fps = 0;
  const sunOffset = atmo.sunDir.clone().multiplyScalar(300);
  const texel = (SH * 2) / sun.shadow.mapSize.x;
  const stats = { fps: 0, calls: 0, tris: 0 };

  let paused = false;
  let debugCam: [number[], [number, number, number]] | null = null;
  const update = (dt: number) => {
    t += dt;
    combat?.preUpdate(dt, input, tpc.yaw, started);
    player.update(dt, input, tpc.yaw, started);
    combat?.postUpdate(dt);
    if (hitWorld && combat && !combatSystem) {
      hitWorld.beginFrame();
      const a = combat.activeAttack;
      if (a) for (const e of hitWorld.sweepWeapon(a.key, 'player', { hilt: a.hilt, tip: a.tip, radius: 0.03 }, combat.chest(), { hilt: a.prevHilt, tip: a.prevTip })) { hitEvents.push(e); if (hitEvents.length > 64) hitEvents.shift(); }
    }
    mentor?.update(dt);
    enemyShowcase?.update(dt);
    arena?.update(dt, { position: player.position, facing: player.facing, radius: 0.38, attackKey: combat?.state === 'attack' ? `p${combat.attackInstance}` : null, mash: combat?.mashScore() ?? 0 });
    combatSystem?.update(dt);
    if (debugCam) { camera.position.fromArray(debugCam[0]); camera.lookAt(...debugCam[1]); }
    else tpc.update(dt, input, player.position, Math.hypot(player.velocity.x, player.velocity.z));
    setVegetationTime(t);
    setFoliageTime(t);
    fog.far = t;
    updateWorld(t);
    // Shadow frustum follows the player, snapped to texels to prevent shimmering.
    const c = player.position;
    sun.target.position.set(Math.round(c.x / texel) * texel, Math.round(c.y / texel) * texel, Math.round(c.z / texel) * texel);
    sun.position.copy(sun.target.position).add(sunOffset);
  };

  const tick = () => {
    const dt = Math.min(clock.getDelta(), 1 / 20);
    if (!paused) {
      update(dt);
      renderer.info.reset();
      post.render();
    }
    frames++; fpsTime += dt;
    if (fpsTime > 0.5) {
      fps = frames / fpsTime; frames = 0; fpsTime = 0;
      stats.fps = fps; stats.calls = renderer.info.render.calls; stats.tris = renderer.info.render.triangles;
      ui.fps.textContent = `${fps.toFixed(0)} fps · ${stats.calls} draws · ${(stats.tris / 1e6).toFixed(2)}M tris`;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  requestAnimationFrame(tick);

  // Hooks used by automated playtests and screenshot capture.
  Object.assign(window, {
    __tlc: {
      ready: true, stats, start, player, mentor, enemies: () => enemyShowcase, combat: () => combat, hits: () => hitWorld, hitEvents, arena: () => arena, combatSystem: () => combatSystem, tpc, input, renderer, scene, camera, post,
      pause: (p: boolean) => { paused = p; renderer.domElement.style.visibility = p ? 'hidden' : 'visible'; },
      /** Deterministic capture for automated tests: simulate n frames, render once, return a JPEG data URL. */
      step: (n: number, dt = 1 / 30, capture = true) => {
        for (let i = 0; i < n; i++) update(dt);
        if (!capture) return { url: '', ms: 0 };
        for (let i = 0; i < 40; i++) updateWorld(t);
        const t0 = performance.now();
        renderer.info.reset();
        post.render();
        renderer.getContext().finish();
        stats.calls = renderer.info.render.calls; stats.tris = renderer.info.render.triangles;
        return { url: renderer.domElement.toDataURL('image/jpeg', 0.92), ms: performance.now() - t0 };
      },
      teleport: (x: number, z: number) => { player.teleport(x, z); tpc.snap(player.position); },
      view: (yaw: number, pitch: number, dist?: number) => { tpc.yaw = yaw; tpc.pitch = pitch; if (dist) tpc.distance = dist; },
      ground: terrainHeight,
      colliders,
      debugCam: (pos: number[] | null, look?: [number, number, number]) => { debugCam = pos ? [pos, look!] : null; },
      atmo: { sunDir: atmo.sunDir.toArray(), sunColor: atmo.sunColor.toArray(), fog: atmo.fogColor.toArray(), sunFog: atmo.sunFogColor.toArray(), rot: atmo.backgroundRotationY },
    },
  });
  document.title = 'The Last Colossus — The Forgotten Valley';
}

const frame = () => new Promise((r) => requestAnimationFrame(() => r(null)));

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

main().catch((e) => {
  console.error(e);
  ui.status.textContent = `Something went wrong: ${e?.message ?? e}`;
});
