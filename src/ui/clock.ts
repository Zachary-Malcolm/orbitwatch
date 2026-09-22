import { log } from '../telemetry';
import { $ } from './dom';

// The simulated clock: runs at `speed` × real time from an anchor, so it can be held, sped up or jumped.

let speed = 1;
let anchorSim = Date.now();
let anchorReal = performance.now();
let jumps = 0;

export const simNow = () => anchorSim + (performance.now() - anchorReal) * speed;
export const clockSpeed = () => speed;
/**
 * Counts jumps of the clock (not speed changes). Watchers of state changes such as eclipses and rises
 * compare it to tell a real change from a jump to a different moment, which they shouldn't announce.
 */
export const clockJumps = () => jumps;

/** Set the simulated clock to `ms` and run it at `nextSpeed`. */
export function jumpTo(ms: number, nextSpeed: number) {
  if (Math.abs(ms - simNow()) > 1000) jumps++;
  anchorSim = ms;
  anchorReal = performance.now();
  speed = nextSpeed;
  document.querySelectorAll<HTMLButtonElement>('#speeds [data-speed]').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.speed) === speed);
  });
}

function setSpeed(next: number, resetToNow = false) {
  jumpTo(resetToNow ? Date.now() : simNow(), next);
  log('CHRONO', resetToNow ? 'RESYNCED TO REAL TIME' : speed === 0 ? 'SIMULATION HELD' : `TIME RATE ×${speed}`);
}

export function initClock() {
  $('speeds').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn) return;
    if (btn.id === 'now-btn') setSpeed(1, true);
    else setSpeed(Number(btn.dataset.speed));
  });
}
