/**
 * Lightweight 2.5D collision: circles and oriented boxes in the XZ plane, each with a vertical extent.
 * A collider whose top is within step height of the player's feet is walkable (stairs, platforms, bridge deck);
 * otherwise it pushes the player out. Stored in a uniform grid for fast lookup.
 */
export interface Circle { kind: 'circle'; x: number; z: number; r: number; bottom: number; top: number }
export interface Box { kind: 'box'; x: number; z: number; hw: number; hd: number; rot: number; bottom: number; top: number; cos: number; sin: number }
export type Collider = Circle | Box;

const CELL = 16;
export const STEP_HEIGHT = 0.6;

export class Colliders {
  private grid = new Map<string, Collider[]>();
  readonly all: Collider[] = [];

  addCircle(x: number, z: number, r: number, bottom: number, top: number) {
    this.insert({ kind: 'circle', x, z, r, bottom, top });
  }

  addBox(x: number, z: number, w: number, d: number, rot: number, bottom: number, top: number) {
    this.insert({ kind: 'box', x, z, hw: w / 2, hd: d / 2, rot, bottom, top, cos: Math.cos(rot), sin: Math.sin(rot) });
  }

  private insert(c: Collider) {
    this.all.push(c);
    const ext = c.kind === 'circle' ? c.r : Math.hypot(c.hw, c.hd);
    for (let gx = Math.floor((c.x - ext) / CELL); gx <= Math.floor((c.x + ext) / CELL); gx++)
      for (let gz = Math.floor((c.z - ext) / CELL); gz <= Math.floor((c.z + ext) / CELL); gz++) {
        const k = `${gx},${gz}`;
        (this.grid.get(k) ?? this.grid.set(k, []).get(k)!).push(c);
      }
  }

  near(x: number, z: number): Collider[] {
    return this.grid.get(`${Math.floor(x / CELL)},${Math.floor(z / CELL)}`) ?? [];
  }

  /** Highest walkable collider surface under (x,z) that is reachable from feetY, or -Infinity. */
  surfaceAt(x: number, z: number, feetY: number, radius: number): number {
    let best = -Infinity;
    for (const c of this.near(x, z)) {
      if (c.top > feetY + STEP_HEIGHT || c.top < feetY - 3) continue;
      if (inside(c, x, z, radius * 0.5)) best = Math.max(best, c.top);
    }
    return best;
  }

  /** Pushes (x,z) out of solid colliders. Returns corrected position. */
  resolve(x: number, z: number, feetY: number, radius: number, headroom = 1.7): [number, number] {
    for (let iter = 0; iter < 3; iter++) {
      let moved = false;
      for (const c of this.near(x, z)) {
        if (c.top <= feetY + STEP_HEIGHT || c.bottom >= feetY + headroom) continue;
        if (c.kind === 'circle') {
          const dx = x - c.x, dz = z - c.z;
          const d = Math.hypot(dx, dz), min = c.r + radius;
          if (d < min && d > 1e-6) { x = c.x + (dx / d) * min; z = c.z + (dz / d) * min; moved = true; }
        } else {
          // Into box local space.
          const dx = x - c.x, dz = z - c.z;
          const lx = dx * c.cos + dz * c.sin, lz = -dx * c.sin + dz * c.cos;
          const qx = Math.max(-c.hw, Math.min(c.hw, lx)), qz = Math.max(-c.hd, Math.min(c.hd, lz));
          let ox = lx - qx, oz = lz - qz;
          let d = Math.hypot(ox, oz);
          let nlx = lx, nlz = lz;
          if (d < 1e-6) {
            // Centre is inside: push out along the shallowest axis.
            const px = c.hw - Math.abs(lx), pz = c.hd - Math.abs(lz);
            if (px < pz) nlx = Math.sign(lx || 1) * (c.hw + radius); else nlz = Math.sign(lz || 1) * (c.hd + radius);
          } else if (d < radius) {
            ox /= d; oz /= d;
            nlx = qx + ox * radius; nlz = qz + oz * radius;
          } else continue;
          x = c.x + nlx * c.cos - nlz * c.sin;
          z = c.z + nlx * c.sin + nlz * c.cos;
          moved = true;
        }
      }
      if (!moved) break;
    }
    return [x, z];
  }
}

function inside(c: Collider, x: number, z: number, pad: number) {
  if (c.kind === 'circle') return Math.hypot(x - c.x, z - c.z) < c.r + pad;
  const dx = x - c.x, dz = z - c.z;
  const lx = dx * c.cos + dz * c.sin, lz = -dx * c.sin + dz * c.cos;
  return Math.abs(lx) < c.hw + pad && Math.abs(lz) < c.hd + pad;
}
