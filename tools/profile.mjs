// Per-category visible triangle/draw breakdown from the player's start view.
import { createRequire } from 'module';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const quality = process.argv[2] || 'high';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 640, height: 360 } });
p.setDefaultTimeout(600000);
await p.goto(`http://localhost:5173/?debug&quality=${quality}`);
await p.waitForFunction(() => window.__tlc?.ready, null, { timeout: 900000, polling: 2000 });
const r = await p.evaluate(() => {
  const { scene, camera, renderer } = window.__tlc;
  camera.updateMatrixWorld();
  const F = camera.projectionMatrix.clone().multiply(camera.matrixWorldInverse);
  const planes = []; const e = F.elements;
  const mk = (a, b, c, d) => { const l = Math.hypot(a, b, c); planes.push([a / l, b / l, c / l, d / l]); };
  mk(e[3] - e[0], e[7] - e[4], e[11] - e[8], e[15] - e[12]); mk(e[3] + e[0], e[7] + e[4], e[11] + e[8], e[15] + e[12]);
  mk(e[3] + e[1], e[7] + e[5], e[11] + e[9], e[15] + e[13]); mk(e[3] - e[1], e[7] - e[5], e[11] - e[9], e[15] - e[13]);
  mk(e[3] - e[2], e[7] - e[6], e[11] - e[10], e[15] - e[14]); mk(e[3] + e[2], e[7] + e[6], e[11] + e[10], e[15] + e[14]);
  const out = {}, draws = {};
  scene.traverseVisible((o) => {
    if (!o.isMesh && !o.isPoints) return;
    const g = o.geometry;
    if (o.frustumCulled) {
      if (!g.boundingSphere) g.computeBoundingSphere();
      const s = (o.isInstancedMesh && o.boundingSphere) ? o.boundingSphere.clone() : g.boundingSphere.clone();
      s.applyMatrix4(o.matrixWorld);
      if (planes.some(([a, b, c, d]) => a * s.center.x + b * s.center.y + c * s.center.z + d < -s.radius)) return;
    }
    const tri = (g.index ? g.index.count : g.attributes.position.count) / 3;
    const n = o.isInstancedMesh ? o.count : (g.isInstancedBufferGeometry ? g.instanceCount : 1);
    const name = (o.material.name || o.material.type) + (o.isInstancedMesh ? '[I]' : '');
    out[name] = (out[name] || 0) + tri * n; draws[name] = (draws[name] || 0) + 1;
  });
  renderer.render(scene, camera);
  const tot = Object.values(out).reduce((a, b) => a + b, 0);
  return [`TOTAL main-pass ${(tot / 1e6).toFixed(2)}M tris, renderer.info ${renderer.info.render.calls} calls ${(renderer.info.render.triangles / 1e6).toFixed(2)}M tris (incl. shadow)`,
    ...Object.entries(out).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${(v / 1e3).toFixed(0)}k tris, ${draws[k]} draws`)];
});
console.log(r.join('\n'));
await b.close();
