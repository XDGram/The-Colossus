/**
 * Loading-screen art: an ink-wash (sumi-e) painting drawn in code, so it appears instantly while the game loads.
 * Paper, layered misty mountains, a red sun, the temple gate's curved roof, a lone swordsman with his katana,
 * and a few gold ginkgo leaves. Deterministic (seeded) so it looks the same every time.
 */
export function paintInkArt(canvas: HTMLCanvasElement) {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const W = canvas.clientWidth || innerWidth, H = canvas.clientHeight || innerHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  const g = canvas.getContext('2d')!;
  g.scale(dpr, dpr);
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const S = Math.min(W, H);

  // Paper.
  g.fillStyle = '#e9e3d6'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < (W * H) / 900; i++) { g.fillStyle = `rgba(80,70,55,${rnd() * 0.05})`; g.fillRect(rnd() * W, rnd() * H, 1 + rnd() * 2, 1); }
  const vig = g.createRadialGradient(W * 0.5, H * 0.45, S * 0.2, W * 0.5, H * 0.5, Math.max(W, H) * 0.75);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(60,48,32,0.35)');
  g.fillStyle = vig; g.fillRect(0, 0, W, H);

  // Red sun.
  const sx = W * 0.68, sy = H * 0.3, sr = S * 0.16;
  g.fillStyle = '#b3261e'; g.globalAlpha = 0.92; g.beginPath(); g.arc(sx, sy, sr, 0, Math.PI * 2); g.fill(); g.globalAlpha = 1;

  // Mountain ridges, far (pale) to near (dark), with soft wash edges.
  const ridge = (base: number, amp: number, alpha: number, blur: number, rough: number) => {
    g.save(); g.filter = `blur(${blur}px)`; g.fillStyle = `rgba(20,18,16,${alpha})`;
    g.beginPath(); g.moveTo(-20, H + 20);
    let y = base;
    for (let x = -20; x <= W + 20; x += 6) {
      y += (rnd() - 0.5) * rough;
      const peak = Math.sin(x * 0.004 + base) * amp + Math.sin(x * 0.011 + base * 3) * amp * 0.35;
      g.lineTo(x, H * base - peak + (y - base));
    }
    g.lineTo(W + 20, H + 20); g.closePath(); g.fill(); g.restore();
  };
  ridge(0.58, S * 0.12, 0.16, 6, 0.6);
  ridge(0.66, S * 0.09, 0.28, 4, 0.8);
  ridge(0.76, S * 0.06, 0.45, 2.5, 1.0);
  // Mist band.
  const mist = g.createLinearGradient(0, H * 0.6, 0, H * 0.85);
  mist.addColorStop(0, 'rgba(233,227,214,0)'); mist.addColorStop(0.5, 'rgba(233,227,214,0.55)'); mist.addColorStop(1, 'rgba(233,227,214,0)');
  g.fillStyle = mist; g.fillRect(0, H * 0.6, W, H * 0.25);

  // Temple gate roof (curved eaves) on the left, brushed in dark ink.
  const tx = W * 0.2, ty = H * 0.56, tw = S * 0.5;
  g.fillStyle = 'rgba(15,13,12,0.88)';
  g.beginPath();
  g.moveTo(tx - tw * 0.55, ty + 4);
  g.quadraticCurveTo(tx - tw * 0.3, ty - tw * 0.02, tx - tw * 0.18, ty - tw * 0.2);
  g.lineTo(tx + tw * 0.18, ty - tw * 0.2);
  g.quadraticCurveTo(tx + tw * 0.3, ty - tw * 0.02, tx + tw * 0.55, ty + 4);
  g.quadraticCurveTo(tx, ty - tw * 0.06, tx - tw * 0.55, ty + 4);
  g.fill();
  g.fillRect(tx - tw * 0.32, ty - 2, tw * 0.64, tw * 0.03); // beam
  for (const k of [-0.28, -0.1, 0.1, 0.28]) g.fillRect(tx + tw * k - 3, ty, 6, H * 0.32); // posts
  g.fillRect(tx - tw * 0.22, ty - tw * 0.25, tw * 0.44, tw * 0.05); // upper roof ridge

  // Ground brush stroke.
  g.save(); g.filter = 'blur(1px)';
  g.fillStyle = 'rgba(15,13,12,0.9)';
  g.beginPath(); g.moveTo(0, H * 0.9);
  for (let x = 0; x <= W; x += 8) g.lineTo(x, H * 0.885 + Math.sin(x * 0.02) * 3 + (rnd() - 0.5) * 3);
  g.lineTo(W, H); g.lineTo(0, H); g.closePath(); g.fill(); g.restore();

  // Lone swordsman, right of centre, katana held low and back.
  const mx = W * 0.62, my = H * 0.885, mh = S * 0.34;
  g.fillStyle = '#100e0d';
  g.beginPath();
  g.moveTo(mx - mh * 0.16, my);                         // wide hakama hem
  g.lineTo(mx - mh * 0.09, my - mh * 0.48);
  g.lineTo(mx - mh * 0.13, my - mh * 0.78);              // shoulders / cloak
  g.quadraticCurveTo(mx, my - mh * 0.86, mx + mh * 0.12, my - mh * 0.78);
  g.lineTo(mx + mh * 0.1, my - mh * 0.48);
  g.lineTo(mx + mh * 0.18, my);
  g.closePath(); g.fill();
  g.beginPath(); g.arc(mx, my - mh * 0.9, mh * 0.065, 0, Math.PI * 2); g.fill(); // head
  // Cloak trailing in the wind.
  g.beginPath(); g.moveTo(mx - mh * 0.12, my - mh * 0.76);
  g.quadraticCurveTo(mx - mh * 0.45, my - mh * 0.7, mx - mh * 0.55, my - mh * 0.52);
  g.quadraticCurveTo(mx - mh * 0.35, my - mh * 0.6, mx - mh * 0.1, my - mh * 0.6); g.fill();
  // Katana: a thin bright edge.
  g.strokeStyle = '#100e0d'; g.lineWidth = Math.max(2, mh * 0.012); g.lineCap = 'round';
  g.beginPath(); g.moveTo(mx + mh * 0.08, my - mh * 0.52); g.quadraticCurveTo(mx + mh * 0.4, my - mh * 0.4, mx + mh * 0.62, my - mh * 0.18); g.stroke();
  g.strokeStyle = 'rgba(233,227,214,0.8)'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(mx + mh * 0.14, my - mh * 0.5); g.quadraticCurveTo(mx + mh * 0.4, my - mh * 0.41, mx + mh * 0.6, my - mh * 0.19); g.stroke();

  // Gold ginkgo leaves drifting.
  for (let i = 0; i < 26; i++) {
    const x = rnd() * W, y = rnd() * H * 0.85, r = S * (0.006 + rnd() * 0.008), a = rnd() * Math.PI * 2;
    g.save(); g.translate(x, y); g.rotate(a); g.fillStyle = `rgba(${200 + rnd() * 30},${150 + rnd() * 30},40,${0.65 + rnd() * 0.3})`;
    g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, r * 1.6, -0.9, 0.9); g.closePath(); g.fill(); g.restore();
  }

  // Splatter accents.
  for (let i = 0; i < 40; i++) { g.fillStyle = `rgba(15,13,12,${0.15 + rnd() * 0.5})`; g.beginPath(); g.arc(W * (0.05 + rnd() * 0.25), H * (0.08 + rnd() * 0.2), 0.5 + rnd() * 2.5, 0, Math.PI * 2); g.fill(); }
}

/** Combat tips shown on the loading screen. */
export const TIPS = [
  ['Block', 'Hold Block to soften an Ash Runner’s blade. Tap it just as the strike lands to parry instead.'],
  ['Read the glint', 'A pale glint can be parried. A red glint cannot — roll away when the Iron Breaker smashes or charges.'],
  ['Riposte', 'After a parry, strike at once. A riposte cuts deep, deeper still into a staggered foe.'],
  ['Heavy slash', 'Hold Attack for a heavy slash that breaks an Ash Runner’s stance.'],
  ['Break the guard', 'Attack while blocking to kick through an enemy’s guard.'],
  ['The Iron Breaker', 'Ordinary cuts will not stop him. Strike from behind, or after a missed smash, to bring him to his knees.'],
  ['Patience', 'Only two foes attack at once. Watch the others circle, and choose your moment.'],
  ['Timing', 'Mashing Attack leaves you open. Time each cut of the combo.'],
] as const;
