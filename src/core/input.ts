/** Keyboard + mouse input. Mouse look uses pointer lock when available, or click-drag as a fallback. */
export class Input {
  readonly keys = new Set<string>();
  lookX = 0;
  lookY = 0;
  zoom = 0;
  private dragging = false;
  readonly touch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
  private stick = { id: -1, ox: 0, oy: 0, x: 0, y: 0 };
  private lookTouch = { id: -1, x: 0, y: 0 };
  private sprintHeld = false;

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
    if (this.touch) this.setupTouch(el);
  }

  /** Mobile: left thumb = floating joystick, right side = drag to look, sprint button. */
  private setupTouch(el: HTMLElement) {
    const ui = document.createElement('div');
    ui.id = 'touch';
    ui.innerHTML = '<div class="base"><div class="knob"></div></div><button class="sprint" aria-label="Run">RUN</button>';
    document.body.appendChild(ui);
    const base = ui.querySelector('.base') as HTMLElement, knob = ui.querySelector('.knob') as HTMLElement;
    const sprint = ui.querySelector('.sprint') as HTMLElement;
    const R = 52;
    sprint.addEventListener('touchstart', (e) => { this.sprintHeld = !this.sprintHeld; sprint.classList.toggle('on', this.sprintHeld); e.preventDefault(); e.stopPropagation(); }, { passive: false });
    el.addEventListener('touchstart', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.clientX < innerWidth * 0.45 && this.stick.id < 0) {
          Object.assign(this.stick, { id: t.identifier, ox: t.clientX, oy: t.clientY, x: 0, y: 0 });
          base.style.cssText = `left:${t.clientX - R}px;top:${t.clientY - R}px;opacity:1`;
          knob.style.transform = 'translate(0px,0px)';
        } else if (this.lookTouch.id < 0) {
          Object.assign(this.lookTouch, { id: t.identifier, x: t.clientX, y: t.clientY });
        }
      }
      e.preventDefault();
    }, { passive: false });
    el.addEventListener('touchmove', (e) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.stick.id) {
          let dx = t.clientX - this.stick.ox, dy = t.clientY - this.stick.oy;
          const l = Math.hypot(dx, dy);
          if (l > R) { dx *= R / l; dy *= R / l; }
          this.stick.x = dx / R; this.stick.y = dy / R;
          knob.style.transform = `translate(${dx}px,${dy}px)`;
        } else if (t.identifier === this.lookTouch.id) {
          this.lookX += (t.clientX - this.lookTouch.x) * 1.6;
          this.lookY += (t.clientY - this.lookTouch.y) * 1.6;
          this.lookTouch.x = t.clientX; this.lookTouch.y = t.clientY;
        }
      }
      e.preventDefault();
    }, { passive: false });
    const end = (e: TouchEvent) => {
      for (const t of Array.from(e.changedTouches)) {
        if (t.identifier === this.stick.id) { this.stick.id = -1; this.stick.x = this.stick.y = 0; base.style.opacity = '0.35'; }
        if (t.identifier === this.lookTouch.id) this.lookTouch.id = -1;
      }
    };
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
  }

  lock() { try { this.el.requestPointerLock?.(); } catch { /* unsupported (iOS) */ } }
  get locked() { return document.pointerLockElement === this.el; }

  axis() {
    const k = this.keys;
    const x = (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) - (k.has('KeyA') || k.has('ArrowLeft') ? 1 : 0);
    const y = (k.has('KeyW') || k.has('ArrowUp') ? 1 : 0) - (k.has('KeyS') || k.has('ArrowDown') ? 1 : 0);
    if (this.stick.id >= 0 && (x === 0 && y === 0)) {
      // Analogue stick; a light push walks, full deflection jogs.
      return { x: this.stick.x, y: -this.stick.y, mag: Math.min(1, Math.hypot(this.stick.x, this.stick.y)) };
    }
    return { x, y, mag: 1 };
  }
  get sprint() { return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.sprintHeld; }
  get walk() { return this.keys.has('ControlLeft') || this.keys.has('AltLeft') || this.keys.has('KeyC'); }

  consumeLook() { const r = { x: this.lookX, y: this.lookY, zoom: this.zoom }; this.lookX = this.lookY = this.zoom = 0; return r; }
}
