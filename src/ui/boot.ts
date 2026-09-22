import { loadObserver } from '../observer';
import { globe } from './context';
import { $ } from './dom';
import { muteSound, sfx, soundLevel, unlockAudio } from './sound';
import { tvSwitchOn } from './tv';

// The boot screen shown while the terminal starts up: a pixel logo that flickers on, a spinning ASCII
// globe with satellites in orbit, a start-up log and a chunky segmented loading bar, then a CRT
// "switch-on" into the dashboard.
//
// The pacing is theatre (about five seconds) but the content is not: every log line reports something
// real (this device, the catalogue that actually arrived, imagery tiles streaming, stories received),
// and the bar cannot reach 100% until the satellite catalogue has really loaded. On a slow link it
// holds near the end, awaiting the downlink. Any key or tap skips it (to the television switch-on). Unless sound is muted, it opens on
// a press-any-key prompt, because browsers only allow sound after the visitor has pressed something,
// and the boot sequence has sounds of its own (see the boot section of sound.ts).

const BOOT_MS = 5000;
const SEGMENTS = 32;

// ---- Pixel logo ----------------------------------------------------------------

const FONT: Record<string, string[]> = {
  O: [' ### ', '#   #', '#   #', '#   #', ' ### '],
  R: ['#### ', '#   #', '#### ', '#  # ', '#   #'],
  B: ['#### ', '#   #', '#### ', '#   #', '#### '],
  I: ['#####', '  #  ', '  #  ', '  #  ', '#####'],
  T: ['#####', '  #  ', '  #  ', '  #  ', '  #  '],
  W: ['#   #', '#   #', '# # #', '# # #', ' # # '],
  A: [' ### ', '#   #', '#####', '#   #', '#   #'],
  C: [' ####', '#    ', '#    ', '#    ', ' ####'],
  H: ['#   #', '#   #', '#####', '#   #', '#   #'],
};

function buildLogo() {
  const word = 'ORBITWATCH';
  const rows = FONT.O.length;
  const cols = word.length * 6 - 1;
  const logo = $('boot-logo');
  logo.style.setProperty('--cols', String(cols));
  logo.style.setProperty('--rows', String(rows));
  const cells: HTMLElement[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const letter = word[Math.floor(c / 6)];
      const on = c % 6 < 5 && FONT[letter][r][c % 6] === '#';
      const cell = document.createElement('i');
      if (on) {
        cell.className = 'on';
        // Sweep on from left to right, with a little jitter so it flickers in like a warming tube.
        cell.style.animationDelay = `${120 + c * 14 + Math.random() * 140}ms`;
      }
      cells.push(cell);
    }
  }
  logo.replaceChildren(...cells);
}

// ---- Spinning ASCII globe --------------------------------------------------------

const COLS = 46;
const ROWS = 21;
const RX = 13;
const RY = 6.5; // text cells are about twice as tall as they are wide
const SHADE = ' .:-=+*#';
const TILT = 0.4;
const ORBITS = [
  { r: 1.38, inc: 0.95, node: 0.3, speed: 0.9, phase: 0 },
  { r: 1.62, inc: 1.65, node: 1.9, speed: 0.62, phase: 2.1 },
  { r: 1.24, inc: 0.35, node: 4.2, speed: 1.25, phase: 4.0 },
];

/** One frame of the globe as HTML: shaded wireframe Earth, orbit paths and satellites. */
function globeFrame(t: number): string {
  const grid: string[][] = [];
  const cls: string[][] = [];
  const cx = (COLS - 1) / 2;
  const cy = (ROWS - 1) / 2;
  const light = [-0.55, 0.45, 0.7];
  for (let r = 0; r < ROWS; r++) {
    grid.push(new Array(COLS).fill(' '));
    cls.push(new Array(COLS).fill(''));
    for (let c = 0; c < COLS; c++) {
      const x = (c - cx) / RX;
      const y = -(r - cy) / RY;
      const d2 = x * x + y * y;
      if (d2 > 1) continue;
      const z = Math.sqrt(1 - d2);
      const b = Math.max(0, x * light[0] + y * light[1] + z * light[2]);
      // Into the globe's own frame (axis tilted towards the viewer), then latitude/longitude.
      const by = y * Math.cos(TILT) + z * Math.sin(TILT);
      const bz = z * Math.cos(TILT) - y * Math.sin(TILT);
      const lat = (Math.asin(Math.max(-1, Math.min(1, by))) * 180) / Math.PI;
      const lon = (((Math.atan2(x, bz) + t * 0.6) * 180) / Math.PI) % 360;
      const nearLat = Math.abs(lat - Math.round(lat / 30) * 30) < 3.2;
      const lonMod = ((lon % 30) + 30) % 30;
      const nearLon = Math.min(lonMod, 30 - lonMod) < 4 / Math.max(0.35, Math.cos((lat * Math.PI) / 180));
      if (nearLat || nearLon) {
        grid[r][c] = nearLat && nearLon ? '+' : nearLat ? '-' : '|';
        cls[r][c] = b > 0.25 ? 'g' : 'n';
      } else {
        grid[r][c] = SHADE[Math.min(SHADE.length - 1, Math.floor(b * SHADE.length))];
        cls[r][c] = b > 0.25 ? '' : 'n';
      }
    }
  }

  const put = (px: number, py: number, pz: number, ch: string, k: string) => {
    const c = Math.round(cx + px * RX);
    const r = Math.round(cy - py * RY);
    if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return;
    const behind = pz < 0 && px * px + py * py < 1;
    if (!behind) {
      grid[r][c] = ch;
      cls[r][c] = k;
    }
  };
  for (const o of ORBITS) {
    const at = (a: number): [number, number, number] => {
      // A circle in the equatorial plane, inclined about X, then turned about Y to its node.
      const ex = o.r * Math.cos(a);
      const ez = o.r * Math.sin(a);
      const iy = -ez * Math.sin(o.inc);
      const iz = ez * Math.cos(o.inc);
      return [ex * Math.cos(o.node) + iz * Math.sin(o.node), iy, -ex * Math.sin(o.node) + iz * Math.cos(o.node)];
    };
    for (let k = 0; k < 110; k++) {
      const [x, y, z] = at((k / 110) * Math.PI * 2);
      const c = Math.round(cx + x * RX);
      const r = Math.round(cy - y * RY);
      if (grid[r]?.[c] === ' ') put(x, y, z, '.', 'o');
    }
    const [x, y, z] = at(o.phase + t * o.speed);
    put(x, y, z, '@', 's');
  }

  let html = '';
  for (let r = 0; r < ROWS; r++) {
    let run = '';
    let runCls = cls[r][0];
    for (let c = 0; c <= COLS; c++) {
      if (c === COLS || cls[r][c] !== runCls) {
        html += runCls ? `<span class="${runCls}">${run}</span>` : run;
        if (c === COLS) break;
        run = '';
        runCls = cls[r][c];
      }
      run += grid[r][c];
    }
    html += '\n';
  }
  return html;
}

// ---- Start-up log ------------------------------------------------------------------

type Report = { text: string; ok: boolean };
const reports = new Map<string, Report>();

/** Report a real start-up result (e.g. the catalogue that arrived) to the boot log. */
export function bootReport(key: string, text: string, ok = true) {
  if (!reports.has(key)) reports.set(key, { text, ok });
}

interface Line {
  at: number;
  label: string;
  /** The result, or null while it isn't known yet. */
  value: () => Report | null;
  /** The bar can't complete until this line has a result. */
  gate?: boolean;
  /** Shown if there's still no result when the line's turn comes (only for lines that don't gate). */
  pending?: string;
}

const LINES: Line[] = [
  { at: 350, label: 'CPU CORES', value: () => ({ text: `${navigator.hardwareConcurrency || '?'} THREADS`, ok: true }) },
  {
    at: 780,
    label: 'GRAPHICS',
    value: () => ({
      text: `WEBGL${globe.renderer.capabilities.isWebGL2 ? '2' : '1'} · ${globe.renderer.capabilities.maxTextureSize} TEX`,
      ok: true,
    }),
  },
  { at: 1200, label: 'DISPLAY', value: () => ({ text: `${screen.width}×${screen.height} @${Math.round(devicePixelRatio * 10) / 10}X`, ok: true }) },
  { at: 1620, label: 'SGP4 PROPAGATOR', value: () => ({ text: 'LOADED', ok: true }) },
  { at: 2080, label: 'CELESTRAK UPLINK', value: () => reports.get('catalogue') ?? null, gate: true },
  { at: 2520, label: 'DEBRIS TRACKING', value: () => reports.get('debris') ?? null, pending: 'PENDING' },
  {
    at: 2980,
    label: 'NASA GIBS IMAGERY',
    value: () => {
      const s = globe.tiles.stats();
      const n = s.visible + s.loading;
      return n ? { text: `${n} TILES`, ok: true } : null;
    },
    pending: 'CONNECTING',
  },
  { at: 3420, label: 'OBSERVER STATION', value: () => ({ text: loadObserver() ? 'RESTORED' : 'NOT SET', ok: true }) },
  { at: 3860, label: 'NEWS UPLINK', value: () => reports.get('news') ?? null, pending: 'STANDBY' },
];

const STATUS: [number, string][] = [
  [0, 'WARMING CATHODE'],
  [0.12, 'PROBING HARDWARE'],
  [0.4, 'DOWNLINKING ORBITAL ELEMENTS'],
  [0.62, 'STREAMING NASA IMAGERY'],
  [0.8, 'ESTABLISHING UPLINKS'],
  [0.95, 'FINAL CHECKS'],
];

/** Loading-bar progress over time: bursts and short pauses, like real loading, ending at 5 s. */
const PACE: [number, number][] = [
  [0, 0], [500, 0.04], [800, 0.12], [1100, 0.14], [1500, 0.3], [1800, 0.32], [2300, 0.5], [2600, 0.53],
  [3200, 0.72], [3500, 0.75], [4100, 0.9], [4600, 0.95], [5000, 1],
];

function paced(ms: number): number {
  for (let i = 1; i < PACE.length; i++) {
    const [t1, p1] = PACE[i];
    if (ms <= t1) {
      const [t0, p0] = PACE[i - 1];
      return p0 + ((p1 - p0) * (ms - t0)) / (t1 - t0);
    }
  }
  return 1;
}

let resolveBooted: () => void;
/** Resolves once the boot screen has gone and the dashboard is showing. */
export const whenBooted = new Promise<void>((resolve) => (resolveBooted = resolve));

/**
 * Show the boot screen. Browsers only allow sound after the visitor has pressed something, so unless
 * sound is muted it opens on a "PRESS ANY KEY TO POWER ON" prompt, and that press starts both the
 * audio and the boot sequence. (The catalogue is already downloading behind the prompt.)
 */
export function startBoot() {
  document.body.classList.add('booting');
  if (soundLevel() === 'off') return runBoot();

  const prompt = $('boot-prompt');
  const inner = $('boot-inner');
  prompt.hidden = false;
  inner.hidden = true;
  $('boot-hint').textContent = `OR TAP ANYWHERE · SOUND ${soundLevel().toUpperCase()}`;
  const muted = $('boot-muted');
  const go = (withSound: boolean) => {
    removeEventListener('keydown', onKey);
    $('boot').removeEventListener('click', onClick);
    if (withSound) unlockAudio();
    else muteSound();
    prompt.hidden = true;
    inner.hidden = false;
    // Let this press finish before the boot starts listening for a skip.
    setTimeout(runBoot, 0);
  };
  const onKey = (e: KeyboardEvent) => {
    if (['Tab', 'Shift', 'Control', 'Alt', 'Meta'].includes(e.key) || e.target === muted) return;
    go(true);
  };
  // Click rather than pointerdown: on touch screens only the end of a tap counts as permission for sound.
  const onClick = (e: MouseEvent) => go(e.target !== muted);
  addEventListener('keydown', onKey);
  $('boot').addEventListener('click', onClick);
}

function runBoot() {
  const boot = $('boot');
  buildLogo();
  sfx.crackle();

  const bar = $('boot-bar');
  const segs = Array.from({ length: SEGMENTS }, () => document.createElement('i'));
  bar.replaceChildren(...segs);
  const logEl = $('boot-log');
  const rows = LINES.map((line) => {
    const li = document.createElement('li');
    li.hidden = true;
    const label = Object.assign(document.createElement('span'), { className: 'lbl' });
    const value = Object.assign(document.createElement('span'), { className: 'val' });
    const tag = Object.assign(document.createElement('span'), { className: 'tag' });
    li.append(label, value, tag);
    logEl.append(li);
    return { line, li, label, value, tag, result: null as Report | null };
  });
  const final = Object.assign(document.createElement('li'), { className: 'final', hidden: true });
  logEl.append(final);

  const t0 = performance.now();
  let progress = 0;
  let litShown = 0;
  let finishing = false;
  let raf = 0;
  const dotsFull = (label: string) => `${label} ${'.'.repeat(Math.max(2, 20 - label.length))}`;

  const frame = (now: number) => {
    const ms = now - t0;
    $('boot-globe').innerHTML = globeFrame(ms / 1000);

    // Log lines type out in their turn, then show their (real) result.
    for (const row of rows) {
      const { line } = row;
      if (ms < line.at) continue;
      row.li.hidden = false;
      const typed = Math.min(1, (ms - line.at) / 220);
      const full = dotsFull(line.label);
      row.label.textContent = `> ${full.slice(0, Math.ceil(full.length * typed))}`;
      if (typed < 1) sfx.key();
      if (typed < 1 || row.result) continue;
      const result = line.value() ?? (line.pending && ms > line.at + 400 ? { text: line.pending, ok: true } : null);
      if (result) {
        row.result = result;
        row.value.textContent = ` ${result.text}`;
        row.tag.textContent = result.ok ? ' [ OK ]' : ' [FAIL]';
        row.tag.classList.toggle('fail', !result.ok);
        sfx.check(result.ok);
      } else {
        row.value.textContent = ` ${'.'.repeat(1 + (Math.floor(ms / 250) % 3))}`;
      }
    }

    // The bar follows the pace, but holds short of the end until the catalogue has really arrived.
    const catalogueIn = rows.find((r) => r.line.gate)!.result !== null;
    const target = catalogueIn ? paced(ms) : Math.min(paced(ms), 0.9);
    progress = Math.max(progress, Math.min(target, progress + 0.02 + (catalogueIn && ms > BOOT_MS ? 0.05 : 0)));
    const lit = Math.round(progress * SEGMENTS);
    segs.forEach((s, i) => (s.className = i < lit - 1 ? 'on' : i === lit - 1 ? 'on hot' : ''));
    // Each newly lit segment ticks, higher as the bar fills (a burst plays as a quick run up).
    for (let i = litShown; i < lit; i++) sfx.segment(i, SEGMENTS, (i - litShown) * 0.03);
    litShown = Math.max(litShown, lit);
    $('boot-pct').textContent = `${String(Math.round(progress * 100)).padStart(3, '0')}%`;
    const waiting = !catalogueIn && progress >= 0.9;
    if (waiting) sfx.modem();
    const status = waiting ? 'AWAITING DOWNLINK' : [...STATUS].reverse().find(([p]) => progress >= p)![1];
    $('boot-status').textContent = progress >= 1 ? 'SYSTEM READY' : `${status}${'.'.repeat(1 + (Math.floor(ms / 300) % 3))}`;

    if (progress >= 1 && rows.every((r) => r.result)) {
      const degraded = rows.some((r) => r.result && !r.result.ok);
      final.hidden = false;
      final.classList.toggle('fail', degraded);
      final.textContent = degraded ? '> DEGRADED · SEE EVENT LOG' : '> ALL SYSTEMS NOMINAL';
      boot.classList.add('ready');
      sfx.ready();
      return finish(650);
    }
    raf = requestAnimationFrame(frame);
  };

  const finish = (holdMs: number) => {
    if (finishing) return;
    finishing = true;
    cancelAnimationFrame(raf);
    removeEventListener('keydown', skip);
    boot.removeEventListener('pointerdown', skip);
    setTimeout(() => {
      // The boot screen snaps off to black, then the dashboard switches on like an old television
      // (src/ui/tv.ts). The television's black screen goes up before the boot screen comes down,
      // so the dashboard is never seen before the static reveals it.
      sfx.snapOff();
      const switchingOn = tvSwitchOn();
      boot.remove();
      document.body.classList.remove('booting');
      switchingOn.then(resolveBooted);
    }, holdMs);
  };
  const skip = () => finish(0);
  addEventListener('keydown', skip);
  boot.addEventListener('pointerdown', skip);
  raf = requestAnimationFrame(frame);
}
