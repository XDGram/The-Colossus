// usage: node tools/shot.mjs <url> <out.png> [w h] [waitMs]
import { createRequire } from 'module';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const [url, out, w = 800, h = 600, wait = 0] = process.argv.slice(2);
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: +w, height: +h } });
p.on('console', m => console.log('[page]', m.text())); p.on('pageerror', e => console.log('[err]', e.message));
await p.goto(url); await p.waitForFunction(() => document.title.startsWith('done') || document.title.startsWith('err'), null, { timeout: 600000 });
if (+wait) await p.waitForTimeout(+wait);
console.log(await p.title()); await p.screenshot({ path: out }); await b.close();
