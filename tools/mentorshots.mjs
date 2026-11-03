// Captures mentor preview shots: node tools/mentorshots.mjs <outDir>
import { createRequire } from 'module';
import fs from 'fs';
const { chromium } = createRequire('/opt/node22/lib/node_modules/')('playwright');
const [out] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const p = await b.newPage({ viewport: { width: 700, height: 900 } });
p.setDefaultTimeout(900000);
p.on('pageerror', (e) => console.log('ERR', e.message));
p.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text()); });
await p.goto('http://localhost:5173/tools/mentor/' + (process.env.Q || ''));
await p.waitForFunction(() => document.title === 'ready', null, { polling: 1000 });
const shots = JSON.parse(process.env.SHOTS || '[]');
for (const [name, ...args] of shots) {
  const url = await p.evaluate((a) => window.shot(...a), args);
  fs.writeFileSync(`${out}/${name}.jpg`, Buffer.from(url.split(',')[1], 'base64'));
}
console.log('ok');
await b.close();
