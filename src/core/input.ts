/** Keyboard + mouse input. Mouse look uses pointer lock when available, or click-drag as a fallback. */
export class Input {
  readonly keys = new Set<string>();
  lookX = 0;
  lookY = 0;
  zoom = 0;
  private dragging = false;

  constructor(private el: HTMLElement) {
    addEventListener('keydown', (e) => {
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    el.addEventListener('mousedown', () => { this.dragging = true; });
    addEventListener('mouseup', () => { this.dragging = false; });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === this.el || this.dragging) {
        this.lookX += e.movementX;
        this.lookY += e.movementY;
      }
    });
    el.addEventListener('wheel', (e) => { this.zoom += Math.sign(e.deltaY); e.preventDefault(); }, { passive: false });
  }

  lock() { this.el.requestPointerLock?.(); }
  get locked() { return document.pointerLockElement === this.el; }

  axis() {
    const k = this.keys;
    const x = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const y = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    return { x, y };
  }
  get sprint() { return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'); }
  get walk() { return this.keys.has('ControlLeft') || this.keys.has('AltLeft') || this.keys.has('KeyC'); }

  consumeLook() { const r = { x: this.lookX, y: this.lookY, zoom: this.zoom }; this.lookX = this.lookY = this.zoom = 0; return r; }
}
