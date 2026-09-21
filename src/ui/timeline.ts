import { log } from '../telemetry';
import { clockSpeed, jumpTo, simNow } from './clock';
import { $ } from './dom';
import { hms } from './format';
import { updateFastReadouts } from './gauges';
import { currentPasses } from './passesPanel';

// The timeline: drag to move the simulated time anywhere in the next 24 hours. The clock holds while
// dragging and carries on at its previous speed from wherever it is let go. Passes of the locked target
// over the observer station are marked on it. It sits under the chrono clock, except on phones, where
// the clock panel is far below the globe: there it moves onto the bottom of the globe, with a readout
// of the offset, so the globe stays in view while dragging.

const SPAN_MIN = 24 * 60;
const PHONE = matchMedia('(max-width: 900px)');

let dragging = false;
let resumeSpeed = 1;
let marksKey = '';

/** Minutes from real time, as the slider measures it. */
const offsetMin = (sim: number) => (sim - Date.now()) / 60_000;

/** "NOW", "+19:35", "+2D 14:44" or "−00:05". */
function offsetLabel(minutes: number) {
  if (Math.abs(minutes) < 1) return 'NOW';
  return `${minutes < 0 ? '−' : '+'}${hms(minutes * 60_000).slice(0, -3)}`;
}

function scrubTo(minutes: number, speed: number) {
  jumpTo(Date.now() + minutes * 60_000, speed);
  updateFastReadouts(simNow());
  updateTimeline(simNow());
}

/** Under the clock on wider screens, on the globe on phones. */
function placeTimeline() {
  const timeline = $('timeline');
  if (PHONE.matches) document.querySelector('.viewport')!.append(timeline);
  else $('sim-time').after(timeline);
}

/** Keep the slider and its pass marks in step with the clock (4 times a second). */
export function updateTimeline(sim: number) {
  const slider = $<HTMLInputElement>('scrub');
  const offset = offsetMin(sim);
  // Outside the window (an old encounter link, or run far ahead at 1000×): park at the end, dimmed.
  slider.classList.toggle('out', offset < -1 || offset > SPAN_MIN + 1);
  if (!dragging) slider.value = String(Math.round(Math.min(Math.max(offset, 0), SPAN_MIN)));
  $('scrub-offset').textContent = offsetLabel(offset);

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
  placeTimeline();
  PHONE.addEventListener('change', placeTimeline);
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
