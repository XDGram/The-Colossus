import * as THREE from 'three';

/**
 * Screen-edge markers for attacks that start off screen (docs/combat.md §7, revised): a chevron at the edge of the
 * screen pointing toward the attacker, shown while its warning and swing last. Pale = parryable, red = unparryable.
 */
const CSS = `
.threat { position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; pointer-events: none; z-index: 7; transition: opacity 0.15s; }
.threat svg { width: 100%; height: 100%; filter: drop-shadow(0 0 6px rgba(0,0,0,0.8)); }
.threat path { fill: #fff2d8; }
.threat.red path { fill: #ff3a22; }
`;

interface Marker { el: HTMLElement; at: () => THREE.Vector3 | null; red: () => boolean }

export class ThreatMarkers {
  private list: Marker[] = [];
  private v = new THREE.Vector3();
  constructor(private camera: THREE.Camera) {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
  }
  /** Track an attacker: `at` returns its chest position, or null once the attack is over. */
  add(at: () => THREE.Vector3 | null, red: () => boolean) {
    const el = document.createElement('div'); el.className = 'threat';
    el.innerHTML = '<svg viewBox="0 0 34 34"><path d="M17 2 L32 26 L17 19 L2 26 Z"/></svg>';
    document.body.appendChild(el);
    this.list.push({ el, at, red });
  }
  update() {
    const cam = this.camera as THREE.PerspectiveCamera;
    this.list = this.list.filter((m) => {
      const p = m.at();
      if (!p) { m.el.remove(); return false; }
      // Direction in camera space; behind the camera points down the screen.
      this.v.copy(p).applyMatrix4(cam.matrixWorldInverse);
      let x = this.v.x, y = this.v.y;
      if (this.v.z > 0) { x = this.v.x; y = -Math.abs(this.v.y) - Math.abs(this.v.z); }
      const ang = Math.atan2(x, y);
      // Hidden while the attacker is on screen (its own glint shows then).
      const ndc = p.clone().project(cam);
      m.el.style.opacity = this.v.z < 0 && Math.abs(ndc.x) < 0.92 && Math.abs(ndc.y) < 0.92 ? '0' : '1';
      // Place on an inset ellipse around the screen centre.
      const rx = innerWidth / 2 - 40, ry = innerHeight / 2 - 40;
      const sx = innerWidth / 2 + Math.sin(ang) * rx, sy = innerHeight / 2 - Math.cos(ang) * ry;
      m.el.style.left = `${sx}px`; m.el.style.top = `${sy}px`;
      m.el.style.transform = `rotate(${ang}rad)`;
      m.el.classList.toggle('red', m.red());
      return true;
    });
  }
}
