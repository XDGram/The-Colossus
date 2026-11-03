// node tools/animshots.mjs <outDir>  (SHOTS='[[name, which, clip, t, yaw, dist, h, look]]', ANALYSE='[[which, clip]]')
import { createRequire } from 'module'; import fs from 'fs';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const [out] = process.argv.slice(2); fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 640, height: 800 } }); p.setDefaultTimeout(900000);
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto('http://localhost:5173/tools/animprev/' + (process.env.Q || ''));
await p.waitForFunction(() => document.title === 'ready', null, { polling: 500 });
for (const [name, ...args] of JSON.parse(process.env.SHOTS || '[]')) {
  const url = await p.evaluate((a) => window.shot(...a), args);
  fs.writeFileSync(`${out}/${name}.jpg`, Buffer.from(url.split(',')[1], 'base64'));
}
for (const [which, clip] of JSON.parse(process.env.ANALYSE || '[]')) fs.writeFileSync(`${out}/${which}_${clip}.json`, JSON.stringify(await p.evaluate((a) => window.analyse(...a), [which, clip])));
console.log('ok'); await b.close();
