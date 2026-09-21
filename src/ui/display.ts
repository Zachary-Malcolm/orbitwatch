import type { VisualMode } from '../scene';
import { log } from '../telemetry';
import { app, globe, groundTrack } from './context';
import { $ } from './dom';

// Display switches: phosphor / true colour, and the ground-track and footprint overlays.

function setVisualMode(next: VisualMode) {
  globe.setVisualMode(next);
  app.layer?.setVisualMode(next);
  document.body.dataset.vis = next;
  document.querySelectorAll<HTMLButtonElement>('#vis-toggle button').forEach((b) => {
    b.classList.toggle('active', b.dataset.vis === next);
  });
  log('DISPLAY', `VISUAL MODE · ${next === 'phosphor' ? 'PHOSPHOR' : 'TRUE COLOUR'}`);
}

export function initDisplay() {
  $('overlay-toggle').addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    const which = btn?.dataset.overlay;
    if (!btn || !which) return;
    const on = !btn.classList.contains('active');
    btn.classList.toggle('active', on);
    if (which === 'track') groundTrack.showTrack = on;
    else groundTrack.showFootprint = on;
    log('DISPLAY', `${which === 'track' ? 'GROUND TRACK' : 'COVERAGE FOOTPRINT'} · ${on ? 'ON' : 'OFF'}`);
  });

  $('vis-toggle').addEventListener('click', (e) => {
    const vis = (e.target as HTMLElement).closest('button')?.dataset.vis as VisualMode | undefined;
    if (vis && vis !== globe.visualMode) setVisualMode(vis);
  });
}
