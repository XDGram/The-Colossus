import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mulberry32, fbm, smoothstep } from '../core/noise';
import { terrainHeight, terrainNormal, streamX, pathX, valleyAxis, PLAY, SITES, POOL, COLOSSUS_POS, STREAM_SOURCE_Z } from './heightfield';
import type { Colliders } from './colliders';

interface Part { geometry: THREE.BufferGeometry; material: THREE.Material; local: THREE.Matrix4 }

/** Flattens a glTF scene into (geometry, material, local transform) parts for instancing. */
export function partsOf(gltf: GLTF): Part[] {
  const parts: Part[] = [];
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    for (const mat of mats) parts.push({ geometry: m.geometry, material: mat, local: m.matrixWorld.clone() });
  });
  return parts;
}

export function boundsOf(gltf: GLTF) {
  return new THREE.Box3().setFromObject(gltf.scene);
}

/**
 * Spatially chunked instancing with per-chunk LOD: one InstancedMesh per (chunk, LOD, part).
 * Chunks pick a LOD by camera distance and hide beyond maxDist; three.js frustum-culls the rest.
 */
export class ScatterLayer {
  readonly group = new THREE.Group();
  private chunks: { center: THREE.Vector3; lods: THREE.InstancedMesh[][]; radius: number }[] = [];
  private maxDist: number;
  private lodDist: number[];

  constructor(lodParts: Part[][], matrices: THREE.Matrix4[], opts: { chunk?: number; maxDist: number; lodDist?: number[]; castShadow?: boolean; shadowLods?: number }) {
    const size = opts.chunk ?? 80;
    this.maxDist = opts.maxDist;
    this.lodDist = opts.lodDist ?? [];
    const buckets = new Map<string, THREE.Matrix4[]>();
    const p = new THREE.Vector3();
    for (const m of matrices) {
      p.setFromMatrixPosition(m);
      const k = `${Math.floor(p.x / size)},${Math.floor(p.z / size)}`;
      (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(m);
    }
    const tmp = new THREE.Matrix4();
    for (const list of buckets.values()) {
      const center = new THREE.Vector3();
      for (const m of list) center.add(p.setFromMatrixPosition(m));
      center.multiplyScalar(1 / list.length);
      let radius = 0;
      for (const m of list) radius = Math.max(radius, p.setFromMatrixPosition(m).distanceTo(center));
      const lods = lodParts.map((parts, li) => parts.map((part) => {
        const im = new THREE.InstancedMesh(part.geometry, part.material, list.length);
        list.forEach((m, i) => im.setMatrixAt(i, tmp.multiplyMatrices(m, part.local)));
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.castShadow = !!opts.castShadow && li < (opts.shadowLods ?? 1);
        im.receiveShadow = true;
        im.visible = false;
        this.group.add(im);
        return im;
      }));
      this.chunks.push({ center, lods, radius });
    }
  }

  update(cam: THREE.Vector3) {
    for (const c of this.chunks) {
      const d = Math.max(0, c.center.distanceTo(cam) - c.radius);
      let lod = d > this.maxDist ? -1 : 0;
      if (lod === 0) while (lod < c.lods.length - 1 && d > (this.lodDist[lod] ?? Infinity)) lod++;
      c.lods.forEach((objs, i) => { for (const o of objs) o.visible = i === lod; });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Tree impostors: the real tree mesh rendered from N azimuths into an atlas at load time.

const IMPOSTOR_VIEWS = 12;

export class TreeImpostor {
  readonly texture: THREE.Texture;
  readonly width: number;
  readonly height: number;
  readonly baseY: number;
  private rt: THREE.WebGLRenderTarget;

  constructor(renderer: THREE.WebGLRenderer, gltf: GLTF, sun: THREE.DirectionalLight, env: THREE.Texture) {
    const box = boundsOf(gltf);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const R = Math.max(size.x, size.z) * 1.04;
    this.width = R;
    this.height = size.y * 1.03;
    this.baseY = box.min.y;
    const frame = 256;
    const fh = Math.round(frame * (this.height / this.width));
    this.rt = new THREE.WebGLRenderTarget(frame * IMPOSTOR_VIEWS, fh, { type: THREE.HalfFloatType, samples: 4 });
    this.rt.texture.generateMipmaps = true;
    this.rt.texture.minFilter = THREE.LinearMipmapLinearFilter;

    const scene = new THREE.Scene();
    scene.environment = env;
    const model = gltf.scene.clone(true);
    scene.add(model);
    const light = sun.clone();
    light.castShadow = false;
    light.target.position.set(0, 0, 0);
    light.position.copy(sun.position).sub(sun.target.position).normalize().multiplyScalar(50);
    scene.add(light, light.target);
    const cam = new THREE.OrthographicCamera(-R / 2, R / 2, this.height / 2, -this.height / 2, 0.1, 100);

    const prevTarget = renderer.getRenderTarget();
    const prevClear = renderer.getClearColor(new THREE.Color());
    const prevAlpha = renderer.getClearAlpha();
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(new THREE.Color(0.03, 0.04, 0.02), 0);
    renderer.clear();
    for (let k = 0; k < IMPOSTOR_VIEWS; k++) {
      const phi = (k / IMPOSTOR_VIEWS) * Math.PI * 2;
      cam.position.set(center.x + Math.sin(phi) * 40, box.min.y + this.height / 2, center.z + Math.cos(phi) * 40);
      cam.lookAt(center.x, box.min.y + this.height / 2, center.z);
      this.rt.viewport.set(k * frame, 0, frame, fh);
      this.rt.scissor.set(k * frame, 0, frame, fh);
      this.rt.scissorTest = true;
      renderer.setRenderTarget(this.rt);
      renderer.render(scene, cam);
    }
    this.rt.scissorTest = false;
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(prevClear, prevAlpha);
    this.texture = this.rt.texture;
  }

  material() {
    const m = new THREE.MeshBasicMaterial({ map: this.texture, alphaTest: 0.45, side: THREE.DoubleSide });
    m.onBeforeCompile = (sh) => {
      sh.defines = { ...sh.defines, CUSTOM_FOG_WPOS: '' };
      sh.vertexShader = sh.vertexShader.replace('#include <project_vertex>', /* glsl */ `
        vec4 iCenter = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        float iScale = length(instanceMatrix[0].xyz);
        vec3 toCam = cameraPosition - iCenter.xyz; toCam.y = 0.0; toCam = normalize(toCam);
        vec3 right = vec3(toCam.z, 0.0, -toCam.x);
        vec3 c0 = instanceMatrix[0].xyz / iScale;
        float psi = atan(-c0.z, c0.x);
        float lx = toCam.x * cos(psi) - toCam.z * sin(psi);
        float lz = toCam.x * sin(psi) + toCam.z * cos(psi);
        float phi = atan(lx, lz);
        float frame = mod(floor(phi / (6.2831853 / ${IMPOSTOR_VIEWS}.0) + 0.5), ${IMPOSTOR_VIEWS}.0);
        vMapUv.x = (frame + uv.x) / ${IMPOSTOR_VIEWS}.0;
        vec3 wp = iCenter.xyz + right * position.x * ${this.width.toFixed(4)} * iScale
                + vec3(0.0, (position.y * ${this.height.toFixed(4)} + ${this.baseY.toFixed(4)}) * iScale, 0.0);
        vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
        gl_Position = projectionMatrix * mvPosition;
        #ifdef USE_FOG
          vFogWorldPos = wp;
        #endif`);
      sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', AUTUMN_GLSL);
    };
    m.customProgramCacheKey = () => 'tree-impostor';
    return m;
  }
}

/** Trees: nearest few as full instanced meshes (with shadows), the rest as impostor billboards. */
export class TreeField {
  readonly group = new THREE.Group();
  private full: THREE.InstancedMesh[];
  private parts: Part[];
  private impostor: THREE.InstancedMesh;
  private trees: THREE.Matrix4[];
  private positions: THREE.Vector3[];
  private lastKey = '';
  private tmp = new THREE.Matrix4();

  constructor(gltf: GLTF, impostor: TreeImpostor, trees: THREE.Matrix4[], private nearDist: number, private maxFull: number, private tints: (THREE.Color | null)[] = []) {
    this.trees = trees;
    this.positions = trees.map((m) => new THREE.Vector3().setFromMatrixPosition(m));
    this.parts = partsOf(gltf);
    for (const p of this.parts) {
      const mat = p.material as THREE.MeshStandardMaterial;
      mat.side = THREE.DoubleSide;
      if (/leaves/i.test(mat.name)) addLeafSway(mat);
    }
    this.full = this.parts.map((p) => {
      const im = new THREE.InstancedMesh(p.geometry, p.material, maxFull);
      im.castShadow = true;
      im.receiveShadow = true;
      im.count = 0;
      im.frustumCulled = false;
      if (/leaves/i.test(p.material.name)) im.setColorAt(0, WHITE);
      this.group.add(im);
      return im;
    });
    const quad = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
    this.impostor = new THREE.InstancedMesh(quad, impostor.material(), trees.length);
    this.impostor.frustumCulled = false;
    this.impostor.setColorAt(0, WHITE);
    this.group.add(this.impostor);
  }

  /** Opt in to per-tree foliage tints (FOLIAGE_TINT), e.g. golden ginkgo in the temple. */
  enableTint() {
    const mats = [this.impostor.material as THREE.Material, ...this.full.filter((f) => f.instanceColor).map((f) => f.material as THREE.Material)];
    for (const m of mats) { m.defines = { ...(m.defines ?? {}), FOLIAGE_TINT: '' }; m.needsUpdate = true; }
  }

  update(cam: THREE.Vector3) {
    // Rebuild only when the camera has moved a few metres.
    const key = `${Math.round(cam.x / 4)},${Math.round(cam.z / 4)}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const order = this.positions.map((p, i) => [p.distanceToSquared(cam), i] as const).sort((a, b) => a[0] - b[0]);
    let nf = 0, ni = 0;
    for (const [d2, i] of order) {
      if (d2 < this.nearDist * this.nearDist && nf < this.maxFull) {
        for (let k = 0; k < this.parts.length; k++) {
          this.full[k].setMatrixAt(nf, this.tmp.multiplyMatrices(this.trees[i], this.parts[k].local));
          if (this.full[k].instanceColor) this.full[k].setColorAt(nf, this.tints[i] ?? WHITE);
        }
        nf++;
      } else {
        this.impostor.setColorAt(ni, this.tints[i] ?? WHITE);
        this.impostor.setMatrixAt(ni++, this.trees[i]);
      }
    }
    for (const f of this.full) { f.count = nf; f.instanceMatrix.needsUpdate = true; if (f.instanceColor) f.instanceColor.needsUpdate = true; }
    this.impostor.count = ni;
    this.impostor.instanceMatrix.needsUpdate = true;
    this.impostor.instanceColor!.needsUpdate = true;
  }
}

const WHITE = new THREE.Color(1, 1, 1);
/** Recolours foliage by luminance toward the per-instance colour (white = unchanged). */
const AUTUMN_GLSL = /* glsl */ `
  #if defined( USE_COLOR ) && defined( FOLIAGE_TINT )
    {
      float lum = dot(diffuseColor.rgb, vec3(0.3, 0.59, 0.11));
      float amt = step(0.02, abs(vColor.r - vColor.g) + abs(vColor.g - vColor.b));
      diffuseColor.rgb = mix(diffuseColor.rgb, vColor * lum * 2.6, amt);
    }
  #endif`;
const swayTime = { value: 0 };
function addLeafSway(mat: THREE.MeshStandardMaterial) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSway = swayTime;
    sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nuniform float uSway;')
      .replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
        {
          vec3 ip = vec3(0.0);
          #ifdef USE_INSTANCING
            ip = instanceMatrix[3].xyz;
          #endif
          float ph = dot(ip, vec3(0.13, 0.0, 0.17));
          float h = max(0.0, transformed.y - 1.0);
          float w = sin(uSway * 1.3 + ph + transformed.x * 0.7) * 0.5 + sin(uSway * 2.7 + ph * 1.7 + transformed.z) * 0.25;
          transformed.x += w * 0.035 * h;
          transformed.z += w * 0.025 * h;
        }`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <color_fragment>', AUTUMN_GLSL);
  };
  mat.customProgramCacheKey = () => 'leaf-sway';
}
export function setVegetationTime(t: number) { swayTime.value = t; }

// ---------------------------------------------------------------------------------------------
// Placement rules for the valley.

export interface Placement { matrices: THREE.Matrix4[] }

export function placeVegetation(blockers: { x: number; z: number; r: number }[], colliders: Colliders) {
  const rnd = mulberry32(2026);
  const r = (a: number, b: number) => a + (b - a) * rnd();
  const up = new THREE.Vector3(0, 1, 0);
  const mat = (x: number, y: number, z: number, s: number, yaw: number, tiltTo?: [number, number, number], tilt = 0) => {
    const q = new THREE.Quaternion().setFromAxisAngle(up, yaw);
    if (tiltTo && tilt > 0) {
      const n = new THREE.Vector3(...tiltTo);
      q.premultiply(new THREE.Quaternion().setFromUnitVectors(up, n.lerp(up, 1 - tilt).normalize()));
    }
    return new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(s, s, s));
  };
  const blocked = (x: number, z: number, pad = 0) => blockers.some((b) => (x - b.x) ** 2 + (z - b.z) ** 2 < (b.r + pad) ** 2);
  const offRoad = (x: number, z: number, d: number) => Math.abs(x - pathX(z)) > d;
  const offStream = (x: number, z: number, d: number) => Math.abs(x - streamX(z)) > d && Math.hypot(x - POOL.x, z - POOL.z) > POOL.r + d;

  // Valley trees: groves driven by low-frequency noise, kept off the road, stream and ruins.
  const trees: THREE.Matrix4[] = [];
  const treeSpots: { x: number; z: number }[] = [];
  for (let tries = 0; tries < 9000 && trees.length < 120; tries++) {
    const z = r(PLAY.minZ - 60, PLAY.maxZ + 40);
    const x = valleyAxis(z) + r(-170, 170);
    // Groves thicken toward the valley edges, keeping the central meadow and the view to the Colossus open.
    const edge = smoothstep(55, 140, Math.abs(x - valleyAxis(z)));
    const grove = fbm(x * 0.009 + 7, z * 0.009, 3) + edge * 0.35;
    if (grove < 0.12 + rnd() * 0.25) continue;
    if (!offRoad(x, z, 9) || !offStream(x, z, 11) || blocked(x, z, 6)) continue;
    const n = terrainNormal(x, z, 1.5);
    if (n[1] < 0.9) continue;
    if (treeSpots.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < 12 * 12)) continue;
    const y = terrainHeight(x, z) - 0.25;
    const s = r(2.4, 3.6);
    trees.push(mat(x, y, z, s, r(0, 6.28)));
    treeSpots.push({ x, z });
    colliders.addCircle(x, z, 0.55 * s * 0.5, y, y + 6);
  }
  // A lone ancient tree beside the road near the start: an early landmark framing the view.
  {
    const z = PLAY.start.z - 40, x = pathX(z) + 12;
    const y = terrainHeight(x, z) - 0.3;
    trees.push(mat(x, y, z, 4.6, 2.2));
    treeSpots.push({ x, z });
    colliders.addCircle(x, z, 1.4, y, y + 8);
  }
  // Distant forests on the lower valley walls and around the basin (impostor-only distance).
  for (let tries = 0; tries < 20000 && trees.length < 1100; tries++) {
    const z = r(-1250, 700);
    const side = rnd() < 0.5 ? -1 : 1;
    const x = valleyAxis(z) + side * r(150, 520);
    const y = terrainHeight(x, z);
    const n = terrainNormal(x, z, 3);
    if (n[1] < 0.72) continue;
    const forest = fbm(x * 0.006, z * 0.006 + 3, 3);
    if (forest < -0.05 + rnd() * 0.3) continue;
    if (Math.hypot(x - COLOSSUS_POS.x, z - COLOSSUS_POS.z) < 200) continue;
    trees.push(mat(x, y - 0.4, z, r(2.6, 4.2), r(0, 6.28)));
  }

  // Autumn accents: a few groves turn amber/red, and the landmark tree by the start blazes red.
  const AMBER = new THREE.Color(1.0, 0.52, 0.16), RED = new THREE.Color(0.9, 0.22, 0.1), GOLD = new THREE.Color(1.0, 0.74, 0.22);
  const tints: (THREE.Color | null)[] = trees.map((m) => {
    const p = new THREE.Vector3().setFromMatrixPosition(m);
    const k = fbm(p.x * 0.004 + 50, p.z * 0.004 - 20, 2);
    if (k > 0.32) return rnd() < 0.5 ? RED : AMBER;
    if (k > 0.2 && rnd() < 0.5) return GOLD;
    return null;
  });
  const landmark = treeSpots.length - 1;
  tints[landmark] = RED;
  // Distant slopes get a scattering of autumn colour too.
  for (let i = treeSpots.length; i < trees.length; i++) if (!tints[i] && rnd() < 0.1) tints[i] = rnd() < 0.5 ? AMBER : GOLD;

  // Bushes: thickets along grove edges, around ruins and on the stream banks.
  const bushes: THREE.Matrix4[] = [];
  for (let tries = 0; tries < 20000 && bushes.length < 900; tries++) {
    const z = r(PLAY.minZ - 60, PLAY.maxZ + 60);
    const x = valleyAxis(z) + r(-200, 200);
    const nearTree = treeSpots.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < 11 * 11);
    const nearRuin = blockers.some((b) => (x - b.x) ** 2 + (z - b.z) ** 2 < (b.r + 4) ** 2);
    const sd = Math.abs(x - streamX(z));
    const edge = Math.abs(x - valleyAxis(z)) > 90;
    if (!nearTree && !nearRuin && !(sd > 7 && sd < 12) && !(edge && rnd() < 0.3)) continue;
    if (!offRoad(x, z, 4) || !offStream(x, z, 6.5) || blocked(x, z, 0.8)) continue;
    const n = terrainNormal(x, z, 1);
    if (n[1] < 0.8) continue;
    const s = r(0.9, 2.3);
    bushes.push(mat(x, terrainHeight(x, z) - 0.2 * s, z, s, r(0, 6.28), n, 0.5));
  }

  // Root clusters at the feet of valley trees.
  const roots = treeSpots.map((t) => {
    const s = r(1.4, 2.1);
    return mat(t.x, terrainHeight(t.x, t.z) - 0.35, t.z, s, r(0, 6.28));
  });

  // Ferns: in shade near trees and ruins, along the stream banks.
  const ferns: THREE.Matrix4[] = [];
  for (let tries = 0; tries < 30000 && ferns.length < 950; tries++) {
    const z = r(PLAY.minZ - 40, PLAY.maxZ + 30);
    const x = valleyAxis(z) + r(-150, 150);
    const nearTree = treeSpots.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < 14 * 14);
    const nearRuin = blockers.some((b) => (x - b.x) ** 2 + (z - b.z) ** 2 < (b.r + 5) ** 2);
    const sd = Math.abs(x - streamX(z));
    const bank = sd > 6 && sd < 14;
    if (!nearTree && !nearRuin && !bank && rnd() > 0.04) continue;
    if (!offRoad(x, z, 3.5) || !offStream(x, z, 5.5) || blocked(x, z, 0.3)) continue;
    const n = terrainNormal(x, z, 0.8);
    if (n[1] < 0.85) continue;
    ferns.push(mat(x, terrainHeight(x, z) - 0.05, z, r(0.7, 1.4), r(0, 6.28), n, 0.6));
  }

  // Mossy rock clusters across the valley floor and stream banks.
  const rockSets: THREE.Matrix4[][] = [[], []];
  for (let tries = 0; tries < 5000 && rockSets[0].length + rockSets[1].length < 180; tries++) {
    const z = r(PLAY.minZ - 150, PLAY.maxZ + 60);
    const x = valleyAxis(z) + r(-200, 200);
    if (!offRoad(x, z, 4) || blocked(x, z, 2)) continue;
    const n = terrainNormal(x, z, 2);
    const s = r(0.6, 1.8);
    rockSets[rnd() < 0.5 ? 0 : 1].push(mat(x, terrainHeight(x, z) - 0.25 * s, z, s, r(0, 6.28), n, 0.8));
  }

  // Large boulders: scattered in the valley and up the walls.
  const boulders: THREE.Matrix4[] = [];
  for (let tries = 0; tries < 6000 && boulders.length < 90; tries++) {
    const z = r(-700, PLAY.maxZ + 150);
    const x = valleyAxis(z) + (rnd() < 0.5 ? -1 : 1) * r(40, 330);
    if (!offRoad(x, z, 8) || !offStream(x, z, 9) || blocked(x, z, 6)) continue;
    const s = r(2.5, 8) * (Math.abs(x - valleyAxis(z)) > 140 ? 1.8 : 1);
    const y = terrainHeight(x, z) - s * 0.25;
    boulders.push(mat(x, y, z, s, r(0, 6.28)));
    colliders.addCircle(x, z, s * 0.62, y, y + s);
  }

  // Rock outcrops breaking through the valley walls: closed boulder meshes at large scale, deeply embedded.
  const outcrops: THREE.Matrix4[] = [];
  for (let tries = 0; tries < 12000 && outcrops.length < 160; tries++) {
    const z = r(-1150, 760);
    const x = valleyAxis(z) + (rnd() < 0.5 ? -1 : 1) * r(175, 650);
    const n = terrainNormal(x, z, 8);
    if (n[1] > 0.9) continue;
    if (Math.hypot(x - COLOSSUS_POS.x, z - COLOSSUS_POS.z) < 260) continue;
    if (Math.hypot(x - SITES.ring.x, z - SITES.ring.z) < 120) continue;
    const s = r(9, 26);
    // Sink deep and lie with the slope so outcrops read as bedrock breaking the surface.
    outcrops.push(mat(x, terrainHeight(x, z) - s * 0.62, z, s, r(0, 6.28), n, 1));
  }
  // The spring: a jumble of boulders where the stream wells up behind the start.
  for (let i = 0; i < 6; i++) {
    const z = STREAM_SOURCE_Z + 6 + r(-4, 10);
    const x = streamX(STREAM_SOURCE_Z) + r(-9, 9);
    const s = r(2.5, 5.5);
    boulders.push(mat(x, terrainHeight(x, z) - s * 0.3, z, s, r(0, 6.28)));
    colliders.addCircle(x, z, s * 0.6, terrainHeight(x, z) - 1, terrainHeight(x, z) + s);
  }

  // Fallen logs, stumps and dry branches along the valley floor.
  const logs: THREE.Matrix4[] = [], stumps: THREE.Matrix4[] = [], branches: THREE.Matrix4[] = [];
  for (let tries = 0; tries < 8000 && branches.length < 260; tries++) {
    const z = r(PLAY.minZ - 30, PLAY.maxZ + 30);
    const x = valleyAxis(z) + r(-140, 140);
    if (!offRoad(x, z, 3) || !offStream(x, z, 6) || blocked(x, z, 1)) continue;
    const n = terrainNormal(x, z, 1.2);
    if (n[1] < 0.88) continue;
    const y = terrainHeight(x, z);
    const nearTree = treeSpots.some((t) => (t.x - x) ** 2 + (t.z - z) ** 2 < 20 * 20);
    if (logs.length < 34 && rnd() < 0.08) {
      const s = r(1.6, 2.6);
      logs.push(mat(x, y - 0.2 * s, z, s, r(0, 6.28), n, 1));
      colliders.addCircle(x, z, 0.9, y - 0.5, y + 0.7);
    } else if (stumps.length < 26 && nearTree && rnd() < 0.15) {
      const s = r(1.0, 1.6);
      stumps.push(mat(x, y - 0.1, z, s, r(0, 6.28)));
      colliders.addCircle(x, z, 0.6 * s, y, y + 0.5 * s);
    } else if (nearTree || rnd() < 0.3) {
      branches.push(mat(x, y + 0.02, z, r(0.8, 1.5), r(0, 6.28), n, 1));
    }
  }

  return { trees, tints, bushes, roots, ferns, rockSets, boulders, outcrops, logs, stumps, branches, treeSpots };
}

/** Dust and pollen motes drifting in the light around the player. */
export class Motes {
  readonly points: THREE.Points;
  private pos: Float32Array;
  private seeds: Float32Array;
  constructor(count = 260) {
    this.pos = new Float32Array(count * 3);
    this.seeds = new Float32Array(count);
    const rnd = mulberry32(5);
    for (let i = 0; i < count; i++) { this.pos.set([rnd() * 40 - 20, rnd() * 8, rnd() * 40 - 20], i * 3); this.seeds[i] = rnd() * 100; }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    // Soft round glints (not squares) that only light up where the sun actually falls.
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const ctx = c.getContext('2d')!;
    const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);
    const sprite = new THREE.CanvasTexture(c);
    const m = new THREE.PointsMaterial({ color: 0xffe2b0, map: sprite, size: 0.07, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending, fog: true });
    m.onBeforeCompile = (sh) => {
      sh.fragmentShader = sh.fragmentShader.replace('#include <fog_fragment>', `
        #ifdef USE_FOG
          float lit = smoothstep(0.55, 0.95, cloudLight(vFogWorldPos));
          gl_FragColor.a *= 0.15 + 0.85 * lit;
        #endif
        #include <fog_fragment>`);
    };
    this.points = new THREE.Points(g, m);
    this.points.frustumCulled = false;
  }
  update(t: number, center: THREE.Vector3) {
    const p = this.pos;
    for (let i = 0; i < this.seeds.length; i++) {
      const s = this.seeds[i];
      let x = p[i * 3] + Math.sin(t * 0.3 + s) * 0.004 + 0.006;
      let y = p[i * 3 + 1] + Math.sin(t * 0.5 + s * 1.3) * 0.003;
      let z = p[i * 3 + 2] + Math.cos(t * 0.27 + s) * 0.004;
      // Wrap around the player.
      const dx = x - center.x, dz = z - center.z;
      if (dx > 20) x -= 40; else if (dx < -20) x += 40;
      if (dz > 20) z -= 40; else if (dz < -20) z += 40;
      const gy = terrainHeight(x, z);
      if (y < gy + 0.2 || y > gy + 9) y = gy + 0.5 + (s % 1) * 6;
      p[i * 3] = x; p[i * 3 + 1] = y; p[i * 3 + 2] = z;
    }
    (this.points.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
  }
}

export { SITES };
