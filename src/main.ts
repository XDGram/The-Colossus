import * as THREE from 'three';
import { Assets } from './core/assets';
import { Input } from './core/input';
import { loadAtmosphere, installFogChunks, FOG } from './world/atmosphere';
import { Colliders } from './world/colliders';
import { ScatterLayer, TreeImpostor, TreeField, Motes, partsOf, setVegetationTime } from './world/vegetation';
import { buildValley, VALLEY_MODELS, VALLEY_TEXTURES } from './world/valleyWorld';
import { Player } from './player/player';
import { Post } from './core/post';
import { mulberry32 } from './core/noise';
import { buildTemple, templeHeight } from './temple/compound';
import { applyTempleMaterials } from './temple/materials';
import { SunBeams } from './temple/light';
import { setFoliageTime } from './world/foliage';
import { ThirdPersonCamera, TEMPLE_RIG } from './player/camera';
import { Mentor } from './player/mentorNpc';
import type { PlayerCombat } from './player/combat';
import { ground } from './world/ground';
import { PLAY, COLOSSUS_POS, terrainHeight } from './world/heightfield';

type Quality = 'high' | 'low';
const params = new URLSearchParams(location.search);
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
// Phones default to Low graphics (playable frame rate); the menu toggle overrides it.
const quality: Quality = (params.get('quality') as Quality) || (localStorage.getItem('tlc-quality') as Quality) || (isTouch ? 'low' : 'high');
const debug = params.has('debug');
// The temple compound is in development; the valley stays the default until it is approved.
// The temple fight is the game; the valley (exploration) stays reachable with ?scene=valley.
const sceneName = params.get('scene') === 'valley' ? 'valley' : 'temple';

const ui = {
  loader: document.getElementById('loader')!,
  bar: document.getElementById('bar') as HTMLElement,
  status: document.getElementById('status')!,
  title: document.getElementById('title')!,
  hint: document.getElementById('hint')!,
  fps: document.getElementById('fps')!,
  quality: document.getElementById('quality')!,
};
// Background music: starts with the loading screen and loops for the whole game. Browsers may block sound until the
// first click / tap / key press, so it also starts on the first interaction. Restarted from the beginning on retry.
const music = new Audio(`${import.meta.env.BASE_URL}assets/audio/music.m4a`);
music.loop = true; music.volume = 0.55; music.preload = 'auto';
const playMusic = () => { music.play().catch(() => {}); };
// The Warden's realm has its own track (assets/audio/valley.m4a, mastered louder, so it plays a little lower). The two
// crossfade; the temple track pauses in place and resumes where it left off.
const valleyMusic = new Audio(`${import.meta.env.BASE_URL}assets/audio/valley.m4a`);
valleyMusic.loop = true; valleyMusic.preload = 'none'; valleyMusic.volume = 0;
const MUSIC_VOL = 0.55, VALLEY_VOL = 0.44;
let musicMode: 'temple' | 'valley' = 'temple', musicFade = 0;
const setMusic = (valley: boolean) => {
  musicMode = valley ? 'valley' : 'temple'; musicFade = 0;
  if (valley) { valleyMusic.currentTime = 0; valleyMusic.volume = 0; valleyMusic.play().catch(() => {}); }
  else { music.volume = 0; playMusic(); }
};
/** Crossfade step (real time): 1.4 s; the faded-out track is paused once silent. */
const fadeMusic = (dt: number) => {
  if (musicFade >= 1.4) return;
  musicFade += dt;
  const k = Math.min(1, musicFade / 1.4), v = musicMode === 'valley';
  try { music.volume = MUSIC_VOL * (v ? 1 - k : k); valleyMusic.volume = VALLEY_VOL * (v ? k : 1 - k); } catch { /* fixed volume (iOS) */ }
  if (k >= 1) { if (v) music.pause(); else valleyMusic.pause(); }
};
/** Music dips while the Warden speaks (until this time, ms). */
let duckUntil = 0;
const duckMusic = () => {
  if (musicFade < 1.4) return;
  const k = performance.now() < duckUntil ? 0.82 : 1;
  try { if (musicMode === 'valley') valleyMusic.volume = VALLEY_VOL * k; else music.volume = MUSIC_VOL * k; } catch { /* fixed volume (iOS) */ }
};
const restartMusic = () => { musicMode = 'temple'; musicFade = 9; valleyMusic.pause(); music.volume = MUSIC_VOL; music.currentTime = 0; playMusic(); };
playMusic();
for (const ev of ['pointerdown', 'keydown', 'touchstart']) addEventListener(ev, () => {
  const m = musicMode === 'valley' ? valleyMusic : music;
  if (m.paused) m.play().catch(() => {});
}, { passive: true });

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
  // Phones can run out of graphics memory (Safari then drops the WebGL context and the picture freezes): say so and
  // offer a reload instead of leaving a frozen screen.
  renderer.domElement.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    const m = document.createElement('div');
    m.style.cssText = 'position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;background:rgba(6,6,6,0.85);color:#ece6d8;font:15px Georgia,serif';
    m.textContent = 'The graphics ran out of memory. Tap to reload (Low graphics uses less).';
    m.addEventListener('click', () => { localStorage.setItem('tlc-quality', 'low'); location.reload(); });
    document.body.appendChild(m);
  });

  const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.25, 9500);
  const scene = new THREE.Scene();

  // ---- loading ----
  let pHdr = 0, pAssets = 0;
  const progress = () => {
    const p = pHdr * 0.25 + pAssets * 0.65;
    ui.bar.style.width = `${(p * 100).toFixed(0)}%`;
    const pct = document.getElementById('pct'); if (pct) pct.textContent = `${(p * 100).toFixed(0)}%`;
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
  // Load only what the scene uses: the temple fight needs the hero tree, the character and the boulders, plus its own
  // building textures; the valley's terrain, ruins, colossus, scatter and foliage assets stay on the server.
  await assets.load(
    sceneName === 'temple'
      // Boulders: only their far LODs. They stand 140 m+ from the courtyard, beyond the 60 m switch to LOD 0.
      ? ['tree_hero', 'ranger', 'boulder_01_lod1', 'boulder_01_lod2']
      : ['tree_hero', 'ranger', ...VALLEY_MODELS],
    sceneName === 'temple'
      ? ['ceramic_roof_01', 'brown_planks_07', 'clay_plaster', 'cobblestone_floor_03', 'wood_planks_grey']
      : VALLEY_TEXTURES,
  );
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
  /** Static ground meshes of the scene (temple courtyard paving) for surface raycasts at impacts. */
  let groundMeshes: THREE.Object3D | null = null;
  /** The sealed main gate (temple): its doors can swing open for the opening cinematic. */
  let gate: { open(k: number): void; solid(on: boolean): void } | null = null;
  sun.position.copy(atmo.sunDir).multiplyScalar(300);
  sun.target.position.set(0, 0, 0);
  const templeLayers: ScatterLayer[] = [];
  const beforeWorld = new Set(scene.children);
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
    // The main gate is sealed: heavy closed doors across the passage (the fight is inside the walls).
    {
      const cv = document.createElement('canvas'); cv.width = 256; cv.height = 512; const c2 = cv.getContext('2d')!;
      c2.fillStyle = '#3a2618'; c2.fillRect(0, 0, 256, 512);
      for (let x = 0; x < 256; x += 32) { c2.fillStyle = x % 64 ? '#40291a' : '#342215'; c2.fillRect(x, 0, 30, 512); c2.fillStyle = 'rgba(0,0,0,0.5)'; c2.fillRect(x + 30, 0, 2, 512); }
      c2.fillStyle = '#1c1714'; for (const y of [70, 250, 430]) c2.fillRect(0, y, 256, 26);
      c2.fillStyle = '#6a5a44'; for (const y of [70, 250, 430]) for (let x = 14; x < 256; x += 40) { c2.beginPath(); c2.arc(x, y + 13, 5, 0, Math.PI * 2); c2.fill(); }
      const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 });
      const gz = 47.62, gy = templeHeight(0, gz);
      // Each leaf hangs on a hinge at its outer edge so the opening cinematic can swing the doors open (inward).
      const hinges: THREE.Group[] = [];
      for (const sx of [-1, 1]) {
        const hinge = new THREE.Group(); hinge.position.set(sx * 2.76, gy, gz); scene.add(hinge);
        const leaf = new THREE.Mesh(new THREE.BoxGeometry(2.76, 5.0, 0.16), mat);
        leaf.position.set(-sx * 1.38, 2.5 + 0.3, 0); leaf.castShadow = leaf.receiveShadow = true; hinge.add(leaf);
        hinges.push(hinge);
      }
      const bar = new THREE.Mesh(new THREE.BoxGeometry(5.8, 0.28, 0.24), new THREE.MeshStandardMaterial({ color: 0x1c1410, roughness: 0.7 }));
      bar.position.set(0, gy + 2.4, gz - 0.16); bar.castShadow = true; scene.add(bar);
      const gateCol = colliders.addBox(0, gz, 5.6, 0.5, 0, gy - 1, gy + 6);
      const top = gateCol.top;
      gate = {
        // 0 = shut, 1 = wide open (about 80° inward); the bar lifts away while open.
        open: (k: number) => { hinges[0].rotation.y = 1.4 * k; hinges[1].rotation.y = -1.4 * k; bar.visible = k < 0.05; },
        solid: (on: boolean) => { gateCol.top = on ? top : -1e4; },
      };
    }
    fog.near = FOG.density * 0.45; // crisper, brighter air than the valley
    scene.add(temple.group);
    groundMeshes = temple.group;
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
      const l = new ScatterLayer(['boulder_01_lod1', 'boulder_01_lod2'].map((n) => partsOf(assets.models[n])), rocks, { maxDist: 2000, lodDist: [300], castShadow: false, chunk: 120 });
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
    const valley = await buildValley({ renderer, assets, sun, atmo, colliders, quality, parent: scene, center: PLAY.start, tuneAll: true,
      status: (m) => { ui.status.textContent = m; }, yieldFrame: frame });
    startPos = PLAY.start;
    startYaw = Math.atan2(-(COLOSSUS_POS.x - PLAY.start.x), -(COLOSSUS_POS.z - PLAY.start.z));
    worldUpdate = valley.update;
  }

  /** Everything the temple world put in the scene (the valley realm hides it). */
  const templeObjects = sceneName === 'temple' ? scene.children.filter((c) => !beforeWorld.has(c)) : [];

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
  if (sceneName === 'temple' && params.has('mentor')) {
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
  let animLib: import('three/examples/jsm/loaders/GLTFLoader.js').GLTF | undefined;
  if (sceneName === 'temple') {
    const [{ PlayerCombat }, { GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
      import('./player/combat'), import('three/examples/jsm/loaders/GLTFLoader.js'), import('three/examples/jsm/libs/meshopt_decoder.module.js')]);
    const lib = await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(`${import.meta.env.BASE_URL}assets/models/enemies.glb`);
    animLib = lib;
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
  const encounterMode = sceneName === 'temple' && !params.has('combat') && !params.has('enemies');
  if (sceneName === 'temple' && (params.has('combat') || encounterMode)) {
    const { CombatArena } = await import('./combat/arena');
    arena = await CombatArena.create(encounterMode ? 'encounter' : params.get('combat') || 'r2b1', scene, import.meta.env.BASE_URL,
      { height: (x, z) => Math.max(ground.height(x, z), colliders.floorAt(x, z, ground.height(x, z) + 0.6)), resolve: (x, z, y, r) => colliders.resolve(x, z, y, r),
        // Line of sight for warnings: sampled every 0.15 m against colliders (and the camera's solid test, e.g. roofs).
        lineBlocked: (a, b) => {
          const d = a.distanceTo(b), dir = b.clone().sub(a).normalize();
          for (let s = 0.2; s < d - 0.25; s += 0.15) { const p = a.clone().addScaledVector(dir, s); if (colliders.blocks(p.x, p.y, p.z) || ground.solid?.(p.x, p.y, p.z)) return true; }
          return false;
        } },
      camera, player.position.clone(), player.facing, +(params.get('seed') || 1),
      () => (mentor ? [{ base: mentor.object.position.clone(), radius: 0.42, bottom: 0.1, top: 1.85 }] : []),
      { lib: animLib, ranger: assets.models.ranger });
  }
  // The older warrior is now the Temple Warden (antagonist): in an arena that includes him, the friendly NPC is hidden.
  if (arena && mentor && /w\d/.test(params.get('combat') || '')) { mentor.object.visible = false; mentor.object.position.y -= 100; }
  // Combat loop (Stage 2C): hits, damage, health and reactions between the player and the arena's enemies.
  let combatSystem: import('./combat/system').CombatSystem | null = null;
  if (arena && combat && hitWorld) {
    const { CombatSystem } = await import('./combat/system');
    combatSystem = new CombatSystem(hitWorld, player, combat, arena.brains);
    const home = player.position.clone(), homeYaw = player.facing;
    // Soft lock for the sword: living enemies' feet.
    combat.targets = () => arena!.brains.filter((b) => !b.dead && !b.removed && b.e.object.visible).map((b) => b.effective());
    combatSystem.onRestart = () => { player.teleport(home.x, home.z); player.setFacing(homeYaw); arena!.reset(); restartMusic(); };
    // Enemies spawned later (the Warden's summon) join the combat loop; the encounter replaces this with its own.
    arena.onSpawn = (b) => combatSystem!.add(b);
  }
  // Attacks that start off screen: a battle cry from the attacker's direction and a screen-edge marker.
  let threats: import('./ui/threat').ThreatMarkers | null = null;
  // Temple Warden boss services: pooled effects, spell hazards (through the combat loop), summons.
  let vfx: import('./fx/vfx').Vfx | null = null;
  let abilities: import('./player/abilities').Abilities | null = null;
  let spiritFx: import('./fx/spirit').SpiritFx | null = null;
  let spiritHud: import('./ui/spirithud').SpiritHud | null = null;
  if (arena && combat && hitWorld && combatSystem) {
    const [{ Vfx }, { Spells }] = await Promise.all([import('./fx/vfx'), import('./boss/spells')]);
    vfx = await Vfx.load(import.meta.env.BASE_URL, scene, quality);
    const groundAt = (x: number, z: number) => Math.max(ground.height(x, z), colliders.floorAt(x, z, ground.height(x, z) + 0.6));
    const { GameAudio } = await import('./audio/audio');
    const audio = new GameAudio(camera); void audio.load(import.meta.env.BASE_URL);
    const sound = (n: string, at?: THREE.Vector3) => {
      // The Warden speaks: his voice is never positional, and the music dips under it.
      if (n.startsWith('w_')) { duckUntil = performance.now() + 3200; audio.play(n as import('./audio/audio').SoundName); return; }
      audio.play(n as import('./audio/audio').SoundName, at);
    };
    const spells = new Spells(hitWorld, vfx, { height: groundAt, blocks: (x, y, z) => colliders.blocks(x, y, z), player, push: (from, d) => combat!.pushFrom(from, d), sound });
    combatSystem.hazards = spells;
    {
      const { ThreatMarkers } = await import('./ui/threat');
      const tm = threats = new ThreatMarkers(camera), ar = arena;
      ar.director.onOffscreen = (id) => {
        const b = ar.brains.find((x) => x.id === id); if (!b) return;
        sound(b.e.cls === 'breaker' || Math.random() < 0.5 ? 'cry2' : 'cry', b.effective());
        tm.add(() => (!b.dead && (b.state === 'tell' || b.state === 'attack') ? b.e.chest() : null), () => b.unparryable);
      };
    }
    // The Ash Runners' power: thrown kunai, flown and swept by the spell system.
    const { POWERS } = await import('./combat/brain');
    POWERS.kunai = (b, from, at) => spells.kunai(b, from, at);
    // Supernatural abilities (docs/abilities.md): Phantom Step, Colossus Rift, Gravity Rupture.
    {
      const [{ SpiritFx }, { Abilities }, { SpiritHud }] = await Promise.all([import('./fx/spirit'), import('./player/abilities'), import('./ui/spirithud')]);
      const stone = assets.textures.cobblestone_floor_03;
      const { MAT } = await import('./temple/kit');
      spiritFx = new SpiritFx(scene, player.model, combat.blade.mount, quality, { map: stone?.color ?? null, normal: stone?.normal ?? null, material: MAT.stone });
      spiritFx.afterimages.build();
      abilities = new Abilities({ player, combat, hits: hitWorld, brains: () => arena!.brains, vfx, fx: spiritFx, sound,
        shake: (a, t) => tpc.shake(a, t), height: groundAt, blocks: (x, y, z) => colliders.blocks(x, y, z),
        surface: (() => {
          const rc = new THREE.Raycaster(); rc.far = 1.5;
          return (x: number, z: number, near: number) => {
            if (!groundMeshes) return near;
            rc.set(new THREE.Vector3(x, near + 0.75, z), new THREE.Vector3(0, -1, 0));
            const h = rc.intersectObject(groundMeshes, true).find((i) => (i.object as THREE.Mesh).isMesh && i.face && i.face.normal.y > 0.5);
            return h ? h.point.y : near;
          };
        })() });
      combat.spirit = abilities;
      combatSystem.abilities = abilities;
      const ab = abilities;
      combatSystem.onAbilityHit = (h, b, r) => ab.onHit(h, b, r);
      spiritFx.onDebrisLand = (p) => ab.debrisLanded(p);
      if (!isTouch) spiritHud = new SpiritHud();
      // Combo and knockdown impacts: the leap's landing kicks up a dust ring; being knocked flying jolts the camera.
      const dustC = new THREE.Color(0.55, 0.5, 0.44);
      combat.onEvent = (e, p) => {
        if (e === 'leapLand') {
          vfx!.burst('smoke_04', p.clone().setY(p.y + 0.1), { count: 10, color: dustC, life: 0.7, size: 0.7, size1: 1.8, speed: 3.5, up: 0.3, alpha: 0.45, drag: 3, normal: true, flat: true });
          vfx!.decal('circle_03', p, { color: new THREE.Color(0.9, 0.85, 0.75), size: 1.2, life: 0.35, fadeIn: 0.01, fadeOut: 0.3, alpha: 0.5, grow: 9 });
          tpc.shake(0.07, 0.2); sound('debris', p);
        } else { tpc.shake(0.14, 0.4); sound('debris', p); }
      };
    }
    const ar = arena;
    Object.assign(arena.bossCtx, {
      spells, vfx, sound,
      // Two Ash Runners come out to either side behind him (phase 2).
      summon: (n: number) => {
        const boss = ar.brains.find((b) => b.e.kind === 'warden' && !b.dead); if (!boss) return;
        const bp = boss.effective(), toP = player.position.clone().sub(bp).setY(0).normalize(), side = new THREE.Vector3(toP.z, 0, -toP.x);
        for (let i = 0; i < n; i++) {
          const p = bp.clone().addScaledVector(toP, -3).addScaledVector(side, (i % 2 ? 1 : -1) * 3.5);
          [p.x, p.z] = colliders.resolve(p.x, p.z, groundAt(p.x, p.z), 0.5);
          const b = ar.spawn('runner', p, Math.atan2(player.position.x - p.x, player.position.z - p.z));
          vfx!.puff(b.e.object.position, true);
        }
      },
    });
  }
  // The temple fight (normal temple play): Warden confrontation, two waves, then the Warden.
  let encounter: import('./combat/encounter').TempleEncounter | null = null;
  let realm: import('./world/realm').WardenRealm | null = null;
  let glitchLevel = 0;
  if (encounterMode && arena && combatSystem) {
    const { TempleEncounter } = await import('./combat/encounter');
    encounter = new TempleEncounter(arena, combatSystem, combat!, player, camera,
      { x: player.position.x, z: player.position.z, yaw: player.facing }, new THREE.Vector3(0, 0, 46.2));
    // Retry after a defeat: the music starts again from the beginning.
    const retry = encounter.retry.bind(encounter);
    encounter.retry = () => { restartMusic(); retry(); };
    tpc.snap(player.position);   // the opening starts the player outside the gate
    encounter.onShake = (a, t) => tpc.shake(a, t);
    encounter.onSnap = () => tpc.snap(player.position);
    encounter.doors = gate;
    arena.bossCtx.shake = (a, t) => tpc.shake(a, t);
    // The Warden's realm: the valley, built in the background during the waves.
    if (!params.has('norealm')) {
      const { WardenRealm } = await import('./world/realm');
      realm = new WardenRealm({ scene, renderer, camera, assets, sun, atmo, colliders, quality, temple: templeObjects, tpc, spiritFx, phone: isTouch });
      const rm = realm;
      encounter.realm = {
        preload: () => { valleyMusic.preload = 'auto'; valleyMusic.load(); void rm.preload().catch(() => {}); },
        build: () => { void rm.build(); },
        get ready() { return rm.ready; }, get active() { return rm.active; },
        enter: () => rm.enter(), exit: () => rm.exit(),
        glitch: (v) => { glitchLevel = v; }, music: setMusic,
      };
    }
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
  const updateWorld = (t: number) => (realm?.active ? realm.update(t, camera.position, player.position) : worldUpdate(t, camera.position, player.position));
  const post = new Post(renderer, scene, camera, quality, atmo.sunDir);
  if (sceneName === 'temple') {
    post.rays.uniforms.uIntensity.value = 0.3;
    if (post.bloom) { post.bloom.strength = 0.22; post.bloom.threshold = 0.95; }
  }
  tpc.update(0.016, input, player.position, 0);
  updateWorld(0);
  await renderer.compileAsync(scene, camera);

  // ---- loop ----
  // Loading finished: the painted art stays behind the menu (home screen) until the fight starts.
  ui.bar.style.width = '100%'; { const pct = document.getElementById('pct'); if (pct) pct.textContent = '100%'; }
  ui.loader.classList.add('ready');
  ui.title.classList.add('show');
  // Pooled effects (boss spells, abilities) are hidden until used. Their shaders compile in the background while the
  // menu is up (the painted loading art covers the canvas), so the menu appears sooner and the first use in the fight
  // doesn't hitch.
  if (vfx || spiritFx) {
    void (async () => {
      await new Promise((r) => setTimeout(r, 600));
      const mount = combat?.blade.mount;
      vfx?.prewarm(true); spiritFx?.prewarm(true); if (mount) mount.visible = true;
      // compileAsync gathers the objects to compile when it is called, so everything is hidden again at once (nothing
      // flashes on screen, even if the fight starts before compiling finishes).
      let done: Promise<unknown> | null = null;
      try { done = renderer.compileAsync(scene, camera); } catch { /* compiled on first use instead */ }
      vfx?.prewarm(false); spiritFx?.prewarm(false); if (mount && combat) mount.visible = combat.drawn;
      await done?.catch(() => {});
    })();
  }
  // The Warden's realm (the valley) downloads and builds while the menu is up, so it is ready for his first raid at the
  // end of wave 1 (the build runs in small slices, so it carries on harmlessly into the opening if play starts early).
  if (encounter?.realm) setTimeout(() => { encounter?.realm?.preload(); encounter?.realm?.build(); }, 1500);
  let started = false;
  // Full screen: the game takes the whole screen when play starts (phones also lock to landscape where allowed).
  const goFullscreen = () => {
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
    if (document.fullscreenElement) return;
    try {
      const r = el.requestFullscreen ? el.requestFullscreen({ navigationUI: 'hide' }) : (el.webkitRequestFullscreen?.(), undefined);
      void r?.then(() => (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> })?.lock?.('landscape').catch(() => {})).catch(() => {});
    } catch { /* not supported (e.g. iPhone Safari): the page already fills the window */ }
  };
  const start = () => {
    if (started) return;
    started = true;
    if (!params.has('combat') && !debug) goFullscreen();
    ui.loader.classList.add('done');
    ui.title.classList.remove('show');
    ui.hint.classList.add('show');
    setTimeout(() => ui.hint.classList.remove('show'), 9000);
    input.lock();
  };
  renderer.domElement.addEventListener('click', () => (started ? input.lock() : start()));
  // Main menu: play the temple fight; the valley is locked (coming soon); controls panel; graphics toggle.
  document.getElementById('m-play')?.addEventListener('click', (e) => { e.stopPropagation(); start(); });
  document.getElementById('m-controls')?.addEventListener('click', (e) => { e.stopPropagation(); document.getElementById('ctl')?.classList.toggle('open'); });
  const gfx = document.getElementById('m-gfx');
  if (gfx) {
    gfx.textContent = `Graphics: ${quality === 'high' ? 'High' : 'Low'}`;
    gfx.addEventListener('click', (e) => { e.stopPropagation(); localStorage.setItem('tlc-quality', quality === 'high' ? 'low' : 'high'); location.reload(); });
  }
  addEventListener('keydown', (e) => {
    if (!started && (e.code === 'Enter' || e.code === 'Space')) start();
    if (e.code === 'KeyG') {
      localStorage.setItem('tlc-quality', quality === 'high' ? 'low' : 'high');
      location.reload();
    }
    if (e.code === 'F3') { ui.fps.classList.toggle('show'); e.preventDefault(); }
    if (e.code === 'KeyF' && started) { if (document.fullscreenElement) void document.exitFullscreen(); else goFullscreen(); }
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
  let idleT = 0;
  let cineFrom: [THREE.Vector3, THREE.Quaternion] | null = null;
  let debugCam: [number[], [number, number, number]] | null = null;
  const update = (dt: number) => {
    t += dt;
    fadeMusic(dt); duckMusic();
    abilities?.tick(dt);
    // Opening cinematic: the encounter walks the player in from the gate; input waits until the fight starts.
    const cine = started ? encounter?.cinematic ?? null : null;
    // An attack press skips ahead in the opening.
    if (cine && input.consumeAttack()) encounter!.skipIntro();
    combat?.preUpdate(dt, input, tpc.yaw, started && !cine);
    if (cine) { player.control.drive = cine.drive.clone(); player.control.lockMove = true; player.control.locomotion = 1; }
    player.update(dt, input, tpc.yaw, started && !cine);
    combat?.postUpdate(dt);
    if (hitWorld && combat && !combatSystem) {
      hitWorld.beginFrame();
      const a = combat.activeAttack;
      if (a) for (const e of hitWorld.sweepWeapon(a.key, 'player', { hilt: a.hilt, tip: a.tip, radius: 0.03 }, combat.chest(), { hilt: a.prevHilt, tip: a.prevTip })) { hitEvents.push(e); if (hitEvents.length > 64) hitEvents.shift(); }
    }
    mentor?.update(dt);
    enemyShowcase?.update(dt);
    // How long the player has waited (standing still, not attacking): the enemies punish it.
    const still = Math.hypot(player.velocity.x, player.velocity.z) < 0.4 && (combat?.state === 'free' || combat?.state === 'block');
    idleT = still && started && !encounter?.cinematic ? idleT + dt : 0;
    arena?.update(dt, { position: player.position, facing: player.facing, radius: 0.38, attackKey: combat?.state === 'attack' ? `p${combat.attackInstance}` : null, mash: combat?.mashScore() ?? 0, ghost: abilities?.ghost ?? false,
      idle: idleT, vel: player.velocity, recovering: combat?.state === 'recover' });
    threats?.update();
    combatSystem?.update(dt);
    vfx?.update(dt);
    spiritFx?.update(dt);
    if (abilities) { const r = abilities.readiness(); input.spiritStatus(r); spiritHud?.update(r, started && combat?.state !== 'dead' && !encounter?.cinematic); }
    if (started) encounter?.update(dt);
    if (debugCam) { camera.position.fromArray(debugCam[0]); camera.lookAt(...debugCam[1]); }
    else if (cine?.cam) {
      // Opening shots; the gameplay camera is kept behind the warrior, ready for the hand-over.
      camera.position.copy(cine.cam.pos); camera.lookAt(cine.cam.look);
      tpc.yaw = player.facing + Math.PI; tpc.snap(player.position); cineFrom = [camera.position.clone(), camera.quaternion.clone()];
    } else {
      // The storm transition: the camera turns to keep the Warden in focus, from the player's own view.
      const focus = encounter?.focus;
      if (focus) {
        // Over the shoulder (a little to the side), so the player's own body doesn't hide him.
        const want = Math.atan2(focus.x - player.position.x, focus.z - player.position.z) + Math.PI + 0.32;
        tpc.yaw += Math.atan2(Math.sin(want - tpc.yaw), Math.cos(want - tpc.yaw)) * Math.min(1, dt * 4);
        tpc.pitch += (-0.06 - tpc.pitch) * Math.min(1, dt * 3);
      }
      tpc.update(dt, input, player.position, Math.hypot(player.velocity.x, player.velocity.z));
      // Hand-over from the last opening shot to the gameplay camera.
      if (cine && cine.blend >= 0 && cine.blend < 1 && cineFrom) {
        const k = cine.blend * cine.blend * (3 - 2 * cine.blend);
        camera.position.lerpVectors(cineFrom[0], camera.position, k); camera.quaternion.slerpQuaternions(cineFrom[1], camera.quaternion, k);
      }
    }
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
      // Hit-stop: ability impacts briefly slow the world.
      update(dt * (abilities?.timeScale(dt) ?? 1));
      post.glitch = glitchLevel; post.dark = encounter?.dark ?? 0;
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
      ready: true, stats, start, player, mentor, abilities: () => abilities, spiritFx: () => spiritFx, vfx: () => vfx, enemies: () => enemyShowcase, combat: () => combat, hits: () => hitWorld, hitEvents, arena: () => arena, combatSystem: () => combatSystem, encounter: () => encounter, realm: () => realm, tpc, input, renderer, scene, camera, post,
      pause: (p: boolean) => { paused = p; renderer.domElement.style.visibility = p ? 'hidden' : 'visible'; },
      /** Deterministic capture for automated tests: simulate n frames, render once, return a JPEG data URL. */
      step: (n: number, dt = 1 / 30, capture = true) => {
        for (let i = 0; i < n; i++) update(dt);
        if (!capture) return { url: '', ms: 0 };
        for (let i = 0; i < 40; i++) updateWorld(t);
        post.glitch = glitchLevel; post.dark = encounter?.dark ?? 0;
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

main().catch((e) => {
  console.error(e);
  ui.status.textContent = `Something went wrong: ${e?.message ?? e}`;
});
