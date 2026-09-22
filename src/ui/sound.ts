import { log } from '../telemetry';
import { $ } from './dom';

// Terminal sounds, synthesised with the Web Audio API (no audio files). Everything is built from
// square and triangle waves and short bursts of filtered noise, the sound palette of 1980s terminals
// and home computers, and runs through one gentle low-pass filter so nothing is harsh: the audio
// equivalent of the phosphor glow.
//
// On by default at medium volume; the [♪] button in the status bar steps up through LOW → MED → HIGH
// and then OFF, and the choice is remembered in this browser only. Browsers only allow audio after the visitor has interacted with the page, so the
// audio engine starts on a click or key press and anything before that stays silent: the first sound
// a visitor hears is their own first click. On iPhone the
// ring/silent switch still mutes it, which is deliberate: the visitor's choice wins.

const STORAGE_KEY = 'orbitwatch.sound';

type Level = 'off' | 'low' | 'med' | 'high';
const VOLUME: Record<Level, number> = { off: 0, low: 0.045, med: 0.09, high: 0.16 };
const NEXT: Record<Level, Level> = { off: 'low', low: 'med', med: 'high', high: 'off' };

let level = loadLevel();
let enabled = level !== 'off';
let ctx: AudioContext | null = null;
let master: GainNode;
let noiseBuffer: AudioBuffer;
const lastPlayed = new Map<string, number>();

function loadLevel(): Level {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved === 'off' || saved === 'low' || saved === 'high' ? saved : 'med';
  } catch {
    return 'med';
  }
}

function saveLevel() {
  try {
    localStorage.setItem(STORAGE_KEY, level);
  } catch {
    // Storage unavailable: the setting just lasts for this visit.
  }
}

/** True while the browser counts us as inside a click or key press (when audio may start). */
const inGesture = () => navigator.userActivation?.isActive ?? false;

/** The audio engine, or null when sound is off or the browser hasn't allowed audio yet. */
function audio(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    if (!inGesture()) return null;
    ctx = new AudioContext();
    const warm = ctx.createBiquadFilter();
    warm.type = 'lowpass';
    warm.frequency.value = 3200;
    master = ctx.createGain();
    master.gain.value = VOLUME[level];
    master.connect(warm).connect(ctx.destination);
    noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 0.1, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    // The terminal warms up the first time sound is allowed.
    queueMicrotask(() => sfx.powerOn());
  }
  if (ctx.state === 'running') return ctx;
  // Suspended until a gesture: resume it, and only schedule sounds if this is that gesture
  // (otherwise they would all play at once when audio is finally allowed).
  if (!inGesture()) return null;
  void ctx.resume();
  return ctx;
}

interface ToneOptions {
  type?: OscillatorType;
  gain?: number;
  /** Glide to this frequency over the tone. */
  slideTo?: number;
  /** Fade away over the whole tone after a soft attack (a struck, ringing sound) instead of holding. */
  ring?: boolean;
}

/** One enveloped note: `freq` Hz, starting `at` s from now, lasting `dur` s. */
function tone(freq: number, at: number, dur: number, { type = 'square', gain = 1, slideTo, ring = false }: ToneOptions = {}) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + at;
  const osc = c.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  const env = c.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(gain, t + (ring ? 0.012 : 0.004));
  if (!ring) env.gain.setValueAtTime(gain, t + Math.max(0.005, dur - 0.015));
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(env).connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** A burst of band-passed noise: the mechanical part of a key or relay click. */
function tick(at: number, dur: number, gain: number, freq: number, q = 1.2) {
  const c = audio();
  if (!c) return;
  const t = c.currentTime + at;
  const src = c.createBufferSource();
  src.buffer = noiseBuffer;
  const band = c.createBiquadFilter();
  band.type = 'bandpass';
  band.frequency.value = freq;
  band.Q.value = q;
  const env = c.createGain();
  env.gain.setValueAtTime(gain, t);
  env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(band).connect(env).connect(master);
  src.start(t, Math.random() * 0.05);
  src.stop(t + dur + 0.01);
}

/** Skip a sound if the same one played less than `ms` ago (fast repeats would smear together). */
function throttle(name: string, ms: number): boolean {
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? -Infinity) < ms) return false;
  lastPlayed.set(name, now);
  return true;
}

export const soundLevel = () => level;

export const sfx = {
  /** Key click: any button, link or list row. */
  click() {
    tick(0, 0.014, 0.9, 2600);
    tone(1850, 0, 0.018, { gain: 0.25 });
  },
  /** A switch turning on (rising) or off (falling). */
  toggle(on: boolean) {
    tick(0, 0.01, 0.6, 2200);
    const [a, b] = on ? [523, 784] : [784, 523];
    tone(a, 0, 0.035, { gain: 0.45 });
    tone(b, 0.04, 0.05, { gain: 0.45 });
  },
  /** Target acquired: three quick pips and a held tone. */
  lock() {
    for (const k of [0, 1, 2]) tone(1319, 0.06 + k * 0.07, 0.035, { gain: 0.4 });
    tone(1760, 0.27, 0.12, { gain: 0.45 });
  },
  /** Target released: a falling sweep. */
  release() {
    tone(880, 0, 0.18, { gain: 0.4, slideTo: 330 });
  },
  /** Acquisition / loss of signal as a satellite rises over or sets below the station. */
  aos() {
    tone(659, 0, 0.09, { type: 'triangle', gain: 0.8 });
    tone(988, 0.1, 0.16, { type: 'triangle', gain: 0.8 });
  },
  los() {
    tone(988, 0, 0.09, { type: 'triangle', gain: 0.8 });
    tone(659, 0.1, 0.16, { type: 'triangle', gain: 0.8 });
  },
  /** Closest approach reached: a pulsing two-tone alarm. */
  alarm() {
    for (let k = 0; k < 4; k++) tone(k % 2 ? 330 : 440, k * 0.12, 0.1, { type: 'sawtooth', gain: 0.35 });
  },
  /** A long job finished (close-approach screening). */
  done() {
    [1047, 1319, 1568].forEach((f, k) => tone(f, k * 0.05, k === 2 ? 0.09 : 0.045, { gain: 0.35 }));
  },
  /** A news story arrived: a small bell, like a teleprinter's. */
  bell() {
    tone(1568, 0, 0.35, { type: 'triangle', gain: 0.5 });
    tone(3136, 0, 0.12, { type: 'triangle', gain: 0.12 });
  },
  /** One teletype character: a faint random-pitched tick. */
  type() {
    tick(0, 0.006, 0.18, 1500 + Math.random() * 1500);
  },
  /** A detent while dragging the timeline. */
  scrub() {
    if (throttle('scrub', 45)) tick(0, 0.008, 0.5, 3000);
  },
  /** CRT power-on: a relay thunk, the tube's hum rising, and a faint high whine settling in. */
  powerOn() {
    tick(0, 0.14, 1.4, 140, 0.8);
    tone(55, 0.02, 0.6, { type: 'triangle', gain: 0.9, slideTo: 220 });
    tone(2600, 0.1, 0.7, { type: 'sine', gain: 0.05, slideTo: 3100 });
  },
  /** One beep of the closest-approach countdown; `step` counts up to 13 and the pitch climbs with it. */
  countdown(step: number) {
    tone(880 + step * 55, 0, 0.04, { gain: 0.4 });
  },
  /**
   * The standby radar's sweep passing north: a low submarine-sonar ping. Pure sine waves (no harsh
   * overtones) that ring away slowly with a faint echo, quiet enough to register without nagging.
   */
  ping() {
    tone(523, 0, 1.6, { type: 'sine', gain: 0.32, slideTo: 505, ring: true });
    tone(262, 0, 1.0, { type: 'sine', gain: 0.12, ring: true });
    tone(523, 0.42, 1.2, { type: 'sine', gain: 0.07, slideTo: 505, ring: true });
  },
  /** The locked target entering Earth's shadow (a low falling tone) or coming back into sunlight. */
  eclipse(entering: boolean) {
    if (entering) tone(262, 0, 0.4, { type: 'triangle', gain: 0.7, slideTo: 175 });
    else tone(392, 0, 0.3, { type: 'triangle', gain: 0.6, slideTo: 587 });
  },
  /** Data received: a burst of 1200/2200 Hz tones, the Bell 202 modem signal. */
  modem() {
    if (!throttle('modem', 1500)) return;
    for (let k = 0; k < 12; k++) tone(Math.random() < 0.5 ? 1200 : 2200, k * 0.02, 0.02, { gain: 0.12 });
  },
};

function isSwitchOn(el: Element): boolean {
  if (el.matches('#legend li')) return !el.classList.contains('off');
  if (el.hasAttribute('aria-pressed')) return el.getAttribute('aria-pressed') === 'true';
  return el.classList.contains('active');
}

function renderButton() {
  const btn = $('sound-btn');
  // Lit while sound is on, with a level bar (the same width at every level, for narrow status bars).
  btn.textContent = { off: '[♪·]', low: '[♪▂]', med: '[♪▅]', high: '[♪█]' }[level];
  btn.classList.toggle('active', enabled);
  btn.setAttribute('aria-pressed', String(enabled));
  btn.setAttribute('aria-label', `Terminal sounds: ${level}`);
  btn.title = {
    off: 'Sound: off (click for low)',
    low: 'Sound: low (click for medium)',
    med: 'Sound: medium (click for high)',
    high: 'Sound: high (click to mute)',
  }[level];
}

export function initSound() {
  renderButton();
  $('sound-btn').addEventListener('click', () => {
    // Say goodbye before muting: the blip is scheduled while sound is still on.
    if (NEXT[level] === 'off') sfx.toggle(false);
    level = NEXT[level];
    enabled = level !== 'off';
    saveLevel();
    renderButton();
    if (ctx && enabled) master.gain.setTargetAtTime(VOLUME[level], ctx.currentTime, 0.02);
    if (enabled) sfx.toggle(true);
    log('AUDIO', `TERMINAL SOUND · ${level.toUpperCase()}`);
  });

  // Every click on something interactive makes a sound. This listener is on the document, so it runs
  // after each control's own handler and can tell whether a switch has just turned on or off.
  document.addEventListener('click', (e) => {
    const el = (e.target as Element).closest(
      'button, a[href], #legend li, #results li, .pass-list li:not(.empty), .cj-list li:not(.empty)',
    );
    if (!el || el.id === 'sound-btn') return;
    if (el.matches('[data-overlay], #legend li, #cj-intra, #o-pick')) sfx.toggle(isSwitchOn(el));
    else sfx.click();
  });
}
