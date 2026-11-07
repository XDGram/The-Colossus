import type { SpiritKind } from '../core/input';

/**
 * Desktop ability bar (bottom left): Phantom Step [Q], Colossus Rift [E], Gravity Rupture [R], each with a cooldown
 * sweep that fills back in cyan and a brief flash when the ability becomes ready again. Touch devices use the SPIRIT
 * button instead (src/core/input.ts).
 */
const CSS = `
#spirit-hud { position: fixed; left: max(18px, env(safe-area-inset-left)); bottom: max(22px, env(safe-area-inset-bottom)); display: flex; gap: 10px; z-index: 5; pointer-events: none;
  font-family: Inter, system-ui, sans-serif; opacity: 0; transition: opacity 0.4s; }
#spirit-hud.show { opacity: 1; }
#spirit-hud .ab { position: relative; width: 54px; text-align: center; color: #e6f7ff; }
#spirit-hud .gem { position: relative; width: 46px; height: 46px; margin: 0 auto; border-radius: 50%; overflow: hidden;
  background: radial-gradient(circle at 50% 40%, rgba(40,90,120,0.55), rgba(8,14,20,0.75)); border: 1px solid rgba(140,225,255,0.45);
  box-shadow: 0 0 0 1px rgba(0,0,0,0.35), 0 0 10px rgba(80,210,255,0.0); transition: box-shadow 0.25s, border-color 0.25s; }
#spirit-hud .ab.ready .gem { border-color: rgba(170,240,255,0.95); box-shadow: 0 0 0 1px rgba(0,0,0,0.35), 0 0 14px rgba(80,210,255,0.55); }
#spirit-hud .ab.flash .gem { box-shadow: 0 0 0 1px rgba(0,0,0,0.35), 0 0 26px rgba(150,235,255,0.95); }
#spirit-hud .sweep { position: absolute; inset: 0; background: conic-gradient(rgba(5,10,14,0.78) calc(var(--c) * 360deg), transparent 0); }
#spirit-hud svg { position: absolute; inset: 9px; width: 28px; height: 28px; fill: none; stroke: #bdf1ff; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; filter: drop-shadow(0 0 3px rgba(80,210,255,0.9)); }
#spirit-hud .ab:not(.ready) svg { stroke: rgba(150,200,220,0.55); filter: none; }
#spirit-hud .key { position: absolute; right: 0; top: -4px; min-width: 16px; height: 16px; border-radius: 3px; background: rgba(8,12,16,0.85); border: 1px solid rgba(170,240,255,0.6);
  font-size: 10px; font-weight: 600; line-height: 15px; color: #dff7ff; }
#spirit-hud .nm { margin-top: 4px; font-size: 9px; letter-spacing: 0.14em; text-transform: uppercase; opacity: 0.85; text-shadow: 0 1px 2px #000; white-space: nowrap; }
`;
// Original line icons: a dash with afterimages, a crescent wave, a blade driven into concentric rings.
const ICONS: Record<SpiritKind, string> = {
  phantom: '<svg viewBox="0 0 28 28"><path d="M4 18 L22 9"/><path d="M8 22 L19 16.5" opacity="0.6"/><path d="M3 13 L12 8.5" opacity="0.45"/><circle cx="23" cy="8.5" r="1.6"/></svg>',
  rift: '<svg viewBox="0 0 28 28"><path d="M6 5 C16 8 20 16 18 24"/><path d="M10 6 C17 10 19 16 17.5 22" opacity="0.55"/><path d="M4 14 L9 12" opacity="0.6"/></svg>',
  rupture: '<svg viewBox="0 0 28 28"><path d="M14 2 L14 16"/><path d="M11 5 L17 5"/><ellipse cx="14" cy="20" rx="11" ry="4"/><ellipse cx="14" cy="20" rx="5.5" ry="2" opacity="0.6"/></svg>',
};
const NAMES: Record<SpiritKind, [string, string]> = { phantom: ['Phantom Step', 'Q'], rift: ['Colossus Rift', 'E'], rupture: ['Gravity Rupture', 'R'] };

export class SpiritHud {
  private root: HTMLElement;
  private items = new Map<SpiritKind, { el: HTMLElement; sweep: HTMLElement; was: boolean }>();
  constructor() {
    const st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    this.root = document.createElement('div'); this.root.id = 'spirit-hud';
    for (const k of Object.keys(NAMES) as SpiritKind[]) {
      const el = document.createElement('div'); el.className = 'ab ready';
      el.innerHTML = `<div class="gem">${ICONS[k]}<div class="sweep"></div></div><span class="key">${NAMES[k][1]}</span><div class="nm">${NAMES[k][0]}</div>`;
      this.root.appendChild(el);
      this.items.set(k, { el, sweep: el.querySelector('.sweep') as HTMLElement, was: true });
    }
    document.body.appendChild(this.root);
  }
  update(ready: Record<SpiritKind, number>, show: boolean) {
    this.root.classList.toggle('show', show);
    for (const [k, it] of this.items) {
      const r = Math.max(0, Math.min(1, ready[k])), on = r >= 1;
      it.sweep.style.setProperty('--c', (1 - r).toFixed(3));
      if (on !== it.was) {
        it.el.classList.toggle('ready', on);
        if (on) { it.el.classList.add('flash'); setTimeout(() => it.el.classList.remove('flash'), 280); }
        it.was = on;
      }
    }
  }
}
