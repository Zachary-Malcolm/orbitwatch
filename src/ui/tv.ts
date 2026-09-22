import { sfx } from './sound';

// The switch-on from the boot screen to the dashboard, like an old television warming up, in the
// terminal's phosphor amber: a point of light blooms in the centre, stretches into a bright horizontal
// line, tears open into rolling static (with the dashboard expanding underneath), and the static
// flickers away while the picture steadies. The page's CRT scanlines sit on top of all of it.

/** Size of one grain of static, in CSS pixels (the noise is drawn small and scaled up, square). */
const GRAIN_PX = 3;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Amber static with bright horizontal bands rolling through it, drawn small and scaled up. */
function startStatic(canvas: HTMLCanvasElement): () => void {
  const w = (canvas.width = Math.ceil(innerWidth / GRAIN_PX));
  const h = (canvas.height = Math.ceil(innerHeight / GRAIN_PX));
  const ctx = canvas.getContext('2d')!;
  const img = ctx.createImageData(w, h);
  const d = img.data;
  let raf = 0;
  const draw = (now: number) => {
    // Bands are measured in screen pixels, so they look the same on any screen shape.
    const roll = now / 3;
    for (let y = 0; y < h; y++) {
      const py = y * GRAIN_PX;
      // Two bands of different widths drifting down the screen at different speeds.
      const band = 0.68 + 0.22 * Math.sin((py + roll) / 21) + 0.15 * Math.sin((py - roll * 0.6) / 57);
      for (let x = 0; x < w; x++) {
        const v = Math.min(1, Math.random() * band * 1.25);
        const i = (y * w + x) * 4;
        // Amber, running towards pale amber in the brightest grains (as the phosphor pass does).
        d[i] = 255 * v;
        d[i + 1] = (176 + 50 * v * v) * v;
        d[i + 2] = 160 * v * v * v;
        d[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
    raf = requestAnimationFrame(draw);
  };
  raf = requestAnimationFrame(draw);
  return () => cancelAnimationFrame(raf);
}

/** Play the switch-on over the (already rendered) dashboard; resolves when it's done. */
export async function tvSwitchOn(): Promise<void> {
  const app = document.getElementById('app')!;
  const tv = document.createElement('div');
  tv.className = 'tv';
  tv.setAttribute('aria-hidden', 'true');
  const noise = Object.assign(document.createElement('canvas'), { className: 'tv-noise' });
  const dot = Object.assign(document.createElement('div'), { className: 'tv-dot' });
  const line = Object.assign(document.createElement('div'), { className: 'tv-line' });
  tv.append(noise, line, dot);
  document.body.append(tv);

  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    await tv.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: 'forwards' }).finished;
    tv.remove();
    return;
  }

  // Expand from the middle of the screen (on phones #app is the whole, much taller, scrolling page).
  app.style.transformOrigin = `50% ${scrollY + innerHeight / 2}px`;
  app.style.transform = 'scale(1, 0.004)';

  // 1. A point of light blooms in the centre.
  sfx.tvWhine();
  dot.animate(
    [
      { transform: 'scale(0)', opacity: 0 },
      { transform: 'scale(1.5)', opacity: 1, offset: 0.6 },
      { transform: 'scale(1)', opacity: 1 },
    ],
    { duration: 260, easing: 'ease-out', fill: 'forwards' },
  );
  await wait(200);

  // 2. It stretches into a bright horizontal line.
  sfx.crtOn();
  line.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: 250, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)', fill: 'forwards' });
  dot.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 250, delay: 120, fill: 'forwards' });
  await wait(260);

  // 3. The line tears open into rolling static, with the dashboard expanding underneath it.
  sfx.staticBurst(0.75);
  const stopStatic = startStatic(noise);
  const open = { duration: 290, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.08)', fill: 'forwards' as const };
  noise.animate([{ transform: 'scaleY(0.004)' }, { transform: 'scaleY(1)' }], open);
  const opening = app.animate([{ transform: 'scale(1, 0.004)' }, { transform: 'none' }], open);
  line.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, fill: 'forwards' });
  await wait(290);
  app.style.transform = '';

  // 4. The static flickers away and the picture steadies.
  const flicker = { duration: 560, easing: 'linear', fill: 'forwards' as const };
  tv.animate([1, 0.85, 0.95, 0.45, 0.7, 0.2, 0.35, 0].map((opacity) => ({ opacity })), flicker);
  await app.animate(
    [2.2, 0.5, 1.7, 0.75, 1.3, 0.9, 1.08, 1].map((b) => ({ filter: `brightness(${b})` })),
    { duration: 620, easing: 'linear' },
  ).finished;

  stopStatic();
  tv.remove();
  // Leave no transform on the dashboard (it would change how fixed-position elements inside it behave).
  opening.cancel();
  app.style.transformOrigin = '';
}
