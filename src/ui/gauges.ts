import * as THREE from 'three';
import { NASA_MODEL_NAMES } from '../nasaModels';
import { latency, log } from '../telemetry';
import { blocks, Sparkline } from '../terminal';
import { cameraModeLabel } from './camera';
import { clockSpeed } from './clock';
import { app, globe, models, observerMarker } from './context';
import { updateDetails } from './dossier';
import { $ } from './dom';
import { fmt, hms } from './format';
import { getObserver } from './passesPanel';

// Gauges and readouts. Everything here is measured, not simulated. Fast readouts refresh every
// 250 ms, heavier gauges and the trend graphs every 2 s.

const GAUGE_MS = 2000;
const bootTime = performance.now();
const sparkFps = new Sparkline($('g-fps'));
const sparkProp = new Sparkline($('g-prop'));
const sparkView = new Sparkline($('g-view'));
let frames = 0;
let frameCpu = 0;
let lastGauge = performance.now();
let tilesReceived = 0;
let peakProp = 1;

const linkText = (source: string) => {
  const ms = latency.get(source);
  return ms === undefined ? 'IDLE' : `${Math.round(ms)} MS`;
};

/** Count one rendered frame and the CPU time it took. */
export function recordFrame(cpuMs: number) {
  frames++;
  frameCpu += cpuMs;
}

export function updateFastReadouts(sim: number) {
  const date = new Date(sim).toISOString();
  $('utc').textContent = new Date().toISOString().slice(0, 19).replace('T', ' ').replaceAll('-', '.');
  $('sim-time').textContent = date.slice(11, 19);
  $('sim-date').textContent = date.slice(0, 10).replaceAll('-', '.');
  const offset = sim - Date.now();
  $('sim-offset').textContent = `${offset < 0 ? '-' : '+'}${hms(offset)}`;
  $('live-badge').classList.toggle('on', clockSpeed() === 1 && Math.abs(offset) < 3000);
  $('sb-uptime').textContent = hms(performance.now() - bootTime);
  $('h-alt').textContent = `${fmt((globe.camera.position.length() - 1) * 6378.137, 0)} KM`;
  $('h-mode').textContent = cameraModeLabel();
  updateDetails();
}

/** The slower gauges; does nothing until 2 s have passed since the last update. */
export function updateGauges(now: number) {
  if (now - lastGauge <= GAUGE_MS) return;
  const seconds = (now - lastGauge) / 1000;
  const fps = frames / seconds;
  const frameMs = frameCpu / Math.max(frames, 1);
  frames = 0;
  frameCpu = 0;
  lastGauge = now;

  $('m-fps').textContent = `${fmt(fps, 0)} FPS`;
  blocks($('b-fps'), fps / 60, fps < 30);
  $('m-ft').textContent = `${fmt(frameMs, 1)} MS CPU`;
  blocks($('b-ft'), frameMs / 16.7, frameMs > 16.7);
  sparkFps.push(fps);
  $('g-fps-v').textContent = `${fmt(fps, 0)}`;

  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
  if (heap) {
    $('m-heap').textContent = `${fmt(heap.usedJSHeapSize / 1048576, 0)} / ${fmt(heap.jsHeapSizeLimit / 1048576, 0)} MB`;
    blocks($('b-heap'), heap.usedJSHeapSize / heap.jsHeapSizeLimit, heap.usedJSHeapSize / heap.jsHeapSizeLimit > 0.8);
  } else {
    $('m-heap').textContent = 'N/A IN THIS BROWSER';
  }

  $('l-celestrak').textContent = linkText(latency.has('MIRROR') ? 'MIRROR' : 'CELESTRAK');
  $('l-satcat').textContent = linkText('SATCAT');
  $('l-wikidata').textContent = linkText('WIKIDATA');
  $('l-wikipedia').textContent = linkText('WIKIPEDIA');

  const tiles = globe.tiles.stats();
  $('l-gibs').textContent = `${tiles.visible} TILES · Z${tiles.maxZ || '-'} · ${tiles.loading} RX`;
  blocks($('b-gibs'), tiles.visible / 160);
  $('h-tiles').textContent = `NASA GIBS Z${tiles.maxZ || '-'} · ${tiles.visible} TILES`;
  const newTiles = globe.tiles.received - tilesReceived;
  tilesReceived = globe.tiles.received;
  if (newTiles > 0) log('GIBS', `+${newTiles} IMAGERY TILES · ${tiles.visible} ON SCREEN · DEEPEST Z${tiles.maxZ}`);

  const totalModels = Object.keys(NASA_MODEL_NAMES).length;
  $('l-models').textContent = `${models.nasaModelsLoaded} / ${totalModels} CACHED`;
  blocks($('b-models'), models.nasaModelsLoaded / totalModels);

  const layer = app.layer;
  if (!layer) return;
  const propRate = layer.propagated / seconds;
  layer.propagated = 0;
  peakProp = Math.max(peakProp, propRate);
  $('m-prop').textContent = `${fmt(propRate / 1000, 1)}K / S`;
  blocks($('b-prop'), propRate / peakProp);
  sparkProp.push(propRate);
  $('g-prop-v').textContent = `${fmt(propRate / 1000, 1)}K`;

  if (getObserver()) {
    // Above the horizon when (satellite − station) · up > 0; the station is on the unit sphere, so p · up > 1.
    const up = observerMarker.worldPosition(new THREE.Vector3());
    const pos = layer.positions;
    let above = 0;
    for (let j = 0; j < pos.length; j += 3) if (pos[j] * up.x + pos[j + 1] * up.y + pos[j + 2] * up.z > 1) above++;
    $('o-above').textContent = `${above.toLocaleString('en-GB')} OBJ`;
  } else {
    $('o-above').textContent = '--';
  }

  const live = layer.liveCounts(globe.camera, globe.sunDir);
  $('m-sunlit').textContent = `${fmt((live.sunlit / Math.max(live.shown, 1)) * 100, 1)}% · ${live.sunlit.toLocaleString('en-GB')}`;
  blocks($('b-sunlit'), live.sunlit / Math.max(live.shown, 1));
  $('m-inview').textContent = `${live.inView.toLocaleString('en-GB')} OBJ`;
  sparkView.push(live.inView);
  $('g-view-v').textContent = live.inView.toLocaleString('en-GB');
}

/** The orbit-regime census bars, built once when the catalogue loads. */
export function buildCensus(counts: Record<string, number>) {
  const el = $('census');
  const max = Math.max(...Object.values(counts));
  for (const [regime, n] of Object.entries(counts)) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<label>${regime}</label><b>${n.toLocaleString('en-GB')}</b>`;
    const bar = document.createElement('div');
    bar.className = 'bar';
    blocks(bar, n / max);
    el.append(row, bar);
  }
}
