/** Supernatural abilities (docs/abilities.md). */
export type SpiritKind = 'phantom' | 'rift' | 'rupture';
/** Mobile spirit stance: after tapping SPIRIT, the next DODGE / ATTACK / BLOCK press casts an ability. */
export const SPIRIT_STANCE = 2.2;

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
  // Combat actions: presses are queued until consumed; block is also tracked as held.
  private attackQ = 0;
  private attackDown = false;
  private dodgeQ = 0;
  private blockPressQ = 0;
  private blockMouse = false;
  private blockTouch = false;
  // Abilities: Q / E / R on desktop; the SPIRIT stance on touch. E (or ATTACK in the stance) is held to charge the Rift.
  private spiritQ: SpiritKind[] = [];
  private riftKey = false; private riftTouch = false;
  private stanceUntil = 0;
  private spiritUi: { root: HTMLElement; spirit: HTMLElement; btns: Record<SpiritKind, HTMLElement>; labels: Map<HTMLElement, string> } | null = null;

  constructor(private el: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat) this.dodgeQ++;
      if (!e.repeat) {
        if (e.code === 'KeyQ') this.spiritQ.push('phantom');
        else if (e.code === 'KeyE') { this.spiritQ.push('rift'); this.riftKey = true; }
        else if (e.code === 'KeyR') this.spiritQ.push('rupture');
      }
      this.keys.add(e.code);
      if (['Space', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => { this.keys.delete(e.code); if (e.code === 'KeyE') this.riftKey = false; });
    addEventListener('blur', () => { this.keys.clear(); this.riftKey = false; });
    el.addEventListener('mousedown', (e) => {
      this.dragging = true;
      if (e.button === 0) { this.attackQ++; this.attackDown = true; }
      if (e.button === 2) { this.blockMouse = true; this.blockPressQ++; }
    });
    addEventListener('mouseup', (e) => { this.dragging = false; if (e.button === 2) this.blockMouse = false; if (e.button === 0) this.attackDown = false; });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
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
    // Combat buttons, added beside (not over) the joystick and RUN.
    const btn = (cls: string, label: string) => { const b = document.createElement('button'); b.className = `act ${cls}`; b.textContent = label; b.setAttribute('aria-label', label); ui.appendChild(b); return b; };
    const atk = btn('attack', 'ATTACK'), dodge = btn('dodge', 'DODGE'), block = btn('block', 'BLOCK');
    // SPIRIT: one extra button above the cluster. Tapping it opens the spirit stance: for a moment the existing
    // DODGE / ATTACK / BLOCK buttons cast Phantom Step / Colossus Rift (hold to charge) / Gravity Rupture instead.
    // Their positions and sizes don't change; they get a cyan rim and new labels until the stance ends.
    const spirit = document.createElement('button'); spirit.className = 'spirit'; spirit.setAttribute('aria-label', 'Spirit abilities');
    spirit.innerHTML = '<svg viewBox="0 0 40 40" aria-hidden="true"><path d="M20 3 L23.5 16.5 L37 20 L23.5 23.5 L20 37 L16.5 23.5 L3 20 L16.5 16.5 Z"/></svg><span>SPIRIT</span><i class="ring"></i>';
    spirit.style.display = 'none';   // shown once the game reports abilities (temple fight only)
    ui.appendChild(spirit);
    const labels = new Map<HTMLElement, string>([[atk, 'ATTACK'], [dodge, 'DODGE'], [block, 'BLOCK']]);
    this.spiritUi = { root: ui, spirit, btns: { phantom: dodge, rift: atk, rupture: block }, labels };
    spirit.addEventListener('touchstart', (e) => { this.setStance(!this.stance); e.preventDefault(); e.stopPropagation(); }, { passive: false });
    const press = (b: HTMLElement, fn: () => void, kind: SpiritKind) => b.addEventListener('touchstart', (e) => {
      if (this.stance) { this.spiritQ.push(kind); if (kind === 'rift') this.riftTouch = true; this.setStance(false); }
      else fn();
      b.classList.add('on'); e.preventDefault(); e.stopPropagation();
    }, { passive: false });
    press(atk, () => { this.attackQ++; this.attackDown = true; }, 'rift');
    press(dodge, () => this.dodgeQ++, 'phantom');
    press(block, () => { this.blockTouch = true; this.blockPressQ++; }, 'rupture');
    for (const b of [atk, dodge, block]) {
      const up = (e: TouchEvent) => { b.classList.remove('on'); if (b === block) this.blockTouch = false; if (b === atk) { this.attackDown = false; this.riftTouch = false; } e.preventDefault(); e.stopPropagation(); };
      b.addEventListener('touchend', up, { passive: false }); b.addEventListener('touchcancel', up, { passive: false });
    }
    const R = 52;
    sprint.addEventListener('touchstart', (e) => { this.sprintHeld = !this.sprintHeld; sprint.classList.toggle('on', this.sprintHeld); e.preventDefault(); e.stopPropagation(); }, { passive: false });
    // A touch can end without the page being told (entering full screen, rotating, a system gesture, switching apps).
    // The stick would then stay "held" forever and ignore new touches, so any touch the browser no longer lists is
    // released before a new one is assigned, and everything is released when the page loses focus or changes mode.
    const releaseStick = () => { this.stick.id = -1; this.stick.x = this.stick.y = 0; base.style.opacity = '0.35'; knob.style.transform = 'translate(0px,0px)'; };
    const releaseAll = () => { releaseStick(); this.lookTouch.id = -1; };
    const prune = (list: TouchList) => {
      const live = new Set(Array.from(list).map((t) => t.identifier));
      if (this.stick.id >= 0 && !live.has(this.stick.id)) releaseStick();
      if (this.lookTouch.id >= 0 && !live.has(this.lookTouch.id)) this.lookTouch.id = -1;
    };
    for (const ev of ['fullscreenchange', 'webkitfullscreenchange', 'visibilitychange']) document.addEventListener(ev, releaseAll);
    for (const ev of ['orientationchange', 'pagehide']) addEventListener(ev, releaseAll);
    // ?touchdebug: a small readout of the touches and the stick (for diagnosing a device).
    if (new URLSearchParams(location.search).has('touchdebug')) {
      const dbg = document.createElement('div');
      dbg.style.cssText = 'position:fixed;left:8px;top:40px;z-index:50;font:11px monospace;color:#0f0;background:rgba(0,0,0,0.6);padding:4px;pointer-events:none;white-space:pre';
      document.body.appendChild(dbg);
      const log: string[] = [];
      for (const ev of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) document.addEventListener(ev, (e) => {
        const t = e as TouchEvent; if (ev === 'touchmove' && log[0]?.startsWith('touchmove')) log.shift();
        log.unshift(`${ev} ${(t.target as HTMLElement)?.tagName} n=${t.touches.length}`); log.length = Math.min(log.length, 6);
      }, { capture: true, passive: true });
      const show = () => { dbg.textContent = `stick ${this.stick.id} ${this.stick.x.toFixed(2)},${this.stick.y.toFixed(2)} look ${this.lookTouch.id}\n${log.join('\n')}`; requestAnimationFrame(show); };
      show();
    }
    // Touches that end anywhere (also over the buttons) are seen here too.
    const endAnywhere = (e: TouchEvent) => prune(e.touches);
    document.addEventListener('touchend', endAnywhere, { capture: true });
    document.addEventListener('touchcancel', endAnywhere, { capture: true });
    el.addEventListener('touchstart', (e) => {
      prune(e.touches);
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
        if (t.identifier === this.stick.id) releaseStick();
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

  /** Spirit stance (touch): active until it times out, an ability is cast, or SPIRIT is tapped again. */
  get stance() { return performance.now() < this.stanceUntil; }
  setStance(on: boolean) {
    this.stanceUntil = on ? performance.now() + SPIRIT_STANCE * 1000 : 0;
    this.refreshStance();
  }
  private refreshStance() {
    const u = this.spiritUi; if (!u) return;
    const on = this.stance;
    u.root.classList.toggle('stance', on); u.spirit.classList.toggle('on', on);
    const names: Record<SpiritKind, string> = { phantom: 'STEP', rift: 'RIFT', rupture: 'RUPTURE' };
    for (const k of Object.keys(u.btns) as SpiritKind[]) { const b = u.btns[k]; b.textContent = on ? names[k] : u.labels.get(b)!; b.classList.toggle('sp', on); }
  }
  /**
   * Ability readiness for the touch UI (1 = ready, 0..1 = cooling down). Called by the game every frame; also ends a
   * timed-out stance.
   */
  spiritStatus(ready: Record<SpiritKind, number>) {
    const u = this.spiritUi; if (!u) return;
    if (u.spirit.style.display) u.spirit.style.display = '';
    if (u.root.classList.contains('stance') && !this.stance) this.refreshStance();
    const any = Math.max(ready.phantom, ready.rift, ready.rupture);
    u.spirit.style.setProperty('--k', any.toFixed(3));
    u.spirit.classList.toggle('ready', ready.phantom >= 1 || ready.rift >= 1 || ready.rupture >= 1);
    for (const k of Object.keys(u.btns) as SpiritKind[]) u.btns[k].classList.toggle('cool', this.stance && ready[k] < 1);
  }
  /** Next queued ability press, or null. */
  consumeSpirit(): SpiritKind | null { return this.spiritQ.shift() ?? null; }
  /** Rift charge input held (E, or ATTACK pressed in the spirit stance). */
  get riftHeld() { return this.riftKey || this.riftTouch; }
  /** Test hook: press / release an ability input. */
  injectSpirit(k: SpiritKind | 'riftUp') { if (k === 'riftUp') { this.riftKey = false; this.riftTouch = false; } else { this.spiritQ.push(k); if (k === 'rift') this.riftKey = true; } }

  /** Number of attack presses since the last call (0 or more). */
  consumeAttack() { const n = this.attackQ; this.attackQ = 0; return n; }
  consumeDodge() { const n = this.dodgeQ; this.dodgeQ = 0; return n; }
  consumeBlockPress() { const n = this.blockPressQ; this.blockPressQ = 0; return n; }
  get blockHeld() { return this.blockMouse || this.blockTouch; }
  /** Attack button/mouse currently held (hold = heavy attack). */
  get attackHeld() { return this.attackDown; }
  /** Test hook: inject an action as if pressed. */
  inject(a: 'attack' | 'dodge' | 'blockDown' | 'blockUp') {
    if (a === 'attack') this.attackQ++; else if (a === 'dodge') this.dodgeQ++;
    else if (a === 'blockDown') { this.blockMouse = true; this.blockPressQ++; } else this.blockMouse = false;
  }

  consumeLook() { const r = { x: this.lookX, y: this.lookY, zoom: this.zoom }; this.lookX = this.lookY = this.zoom = 0; return r; }
}
