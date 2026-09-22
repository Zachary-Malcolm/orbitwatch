import './style.css';
import * as THREE from 'three';
import { SatelliteLayer } from './satellites';
import { loadDebris, loadSatellites, type SatInfo } from './tle';
import { log } from './telemetry';
import { mountLog, radarFrame } from './terminal';
import { app, canvas, globe, groundTrack, models, observerMarker } from './ui/context';
import { $ } from './ui/dom';
import { initClock, simNow } from './ui/clock';
import { updateCamera, updateReticle } from './ui/camera';
import { initTabs } from './ui/tabs';
import { initSelection } from './ui/selection';
import { initObserverPanel, updateObserverReadouts } from './ui/passesPanel';
import { getConj, initConjunctionPanel, runScreening } from './ui/conjunctionPanel';
import { encounterCountdown, holdAtClosestApproach, initEncounter, updateEncounterReadouts } from './ui/encounter';
import { applyHash, initLinks } from './ui/links';
import { initDossier } from './ui/dossier';
import { initNews } from './ui/newsPanel';
import { initDisplay } from './ui/display';
import { initPicking, updateHover } from './ui/picking';
import { enableSearch, initSearch } from './ui/search';
import { buildLegend } from './ui/legend';
import { buildCensus, recordFrame, updateFastReadouts, updateGauges } from './ui/gauges';
import { initTour, offerTour } from './ui/tour';
import { initTimeline, updateTimeline } from './ui/timeline';
import { initSound, sfx } from './ui/sound';
import { bootReport, startBoot, whenBooted } from './ui/boot';
import { initMobile, updateTargetChip } from './ui/mobile';

// Entry point: wires up the terminal's panels (src/ui/), runs the frame loop and loads the catalogue.

startBoot();
mountLog($('log'));
log('SYSTEM', 'ORBITWATCH MK-II TERMINAL ONLINE', 'ok');
log('RENDER', `WEBGL${globe.renderer.capabilities.isWebGL2 ? '2' : '1'} CONTEXT · MAX TEX ${globe.renderer.capabilities.maxTextureSize}`);

initClock();
initTabs();
initSelection();
initObserverPanel();
initConjunctionPanel();
initEncounter();
initLinks();
initDossier();
initNews();
initDisplay();
initPicking();
initSearch();
initTour();
initTimeline();
initSound();
initMobile();

// ---- Main loop -------------------------------------------------------------
const satPos = new THREE.Vector3();
const beamTarget = new THREE.Vector3();
let lastFast = 0;
let radarTurn = NaN;

/** The standby radar scope, which pings each time its sweep passes north (every ~4.4 s) while on screen. */
function drawRadar(now: number) {
  const angle = now / 700;
  const radar = $('radar');
  radar.textContent = radarFrame(angle);
  const turn = Math.floor((angle - 1.5 * Math.PI) / (2 * Math.PI));
  const r = radar.getBoundingClientRect();
  if (turn !== radarTurn && !Number.isNaN(radarTurn) && r.bottom > 0 && r.top < innerHeight) sfx.ping();
  radarTurn = turn;
}

function frame(now: number) {
  const t0 = performance.now();
  const sim = holdAtClosestApproach(simNow());
  encounterCountdown(sim);
  globe.setTime(new Date(sim));
  const layer = app.layer;
  if (layer) {
    layer.update(sim);
    updateCamera();
    const sel = layer.selected;
    const shown = sel >= 0 && !layer.hidden.has(layer.sats[sel].category);
    groundTrack.group.visible = shown;
    app.coverage = shown
      ? groundTrack.update(sim, layer.positionOf(sel, satPos), { width: canvas.clientWidth, height: canvas.clientHeight })
      : null;

    models.update(layer, globe.camera, canvas.clientHeight);
    updateReticle();
  } else {
    globe.controls.update();
  }
  // Outside the layer check so a restored station is sized correctly while the catalogue loads.
  const target = layer && layer.selected >= 0 && !layer.hidden.has(layer.sats[layer.selected].category) ? layer.positionOf(layer.selected, beamTarget) : null;
  observerMarker.update(globe.camera, { width: canvas.clientWidth, height: canvas.clientHeight }, target);
  updateHover();

  if (now - lastFast > 250) {
    lastFast = now;
    updateFastReadouts(sim);
    updateEncounterReadouts(sim);
    updateObserverReadouts(sim);
    updateTimeline(sim);
    updateTargetChip();
    if (!$('standby').hidden) drawRadar(now);
  }
  updateGauges(now);

  globe.render();
  recordFrame(performance.now() - t0);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- Boot --------------------------------------------------------------------
Promise.all([
  loadSatellites(),
  loadDebris().catch((err: unknown) => {
    console.warn(err);
    log('CELESTRAK', 'DEBRIS CATALOGUE UNAVAILABLE', 'warn');
    return null;
  }),
])
  .then(([active, debris]) => {
    const { fetchedAt, source } = active;
    const sats: SatInfo[] = debris ? [...active.sats, ...debris.sats] : active.sats;
    const layer = new SatelliteLayer(sats, globe.scene);
    app.layer = layer;
    app.byNorad = new Map(sats.map((s, i) => [s.noradId, i]));
    layer.setVisualMode(globe.visualMode);
    models.setCatalog(sats);
    buildLegend(layer.counts());
    buildCensus(layer.regimeCounts());
    enableSearch();
    const age = Math.round((Date.now() - fetchedAt.getTime()) / 60000);
    $('sb-link').textContent = `■ CELESTRAK ${source.toUpperCase()}`;
    $('sb-link').classList.remove('blink-slow');
    const via = { mirror: `SITE MIRROR, ${age} MIN OLD`, cache: `BROWSER CACHE, ${age} MIN OLD`, live: 'LIVE DOWNLINK' }[source];
    log('CELESTRAK', `${active.sats.length.toLocaleString('en-GB')} ELEMENT SETS PARSED · ${via}`, 'ok');
    if (debris) log('CELESTRAK', `${debris.sats.length.toLocaleString('en-GB')} DEBRIS FRAGMENTS · 4 BREAK-UP EVENTS`, 'ok');
    log('SGP4', 'PROPAGATOR ARMED · ROUND-ROBIN 4 MS SLICE');
    bootReport('catalogue', `${active.sats.length.toLocaleString('en-GB')} ELEMENT SETS`);
    bootReport('debris', debris ? `${debris.sats.length.toLocaleString('en-GB')} FRAGMENTS` : 'UNAVAILABLE', debris !== null);
    applyHash();
    runScreening();
    whenBooted.then(offerTour);
  })
  .catch((err: unknown) => {
    console.error(err);
    $('sb-link').textContent = '■ LINK DOWN';
    $('sb-link').classList.add('warn');
    log('CELESTRAK', 'COULD NOT RETRIEVE ORBITAL ELEMENTS · RETRY IN A FEW MINUTES', 'warn');
    bootReport('catalogue', 'LINK DOWN', false);
    bootReport('debris', 'LINK DOWN', false);
    whenBooted.then(offerTour);
  });

if (import.meta.env.DEV) Object.assign(window, { debug: { globe, models, getLayer: () => app.layer, getConj } });
