import './style.css';
import * as THREE from 'three';
import { GlobeScene, type VisualMode } from './scene';
import { CATEGORIES, SatelliteLayer } from './satellites';
import { ModelLayer } from './models';
import { GroundTrack, type Coverage } from './groundTrack';
import {
  ObserverMarker,
  compass,
  formatLatLon,
  loadObserver,
  locate,
  lookAt,
  parseLatLon,
  predictPasses,
  saveObserver,
  skyCondition,
  sunElevation,
  MIN_PASS_ELEVATION_DEG,
  type Observer,
  type PassForecast,
} from './observer';
import { NASA_MODEL_NAMES } from './nasaModels';
import { fetchIntel, type CatalogInfo, type WikiInfo } from './intel';
import { loadDebris, loadSatellites, type Category, type SatInfo } from './tle';
import { isIntraConstellation, screenConjunctions, severity, type Conjunction, type ScreenResult } from './conjunctions';
import { latency, log } from './telemetry';
import { latestNews, newsFor, timeAgo, type Article, type ObjectNews } from './news';
import { blocks, mountLog, radarFrame, Sparkline } from './terminal';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

mountLog($('log'));
log('SYSTEM', 'ORBITWATCH MK-II TERMINAL ONLINE', 'ok');
queueMicrotask(() => {
  const saved = loadObserver();
  if (!saved) return;
  setObserver(saved, false);
  log('STATION', `OBSERVER RESTORED · ${formatLatLon(saved)}`);
});

const globe = new GlobeScene($('globe'));
const models = new ModelLayer(globe.scene);
const groundTrack = new GroundTrack(globe.earth);
let coverage: Coverage | null = null;
const observerMarker = new ObserverMarker(globe.scene, globe.earth);
const beamTarget = new THREE.Vector3();
let layer: SatelliteLayer | null = null;
const bootTime = performance.now();
log('RENDER', `WEBGL${globe.renderer.capabilities.isWebGL2 ? '2' : '1'} CONTEXT · MAX TEX ${globe.renderer.capabilities.maxTextureSize}`);

// ---- Simulated clock -------------------------------------------------------
let speed = 1;
let anchorSim = Date.now();
let anchorReal = performance.now();
const simNow = () => anchorSim + (performance.now() - anchorReal) * speed;

/** Set the simulated clock to `ms` and run it at `nextSpeed`. */
function jumpTo(ms: number, nextSpeed: number) {
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

function select(index: number, keepEncounter = false) {
  if (!layer) return;
  const previous = layer.selected;
  layer.select(index, simNow());
  if (!keepEncounter) clearEncounter();
  if (index >= 0) showTab('target');
  else showTab(tab);
  lastSunlit = null;
  groundTrack.setTarget(index >= 0 ? layer.sats[index].satrec : null, index >= 0 ? CATEGORIES[layer.sats[index].category].color : undefined);
  if (index < 0) {
    if (previous >= 0) log('TRACK', `TARGET RELEASED · ${layer.sats[previous].name}`);
    if (mode !== 'earth') beginFlight('to-earth');
    updateHash();
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
  intel.wiki
    .then((w) => newsFor(sat, w))
    .then((n) => layer?.selected === index && showObjectNews(n));
  intel.wiki.then((w) => {
    if (layer?.selected !== index) return;
    showWiki(w);
    log('WIKI', w ? `BRIEFING RETRIEVED · ${w.title}${w.context === 'own' ? '' : ` (${w.context})`}` : 'NO BRIEFING ON FILE', w ? 'info' : 'warn');
  });
  beginFlight('to-sat');
  updateDetails();
  renderTargetConjunctions(index);
  refreshPasses();
  updateHash();
}

// ---- Observer station & pass prediction ----------------------------------------
let observer: Observer | null = null;
let forecast: PassForecast | null = null;
let forecastFor = -1;
let forecastAt = 0;
let picking = false;
let lastAbove: boolean | null = null;

function setObserver(o: Observer | null, announce = true) {
  observer = o;
  saveObserver(o);
  observerMarker.setObserver(o);
  $('o-pos').textContent = o ? formatLatLon(o) : 'NOT SET';
  if (announce) log('STATION', o ? `OBSERVER SET · ${formatLatLon(o)} · ${o.source.toUpperCase()}` : 'OBSERVER CLEARED');
  lastAbove = null;
  refreshPasses();
  updateObserverReadouts(simNow());
}

function setPicking(on: boolean) {
  picking = on;
  document.body.classList.toggle('picking', on);
  $('o-pick').classList.toggle('active', on);
}

$('o-locate').addEventListener('click', () => {
  log('STATION', 'REQUESTING DEVICE LOCATION');
  locate().then(setObserver, (err: GeolocationPositionError | Error) =>
    log('STATION', `LOCATION UNAVAILABLE · ${err.message.toUpperCase()}`, 'warn'),
  );
});
$('o-pick').addEventListener('click', () => {
  setPicking(!picking);
  if (picking) log('STATION', 'CLICK A POINT ON THE GLOBE TO PLACE THE STATION');
});
$('o-clear').addEventListener('click', () => setObserver(null));
$<HTMLInputElement>('o-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const input = e.target as HTMLInputElement;
  const o = parseLatLon(input.value);
  if (!o) {
    log('STATION', 'COULD NOT READ COORDINATES · TRY "51.48, -0.00"', 'warn');
    return;
  }
  input.value = '';
  setObserver(o);
});

function refreshPasses() {
  const sel = layer?.selected ?? -1;
  $('p-body').hidden = !observer;
  $('p-none').hidden = !!observer;
  forecast = null;
  forecastFor = sel;
  if (!layer || sel < 0 || !observer) return;
  forecastAt = simNow();
  forecast = predictPasses(layer.sats[sel].satrec, observer, forecastAt);
  renderPasses();
}

const localTime = (ms: number) =>
  new Date(ms)
    .toLocaleString('en-GB', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .toUpperCase()
    .replace(',', ' ·');

function renderPasses() {
  const list = $('p-list');
  list.replaceChildren();
  if (!forecast) return;
  const note = (text: string) => {
    list.innerHTML = '<li class="empty"></li>';
    list.firstElementChild!.textContent = text;
  };
  if (forecast.kind === 'always') {
    note(`SLOW ORBIT · STAYS UP AT AZ ${fmt(forecast.azDeg, 0)}° ${compass(forecast.azDeg)} · EL ${fmt(forecast.elDeg, 0)}°`);
    return;
  }
  if (forecast.kind === 'never') return note('NEVER RISES ABOVE THIS HORIZON');
  if (!forecast.passes.length) return note(`NO PASSES ABOVE ${MIN_PASS_ELEVATION_DEG}° IN THE NEXT 3 DAYS`);
  for (const p of forecast.passes) {
    const li = document.createElement('li');
    li.classList.toggle('low', p.maxEl < 30);
    const cells: [string, string][] = [
      ['when', `${p.inProgress ? 'NOW' : localTime(p.riseMs)}`],
      ['peak', `MAX ${fmt(p.maxEl, 0)}°`],
      [
        'path',
        `${compass(p.riseAz)} → ${compass(p.maxAz)} → ${compass(p.setAz)} · ${fmt((p.setMs - p.riseMs) / 60_000, 0)} MIN`,
      ],
    ];
    for (const [cls, text] of cells) li.append(Object.assign(document.createElement('span'), { className: cls, textContent: text }));
    if (p.visible) li.querySelector('.peak')!.append(Object.assign(document.createElement('span'), { className: 'vis', textContent: ' ☼ VISIBLE' }));
    li.title = 'Times are in your local time zone. Click to jump to this pass.';
    li.addEventListener('click', () => {
      jumpTo(p.riseMs - 60_000, 10);
      log('CHRONO', `JUMP TO PASS · ${localTime(p.riseMs)} LOCAL · ×10`);
    });
    list.append(li);
  }
}

function updateObserverReadouts(sim: number) {
  if (!observer) {
    $('o-sky').textContent = '--';
    return;
  }
  const date = new Date(sim);
  const sunEl = sunElevation(observer, date);
  $('o-sky').textContent = `${skyCondition(sunEl)} · SUN ${fmt(sunEl, 0)}°`;
  if (!layer || layer.selected < 0) return;
  const sel = layer.selected;
  if (sel !== forecastFor || Math.abs(sim - forecastAt) > 6 * 3_600_000) refreshPasses();

  const look = lookAt(layer.sats[sel].satrec, observer, date);
  if (!look) return;
  const above = look.elDeg > 0;
  $('p-look').textContent = `AZ ${fmt(look.azDeg, 0)}° ${compass(look.azDeg)} · EL ${fmt(look.elDeg, 1)}° · ${fmt(look.rangeKm, 0)} KM`;
  $('p-now').textContent = above ? 'ABOVE HORIZON' : 'BELOW HORIZON';
  $('p-now').classList.toggle('shadow', !above);
  if (lastAbove !== null && above !== lastAbove) {
    const name = layer.sats[sel].name;
    log('STATION', `${above ? 'AOS' : 'LOS'} · ${name} ${above ? 'RISES' : 'SETS'} · AZ ${fmt(look.azDeg, 0)}° ${compass(look.azDeg)}`, above ? 'ok' : 'info');
  }
  lastAbove = above;

  if (forecast?.kind === 'passes') {
    const next = forecast.passes.find((p) => p.setMs > sim);
    if (!next) $('p-next').textContent = '--';
    else if (next.riseMs <= sim) $('p-next').textContent = `IN PROGRESS · SETS T−${hms(next.setMs - sim)}`;
    else $('p-next').textContent = `T−${hms(next.riseMs - sim)} · MAX ${fmt(next.maxEl, 0)}°${next.visible ? ' · ☼ VISIBLE' : ''}`;
  } else {
    $('p-next').textContent = forecast?.kind === 'always' ? 'ALWAYS UP' : forecast?.kind === 'never' ? 'NEVER' : '--';
  }
}

// ---- Right-column tabs ---------------------------------------------------------
type Tab = 'target' | 'conj' | 'news';
let tab: Tab = 'target';

function showTab(next: Tab) {
  tab = next;
  const sel = layer?.selected ?? -1;
  document.querySelectorAll<HTMLButtonElement>('#right-tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  $('conj').hidden = tab !== 'conj';
  $('news').hidden = tab !== 'news';
  $('details').hidden = tab !== 'target' || sel < 0;
  $('standby').hidden = tab !== 'target' || sel >= 0;
}

$('right-tabs').addEventListener('click', (e) => {
  const next = (e.target as HTMLElement).closest('button')?.dataset.tab as Tab | undefined;
  if (next) showTab(next);
});

// ---- Close-approach screening ----------------------------------------------------
const THRESHOLD_KM = 5;
let conj: ScreenResult | null = null;
let screening = false;
let windowHours = 24;
let includeIntra = false;

function visibleEvents(): Conjunction[] {
  if (!conj || !layer) return [];
  const sats = layer.sats;
  return includeIntra && !conj.skipIntra
    ? conj.events
    : conj.events.filter((ev) => !isIntraConstellation(sats[ev.a], sats[ev.b]));
}

const fmtKm = (km: number) => `${fmt(km, km < 10 ? 2 : 0)} KM`;
const untilText = (ms: number) => (ms >= Date.now() ? `T+${hms(ms - Date.now()).slice(0, -3)}` : 'PASSED');

/** One list row. With `perspective`, only the other object is named. */
function conjRow(ev: Conjunction, rank: number, perspective = -1): HTMLLIElement {
  const sats = layer!.sats;
  const li = document.createElement('li');
  li.className = severity(ev.missKm);
  const other = perspective === ev.a ? ev.b : ev.a;
  const cells: [string, string][] = [
    ['rk', String(rank).padStart(2, '0')],
    ['miss', fmtKm(ev.missKm)],
    ['when', untilText(ev.tcaMs)],
    ['spd', `${fmt(ev.relSpeedKms, 1)} KM/S`],
  ];
  for (const [cls, text] of cells) li.append(Object.assign(document.createElement('span'), { className: cls, textContent: text }));
  const pair = Object.assign(document.createElement('span'), { className: 'pair' });
  if (perspective >= 0) pair.append(Object.assign(document.createElement('span'), { className: 'x', textContent: '× ' }), sats[other].name);
  else pair.append(sats[ev.a].name, Object.assign(document.createElement('span'), { className: 'x', textContent: ' × ' }), sats[ev.b].name);
  li.append(pair);
  li.title = `Closest approach ${new Date(ev.tcaMs).toISOString().replace('T', ' ').slice(0, 19)} UTC`;
  li.addEventListener('click', () => openEncounter(ev));
  return li;
}

function renderConjList() {
  const list = $('cj-list');
  list.replaceChildren();
  const events = visibleEvents();
  $('conj-count').textContent = conj ? String(events.length) : screening ? '··' : '--';
  if (!conj) return;
  if (!events.length) {
    list.innerHTML = `<li class="empty">NO APPROACHES UNDER ${THRESHOLD_KM} KM IN THIS WINDOW</li>`;
    return;
  }
  events.slice(0, 80).forEach((ev, i) => list.append(conjRow(ev, i + 1)));
}

function renderTargetConjunctions(index: number) {
  const list = $('d-conj');
  list.replaceChildren();
  $('d-conj-title').textContent = `CLOSE APPROACHES · NEXT ${windowHours} H`;
  if (!conj) {
    list.innerHTML = `<li class="empty">${screening ? 'SCREENING IN PROGRESS…' : 'NOT YET SCREENED'}</li>`;
    return;
  }
  const mine = visibleEvents().filter((ev) => ev.a === index || ev.b === index);
  if (!mine.length) list.innerHTML = `<li class="empty">NONE UNDER ${THRESHOLD_KM} KM</li>`;
  mine.slice(0, 10).forEach((ev, i) => list.append(conjRow(ev, i + 1, index)));
}

async function runScreening() {
  if (!layer || screening) return;
  screening = true;
  conj = null;
  renderConjList();
  if (layer.selected >= 0) renderTargetConjunctions(layer.selected);
  const n = layer.sats.length;
  log('CONJ', `SCREENING ${n.toLocaleString('en-GB')} OBJECTS · ${windowHours} H WINDOW · < ${THRESHOLD_KM} KM`);
  try {
    conj = await screenConjunctions(
      layer.sats,
      { startMs: Date.now(), hours: windowHours, thresholdKm: THRESHOLD_KM, skipIntra: !includeIntra },
      (f) => {
        $('cj-status').textContent = `SCREENING ${Math.round(f * 100)}%`;
        blocks($('b-cj'), f);
      },
    );
    const events = visibleEvents();
    $('cj-status').textContent = `${events.length} FOUND · ${fmt(conj.ms / 1000, 1)} S`;
    blocks($('b-cj'), 1);
    log(
      'CONJ',
      `${events.length} CLOSE APPROACHES · ${fmt(conj.pairsChecked / 1e6, 1)}M PAIR CHECKS · ${conj.workers} WORKERS · ${fmt(conj.ms / 1000, 1)} S`,
      'ok',
    );
    const top = events[0];
    if (top) {
      log('CONJ', `CLOSEST · ${layer.sats[top.a].name} × ${layer.sats[top.b].name} · ${fmtKm(top.missKm)} · ${untilText(top.tcaMs)}`, 'warn');
    }
  } catch (err) {
    console.error(err);
    $('cj-status').textContent = 'SCREENING FAILED';
    log('CONJ', 'SCREENING FAILED', 'warn');
  }
  screening = false;
  renderConjList();
  if (layer.selected >= 0) renderTargetConjunctions(layer.selected);
}

$('cj-run').addEventListener('click', () => runScreening());
$('cj-window').addEventListener('click', (e) => {
  const h = Number((e.target as HTMLElement).closest('button')?.dataset.h);
  if (!h || h === windowHours) return;
  windowHours = h;
  document.querySelectorAll<HTMLButtonElement>('#cj-window button').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.h) === h);
  });
  runScreening();
});
$('cj-intra').addEventListener('click', () => {
  includeIntra = !includeIntra;
  $('cj-intra').setAttribute('aria-pressed', String(includeIntra));
  $('cj-intra').textContent = `${includeIntra ? '[X]' : '[ ]'} INCLUDE PAIRS WITHIN ONE CONSTELLATION`;
  // Screens that skipped intra-constellation pairs never computed them, so re-run when they are wanted.
  if (includeIntra && conj?.skipIntra) runScreening();
  else {
    renderConjList();
    if (layer && layer.selected >= 0) renderTargetConjunctions(layer.selected);
  }
});

// ---- Encounter view ------------------------------------------------------------
// Opening a close approach locks onto the first object, shows the second alongside it with a
// red line joining them, rewinds the clock to shortly before closest approach and holds the
// clock at the exact moment of closest approach.
const ENCOUNTER_LEAD_MS = 30_000;
let encounter: (Conjunction & { held: boolean }) | null = null;

function openEncounter(ev: Conjunction) {
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

function clearEncounter() {
  if (!encounter) return;
  encounter = null;
  layer?.setSecondary(-1, simNow());
  $('d-encounter').hidden = true;
  $('h-encounter').hidden = true;
}

function updateEncounterReadouts(sim: number) {
  if (!encounter || !layer) return;
  const sep = layer.separation(encounter.a, encounter.b, sim);
  const range = sep ? fmtKm(sep.km) : '--';
  $('e-range').textContent = range;
  $('h-range').textContent = range;
  const dt = sim - encounter.tcaMs;
  $('h-tca').textContent = Math.abs(dt) < 500 ? 'NOW' : `${dt < 0 ? 'T−' : 'T+'}${hms(dt)}`;
  if (sep) blocks($('b-range'), 1 - Math.min(1, sep.km / 500), sep.km < THRESHOLD_KM);
}

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

// ---- Shareable links -------------------------------------------------------------
// #norad=25544 opens a satellite; #norad=A&with=B&t=<ISO time> opens a close approach.
let byNorad = new Map<string, number>();

function updateHash() {
  if (!layer) return;
  const sats = layer.sats;
  let hash = '';
  if (encounter) {
    hash = `#norad=${sats[encounter.a].noradId}&with=${sats[encounter.b].noradId}&t=${new Date(encounter.tcaMs).toISOString()}`;
  } else if (layer.selected >= 0) {
    hash = `#norad=${sats[layer.selected].noradId}`;
  }
  if (hash !== location.hash) history.replaceState(null, '', hash || location.pathname + location.search);
}

function applyHash() {
  if (!layer) return;
  const params = new URLSearchParams(location.hash.slice(1));
  const a = byNorad.get(params.get('norad') ?? '');
  if (a === undefined) {
    if (params.has('norad')) log('LINK', `NORAD ${params.get('norad')} NOT IN CATALOGUE`, 'warn');
    return;
  }
  const b = byNorad.get(params.get('with') ?? '');
  const t = Date.parse(params.get('t') ?? '');
  log('LINK', `OPENING SHARED ${b !== undefined ? 'ENCOUNTER' : 'TARGET'} FROM URL`);
  if (b !== undefined && Number.isFinite(t)) {
    const sep = layer.separation(a, b, t);
    openEncounter({ a, b, tcaMs: t, missKm: sep?.km ?? NaN, relSpeedKms: sep?.kms ?? NaN });
  } else {
    select(a);
  }
}

window.addEventListener('hashchange', applyHash);

$('copy-link').addEventListener('click', () => {
  navigator.clipboard.writeText(location.href).then(
    () => log('LINK', `COPIED · ${location.href}`, 'ok'),
    () => log('LINK', 'CLIPBOARD UNAVAILABLE · COPY THE ADDRESS BAR INSTEAD', 'warn'),
  );
});

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
  $('d-news-title').textContent = 'NEWS';
  $('d-news').innerHTML = '<li class="empty">SEARCHING NEWS UPLINK…</li>';
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
  // Debris "programme" articles are about the break-up that created the fragment.
  const isDebris = layer !== null && layer.selected >= 0 && layer.sats[layer.selected].category === 'debris';
  const label = w.context === 'programme' ? (isDebris ? 'ORIGIN' : 'PROGRAMME') : 'BACKGROUND';
  $('d-about-title').textContent = w.context === 'own' ? 'BRIEFING' : `${label} · ${w.title}`;
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
  set('d-foot', coverage ? `${fmt(coverage.horizonRadiusKm, 0)} KM` : '--');
  set('d-cover', coverage ? `${fmt(coverage.earthFraction * 100, coverage.earthFraction < 0.1 ? 2 : 1)}%` : '--');
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

// ---- News ------------------------------------------------------------------------
// The ticker types out the latest headlines one at a time; the NEWS tab lists them; the
// dossier shows news about the selected object. New stories are polled every 5 minutes.
const NEWS_POLL_MS = 5 * 60_000;
let feed: Article[] = [];
const seenArticles = new Set<number>();
const arrivedLive = new Set<number>();

/** Fresh = published in the last hour, or arrived since this page was opened. */
const isFresh = (a: Article) => arrivedLive.has(a.id) || Date.now() - a.publishedMs < 3_600_000;

function newsItem(a: Article, withSummary: boolean): HTMLLIElement {
  const li = document.createElement('li');
  const link = Object.assign(document.createElement('a'), { href: a.url, target: '_blank', rel: 'noopener' });
  const meta = Object.assign(document.createElement('span'), { className: 'meta', textContent: `${timeAgo(a.publishedMs)} · ${a.site}` });
  if (isFresh(a)) meta.append(Object.assign(document.createElement('span'), { className: 'new', textContent: ' · ◉ NEW' }));
  link.append(meta, Object.assign(document.createElement('span'), { className: 'ttl', textContent: a.title }));
  if (withSummary && a.summary) link.append(Object.assign(document.createElement('span'), { className: 'sum', textContent: a.summary }));
  li.append(link);
  return li;
}

function renderFeed() {
  const list = $('news-list');
  list.replaceChildren(...feed.map((a) => newsItem(a, true)));
  if (!feed.length) list.innerHTML = '<li class="empty">NEWS UPLINK UNAVAILABLE</li>';
  $('news-count').textContent = String(feed.filter(isFresh).length || feed.length);
}

async function refreshNews() {
  try {
    const latest = await latestNews(20);
    if (!latest.length) throw new Error('empty');
    const incoming = latest.filter((a) => !seenArticles.has(a.id));
    const firstSync = seenArticles.size === 0;
    for (const a of incoming) {
      seenArticles.add(a.id);
      if (!firstSync) {
        arrivedLive.add(a.id);
        log('NEWS', `${a.site} · ${a.title}`, 'ok');
      }
    }
    if (firstSync) log('NEWS', `UPLINK ESTABLISHED · ${latest.length} STORIES · LATEST ${timeAgo(latest[0].publishedMs)}`);
    feed = latest;
    $('news-sync').textContent = new Date().toISOString().slice(11, 19) + ' UTC';
    renderFeed();
  } catch {
    log('NEWS', 'NEWS UPLINK UNAVAILABLE · WILL RETRY', 'warn');
  }
}

// Teletype: type the headline a character at a time, hold it, then move to the next.
let tickerIndex = -1;
let tickerChars = 0;
let tickerHoldUntil = 0;
setInterval(() => {
  if (!feed.length) return;
  const now = performance.now();
  const current = feed[tickerIndex];
  if (!current || (tickerChars >= current.title.length && now > tickerHoldUntil)) {
    tickerIndex = (tickerIndex + 1) % Math.min(feed.length, 12);
    tickerChars = 0;
    const next = feed[tickerIndex];
    const ticker = $<HTMLAnchorElement>('ticker');
    ticker.href = next.url;
    ticker.classList.toggle('fresh', isFresh(next));
    ticker.querySelector('.tk-tag')!.textContent = isFresh(next) ? '◉ NEW' : next.site.toUpperCase();
    return;
  }
  if (tickerChars < current.title.length) {
    tickerChars = Math.min(current.title.length, tickerChars + 2);
    $('ticker-text').textContent = current.title.slice(0, tickerChars);
    if (tickerChars === current.title.length) tickerHoldUntil = now + 7000;
  }
}, 40);

refreshNews();
setInterval(refreshNews, NEWS_POLL_MS);

function showObjectNews(n: ObjectNews | null) {
  const list = $('d-news');
  if (!n) {
    $('d-news-title').textContent = 'NEWS';
    list.innerHTML = '<li class="empty">NO SPECIFIC COVERAGE FOR THIS OBJECT</li>';
    return;
  }
  $('d-news-title').textContent = `NEWS · ${n.topic}${n.programme ? ' PROGRAMME' : ''}`;
  list.replaceChildren(...n.articles.slice(0, 5).map((a) => newsItem(a, false)));
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
  if (picking) {
    const ll = cursorLatLon(e);
    if (!ll) return;
    setPicking(false);
    setObserver({ latDeg: ll[0], lonDeg: ll[1], source: 'globe' });
    return;
  }
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

  if (!layer) return;
  const propRate = layer.propagated / seconds;
  layer.propagated = 0;
  peakProp = Math.max(peakProp, propRate);
  $('m-prop').textContent = `${fmt(propRate / 1000, 1)}K / S`;
  blocks($('b-prop'), propRate / peakProp);
  sparkProp.push(propRate);
  $('g-prop-v').textContent = `${fmt(propRate / 1000, 1)}K`;

  if (observer) {
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
  let sim = simNow();
  if (encounter && !encounter.held && speed > 0 && sim >= encounter.tcaMs && sim - encounter.tcaMs < 60_000) {
    // Freeze exactly at closest approach so the geometry can be inspected.
    encounter.held = true;
    jumpTo(encounter.tcaMs, 0);
    sim = encounter.tcaMs;
    const sep = layer?.separation(encounter.a, encounter.b, sim);
    log('CONJ', `CLOSEST APPROACH · ${sep ? fmtKm(sep.km) : '--'} · HELD AT TCA`, 'warn');
  }
  globe.setTime(new Date(sim));
  if (layer) {
    layer.update(sim);
    updateCamera();
    const sel = layer.selected;
    const shown = sel >= 0 && !layer.hidden.has(layer.sats[sel].category);
    groundTrack.group.visible = shown;
    coverage = shown
      ? groundTrack.update(sim, layer.positionOf(sel, tmp), { width: canvas.clientWidth, height: canvas.clientHeight })
      : null;
    observerMarker.update(globe.camera, { width: canvas.clientWidth, height: canvas.clientHeight }, shown ? layer.positionOf(sel, beamTarget) : null);
    models.update(layer, globe.camera, canvas.clientHeight);
    updateReticle();
  } else {
    globe.controls.update();
  }
  updateHover();

  if (now - lastFast > 250) {
    lastFast = now;
    updateFastReadouts(sim);
    updateEncounterReadouts(sim);
    updateObserverReadouts(sim);
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
    layer = new SatelliteLayer(sats, globe.scene);
    byNorad = new Map(sats.map((s, i) => [s.noradId, i]));
    layer.setVisualMode(globe.visualMode);
    models.setCatalog(sats);
    buildLegend(layer.counts());
    buildCensus(layer.regimeCounts());
    search.disabled = false;
    const age = Math.round((Date.now() - fetchedAt.getTime()) / 60000);
    $('sb-link').textContent = `■ CELESTRAK ${source.toUpperCase()}`;
    $('sb-link').classList.remove('blink-slow');
    const via = { mirror: `SITE MIRROR, ${age} MIN OLD`, cache: `BROWSER CACHE, ${age} MIN OLD`, live: 'LIVE DOWNLINK' }[source];
    log('CELESTRAK', `${active.sats.length.toLocaleString('en-GB')} ELEMENT SETS PARSED · ${via}`, 'ok');
    if (debris) log('CELESTRAK', `${debris.sats.length.toLocaleString('en-GB')} DEBRIS FRAGMENTS · 4 BREAK-UP EVENTS`, 'ok');
    log('SGP4', 'PROPAGATOR ARMED · ROUND-ROBIN 4 MS SLICE');
    applyHash();
    runScreening();
  })
  .catch((err: unknown) => {
    console.error(err);
    $('sb-link').textContent = '■ LINK DOWN';
    $('sb-link').classList.add('warn');
    log('CELESTRAK', 'COULD NOT RETRIEVE ORBITAL ELEMENTS · RETRY IN A FEW MINUTES', 'warn');
  });

if (import.meta.env.DEV) Object.assign(window, { debug: { globe, models, getLayer: () => layer, getConj: () => conj } });
