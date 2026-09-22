import { severity, type Conjunction } from '../conjunctions';
import { log } from '../telemetry';
import { blocks } from '../terminal';
import { clockSpeed, jumpTo, simNow } from './clock';
import { THRESHOLD_KM } from './conjunctionPanel';
import { app } from './context';
import { $ } from './dom';
import { fmt, fmtKm, hms } from './format';
import { toggleCategory } from './legend';
import { updateHash } from './links';
import { select } from './selection';
import { sfx } from './sound';

// Encounter view. Opening a close approach locks onto the first object, shows the second alongside
// it with a red line joining them, rewinds the clock to shortly before closest approach and holds
// the clock at the exact moment of closest approach.

const ENCOUNTER_LEAD_MS = 30_000;
let encounter: (Conjunction & { held: boolean }) | null = null;

export const currentEncounter = (): Conjunction | null => encounter;

export function openEncounter(ev: Conjunction) {
  const layer = app.layer;
  if (!layer) return;
  const sats = layer.sats;
  for (const i of [ev.a, ev.b]) if (layer.hidden.has(sats[i].category)) toggleCategory(sats[i].category, true);
  select(ev.a, true);
  encounter = { ...ev, held: false };
  jumpTo(ev.tcaMs - ENCOUNTER_LEAD_MS, 1);
  layer.setSecondary(ev.b, simNow());
  const sev = severity(ev.missKm);
  $('e-with').textContent = sats[ev.b].name;
  $('e-tca').textContent = `${new Date(ev.tcaMs).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
  $('e-miss').textContent = Number.isFinite(ev.missKm) ? fmtKm(ev.missKm) : '--';
  $('e-speed').textContent = Number.isFinite(ev.relSpeedKms) ? `${fmt(ev.relSpeedKms, 2)} KM/S` : '--';
  $('e-sev').textContent = sev.toUpperCase();
  $('e-sev').className = `illum sev-${sev}`;
  $('d-encounter').hidden = false;
  $('h-encounter').hidden = false;
  log('CONJ', `ENCOUNTER · ${sats[ev.a].name} × ${sats[ev.b].name} · MISS ${fmtKm(ev.missKm)}`, sev === 'critical' ? 'warn' : 'info');
  updateHash();
}

export function clearEncounter() {
  if (!encounter) return;
  encounter = null;
  app.layer?.setSecondary(-1, simNow());
  $('d-encounter').hidden = true;
  $('h-encounter').hidden = true;
}

/**
 * Called each frame before anything is drawn: freezes the clock exactly at closest approach, so the
 * geometry can be inspected. Returns the simulated time to draw.
 */
export function holdAtClosestApproach(sim: number): number {
  if (!encounter || encounter.held || clockSpeed() <= 0 || sim < encounter.tcaMs || sim - encounter.tcaMs >= 60_000) return sim;
  encounter.held = true;
  jumpTo(encounter.tcaMs, 0);
  const sep = app.layer?.separation(encounter.a, encounter.b, encounter.tcaMs);
  log('CONJ', `CLOSEST APPROACH · ${sep ? fmtKm(sep.km) : '--'} · HELD AT TCA`, 'warn');
  sfx.alarm();
  return encounter.tcaMs;
}

export function updateEncounterReadouts(sim: number) {
  const layer = app.layer;
  if (!encounter || !layer) return;
  const sep = layer.separation(encounter.a, encounter.b, sim);
  const range = sep ? fmtKm(sep.km) : '--';
  $('e-range').textContent = range;
  $('h-range').textContent = range;
  const dt = sim - encounter.tcaMs;
  $('h-tca').textContent = Math.abs(dt) < 500 ? 'NOW' : `${dt < 0 ? 'T−' : 'T+'}${hms(dt)}`;
  if (sep) blocks($('b-range'), 1 - Math.min(1, sep.km / 500), sep.km < THRESHOLD_KM);
}

export function initEncounter() {
  $('e-replay').addEventListener('click', () => {
    if (!encounter) return;
    encounter.held = false;
    jumpTo(encounter.tcaMs - 60_000, 1);
    log('CHRONO', 'ENCOUNTER REPLAY · T−60 S');
  });
  $('e-exit').addEventListener('click', () => {
    clearEncounter();
    updateHash();
  });
  $('e-with').addEventListener('click', () => {
    if (encounter) select(encounter.b);
  });
}
