import { log } from '../telemetry';
import { app } from './context';
import { $ } from './dom';
import { currentEncounter, openEncounter } from './encounter';
import { select } from './selection';

// Shareable links: #norad=25544 opens a satellite; #norad=A&with=B&t=<ISO time> opens a close approach.
// Links only ever carry catalogue numbers and a time, never the observer's location.

export function updateHash() {
  const layer = app.layer;
  if (!layer) return;
  const sats = layer.sats;
  const encounter = currentEncounter();
  let hash = '';
  if (encounter) {
    hash = `#norad=${sats[encounter.a].noradId}&with=${sats[encounter.b].noradId}&t=${new Date(encounter.tcaMs).toISOString()}`;
  } else if (layer.selected >= 0) {
    hash = `#norad=${sats[layer.selected].noradId}`;
  }
  if (hash !== location.hash) history.replaceState(null, '', hash || location.pathname + location.search);
}

/** Open whatever the address bar's link points at. */
export function applyHash() {
  const layer = app.layer;
  if (!layer) return;
  const params = new URLSearchParams(location.hash.slice(1));
  const a = app.byNorad.get(params.get('norad') ?? '');
  if (a === undefined) {
    if (params.has('norad')) log('LINK', `NORAD ${params.get('norad')} NOT IN CATALOGUE`, 'warn');
    return;
  }
  const b = app.byNorad.get(params.get('with') ?? '');
  const t = Date.parse(params.get('t') ?? '');
  log('LINK', `OPENING SHARED ${b !== undefined ? 'ENCOUNTER' : 'TARGET'} FROM URL`);
  if (b !== undefined && Number.isFinite(t)) {
    const sep = layer.separation(a, b, t);
    openEncounter({ a, b, tcaMs: t, missKm: sep?.km ?? NaN, relSpeedKms: sep?.kms ?? NaN });
  } else {
    select(a);
  }
}

export function initLinks() {
  window.addEventListener('hashchange', applyHash);
  $('copy-link').addEventListener('click', () => {
    navigator.clipboard.writeText(location.href).then(
      () => log('LINK', `COPIED · ${location.href}`, 'ok'),
      () => log('LINK', 'CLIPBOARD UNAVAILABLE · COPY THE ADDRESS BAR INSTEAD', 'warn'),
    );
  });
}
