import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(process.argv[2]);
for (const m of doc.getRoot().listMeshes()) for (const p of m.listPrimitives()) {
  const idx = p.getIndices().getArray(); const n = p.getAttribute('POSITION').getCount();
  const par = new Int32Array(n).map((_, i) => i); const f = x => { while (par[x] !== x) x = par[x] = par[par[x]]; return x; };
  for (let i = 0; i < idx.length; i += 3) { const a = f(idx[i]), b = f(idx[i+1]), c = f(idx[i+2]); par[b] = a; par[f(c)] = a; }
  const comps = new Set(); for (let i = 0; i < n; i++) comps.add(f(i));
  console.log(p.getMaterial().getName(), 'tris', idx.length/3, 'islands', comps.size);
}
