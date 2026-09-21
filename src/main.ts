import './style.css';
import * as THREE from 'three';
import { GlobeScene, type VisualMode } from './scene';
import { CATEGORIES, SatelliteLayer } from './satellites';
import { ModelLayer } from './models';
import { NASA_MODEL_NAMES } from './nasaModels';
import { fetchIntel, type CatalogInfo, type WikiInfo } from './intel';
import { loadSatellites, type Category } from './tle';
import { latency, log } from './telemetry';
import { blocks, mountLog, radarFrame, Sparkline } from './terminal';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

mountLog($('log'));
log('SYSTEM', 'ORBITWATCH MK-II TERMINAL ONLINE', 'ok');

const globe = new GlobeScene($('globe'));
const models = new ModelLayer(globe.scene);
let layer: SatelliteLayer | null = null;
const bootTime = performance.now();
log('RENDER', `WEBGL${globe.renderer.capabilities.isWebGL2 ? '2' : '1'} CONTEXT · MAX TEX ${globe.renderer.capabilities.maxTextureSize}`);

// ---- Simulated clock -------------------------------------------------------
let speed = 1;
let anchorSim = Date.now();
let anchorReal = performance.now();
const simNow = () => anchorSim + (performance.now() - anchorReal) * speed;

function setSpeed(next: number, resetToNow = false) {
  anchorSim = resetToNow ? Date.now() : simNow();
  anchorReal = performance.now();
  speed = next;
  document.querySelectorAll<HTMLButtonElement>('#speeds [data-speed]').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.speed) === speed);
  });
  log('CHRONO', resetToNow ? 'RESYNCED TO REAL TIME' : speed === 0 ? 'SIMULATION HELD' : `TIME RATE ×${speed}`);
}

$('speeds').addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('button');
  if (!btn) return;
  if (btn.id === 'now-btn') setSpeed(1, true);
  else setSpeed(Number(btn.dataset.speed));
});

// ---- Camera ------------------------------------------------------------------
// 'earth': orbiting the globe. 'to-sat' / 'to-earth': animated transitions.
// 'tracking': the orbit controls pivot around the selected satellite, and the camera's
// offset is held in the satellite's local frame (along-track, radial, cross-track) so
// the view of the Earth below stays put as it orbits.
type CameraMode = 'earth' | 'to-sat' | 'tracking' | 'to-earth';
const MODE_LABELS: Record<CameraMode, string> = {
  earth: 'GLOBAL ORBIT',
  'to-sat': 'SLEWING ▶ TARGET',
  tracking: 'TARGET TRACK',
  'to-earth': 'SLEWING ▶ GLOBAL',
};
let mode: CameraMode = 'earth';
let flyStart = 0;
const FLY_MS = 1800;
const TRACK_OFFSET = new THREE.Vector3(-0.14, 0.06, 0.07); // behind, above and beside, ~1,100 km
const localOffset = new THREE.Vector3();
const startCam = new THREE.Vector3();
const startTarget = new THREE.Vector3();
const endCam = new THREE.Vector3();
const satPos = new THREE.Vector3();
const basis = { t: new THREE.Vector3(), r: new THREE.Vector3(), n: new THREE.Vector3() };
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const q = new THREE.Quaternion();
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

function beginFlight(next: CameraMode) {
  mode = next;
  flyStart = performance.now();
  startCam.copy(globe.camera.position);
  startTarget.copy(globe.controls.target);
  globe.controls.enabled = false;
}

function satFrame(index: number): boolean {
  if (!layer) return false;
  layer.positionOf(index, satPos);
  if (satPos.lengthSq() === 0) return false;
  basis.r.copy(satPos).normalize();
  const j = index * 3;
  basis.t.fromArray(layer.velocities, j);
  basis.t.addScaledVector(basis.r, -basis.t.dot(basis.r)).normalize();
  basis.n.crossVectors(basis.t, basis.r);
  return true;
}

const localToWorld = (local: THREE.Vector3, out: THREE.Vector3) =>
  out
    .copy(satPos)
    .addScaledVector(basis.t, local.x)
    .addScaledVector(basis.r, local.y)
    .addScaledVector(basis.n, local.z);

/** Interpolate around the Earth's centre (direction + radius) so the path never cuts through the globe. */
function arcLerp(from: THREE.Vector3, to: THREE.Vector3, e: number, out: THREE.Vector3) {
  const r = THREE.MathUtils.lerp(from.length(), to.length(), e);
  q.setFromUnitVectors(tmp.copy(from).normalize(), tmp2.copy(to).normalize());
  q.slerp(new THREE.Quaternion(), 1 - e);
  return out.copy(from).normalize().applyQuaternion(q).multiplyScalar(r);
}

function updateCamera() {
  const cam = globe.camera.position;
  const controls = globe.controls;
  const sel = layer?.selected ?? -1;
  const e = ease(Math.min(1, (performance.now() - flyStart) / FLY_MS));

  if (mode === 'tracking') {
    // Capture the offset *before* moving the satellite: the controls apply zoom and drag
    // immediately in their event handlers, so the camera may have moved since last frame.
    // `basis` and `controls.target` still hold last frame's satellite frame here.
    tmp.subVectors(cam, controls.target);
    localOffset.set(tmp.dot(basis.t), tmp.dot(basis.r), tmp.dot(basis.n));
  }

  if ((mode === 'to-sat' || mode === 'tracking') && (sel < 0 || !satFrame(sel))) {
    beginFlight('to-earth');
  }

  if (mode === 'to-sat') {
    arcLerp(startCam, localToWorld(TRACK_OFFSET, endCam), e, cam);
    controls.target.lerpVectors(startTarget, satPos, e);
    if (e >= 1) {
      mode = 'tracking';
      localOffset.copy(TRACK_OFFSET);
      controls.enabled = true;
      controls.minDistance = 0.02;
    }
  } else if (mode === 'tracking') {
    localToWorld(localOffset, cam);
    controls.target.copy(satPos);
    controls.update();
  } else if (mode === 'to-earth') {
    arcLerp(startCam, endCam.copy(startCam).setLength(Math.max(startCam.length(), 3.2)), e, cam);
    controls.target.copy(startTarget).multiplyScalar(1 - e);
    if (e >= 1) {
      mode = 'earth';
      controls.enabled = true;
      controls.minDistance = 1.3;
    }
  } else {
    controls.update();
  }
  globe.camera.lookAt(controls.target);
}

/** Size the reticle so it frames the 3D model when close, and stays a fixed size when far. */
function updateReticle() {
  if (!layer || layer.selected < 0) return;
  layer.positionOf(layer.selected, tmp);
  const d = tmp.distanceTo(globe.camera.position);
  const px = Math.max(models.pixels(layer.selected, d) * 1.4, 36);
  // Once the model fills the view the brackets just get in the way.
  if (px > 320) layer.marker.visible = false;
  const worldPerPx = (2 * Math.tan(THREE.MathUtils.degToRad(globe.camera.fov) / 2)) / canvas.clientHeight;
  layer.marker.scale.setScalar(px * worldPerPx);
}

// ---- Selection ---------------------------------------------------------------
let lastSunlit: boolean | null = null;

function select(index: number) {
  if (!layer) return;
  const previous = layer.selected;
  layer.select(index, simNow());
  $('details').hidden = index < 0;
  $('standby').hidden = index >= 0;
  lastSunlit = null;
  if (index < 0) {
    if (previous >= 0) log('TRACK', `TARGET RELEASED · ${layer.sats[previous].name}`);
    if (mode !== 'earth') beginFlight('to-earth');
    return;
  }
  const sat = layer.sats[index];
  if (layer.hidden.has(sat.category)) toggleCategory(sat.category, true);
  const meta = CATEGORIES[sat.category];
  const kicker = $('d-category');
  kicker.style.setProperty('--cat', meta.color);
  kicker.replaceChildren(
    Object.assign(document.createElement('span'), { className: 'glyph', textContent: meta.glyph }),
    ` ${meta.label}`,
  );
  $('d-name').textContent = sat.name;
  $('d-ids').textContent = `NORAD ${sat.noradId} · COSPAR ${formatCospar(sat.intlDesignator)}`;
  const model = models.describe(index);
  $('d-model').textContent =
    model.source === 'nasa'
      ? `NASA 3D · ${model.name}${model.exact ? '' : ' (REPRESENTATIVE)'}`
      : `PROCEDURAL · ${model.name}`;
  log('TRACK', `TARGET LOCK · ${sat.name} [${sat.noradId}]`, 'ok');
  resetIntel();
  const intel = fetchIntel(sat);
  intel.catalog.then((c) => {
    if (layer?.selected !== index) return;
    showCatalog(c);
    if (c) log('SATCAT', `${sat.noradId} · ${c.owner.code} · ${c.objectType} · ${c.status}`);
  });
  intel.wiki.then((w) => {
    if (layer?.selected !== index) return;
    showWiki(w);
    log('WIKI', w ? `BRIEFING RETRIEVED · ${w.title}${w.context === 'own' ? '' : ` (${w.context})`}` : 'NO BRIEFING ON FILE', w ? 'info' : 'warn');
  });
  beginFlight('to-sat');
  updateDetails();
}

$('close-details').addEventListener('click', () => select(-1));
$('release').addEventListener('click', () => select(-1));
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') select(-1);
});

// ---- Dossier -------------------------------------------------------------------
const CATALOG_FIELDS = ['d-owner', 'd-type', 'd-status', 'd-launch', 'd-site', 'd-rcs'];

function resetIntel() {
  for (const id of [...CATALOG_FIELDS, 'd-about']) {
    $(id).classList.add('loading');
    $(id).textContent = '';
  }
  delete $('d-status').dataset.state;
  $('d-figure').hidden = true;
  $('d-wiki').hidden = true;
  $('d-about-title').textContent = 'BRIEFING';
}

function showCatalog(c: CatalogInfo | null) {
  for (const id of CATALOG_FIELDS) $(id).classList.remove('loading');
  if (!c) {
    $('d-owner').textContent = 'CATALOGUE UNAVAILABLE';
    for (const id of CATALOG_FIELDS.slice(1)) $(id).textContent = '—';
    return;
  }
  const owner = $('d-owner');
  if (c.owner.flag) {
    owner.append(
      Object.assign(document.createElement('img'), {
        className: 'flag',
        src: `https://flagcdn.com/w40/${c.owner.flag}.png`,
        alt: '',
      }),
    );
  } else {
    owner.append(Object.assign(document.createElement('span'), { className: 'org', textContent: c.owner.code }));
  }
  owner.append(c.owner.name);
  $('d-type').textContent = c.objectType;
  $('d-status').textContent = c.status;
  $('d-status').dataset.state = c.operational === null ? 'unknown' : c.operational ? 'on' : 'off';
  $('d-launch').textContent = c.launchDate
    ? `${c.launchDate.toISOString().slice(0, 10).replaceAll('-', '.')} · T+${yearsSince(c.launchDate)}`
    : 'UNKNOWN';
  $('d-site').textContent = c.launchSite;
  $('d-rcs').textContent = c.rcsM2 === null ? 'NOT PUBLISHED' : `${radarSize(c.rcsM2)} · ${fmt(c.rcsM2, 2)} M²`;
}

function showWiki(w: WikiInfo | null) {
  $('d-about').classList.remove('loading');
  if (!w) {
    $('d-about').textContent = 'No public briefing is available for this object.';
    return;
  }
  $('d-about-title').textContent =
    w.context === 'own' ? 'BRIEFING' : w.context === 'programme' ? `PROGRAMME · ${w.title}` : `BACKGROUND · ${w.title}`;
  $('d-about').textContent = w.extract;
  const link = $<HTMLAnchorElement>('d-wiki');
  link.href = w.pageUrl;
  link.textContent = `> OPEN "${w.title}" ON WIKIPEDIA`;
  link.hidden = false;
  if (w.imageUrl) {
    $<HTMLImageElement>('d-img').src = w.imageUrl;
    $('d-img-cap').textContent = w.imageFrom ? `REPRESENTATIVE · ${w.imageFrom}` : 'IMG · WIKIMEDIA COMMONS';
    $('d-figure').hidden = false;
  }
}

$<HTMLImageElement>('d-img').addEventListener('error', () => ($('d-figure').hidden = true));

function yearsSince(date: Date): string {
  const years = (Date.now() - date.getTime()) / (365.25 * 86_400_000);
  if (years < 1) return `${Math.max(1, Math.round(years * 12))} MO`;
  return `${fmt(years, 1)} YR`;
}

function radarSize(rcs: number): string {
  if (rcs < 0.1) return 'SMALL';
  if (rcs < 1) return 'MEDIUM';
  return 'LARGE';
}

function updateDetails() {
  if (!layer || layer.selected < 0) return;
  const d = layer.details(layer.selected, simNow());
  const set = (id: string, text: string) => ($(id).textContent = text);
  if (!d) {
    set('d-regime', 'PROPAGATION FAILED — ELEMENTS STALE OR OBJECT DECAYED');
    $('d-regime').classList.add('warn');
    return;
  }
  $('d-regime').classList.remove('warn');
  set('d-alt', `${fmt(d.altitudeKm, 0)} KM`);
  set('d-speed', `${fmt(d.speedKms, 2)} KM/S`);
  set('d-lat', `${fmt(Math.abs(d.latitude), 2)}° ${d.latitude >= 0 ? 'N' : 'S'}`);
  set('d-lon', `${fmt(Math.abs(d.longitude), 2)}° ${d.longitude >= 0 ? 'E' : 'W'}`);
  set('d-apo', `${fmt(d.apogeeKm, 0)} KM`);
  set('d-peri', `${fmt(d.perigeeKm, 0)} KM`);
  set('d-period', d.periodMin < 180 ? `${fmt(d.periodMin, 1)} MIN` : `${fmt(d.periodMin / 60, 2)} H`);
  set('d-inc', `${fmt(d.inclinationDeg, 1)}°`);
  set('d-phase', `${fmt(d.orbitPhase * 100, 0)}% PERIGEE→PERIGEE`);
  blocks($('b-phase'), d.orbitPhase, false, 24);
  const stale = d.tleAgeDays > 7;
  set('d-regime', `${d.regime} · ELEMENTS ${fmt(d.tleAgeDays, 1)} D OLD${stale ? ' · STALE' : ''}`);
  $('d-regime').classList.toggle('warn', stale);
  const illum = $('d-illum');
  illum.textContent = d.sunlit ? '☼ SUNLIT' : '● ECLIPSE';
  illum.classList.toggle('shadow', !d.sunlit);
  if (lastSunlit !== null && lastSunlit !== d.sunlit) {
    log('ORBIT', `${layer.sats[layer.selected].name} ${d.sunlit ? 'EXITED' : 'ENTERED'} EARTH SHADOW`, d.sunlit ? 'ok' : 'warn');
  }
  lastSunlit = d.sunlit;
}

const fmt = (n: number, digits: number) =>
  n.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });

function formatCospar(designator: string): string {
  // "98067A" -> "1998-067A"
  const yy = Number(designator.slice(0, 2));
  if (Number.isNaN(yy)) return designator;
  return `${yy < 57 ? 2000 + yy : 1900 + yy}-${designator.slice(2)}`;
}

// ---- Visual mode ---------------------------------------------------------------
function setVisualMode(next: VisualMode) {
  globe.setVisualMode(next);
  layer?.setVisualMode(next);
  document.body.dataset.vis = next;
  document.querySelectorAll<HTMLButtonElement>('#vis-toggle button').forEach((b) => {
    b.classList.toggle('active', b.dataset.vis === next);
  });
  log('DISPLAY', `VISUAL MODE · ${next === 'phosphor' ? 'PHOSPHOR' : 'TRUE COLOUR'}`);
}

$('vis-toggle').addEventListener('click', (e) => {
  const vis = (e.target as HTMLElement).closest('button')?.dataset.vis as VisualMode | undefined;
  if (vis && vis !== globe.visualMode) setVisualMode(vis);
});

// ---- Picking & cursor readout ------------------------------------------------
const canvas = globe.renderer.domElement;
const tooltip = $('tooltip');
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let down: { x: number; y: number } | null = null;

canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
canvas.addEventListener('pointerup', (e) => {
  if (!down || !layer) return;
  const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
  down = null;
  if (moved > 4) return;
  const hit = pickAt(e);
  if (hit >= 0 && hit !== layer.selected) select(hit);
});

let hoverQueued: PointerEvent | null = null;
canvas.addEventListener('pointermove', (e) => {
  hoverQueued = e;
});
canvas.addEventListener('pointerleave', () => {
  tooltip.hidden = true;
  $('h-cursor').textContent = '--';
});

function pickAt(e: PointerEvent): number {
  if (!layer) return -1;
  const rect = canvas.getBoundingClientRect();
  return layer.pick(e.clientX - rect.left, e.clientY - rect.top, globe.camera, rect.width, rect.height);
}

/** Latitude/longitude of the point on the globe under the cursor, or null for space. */
function cursorLatLon(e: PointerEvent): [number, number] | null {
  const rect = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, globe.camera);
  const hit = raycaster.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1), tmp2);
  if (!hit) return null;
  const p = globe.earth.worldToLocal(hit.clone()).normalize();
  return [THREE.MathUtils.radToDeg(Math.asin(p.y)), THREE.MathUtils.radToDeg(Math.atan2(-p.z, p.x))];
}

function updateHover() {
  if (!hoverQueued) return;
  const e = hoverQueued;
  hoverQueued = null;
  const ll = cursorLatLon(e);
  $('h-cursor').textContent = ll
    ? `${fmt(Math.abs(ll[0]), 2)}°${ll[0] >= 0 ? 'N' : 'S'} ${fmt(Math.abs(ll[1]), 2)}°${ll[1] >= 0 ? 'E' : 'W'}`
    : 'DEEP SPACE';
  if (!layer || e.buttons) return;
  const hit = pickAt(e);
  tooltip.hidden = hit < 0;
  canvas.style.cursor = hit >= 0 ? 'crosshair' : '';
  if (hit >= 0) {
    const s = layer.sats[hit];
    tooltip.textContent = `${CATEGORIES[s.category].glyph} ${s.name} · ${s.noradId}`;
    tooltip.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`;
  }
}

// ---- Search ----------------------------------------------------------------
const search = $<HTMLInputElement>('search');
const results = $('results');

search.addEventListener('input', () => {
  results.replaceChildren();
  const q = search.value.trim().toUpperCase();
  if (!layer || q.length < 2) return;
  const matches: number[] = [];
  layer.sats.forEach((s, i) => {
    if (matches.length < 8 && (s.name.toUpperCase().includes(q) || s.noradId === q)) matches.push(i);
  });
  for (const i of matches) {
    const s = layer.sats[i];
    const li = document.createElement('li');
    li.style.setProperty('--cat', CATEGORIES[s.category].color);
    for (const [cls, text] of [['glyph', CATEGORIES[s.category].glyph], ['nm', s.name], ['id', s.noradId]]) {
      li.append(Object.assign(document.createElement('span'), { className: cls, textContent: text }));
    }
    li.addEventListener('click', () => {
      select(i);
      results.replaceChildren();
      search.value = '';
    });
    results.append(li);
  }
  if (!matches.length) results.innerHTML = '<li class="empty">NO MATCHING OBJECTS</li>';
});

$('quick').addEventListener('click', (e) => {
  const norad = (e.target as HTMLElement).closest('button')?.dataset.norad;
  const i = layer?.sats.findIndex((s) => s.noradId === norad) ?? -1;
  if (i >= 0) select(i);
});

// ---- Legend / layer toggles ------------------------------------------------
function buildLegend(counts: Record<Category, number>) {
  const legend = $('legend');
  for (const [key, meta] of Object.entries(CATEGORIES) as [Category, (typeof CATEGORIES)[Category]][]) {
    if (!counts[key]) continue;
    const li = document.createElement('li');
    li.dataset.category = key;
    li.style.setProperty('--cat', meta.color);
    for (const [cls, text] of [['box', '[X]'], ['glyph', meta.glyph], ['nm', meta.label], ['count', counts[key].toLocaleString('en-GB')]]) {
      li.append(Object.assign(document.createElement('span'), { className: cls, textContent: text }));
    }
    li.addEventListener('click', () => toggleCategory(key));
    legend.append(li);
  }
}

function toggleCategory(cat: Category, forceVisible = false) {
  if (!layer) return;
  const show = forceVisible || layer.hidden.has(cat);
  if (show) layer.hidden.delete(cat);
  else layer.hidden.add(cat);
  const li = document.querySelector(`#legend [data-category="${cat}"]`);
  li?.classList.toggle('off', !show);
  const box = li?.querySelector('.box');
  if (box) box.textContent = show ? '[X]' : '[ ]';
  log('FILTER', `${CATEGORIES[cat].label} · ${show ? 'SHOWN' : 'HIDDEN'}`);
}

// ---- Gauges ------------------------------------------------------------------
// Everything below is measured, not simulated. Fast readouts refresh every 250 ms,
// heavier gauges and the trend graphs every 2 s.
const GAUGE_MS = 2000;
const sparkFps = new Sparkline($('g-fps'));
const sparkProp = new Sparkline($('g-prop'));
const sparkView = new Sparkline($('g-view'));
let frames = 0;
let frameCpu = 0;
let lastGauge = performance.now();
let tilesReceived = 0;
let peakProp = 1;

function hms(ms: number) {
  const s = Math.floor(Math.abs(ms) / 1000);
  const days = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${days ? `${days}D ` : ''}${hh}:${mm}:${ss}`;
}

const linkText = (source: string) => {
  const ms = latency.get(source);
  return ms === undefined ? 'IDLE' : `${Math.round(ms)} MS`;
};

function updateFastReadouts(sim: number) {
  const date = new Date(sim).toISOString();
  $('utc').textContent = new Date().toISOString().slice(0, 19).replace('T', ' ').replaceAll('-', '.');
  $('sim-time').textContent = date.slice(11, 19);
  $('sim-date').textContent = date.slice(0, 10).replaceAll('-', '.');
  const offset = sim - Date.now();
  $('sim-offset').textContent = `${offset < 0 ? '-' : '+'}${hms(offset)}`;
  $('live-badge').classList.toggle('on', speed === 1 && Math.abs(offset) < 3000);
  $('sb-uptime').textContent = hms(performance.now() - bootTime);
  $('h-alt').textContent = `${fmt((globe.camera.position.length() - 1) * 6378.137, 0)} KM`;
  $('h-mode').textContent = MODE_LABELS[mode];
  updateDetails();
}

function updateGauges(now: number) {
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

  $('l-celestrak').textContent = linkText('CELESTRAK');
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

  if (!layer) return;
  const propRate = layer.propagated / seconds;
  layer.propagated = 0;
  peakProp = Math.max(peakProp, propRate);
  $('m-prop').textContent = `${fmt(propRate / 1000, 1)}K / S`;
  blocks($('b-prop'), propRate / peakProp);
  sparkProp.push(propRate);
  $('g-prop-v').textContent = `${fmt(propRate / 1000, 1)}K`;

  const live = layer.liveCounts(globe.camera, globe.sunDir);
  $('m-sunlit').textContent = `${fmt((live.sunlit / Math.max(live.shown, 1)) * 100, 1)}% · ${live.sunlit.toLocaleString('en-GB')}`;
  blocks($('b-sunlit'), live.sunlit / Math.max(live.shown, 1));
  $('m-inview').textContent = `${live.inView.toLocaleString('en-GB')} OBJ`;
  sparkView.push(live.inView);
  $('g-view-v').textContent = live.inView.toLocaleString('en-GB');
}

function buildCensus(counts: Record<string, number>) {
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

// ---- Main loop -------------------------------------------------------------
let lastFast = 0;

function frame(now: number) {
  const t0 = performance.now();
  const sim = simNow();
  globe.setTime(new Date(sim));
  if (layer) {
    layer.update(sim);
    updateCamera();
    models.update(layer, globe.camera, canvas.clientHeight);
    updateReticle();
  } else {
    globe.controls.update();
  }
  updateHover();

  if (now - lastFast > 250) {
    lastFast = now;
    updateFastReadouts(sim);
    if (!$('standby').hidden) $('radar').textContent = radarFrame(now / 700);
  }
  if (now - lastGauge > GAUGE_MS) updateGauges(now);

  globe.render();
  frames++;
  frameCpu += performance.now() - t0;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- Boot --------------------------------------------------------------------
loadSatellites()
  .then(({ sats, fetchedAt, fromCache }) => {
    layer = new SatelliteLayer(sats, globe.scene);
    layer.setVisualMode(globe.visualMode);
    models.setCatalog(sats);
    buildLegend(layer.counts());
    buildCensus(layer.regimeCounts());
    search.disabled = false;
    const age = Math.round((Date.now() - fetchedAt.getTime()) / 60000);
    $('sb-link').textContent = `■ CELESTRAK ${fromCache ? 'CACHE' : 'LIVE'}`;
    $('sb-link').classList.remove('blink-slow');
    log('CELESTRAK', `${sats.length.toLocaleString('en-GB')} ELEMENT SETS PARSED · ${fromCache ? `CACHE, ${age} MIN OLD` : 'LIVE DOWNLINK'}`, 'ok');
    log('SGP4', 'PROPAGATOR ARMED · ROUND-ROBIN 4 MS SLICE');
  })
  .catch((err: unknown) => {
    console.error(err);
    $('sb-link').textContent = '■ LINK DOWN';
    $('sb-link').classList.add('warn');
    log('CELESTRAK', 'COULD NOT RETRIEVE ORBITAL ELEMENTS · RETRY IN A FEW MINUTES', 'warn');
  });

if (import.meta.env.DEV) Object.assign(window, { debug: { globe, models, getLayer: () => layer } });
