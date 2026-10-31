// Confetti on a full screen canvas, no library. One burst from the top, about 2.6 s, then the canvas
// removes itself. Skipped when the person asked for reduced motion.
const COLORS = ['#7c9cff', '#3ddc97', '#ffb547', '#ff5d6c', '#e8ebf2', '#b48cff'];
const DURATION_MS = 2600;
const COUNT = 170;

interface Bit { x: number; y: number; vx: number; vy: number; w: number; h: number; rot: number; vr: number; color: string; wob: number }

let running: HTMLCanvasElement | null = null;

export function confetti(): HTMLCanvasElement | null {
  if (typeof window === 'undefined') return null;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return null;
  running?.remove();
  const cv = document.createElement('canvas');
  cv.className = 'rs-confetti';
  cv.dataset.testid = 'result-confetti';
  cv.setAttribute('aria-hidden', 'true');
  document.body.append(cv);
  running = cv;
  const ctx = cv.getContext('2d');
  if (!ctx) { setTimeout(() => cv.remove(), DURATION_MS); return cv; }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const W = window.innerWidth, H = window.innerHeight;
  cv.width = Math.round(W * dpr);
  cv.height = Math.round(H * dpr);
  ctx.scale(dpr, dpr);
  const bits: Bit[] = Array.from({ length: COUNT }, (_, i) => {
    const fromLeft = i % 2 === 0; // two cannons, top left and top right, aimed in and up
    const a = (fromLeft ? -55 : -125) * (Math.PI / 180) + (Math.random() - 0.5) * 0.9;
    const v = 9 + Math.random() * 9;
    return {
      x: fromLeft ? W * 0.12 : W * 0.88, y: H * 0.28,
      vx: Math.cos(a) * v, vy: Math.sin(a) * v,
      w: 6 + Math.random() * 6, h: 3 + Math.random() * 4,
      rot: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35,
      color: COLORS[i % COLORS.length], wob: Math.random() * Math.PI * 2,
    };
  });
  const t0 = performance.now();
  let last = t0;
  const frame = (now: number) => {
    if (running !== cv) return;
    const dt = Math.min(2, (now - last) / 16.7); // in 60 fps frames
    last = now;
    const age = now - t0;
    ctx.clearRect(0, 0, W, H);
    ctx.globalAlpha = age > DURATION_MS - 600 ? Math.max(0, (DURATION_MS - age) / 600) : 1;
    for (const b of bits) {
      b.vy += 0.32 * dt;
      b.vx *= 0.985 ** dt;
      b.vy *= 0.985 ** dt;
      b.wob += 0.12 * dt;
      b.x += (b.vx + Math.sin(b.wob) * 0.6) * dt;
      b.y += b.vy * dt;
      b.rot += b.vr * dt;
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.rot);
      ctx.scale(1, Math.abs(Math.cos(b.wob))); // flutter
      ctx.fillStyle = b.color;
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
      ctx.restore();
    }
    if (age < DURATION_MS) requestAnimationFrame(frame);
    else { cv.remove(); if (running === cv) running = null; }
  };
  requestAnimationFrame(frame);
  // If frames stop (hidden tab), still clean up.
  setTimeout(() => { if (running === cv) { cv.remove(); running = null; } }, DURATION_MS + 1500);
  return cv;
}
