// prints useful viewpoints (computed from the layout) as JSON for playtest
import { pathX, SITES, COLOSSUS_POS, PLAY, BRIDGE_Z, streamX } from '../src/world/heightfield.ts';
const yawTo = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));
const V = [];
const add = (name, x, z, tx, tz, pitch = -0.04, dist = 4.6, frames = 40) => V.push({ name, x, z, yaw: yawTo(x, z, tx, tz), pitch, dist, face: yawTo(x, z, tx, tz) + Math.PI, frames });
const s = PLAY.start;
add('01_start', s.x, s.z, COLOSSUS_POS.x, COLOSSUS_POS.z, -0.02);
add('02_gate', pathX(352), 352, SITES.gate.x, SITES.gate.z, -0.06, 5);
add('03_colonnade', pathX(210), 210, pathX(150), 150, -0.05, 4.5);
add('04_terrace', SITES.terrace.x - 30, SITES.terrace.z + 18, SITES.terrace.x, SITES.terrace.z, -0.1, 6);
add('05_bridge', streamX(BRIDGE_Z) + 30, BRIDGE_Z + 25, streamX(BRIDGE_Z), BRIDGE_Z, -0.05, 5);
add('06_ring', SITES.ring.x + 5, SITES.ring.z + 40, COLOSSUS_POS.x, COLOSSUS_POS.z, 0.02, 5);
add('07_player_close', pathX(100), 100, pathX(60), 60, -0.15, 2.8);
add('08_back_view', pathX(-50), -50, s.x, s.z, -0.05, 5);
console.log(JSON.stringify(V));
