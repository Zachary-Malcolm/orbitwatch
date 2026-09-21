import { log } from '../telemetry';
import { clockSpeed, jumpTo, simNow } from './clock';
import { $ } from './dom';
import { hms } from './format';
import { updateFastReadouts } from './gauges';
import { currentPasses } from './passesPanel';

// The timeline under the chrono clock: drag to move the simulated time anywhere in the next 24 hours.
// The clock holds while dragging and carries on at its previous speed from wherever it is let go.
// Passes of the locked target over the observer station are marked on it.

const SPAN_MIN = 24 * 60;

let dragging = false;
let resumeSpeed = 1;
let marksKey = '';

/** Minutes from real time, as the slider measures it. */
const offsetMin = (sim: number) => (sim - Date.now()) / 60_000;

function scrubTo(minutes: number, speed: number) {
  jumpTo(Date.now() + minutes * 60_000, speed);
  updateFastReadouts(simNow());
}

/** Keep the slider and its pass marks in step with the clock (4 times a second). */
export function updateTimeline(sim: number) {
  const slider = $<HTMLInputElement>('scrub');
  const offset = offsetMin(sim);
  // Outside the window (an old encounter link, or run far ahead at 1000×): park at the end, dimmed.
  slider.classList.toggle('out', offset < -1 || offset > SPAN_MIN + 1);
  if (!dragging) slider.value = String(Math.round(Math.min(Math.max(offset, 0), SPAN_MIN)));

  const now = Date.now();
  const passes = currentPasses().filter((p) => p.setMs > now && p.riseMs < now + SPAN_MIN * 60_000);
  const key = passes.map((p) => `${p.riseMs}:${p.visible}`).join(',') + `@${Math.floor(now / 60_000)}`;
  if (key === marksKey) return;
  marksKey = key;
  $('scrub-marks').replaceChildren(
    ...passes.map((p) => {
      const mark = document.createElement('i');
      mark.className = p.visible ? 'vis' : '';
      mark.style.setProperty('--at', String(Math.max(0, offsetMin(p.riseMs)) / SPAN_MIN));
      mark.title = `Pass at T+${hms(p.riseMs - now).slice(0, -3)}${p.visible ? ' · visible' : ''}`;
      return mark;
    }),
  );
}

export function initTimeline() {
  const slider = $<HTMLInputElement>('scrub');
  // `input` fires as the thumb moves (hold the clock there), `change` when it is let go (resume).
  slider.addEventListener('input', () => {
    if (!dragging) {
      dragging = true;
      resumeSpeed = clockSpeed();
    }
    scrubTo(Number(slider.value), 0);
  });
  slider.addEventListener('change', () => {
    if (!dragging) return;
    dragging = false;
    const min = Number(slider.value);
    scrubTo(min, resumeSpeed);
    log('CHRONO', `TIMELINE · ${min === 0 ? 'NOW' : `T+${hms(min * 60_000).slice(0, -3)}`}${resumeSpeed === 1 ? '' : ` · ×${resumeSpeed}`}`);
  });
}
