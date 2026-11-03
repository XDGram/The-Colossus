// Captures character preview shots: node tools/charshots.mjs <outDir> [plain]
import { createRequire } from 'module';
import fs from 'fs';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const [out, plain] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 700, height: 900 } });
p.setDefaultTimeout(600000);
p.on('pageerror', (e) => console.log('ERR', e.message));
await p.goto(`http://localhost:5173/tools/char/${plain ? '?plain' : ''}`);
await p.waitForFunction(() => document.title === 'ready');
const shots = [['front', 'Idle_Loop', 0.5, 0], ['three_quarter', 'Idle_Loop', 0.5, 0.75], ['side', 'Idle_Loop', 0.5, 1.57], ['back', 'Idle_Loop', 0.5, 3.0], ['walk', 'Walk_Loop', 0.4, 1.0], ['jog', 'Jog_Fwd_Loop', 0.3, 1.1], ['sprint', 'Sprint_Loop', 0.2, 0.9], ['face', 'Idle_Loop', 0.5, 0.4, 1.2, 1.62, 1.55]];
for (const [name, clip, t, yaw, dist, h, look] of shots) {
  const url = await p.evaluate((a) => window.shot(...a), [clip, t, yaw, dist, h, look].filter((x) => x !== undefined));
  fs.writeFileSync(`${out}/${name}.jpg`, Buffer.from(url.split(',')[1], 'base64'));
}
console.log('ok');
await b.close();
