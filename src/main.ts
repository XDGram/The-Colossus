import * as THREE from 'three';
import { Assets } from './core/assets';
import { Input } from './core/input';
import { loadAtmosphere, installFogChunks, FOG } from './world/atmosphere';
import { Terrain, buildFarTerrain } from './world/terrain';
import { Water } from './world/water';
import { Colliders } from './world/colliders';
import { Ruins } from './world/ruins';
import { Colossus } from './world/colossus';
import { ScatterLayer, TreeImpostor, TreeField, GrassField, Motes, partsOf, placeVegetation, setVegetationTime } from './world/vegetation';
import { Player } from './player/player';
import { ThirdPersonCamera } from './player/camera';
import { PLAY, COLOSSUS_POS, terrainHeight } from './world/heightfield';

type Quality = 'high' | 'low';
const params = new URLSearchParams(location.search);
const quality: Quality = (params.get('quality') as Quality) || (localStorage.getItem('tlc-quality') as Quality) || 'high';
const debug = params.has('debug');

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
  renderer.toneMappingExposure = 0.78;
  renderer.shadowMap.enabled = true;
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
  const atmo = await loadAtmosphere(renderer, `${import.meta.env.BASE_URL}assets/hdri/sky_2k.hdr`, (p) => { pHdr = p; progress(); });
  pHdr = 1; progress();
  // The misty sky's horizon is near-white; pull fog down so distance reads as soft blue-grey depth, not milk.
  atmo.fogColor.multiplyScalar(0.62);
  const sunFog = atmo.fogColor.clone().lerp(new THREE.Color(1.0, 0.86, 0.66), 0.55).multiplyScalar(1.25);
  installFogChunks(atmo.sunDir, sunFog, atmo.fogColor);

  ui.status.textContent = 'Unearthing the valley';
  const assets = new Assets(renderer, (p) => { pAssets = p; progress(); });
  await assets.load(
    [
      'tree_hero', 'ranger',
      ...['rock_moss_set_01', 'rock_moss_set_02', 'boulder_01'].flatMap((m) => [m, `${m}_lod1`, `${m}_lod2`]),
      ...['fern_02', 'root_cluster_01', 'tree_stump_01', 'dead_tree_trunk_02', 'dry_branches_medium_01'].flatMap((m) => [m, `${m}_lod1`]),
    ],
    ['ground037', 'grass004', 'ground067', 'rock051', 'rock030', 'rock064', 'bark014'],
  );

  // ---- sky & light ----
  scene.background = atmo.background;
  scene.backgroundRotation.set(0, atmo.backgroundRotationY, 0);
  scene.backgroundIntensity = 0.85;
  scene.environment = atmo.envMap;
  scene.environmentRotation.set(0, atmo.backgroundRotationY, 0);
  scene.environmentIntensity = 0.6;
  scene.fog = new THREE.FogExp2(atmo.fogColor.getHex(), FOG.density);
  (scene.fog as THREE.FogExp2).color.copy(atmo.fogColor);

  const sun = new THREE.DirectionalLight(atmo.sunColor.clone().lerp(new THREE.Color(1, 0.88, 0.72), 0.35), 3.6);
  sun.castShadow = true;
  const SH = quality === 'high' ? 70 : 50;
  sun.shadow.mapSize.setScalar(quality === 'high' ? 4096 : 2048);
  Object.assign(sun.shadow.camera, { left: -SH, right: SH, top: SH, bottom: -SH, near: 1, far: 600 });
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.04;
  scene.add(sun, sun.target);

  // ---- world ----
  ui.status.textContent = 'Raising stone';
  await frame();
  const colliders = new Colliders();
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

  ui.status.textContent = 'Growing the forest';
  await frame();
  sun.position.copy(atmo.sunDir).multiplyScalar(300);
  sun.target.position.set(0, 0, 0);
  const impostor = new TreeImpostor(renderer, assets.models.tree_hero, sun, atmo.envMap);
  const veg = placeVegetation(ruins.footprints, colliders);
  const trees = new TreeField(assets.models.tree_hero, impostor, [...veg.trees, ...colossus.backTreeSpots], quality === 'high' ? 95 : 60, quality === 'high' ? 10 : 5);
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
  const grass = new GrassField(ruins.footprints, quality);
  scene.add(grass.mesh);
  const motes = new Motes();
  scene.add(motes.points);

  // ---- player ----
  const input = new Input(renderer.domElement);
  const player = new Player(assets.models.ranger, colliders, PLAY.start);
  scene.add(player.object);
  const tpc = new ThirdPersonCamera(camera);
  // Open looking down the valley toward the Colossus.
  tpc.yaw = Math.atan2(-(COLOSSUS_POS.x - PLAY.start.x), -(COLOSSUS_POS.z - PLAY.start.z));
  tpc.pitch = -0.02;
  player.setFacing(tpc.yaw + Math.PI);
  tpc.snap(player.position);

  ui.status.textContent = 'Preparing shaders';
  await frame();
  const updateWorld = (t: number) => {
    const cp = camera.position;
    terrain.update(cp.x, cp.z);
    trees.update(cp);
    for (const l of layers) l.update(cp);
    grass.update(cp);
  };
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
    player.update(dt, input, tpc.yaw, started);
    if (debugCam) { camera.position.fromArray(debugCam[0]); camera.lookAt(...debugCam[1]); }
    else tpc.update(dt, input, player.position, Math.hypot(player.velocity.x, player.velocity.z));
    colossus.update(t);
    water.update(t);
    setVegetationTime(t);
    motes.update(t, player.position);
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
      renderer.render(scene, camera);
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
      ready: true, stats, start, player, tpc, input, renderer, scene, camera,
      pause: (p: boolean) => { paused = p; renderer.domElement.style.visibility = p ? 'hidden' : 'visible'; },
      /** Deterministic capture for automated tests: simulate n frames, render once, return a JPEG data URL. */
      step: (n: number, dt = 1 / 30, capture = true) => {
        for (let i = 0; i < n; i++) update(dt);
        if (!capture) return { url: '', ms: 0 };
        for (let i = 0; i < 40; i++) updateWorld(t);
        const t0 = performance.now();
        renderer.render(scene, camera);
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
