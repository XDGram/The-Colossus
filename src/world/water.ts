import * as THREE from 'three';
import { streamX, waterY, POOL, STREAM_SOURCE_Z } from './heightfield';

/** Tileable procedural normal map (sum of integer-frequency waves) so no external water texture is needed. */
function makeWaterNormals(size = 256) {
  const data = new Uint8Array(size * size * 4);
  const waves: [number, number, number, number][] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 24; i++) {
    const f = 1 + Math.floor(rnd() * (3 + i));
    const a = rnd() * Math.PI * 2;
    waves.push([Math.round(Math.cos(a) * f), Math.round(Math.sin(a) * f), rnd() * Math.PI * 2, 1 / (f * 0.8 + 1)]);
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    let dx = 0, dy = 0;
    for (const [kx, ky, ph, amp] of waves) {
      const c = Math.cos(2 * Math.PI * (kx * u + ky * v) + ph) * amp * 2 * Math.PI;
      dx += c * kx; dy += c * ky;
    }
    const s = 0.012;
    const n = new THREE.Vector3(-dx * s, -dy * s, 1).normalize();
    const i = (y * size + x) * 4;
    data[i] = (n.x * 0.5 + 0.5) * 255; data[i + 1] = (n.y * 0.5 + 0.5) * 255; data[i + 2] = (n.z * 0.5 + 0.5) * 255; data[i + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.needsUpdate = true;
  return t;
}

export class Water {
  readonly group = new THREE.Group();
  private time = { value: 0 };

  constructor() {
    const normals = makeWaterNormals();
    const mat = new THREE.MeshStandardMaterial({
      color: new THREE.Color(0x141c18), roughness: 0.08, metalness: 0.0, envMapIntensity: 1.2,
      transparent: true, opacity: 0.82, normalMap: normals, normalScale: new THREE.Vector2(1.1, 1.1),
    });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = this.time;
      sh.vertexShader = sh.vertexShader.replace('#include <common>', '#include <common>\nattribute float aFlow;\nvarying float vFlow;')
        .replace('#include <uv_vertex>', '#include <uv_vertex>\nvFlow = aFlow;');
      // Two scrolling normal layers flowing downstream; the pool (aFlow = 0) just ripples gently.
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform float uTime;\nvarying float vFlow;')
        .replace('#include <normal_fragment_maps>', /* glsl */ `
          vec2 fuv = vNormalMapUv;
          vec3 n1 = texture2D(normalMap, fuv * vec2(1.0, 0.6) + vec2(0.0, uTime * 0.32 * vFlow + uTime * 0.01)).xyz * 2.0 - 1.0;
          vec3 n2 = texture2D(normalMap, fuv * 0.37 + vec2(uTime * 0.013, uTime * 0.18 * vFlow)).xyz * 2.0 - 1.0;
          vec3 mapN = normalize(vec3((n1.xy + n2.xy) * normalScale, n1.z * n2.z));
          normal = normalize( tbn * mapN );`);
    };

    // Stream ribbon from behind the start down to the pool, sampled every 2m.
    const pos: number[] = [], uv: number[] = [], flow: number[] = [], idx: number[] = [];
    const halfW = 8;
    let v = 0, prevX = streamX(STREAM_SOURCE_Z), prevZ = STREAM_SOURCE_Z;
    for (let z = STREAM_SOURCE_Z, k = 0; z >= POOL.z; z -= 2, k++) {
      const x = streamX(z), y = waterY(z);
      v += Math.hypot(x - prevX, z - prevZ) / 6;
      prevX = x; prevZ = z;
      // Tangent-perpendicular so the ribbon keeps its width around bends.
      const tx = streamX(z - 1) - streamX(z + 1), tz = -2;
      const l = Math.hypot(tx, tz);
      const px = -tz / l, pz = tx / l;
      pos.push(x - px * halfW, y, z - pz * halfW, x + px * halfW, y, z + pz * halfW);
      uv.push(0, v, (halfW * 2) / 6, v);
      const f = Math.min(1, (z - POOL.z) / 30);
      flow.push(f, f);
      if (k > 0) { const a = (k - 1) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aFlow', new THREE.Float32BufferAttribute(flow, 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    g.computeTangents?.();
    const stream = new THREE.Mesh(g, mat);
    stream.renderOrder = 1;
    this.group.add(stream);

    const pg = new THREE.CircleGeometry(POOL.r * 1.05, 64).rotateX(-Math.PI / 2);
    pg.scale(1, 1, 1 / 0.85);
    const puv = pg.getAttribute('uv') as THREE.BufferAttribute;
    for (let i = 0; i < puv.count; i++) puv.setXY(i, puv.getX(i) * 10, puv.getY(i) * 10);
    pg.setAttribute('aFlow', new THREE.Float32BufferAttribute(new Float32Array(puv.count), 1));
    const pool = new THREE.Mesh(pg, mat);
    pool.position.set(POOL.x, waterY(POOL.z) - 0.02, POOL.z);
    pool.renderOrder = 1;
    this.group.add(pool);
  }

  update(t: number) { this.time.value = t; }
}
