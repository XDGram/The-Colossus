import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Colliders } from '../world/colliders';

/**
 * Enterable Japanese-style building kit. A building is generated from a spec: raised floor, plaster-and-
 * timber walls with real door/window openings, interior partitions with doorways, sliding shoji screens,
 * posts, beams, verandas, stairs, and a curved hip roof. Every solid part gets a collider; floors,
 * verandas and steps are walkable. Roof and interior detail are separate groups so the roof can be cut
 * away when the player is inside and furnishings can be culled by distance.
 *
 * Local frame: the building is centred on the origin, its FRONT faces local +z. `rot` turns it in the world
 * the same way as Object3D.rotation.y.
 */

export type Screen = 'open' | 'half' | 'closed' | 'none' | 'lattice';
export interface Opening { at: number; width: number; bottom?: number; top?: number; screen?: Screen }
export interface BuildingSpec {
  name: string;
  x: number; z: number; rot: number;
  w: number; d: number;
  /** Floor height above the ground. */
  base: number;
  wallH: number;
  front?: Opening[]; back?: Opening[]; left?: Opening[]; right?: Opening[];
  /** Interior walls parallel to local z at a given local x, and parallel to local x at a given local z. */
  partX?: { x: number; from?: number; to?: number; openings: Opening[] }[];
  partZ?: { z: number; from?: number; to?: number; openings: Opening[] }[];
  /** Open veranda width around the building (floor and roof extend over it). */
  veranda?: number;
  stairs?: { side: 'front' | 'back' | 'left' | 'right'; at: number; width: number }[];
  roof: { kind: 'hip' | 'hip2' | 'none'; height: number; overhang: number };
  /** Skip exterior walls entirely (open pavilions); posts only. */
  open?: boolean;
  /** Extra posts spacing for colonnades. */
  postSpacing?: number;
  light?: boolean;
  /** Height of a timber board panel at the base of exterior walls (koshi-ita). */
  wainscot?: number;
  /** Exterior wall finish: plaster panels, solid timber boards, or timber below / plaster above. */
  walls?: 'plaster' | 'timber';
  /** Two-tier roofs: a walkable-looking balcony with railing around the upper storey. */
  balcony?: boolean;
  furnish?: (b: Builder) => void;
}

export const MAT = {
  timber: new THREE.MeshStandardMaterial({ color: 0x2b1e15, roughness: 0.82, name: 'k-timber' }),
  plaster: new THREE.MeshStandardMaterial({ color: 0xd8d0bf, roughness: 0.95, name: 'k-plaster' }),
  stone: new THREE.MeshStandardMaterial({ color: 0x8b867d, roughness: 0.92, name: 'k-stone' }),
  floor: new THREE.MeshStandardMaterial({ color: 0x5e4029, roughness: 0.7, name: 'k-floor' }),
  tatami: new THREE.MeshStandardMaterial({ color: 0xa3966a, roughness: 0.9, name: 'k-tatami' }),
  roof: new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.62, metalness: 0.1, name: 'k-roof', side: THREE.DoubleSide }),
  eave: new THREE.MeshStandardMaterial({ color: 0x241910, roughness: 0.85, name: 'k-eave', side: THREE.DoubleSide }),
  shoji: new THREE.MeshStandardMaterial({ color: 0xeee3cb, roughness: 0.9, emissive: new THREE.Color(0x3a2f20), name: 'k-shoji' }),
  cloth: new THREE.MeshStandardMaterial({ color: 0xe8dfcc, roughness: 1, side: THREE.DoubleSide, name: 'k-cloth' }),
  lacquer: new THREE.MeshStandardMaterial({ color: 0x5a1e14, roughness: 0.5, name: 'k-lacquer' }),
  gold: new THREE.MeshStandardMaterial({ color: 0x8a6a2a, roughness: 0.4, metalness: 0.6, name: 'k-gold' }),
  glow: new THREE.MeshStandardMaterial({ color: 0xffe2b0, emissive: new THREE.Color(0xffb35a), emissiveIntensity: 1.6, roughness: 0.8, name: 'k-glow' }),
};
type MatKey = keyof typeof MAT;

export class Builder {
  readonly shell = new Map<MatKey, THREE.BufferGeometry[]>();
  readonly roof = new Map<MatKey, THREE.BufferGeometry[]>();
  readonly detail = new Map<MatKey, THREE.BufferGeometry[]>();
  private m: THREE.Matrix4;
  constructor(readonly spec: BuildingSpec, private colliders: Colliders, private groundY: number) {
    this.m = new THREE.Matrix4().makeRotationY(spec.rot).setPosition(spec.x, groundY, spec.z);
  }
  get floorY() { return this.spec.base; }

  /** Adds geometry in local coordinates. */
  geo(g: THREE.BufferGeometry, mat: MatKey, layer: 'shell' | 'roof' | 'detail' = 'shell') {
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
    g.applyMatrix4(this.m);
    const map = this[layer];
    (map.get(mat) ?? map.set(mat, []).get(mat)!).push(g.index ? g.toNonIndexed() : g);
  }

  /** Local box (centre cx,cy,cz; size sx,sy,sz). `solid` adds a collider; bottom/top in local y. */
  box(mat: MatKey, cx: number, cy: number, cz: number, sx: number, sy: number, sz: number, solid = false, layer: 'shell' | 'roof' | 'detail' = 'shell') {
    this.geo(new THREE.BoxGeometry(sx, sy, sz).translate(cx, cy, cz), mat, layer);
    if (solid) this.collide(cx, cz, sx, sz, cy - sy / 2, cy + sy / 2);
  }

  collide(cx: number, cz: number, sx: number, sz: number, bottom: number, top: number) {
    const s = this.spec, c = Math.cos(s.rot), n = Math.sin(s.rot);
    const wx = s.x + cx * c + cz * n, wz = s.z - cx * n + cz * c;
    this.colliders.addBox(wx, wz, sx, sz, -s.rot, this.groundY + bottom, this.groundY + top);
  }

  cyl(mat: MatKey, cx: number, cy: number, cz: number, r: number, h: number, solid = false, layer: 'shell' | 'detail' = 'detail', seg = 10) {
    this.geo(new THREE.CylinderGeometry(r, r, h, seg).translate(cx, cy, cz), mat, layer);
    if (solid) this.collide(cx, cz, r * 1.6, r * 1.6, cy - h / 2, cy + h / 2);
  }

  /** World position of a local point. */
  world(x: number, y: number, z: number) { return new THREE.Vector3(x, y, z).applyMatrix4(this.m); }
}

export interface Building {
  spec: BuildingSpec;
  group: THREE.Group;
  roof: THREE.Group;
  detail: THREE.Group;
  light?: THREE.PointLight;
  /** Is a world point inside the walls (with margin)? */
  contains(x: number, z: number, margin?: number): boolean;
  centre: THREE.Vector3;
}

const T = 0.16; // wall thickness

export function buildBuilding(spec: BuildingSpec, colliders: Colliders, groundY = 0): Building {
  const b = new Builder(spec, colliders, groundY);
  const { w, d, base, wallH } = spec;
  const v = spec.veranda ?? 0;

  // ---- Platform, floor, veranda ----
  const pw = w + 2 * v + 0.6, pd = d + 2 * v + 0.6;
  b.box('stone', 0, base / 2 - 0.05, 0, pw, base + 0.1, pd, true);
  b.box('floor', 0, base + 0.02, 0, w + 2 * v, 0.05, d + 2 * v);

  // ---- Stairs ----
  for (const st of spec.stairs ?? []) {
    const n = Math.max(1, Math.ceil(base / 0.3));
    const rise = base / n;
    for (let i = 0; i < n; i++) {
      const h = rise * (i + 1), depth = 0.42;
      const off = (n - i) * depth - depth / 2;
      const hw = st.width;
      if (st.side === 'front') b.box('stone', st.at, h / 2, pd / 2 + off - 0.05, hw, h, depth, true);
      if (st.side === 'back') b.box('stone', st.at, h / 2, -pd / 2 - off + 0.05, hw, h, depth, true);
      if (st.side === 'right') b.box('stone', pw / 2 + off - 0.05, h / 2, st.at, depth, h, hw, true);
      if (st.side === 'left') b.box('stone', -pw / 2 - off + 0.05, h / 2, st.at, depth, h, hw, true);
    }
  }

  // ---- Walls with openings ----
  // A wall runs along local axis `axis` ('x' or 'z') at fixed coordinate `fixed`, spanning [from, to].
  const wall = (axis: 'x' | 'z', fixed: number, from: number, to: number, openings: Opening[], exterior: boolean) => {
    const ops = [...openings].sort((a, c) => a.at - c.at);
    let cur = from;
    const seg = (a: number, c: number, y0: number, y1: number) => {
      if (c - a < 0.02 || y1 - y0 < 0.02) return;
      const ws = exterior ? spec.wainscot ?? 0 : 0;
      if (ws > 0 && y0 < ws && y1 > ws) { seg2(a, c, y0, ws, 'timber'); seg2(a, c, ws, y1, exterior && spec.walls === 'timber' ? 'timber' : 'plaster'); }
      else seg2(a, c, y0, y1, (ws > 0 && y1 <= ws) || (exterior && spec.walls === 'timber') ? 'timber' : 'plaster');
    };
    const seg2 = (a: number, c: number, y0: number, y1: number, m: 'timber' | 'plaster') => {
      const mid = (a + c) / 2, len = c - a, cy = base + (y0 + y1) / 2, h = y1 - y0;
      if (axis === 'x') b.box(m, mid, cy, fixed, len, h, T, true);
      else b.box(m, fixed, cy, mid, T, h, len, true);
    };
    const post = (at: number, size = 0.24) => {
      if (axis === 'x') b.box('timber', at, base + wallH / 2, fixed, size, wallH, size + 0.04, true);
      else b.box('timber', fixed, base + wallH / 2, at, size + 0.04, wallH, size, true);
    };
    for (const o of ops) {
      const a = o.at - o.width / 2, c = o.at + o.width / 2;
      seg(cur, a, 0, wallH);
      const bot = o.bottom ?? 0, top = o.top ?? Math.min(2.25, wallH - 0.3);
      seg(a, c, 0, bot);           // sill
      seg(a, c, top, wallH);       // header
      // Timber frame around the opening.
      post(a, 0.14); post(c, 0.14);
      const lintel = (y: number) => {
        if (axis === 'x') b.box('timber', o.at, base + y, fixed, o.width + 0.2, 0.12, T + 0.06);
        else b.box('timber', fixed, base + y, o.at, T + 0.06, 0.12, o.width + 0.2);
      };
      lintel(top); if (bot > 0) lintel(bot);
      // Sliding shoji screens: two panels per opening.
      const sc = o.screen ?? (bot > 0 ? 'lattice' : 'open');
      if (sc === 'lattice') {
        // Vertical-bar lattice (renji/koshi) with rails, and glowing paper set just inside.
        const ph = top - bot, py = base + bot + ph / 2, n = Math.max(3, Math.round(o.width / 0.11));
        const inset = exterior ? -0.05 : 0;
        for (let k = 1; k < n; k++) {
          const at2 = a + (o.width * k) / n;
          if (axis === 'x') b.box('timber', at2, py, fixed + 0.04, 0.035, ph, 0.05, false, 'detail'); else b.box('timber', fixed + 0.04, py, at2, 0.05, ph, 0.035, false, 'detail');
        }
        for (const ry of [bot + ph * 0.33, bot + ph * 0.66]) { if (axis === 'x') b.box('timber', o.at, base + ry, fixed + 0.05, o.width, 0.04, 0.04, false, 'detail'); else b.box('timber', fixed + 0.05, base + ry, o.at, 0.04, 0.04, o.width, false, 'detail'); }
        if (axis === 'x') b.box('shoji', o.at, py, fixed + inset, o.width, ph, 0.02, bot === 0, 'detail'); else b.box('shoji', fixed + inset, py, o.at, 0.02, ph, o.width, bot === 0, 'detail');
      } else if (sc !== 'none') {
        const pw2 = o.width / 2, ph = top - bot, py = base + bot + ph / 2;
        const panel = (centre: number, solid: boolean) => {
          const off = exterior ? 0.03 : 0;
          if (axis === 'x') { b.box('shoji', centre, py, fixed + off, pw2, ph - 0.04, 0.04, solid, 'detail'); b.box('timber', centre, py, fixed + off + 0.025, 0.04, ph - 0.04, 0.03, false, 'detail'); }
          else { b.box('shoji', fixed + off, py, centre, 0.04, ph - 0.04, pw2, solid, 'detail'); b.box('timber', fixed + off + 0.025, py, centre, 0.03, ph - 0.04, 0.04, false, 'detail'); }
        };
        if (sc === 'closed') { panel(o.at - pw2 / 2, true); panel(o.at + pw2 / 2, true); }
        else if (sc === 'half') { panel(o.at - pw2 / 2, true); panel(o.at - pw2 / 2 - 0.02, true); }
        else if (sc === 'open') { panel(a - pw2 / 2 + 0.02, false); panel(c + pw2 / 2 - 0.02, false); }
      }
      cur = c;
    }
    seg(cur, to, 0, wallH);
    // Posts at ends and at intervals; a beam band at the top.
    const spacing = spec.postSpacing ?? 2.6;
    const nPosts = Math.max(1, Math.round((to - from) / spacing));
    for (let i = 0; i <= nPosts; i++) {
      const at = from + ((to - from) * i) / nPosts;
      if (ops.some((o) => Math.abs(at - o.at) < o.width / 2 - 0.05)) continue;
      post(at);
    }
    if (axis === 'x') { b.box('timber', (from + to) / 2, base + wallH - 0.12, fixed, to - from + 0.2, 0.24, T + 0.08); b.box('timber', (from + to) / 2, base + 0.1, fixed, to - from, 0.2, T + 0.06); }
    else { b.box('timber', fixed, base + wallH - 0.12, (from + to) / 2, T + 0.08, 0.24, to - from + 0.2); b.box('timber', fixed, base + 0.1, (from + to) / 2, T + 0.06, 0.2, to - from); }
  };

  if (!spec.open) {
    wall('x', d / 2, -w / 2, w / 2, spec.front ?? [], true);
    wall('x', -d / 2, -w / 2, w / 2, spec.back ?? [], true);
    wall('z', -w / 2, -d / 2, d / 2, spec.left ?? [], true);
    wall('z', w / 2, -d / 2, d / 2, spec.right ?? [], true);
  } else {
    // Open pavilion/colonnade: posts around the perimeter only.
    const sp = spec.postSpacing ?? 3;
    const nx = Math.max(1, Math.round(w / sp)), nz = Math.max(1, Math.round(d / sp));
    for (let i = 0; i <= nx; i++) for (const zz of [-d / 2, d / 2]) b.box('timber', -w / 2 + (w * i) / nx, base + wallH / 2, zz, 0.28, wallH, 0.28, true);
    for (let j = 1; j < nz; j++) for (const xx of [-w / 2, w / 2]) b.box('timber', xx, base + wallH / 2, -d / 2 + (d * j) / nz, 0.28, wallH, 0.28, true);
    for (const zz of [-d / 2, d / 2]) b.box('timber', 0, base + wallH - 0.15, zz, w + 0.3, 0.3, 0.3);
    for (const xx of [-w / 2, w / 2]) b.box('timber', xx, base + wallH - 0.15, 0, 0.3, 0.3, d + 0.3);
  }
  for (const p of spec.partX ?? []) wall('z', p.x, p.from ?? -d / 2, p.to ?? d / 2, p.openings, false);
  for (const p of spec.partZ ?? []) wall('x', p.z, p.from ?? -w / 2, p.to ?? w / 2, p.openings, false);

  // Veranda posts carrying the eaves.
  if (v > 0) {
    const sp = 3;
    const ex = w / 2 + v - 0.2, ez = d / 2 + v - 0.2;
    const nx = Math.max(1, Math.round((2 * ex) / sp)), nz = Math.max(1, Math.round((2 * ez) / sp));
    for (let i = 0; i <= nx; i++) for (const zz of [-ez, ez]) { const x = -ex + (2 * ex * i) / nx; b.box('timber', x, base + wallH / 2, zz, 0.26, wallH, 0.26, true); bracket(b, x, base + wallH, zz, 0, Math.sign(zz)); }
    for (let j = 1; j < nz; j++) for (const xx of [-ex, ex]) { const z = -ez + (2 * ez * j) / nz; b.box('timber', xx, base + wallH / 2, z, 0.26, wallH, 0.26, true); bracket(b, xx, base + wallH, z, Math.sign(xx), 0); }
    // Railing around the veranda edge (gaps at stairs are left open by height: rails are low).
    for (const zz of [-ez, ez]) b.box('timber', 0, base + 0.55, zz + Math.sign(zz) * 0.05, 2 * ex, 0.08, 0.08);
    for (const xx of [-ex, ex]) b.box('timber', xx + Math.sign(xx) * 0.05, base + 0.55, 0, 0.08, 0.08, 2 * ez);
  }

  // Exposed tie beams across the interior (seen when the roof is cut away).
  if (!spec.open) for (let x = -w / 2 + 2.5; x < w / 2 - 1; x += 2.6) b.box('timber', x, base + wallH - 0.15, 0, 0.22, 0.3, d, false, 'roof');

  // ---- Roof ----
  if (spec.roof.kind !== 'none') {
    const o = spec.roof.overhang;
    const RW = w + 2 * v + 2 * o, RD = d + 2 * v + 2 * o;
    if (spec.roof.kind === 'hip') hipRoof(b, RW, RD, base + wallH, spec.roof.height, 1, w + 2 * v, d + 2 * v);
    else {
      // Two tiers: a skirt roof over the veranda, a clerestory band, then the main roof.
      const skirtH = spec.roof.height * 0.38;
      hipRoof(b, RW, RD, base + wallH, skirtH, 0.62, w + 2 * v, d + 2 * v);
      const uw = w * 0.82, ud = d * 0.8, bandH = 2.4;
      const y0 = base + wallH + skirtH * 0.55;
      b.box('plaster', 0, y0 + bandH / 2, 0, uw, bandH, ud, false, 'roof');
      for (let i = 0; i <= 8; i++) for (const zz of [-ud / 2, ud / 2]) b.box('timber', -uw / 2 + (uw * i) / 8, y0 + bandH / 2, zz, 0.22, bandH, 0.24, false, 'roof');
      b.box('timber', 0, y0 + bandH - 0.12, 0, uw + 0.3, 0.26, ud + 0.3, false, 'roof');
      for (let i = 0; i <= 8; i++) for (const zz of [-1, 1]) bracket(b, -uw / 2 + (uw * i) / 8, y0 + bandH, zz * ud / 2, 0, zz);
      if (spec.balcony) {
        // Balcony deck and railing ringing the upper storey.
        const bw = uw + 1.8, bd = ud + 1.8, by = y0 + 0.05;
        b.box('floor', 0, by, 0, bw, 0.14, bd, false, 'roof');
        for (const zz of [-bd / 2, bd / 2]) { b.box('timber', 0, by + 0.95, zz, bw, 0.09, 0.09, false, 'roof'); b.box('timber', 0, by + 0.45, zz, bw, 0.06, 0.06, false, 'roof'); }
        for (const xx of [-bw / 2, bw / 2]) { b.box('timber', xx, by + 0.95, 0, 0.09, 0.09, bd, false, 'roof'); b.box('timber', xx, by + 0.45, 0, 0.06, 0.06, bd, false, 'roof'); }
        for (let i = 0; i <= 10; i++) for (const zz of [-bd / 2, bd / 2]) b.box('timber', -bw / 2 + (bw * i) / 10, by + 0.5, zz, 0.1, 1, 0.1, false, 'roof');
        for (let j = 1; j < 6; j++) for (const xx of [-bw / 2, bw / 2]) b.box('timber', xx, by + 0.5, -bd / 2 + (bd * j) / 6, 0.1, 1, 0.1, false, 'roof');
      }
      // Lattice window bands in the upper storey.
      for (let i = 0; i < 8; i++) for (const zz of [-1, 1]) {
        const cx = -uw / 2 + (uw * (i + 0.5)) / 8;
        for (let k = -4; k <= 4; k++) b.box('timber', cx + k * 0.12, y0 + bandH * 0.55, zz * (ud / 2 + 0.03), 0.035, bandH * 0.45, 0.04, false, 'roof');
      }
      hipRoof(b, uw + 2 * o + 1.2, ud + 2 * o + 1.2, y0 + bandH, spec.roof.height, 1, uw, ud);
    }
  }

  spec.furnish?.(b);

  // ---- Assemble ----
  const group = new THREE.Group(), roof = new THREE.Group(), detail = new THREE.Group();
  group.name = spec.name;
  const emit = (map: Map<MatKey, THREE.BufferGeometry[]>, parent: THREE.Group) => {
    for (const [k, list] of map) {
      const g = mergeGeometries(list, false)!;
      g.computeVertexNormals();
      g.computeBoundingSphere();
      const mesh = new THREE.Mesh(g, MAT[k]);
      mesh.castShadow = k !== 'glow' && k !== 'shoji';
      mesh.receiveShadow = true;
      parent.add(mesh);
    }
  };
  emit(b.shell, group); emit(b.roof, roof); emit(b.detail, detail);
  group.add(roof, detail);
  const centre = b.world(0, base + wallH * 0.6, 0);
  let light: THREE.PointLight | undefined;
  if (spec.light) {
    light = new THREE.PointLight(0xffc58a, 0, Math.max(w, d) * 0.9, 1.6);
    light.position.copy(centre);
    light.visible = false;
    group.add(light);
  }
  const c = Math.cos(spec.rot), s = Math.sin(spec.rot);
  return {
    spec, group, roof, detail, light, centre,
    contains(x: number, z: number, margin = 0.2) {
      const dx = x - spec.x, dz = z - spec.z;
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      return Math.abs(lx) < w / 2 + margin && Math.abs(lz) < d / 2 + margin;
    },
  };
}

/** Tiered bracket cluster (tokyo) on a post top, stepping outward along (ox, oz). */
function bracket(b: Builder, x: number, y: number, z: number, ox: number, oz: number) {
  const tiers = [[0.42, 0.42, 0], [0.8, 0.3, 0.22], [1.2, 0.26, 0.44]];
  tiers.forEach(([len, wid, out], i) => {
    const yy = y + 0.12 + i * 0.2;
    const along = ox !== 0 ? [wid, len] : [len, wid];
    b.box('timber', x + ox * out * 0.5, yy, z + oz * out * 0.5, along[0], 0.16, along[1], false, 'roof');
    b.box('timber', x + ox * out, yy + 0.1, z + oz * out, 0.22, 0.06, 0.22, false, 'roof');
  });
}

/**
 * Curved hip roof with upturned eaves. Ridge along the longer axis; concave slopes; corners lift.
 * A darker underside surface sits just below the tiles so eaves read correctly from beneath.
 */
function hipRoof(b: Builder, W: number, D: number, y0: number, H: number, cut = 1, innerW = W * 0.7, innerD = D * 0.7) {
  const nu = 40, nv = 30;
  const ridgeAlongX = W >= D;
  const top = new THREE.PlaneGeometry(W, D, nu, nv).rotateX(-Math.PI / 2);
  const height = (x: number, z: number) => {
    const u = Math.min(1, Math.abs(x) / (W / 2)), v = Math.min(1, Math.abs(z) / (D / 2));
    const k = ridgeAlongX ? D / W : W / D;
    const f = ridgeAlongX ? Math.min(1 - v, (1 - u) / k) : Math.min(1 - u, (1 - v) / k);
    const slope = Math.pow(Math.max(0, f), 1.45);       // concave
    const corner = Math.pow(u * v, 3) * 0.22;            // upturned corners
    const eave = Math.pow(1 - Math.max(0, f), 6) * 0.08;  // slight lift along all eaves
    return Math.min(cut, slope) * H + (corner + eave) * H;
  };
  const p = top.getAttribute('position') as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) p.setY(i, y0 + height(p.getX(i), p.getZ(i)));
  top.computeVertexNormals();
  b.geo(top, 'roof', 'roof');
  const under = top.clone().translate(0, -0.22, 0);
  b.geo(under, 'eave', 'roof');
  const Y = (x: number, z: number) => y0 + height(x, z);

  // Eave tile ends: a row of round kawara caps along every edge.
  const caps = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(2, Math.floor(len / 0.32));
    const nx = -(z1 - z0) / len, nz = (x1 - x0) / len;
    for (let i = 0; i <= n; i++) {
      const t = i / n, x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      const g = new THREE.CylinderGeometry(0.12, 0.12, 0.14, 8).rotateX(Math.PI / 2);
      g.lookAt(new THREE.Vector3(nx, 0, nz));
      b.geo(g.translate(x, Y(x * 0.995, z * 0.995) - 0.06, z), 'roof', 'roof');
    }
  };
  const hw = W / 2, hd = D / 2;
  caps(-hw, hd, hw, hd); caps(hw, -hd, -hw, -hd); caps(hw, hd, hw, -hd); caps(-hw, -hd, -hw, hd);

  // Rafters (taruki) from the wall line out to the eave, in rows under the overhang.
  const iw = innerW / 2, id = innerD / 2;
  const rafter = (ax: number, az: number, bx: number, bz: number) => {
    const A = new THREE.Vector3(ax, Y(ax, az) - 0.3, az), B = new THREE.Vector3(bx, Y(bx, bz) - 0.28, bz);
    const len = A.distanceTo(B);
    const g = new THREE.BoxGeometry(0.1, 0.12, len);
    g.lookAt(B.clone().sub(A));
    b.geo(g.translate((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2), 'eave', 'roof');
  };
  for (let x = -iw; x <= iw; x += 0.5) { rafter(x, id, x * (hw / iw) * 0.98, hd * 0.99); rafter(x, -id, x * (hw / iw) * 0.98, -hd * 0.99); }
  for (let z = -id + 0.5; z < id; z += 0.5) { rafter(iw, z, hw * 0.99, z * (hd / id) * 0.98); rafter(-iw, z, -hw * 0.99, z * (hd / id) * 0.98); }

  if (cut >= 1) {
    // Main ridge: a rounded cap with onigawara (ridge-end ornaments) that sweep up at both ends.
    const L = Math.abs(W - D) / 2;
    const ax = ridgeAlongX ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1);
    const ridge = new THREE.CylinderGeometry(0.3, 0.3, 2 * L + 0.8, 10).rotateZ(Math.PI / 2);
    if (!ridgeAlongX) ridge.rotateY(Math.PI / 2);
    b.geo(ridge.translate(0, y0 + H + 0.22, 0), 'roof', 'roof');
    b.geo(new THREE.BoxGeometry(ridgeAlongX ? 2 * L + 0.6 : 0.5, 0.35, ridgeAlongX ? 0.5 : 2 * L + 0.6).translate(0, y0 + H + 0.02, 0), 'roof', 'roof');
    for (const s of [-1, 1]) {
      const e = ax.clone().multiplyScalar(s * (L + 0.35));
      const oni = new THREE.BoxGeometry(ridgeAlongX ? 0.4 : 1.0, 1.1, ridgeAlongX ? 1.0 : 0.4);
      b.geo(oni.translate(e.x, y0 + H + 0.65, e.z), 'roof', 'roof');
      // Upswept fin (shibi-like) on the ornament.
      const fin = new THREE.BoxGeometry(ridgeAlongX ? 0.25 : 0.6, 0.9, ridgeAlongX ? 0.6 : 0.25);
      fin.rotateZ(ridgeAlongX ? -s * 0.5 : 0).rotateX(ridgeAlongX ? 0 : s * 0.5);
      b.geo(fin.translate(e.x + ax.x * s * 0.25, y0 + H + 1.3, e.z + ax.z * s * 0.25), 'roof', 'roof');
    }
    // Hip ridges: rounded caps running from each ridge end down to the upturned corners.
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const top3 = ridgeAlongX ? new THREE.Vector2(sx * L, 0) : new THREE.Vector2(0, sz * L);
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 14; i++) {
        const t = i / 14;
        const x = THREE.MathUtils.lerp(top3.x, sx * hw * 0.995, t), z = THREE.MathUtils.lerp(top3.y, sz * hd * 0.995, t);
        pts.push(new THREE.Vector3(x, Y(x, z) + 0.16, z));
      }
      const tube = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.2, 6, false);
      b.geo(tube, 'roof', 'roof');
      const end = pts[pts.length - 1];
      b.geo(new THREE.SphereGeometry(0.3, 8, 6).translate(end.x, end.y + 0.1, end.z), 'roof', 'roof');
    }
  }
}
