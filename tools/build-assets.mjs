// Converts source downloads in assets-src/ into optimized runtime assets in public/assets/.
// Run: node tools/build-assets.mjs
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { dedup, prune, weld, textureCompress, join, flatten, resample, reorder, quantize } from '@gltf-transform/functions';
import { MeshoptSimplifier, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const SRC = path.join(ROOT, 'assets-src');
const OUT = path.join(ROOT, 'public', 'assets');
await MeshoptSimplifier.ready; await MeshoptEncoder.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
const only = process.argv.slice(2);
const want = (n) => !only.length || only.includes(n);

const islandsOf = (P, I, n) => {
  const par = new Int32Array(n).map((_, i) => i);
  const f = (x) => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  for (let i = 0; i < I.length; i += 3) { const a = f(I[i]); par[f(I[i + 1])] = a; par[f(I[i + 2])] = a; }
  const groups = new Map();
  for (let t = 0; t < I.length; t += 3) { const r = f(I[t]); (groups.get(r) ?? groups.set(r, []).get(r)).push(t); }
  return [...groups.values()];
};

/**
 * Replaces every alpha-card island (a leaf or frond) with a single flat quad: plane from the island's
 * average normal, axes from its longest extent, UVs from a least-squares affine fit of the original UVs.
 * Keeps every Nth card and grows the kept ones so the silhouette keeps its density.
 */
function islandsToQuads(prim, keepEvery = 1, grow = 1) {
  const P = prim.getAttribute('POSITION').getArray(), U = prim.getAttribute('TEXCOORD_0').getArray();
  const I = prim.getIndices().getArray();
  const groups = islandsOf(P, I, P.length / 3);
  const pos = [], nor = [], uv = [], idx = [];
  const v = (i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  groups.forEach((tris, gi) => {
    if (((gi * 2654435761) >>> 0) % keepEvery !== 0) return;
    const verts = [...new Set(tris.flatMap((t) => [I[t], I[t + 1], I[t + 2]]))];
    const c = [0, 0, 0]; for (const i of verts) { const p = v(i); c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
    c[0] /= verts.length; c[1] /= verts.length; c[2] /= verts.length;
    const n = [0, 0, 0];
    for (const t of tris) {
      const a = v(I[t]), b = v(I[t + 1]), d = v(I[t + 2]);
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      n[0] += e1[1] * e2[2] - e1[2] * e2[1]; n[1] += e1[2] * e2[0] - e1[0] * e2[2]; n[2] += e1[0] * e2[1] - e1[1] * e2[0];
    }
    const nl = Math.hypot(...n) || 1; n[0] /= nl; n[1] /= nl; n[2] /= nl;
    // Longest in-plane direction.
    let ua = [1, 0, 0], best = -1;
    for (const i of verts) {
      const p = v(i); const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
      const dn = d[0] * n[0] + d[1] * n[1] + d[2] * n[2];
      const q = [d[0] - dn * n[0], d[1] - dn * n[1], d[2] - dn * n[2]];
      const l = Math.hypot(...q); if (l > best) { best = l; ua = q.map((x) => x / (l || 1)); }
    }
    const va = [n[1] * ua[2] - n[2] * ua[1], n[2] * ua[0] - n[0] * ua[2], n[0] * ua[1] - n[1] * ua[0]];
    let s0 = Infinity, s1 = -Infinity, t0 = Infinity, t1 = -Infinity;
    // Least squares: uv = A * [s, t, 1].
    const M = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], bu = [0, 0, 0], bv = [0, 0, 0];
    for (const i of verts) {
      const p = v(i); const d = [p[0] - c[0], p[1] - c[1], p[2] - c[2]];
      const s = d[0] * ua[0] + d[1] * ua[1] + d[2] * ua[2], t = d[0] * va[0] + d[1] * va[1] + d[2] * va[2];
      s0 = Math.min(s0, s); s1 = Math.max(s1, s); t0 = Math.min(t0, t); t1 = Math.max(t1, t);
      const r = [s, t, 1];
      for (let a = 0; a < 3; a++) { for (let b = 0; b < 3; b++) M[a][b] += r[a] * r[b]; bu[a] += r[a] * U[i * 2]; bv[a] += r[a] * U[i * 2 + 1]; }
    }
    const solve = (A, bb) => {
      const m = A.map((row, i) => [...row, bb[i]]);
      for (let i = 0; i < 3; i++) {
        let piv = i; for (let k = i + 1; k < 3; k++) if (Math.abs(m[k][i]) > Math.abs(m[piv][i])) piv = k;
        [m[i], m[piv]] = [m[piv], m[i]];
        const d = m[i][i] || 1e-9;
        for (let k = i; k < 4; k++) m[i][k] /= d;
        for (let r = 0; r < 3; r++) if (r !== i) { const f = m[r][i]; for (let k = i; k < 4; k++) m[r][k] -= f * m[i][k]; }
      }
      return m.map((row) => row[3]);
    };
    const cu = solve(M, bu), cv = solve(M, bv);
    const base = pos.length / 3;
    for (const [s, t] of [[s0, t0], [s1, t0], [s1, t1], [s0, t1]]) {
      const gs = s * grow, gt = t * grow;
      pos.push(c[0] + ua[0] * gs + va[0] * gt, c[1] + ua[1] * gs + va[1] * gt, c[2] + ua[2] * gs + va[2] * gt);
      nor.push(n[0], n[1], n[2]);
      uv.push(cu[0] * s + cu[1] * t + cu[2], cv[0] * s + cv[1] * t + cv[2]);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });
  prim.getAttribute('POSITION').setArray(new Float32Array(pos));
  prim.getAttribute('NORMAL').setArray(new Float32Array(nor));
  prim.getAttribute('TEXCOORD_0').setArray(new Float32Array(uv));
  for (const sem of prim.listSemantics()) if (!['POSITION', 'NORMAL', 'TEXCOORD_0'].includes(sem)) prim.setAttribute(sem, null);
  prim.getIndices().setArray(new Uint32Array(idx));
}

/** Vertex-clustering decimation (robust on noisy photoscans). Cell size is a fraction of the bbox diagonal. */
function clusterPrim(prim, frac) {
  const P = prim.getAttribute('POSITION').getArray(); const I = prim.getIndices().getArray();
  const n = P.length / 3;
  let mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i++) for (let a = 0; a < 3; a++) { mn[a] = Math.min(mn[a], P[i * 3 + a]); mx[a] = Math.max(mx[a], P[i * 3 + a]); }
  const cell = Math.hypot(mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]) * frac;
  const map = new Map(); const rep = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const k = `${Math.floor(P[i * 3] / cell)},${Math.floor(P[i * 3 + 1] / cell)},${Math.floor(P[i * 3 + 2] / cell)}`;
    if (!map.has(k)) map.set(k, i);
    rep[i] = map.get(k);
  }
  const out = []; const seen = new Set();
  for (let t = 0; t < I.length; t += 3) {
    const a = rep[I[t]], b = rep[I[t + 1]], c = rep[I[t + 2]];
    if (a === b || b === c || a === c) continue;
    const key = [a, b, c].sort((x, y) => x - y).join(',');
    if (seen.has(key)) continue; seen.add(key);
    out.push(a, b, c);
  }
  prim.getIndices().setArray(new Uint32Array(out));
  compact(prim);
}

function compact(prim) {
  const I = prim.getIndices().getArray();
  const n = prim.getAttribute('POSITION').getCount();
  const remap = new Int32Array(n).fill(-1); let k = 0;
  for (let i = 0; i < I.length; i++) if (remap[I[i]] < 0) remap[I[i]] = k++;
  for (const sem of prim.listSemantics()) {
    const acc = prim.getAttribute(sem); const sz = acc.getElementSize(); const src = acc.getArray();
    const dst = new src.constructor(k * sz);
    for (let i = 0; i < n; i++) if (remap[i] >= 0) for (let c = 0; c < sz; c++) dst[remap[i] * sz + c] = src[i * sz + c];
    acc.setArray(dst);
  }
  prim.getIndices().setArray(new Uint32Array(Array.from(I, (i) => remap[i])));
}

/** Bakes a separate alpha map into the base colour texture of matching materials (PNG RGBA, alpha-tested). */
async function bakeAlpha(doc, matRe, diffPng, alphaPng) {
  for (const mat of doc.getRoot().listMaterials()) {
    if (!matRe.test(mat.getName())) continue;
    const rgb = await sharp(diffPng).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    const a = await sharp(alphaPng).resize(rgb.info.width, rgb.info.height).greyscale().raw().toBuffer();
    const px = Buffer.alloc(rgb.info.width * rgb.info.height * 4);
    for (let i = 0; i < rgb.info.width * rgb.info.height; i++) {
      px[i * 4] = rgb.data[i * 3]; px[i * 4 + 1] = rgb.data[i * 3 + 1]; px[i * 4 + 2] = rgb.data[i * 3 + 2]; px[i * 4 + 3] = a[i];
    }
    const png = await sharp(px, { raw: { width: rgb.info.width, height: rgb.info.height, channels: 4 } }).png().toBuffer();
    const tex = doc.createTexture(mat.getName() + '_rgba').setImage(new Uint8Array(png)).setMimeType('image/png');
    mat.setBaseColorTexture(tex).setAlphaMode('MASK').setAlphaCutoff(0.5).setDoubleSided(true);
  }
}

async function model(outName, srcFile, { lod = {}, texSize = 1024, alpha } = {}) {
  if (!want(outName.replace(/_lod\d$/, ''))) return;
  const doc = await io.read(srcFile);
  if (alpha) await bakeAlpha(doc, alpha.match, alpha.diffuse, alpha.alpha);
  await doc.transform(dedup(), flatten(), weld());
  for (const mesh of doc.getRoot().listMeshes()) for (const prim of mesh.listPrimitives()) {
    const card = alpha && alpha.match.test(prim.getMaterial()?.getName() || '');
    if (card && lod.quads) islandsToQuads(prim, lod.quads.keepEvery, lod.quads.grow);
    else if (!card && lod.cluster) clusterPrim(prim, lod.cluster);
    else if (card && lod.cardCluster) clusterPrim(prim, lod.cardCluster);
  }
  await doc.transform(join(), textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [texSize, texSize], quality: 82 }),
    reorder({ encoder: MeshoptEncoder }), quantize(), prune());
  doc.createExtension(EXTMeshoptCompression).setRequired(true).setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const out = path.join(OUT, 'models', `${outName}.glb`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await io.write(out, doc);
  let tris = 0; for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) tris += (p.getIndices()?.getCount() ?? 0) / 3;
  console.log(`${outName}.glb  ${(fs.statSync(out).size / 1024).toFixed(0)} KB  ${tris.toFixed(0)} tris`);
}

const ph = (id) => path.join(SRC, 'polyhaven', id, `${id}_1k.gltf`);
const phTex = (id, f) => path.join(SRC, 'polyhaven', id, 'textures', f);
/** Builds LOD0..LOD2 for a model. */
async function lods(id, specs, opts = {}) {
  const names = ['', '_lod1', '_lod2'];
  for (let i = 0; i < specs.length; i++) if (specs[i]) await model(id + names[i], ph(opts.src ?? id), { ...opts, lod: specs[i], texSize: i === 0 ? opts.texSize ?? 1024 : 512 });
}

const treeAlpha = { match: /leaves/i, diffuse: phTex('island_tree_02', 'island_tree_02_leaves_diff_1k.jpg'), alpha: phTex('island_tree_02', 'island_tree_02_leaves_alpha_1k.png') };
const fernAlpha = { match: /fern/i, diffuse: phTex('fern_02', 'fern_02_diff_1k.jpg'), alpha: phTex('fern_02', 'fern_02_Alpha_1k.png') };

// Hero tree (near): every second leaf card as a quad + decimated branches. Far trees use runtime impostors.
if (want('tree_hero')) await model('tree_hero', ph('island_tree_02'), { alpha: treeAlpha, lod: { quads: { keepEvery: 2, grow: 1.22 }, cluster: 0.009 } });
// Rocks and cliffs.
await lods('boulder_01', [{ cluster: 0.0025 }, { cluster: 0.022 }, { cluster: 0.06 }]);
for (const id of ['rock_moss_set_01', 'rock_moss_set_02']) await lods(id, [{ cluster: 0.022 }, { cluster: 0.05 }, { cluster: 0.1 }]);
// Ground detail.
await lods('fern_02', [{}, { quads: { keepEvery: 1, grow: 1.0 } }], { alpha: fernAlpha, texSize: 512 });
await lods('root_cluster_01', [{ cluster: 0.008 }, { cluster: 0.03 }]);
await lods('tree_stump_01', [{ cluster: 0.008 }, { cluster: 0.04 }], { texSize: 512 });
await lods('dead_tree_trunk_02', [{ cluster: 0.006 }, { cluster: 0.03 }], { texSize: 512 });
await lods('dry_branches_medium_01', [{ cluster: 0.01 }, { cluster: 0.04 }], { texSize: 512 });

// Player character: Quaternius Male Ranger outfit + Universal Animation Library locomotion clips.
if (want('ranger')) {
  const Q = path.join(SRC, 'quaternius');
  const char = await io.read(path.join(Q, 'outfits/Modular Character Outfits - Fantasy[Standard]/Exports/glTF (Godot-Unreal)/Outfits/Male_Ranger.gltf'));
  const anim = await io.read(path.join(Q, 'ual/Universal Animation Library[Standard]/Unreal-Godot/UAL1_Standard.glb'));
  const keepClips = new Set(['Idle_Loop', 'Walk_Loop', 'Jog_Fwd_Loop', 'Sprint_Loop']);
  const byName = new Map(char.getRoot().listNodes().map((n) => [n.getName(), n]));
  for (const a of anim.getRoot().listAnimations()) {
    if (!keepClips.has(a.getName())) continue;
    const na = char.createAnimation(a.getName());
    for (const ch of a.listChannels()) {
      const target = byName.get(ch.getTargetNode()?.getName()); if (!target) continue;
      const s = ch.getSampler();
      const cp = (acc) => char.createAccessor().setType(acc.getType()).setArray(acc.getArray().slice());
      const ns = char.createAnimationSampler().setInput(cp(s.getInput())).setOutput(cp(s.getOutput())).setInterpolation(s.getInterpolation());
      na.addSampler(ns).addChannel(char.createAnimationChannel().setTargetNode(target).setTargetPath(ch.getTargetPath()).setSampler(ns));
    }
  }
  const buf = char.getRoot().listBuffers()[0];
  for (const acc of char.getRoot().listAccessors()) acc.setBuffer(buf);
  await char.transform(dedup(), resample(), textureCompress({ encoder: sharp, targetFormat: 'webp', resize: [1024, 1024], quality: 85 }), prune());
  const out = path.join(OUT, 'models', 'ranger.glb');
  await io.write(out, char);
  console.log(`ranger.glb  ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}

// PBR texture sets for terrain, ruins and the Colossus.
async function texSet(id, size = 1024) {
  if (!want(id)) return;
  const dir = path.join(SRC, 'ambientcg', id); const base = path.join(dir, `${id}_1K-JPG`);
  const out = path.join(OUT, 'textures', id.toLowerCase()); fs.mkdirSync(out, { recursive: true });
  await sharp(`${base}_Color.jpg`).resize(size, size).webp({ quality: 85 }).toFile(path.join(out, 'color.webp'));
  await sharp(`${base}_NormalGL.jpg`).resize(size, size).webp({ quality: 90 }).toFile(path.join(out, 'normal.webp'));
  // R = ambient occlusion, G = roughness, B = displacement/height (used for height-based blending).
  const ch = async (suf) => fs.existsSync(`${base}_${suf}.jpg`)
    ? sharp(`${base}_${suf}.jpg`).resize(size, size).greyscale().raw().toBuffer() : Buffer.alloc(size * size, suf === 'AmbientOcclusion' ? 255 : 128);
  const [ao, ro, he] = await Promise.all([ch('AmbientOcclusion'), ch('Roughness'), ch('Displacement')]);
  const px = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i++) { px[i*3] = ao[i]; px[i*3+1] = ro[i]; px[i*3+2] = he[i]; }
  await sharp(px, { raw: { width: size, height: size, channels: 3 } }).webp({ quality: 90 }).toFile(path.join(out, 'arh.webp'));
  console.log('textures/', id.toLowerCase());
}
for (const t of ['Ground037', 'Grass004', 'Ground067', 'Rock051', 'Rock030', 'Rock064', 'Bark014']) await texSet(t);

if (want('hdri')) {
  fs.mkdirSync(path.join(OUT, 'hdri'), { recursive: true });
  fs.copyFileSync(path.join(SRC, 'polyhaven/hdri/qwantani_late_afternoon_puresky.hdr'), path.join(OUT, 'hdri/sky_2k.hdr'));
  console.log('hdri/sky_2k.hdr');
}
