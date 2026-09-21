import {
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
  type Pass,
  type PassForecast,
} from '../observer';
import { log } from '../telemetry';
import { jumpTo, simNow } from './clock';
import { app, observerMarker } from './context';
import { $ } from './dom';
import { fmt, hms, localTime } from './format';

// The observer station (kept only in this browser) and the locked target's passes over it.

let observer: Observer | null = null;
let forecast: PassForecast | null = null;
let forecastFor = -1;
let forecastAt = 0;
let picking = false;
let lastAbove: boolean | null = null;

export const getObserver = () => observer;
/** The locked target's predicted passes over the station (empty if there's no station or target). */
export const currentPasses = (): Pass[] => (forecast?.kind === 'passes' ? forecast.passes : []);
/** True while the next click on the globe places the station. */
export const isPicking = () => picking;

export function setObserver(o: Observer | null, announce = true) {
  observer = o;
  saveObserver(o);
  observerMarker.setObserver(o);
  $('o-pos').textContent = o ? formatLatLon(o) : 'NOT SET';
  if (announce) log('STATION', o ? `OBSERVER SET · ${formatLatLon(o)} · ${o.source.toUpperCase()}` : 'OBSERVER CLEARED');
  lastAbove = null;
  refreshPasses();
  updateObserverReadouts(simNow());
}

export function setPicking(on: boolean) {
  picking = on;
  document.body.classList.toggle('picking', on);
  $('o-pick').classList.toggle('active', on);
}

export function refreshPasses() {
  const layer = app.layer;
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

/** Sky condition, the target's position in the station's sky, and the next-pass countdown (4 times a second). */
export function updateObserverReadouts(sim: number) {
  if (!observer) {
    $('o-sky').textContent = '--';
    return;
  }
  const date = new Date(sim);
  const sunEl = sunElevation(observer, date);
  $('o-sky').textContent = `${skyCondition(sunEl)} · SUN ${fmt(sunEl, 0)}°`;
  const layer = app.layer;
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

export function initObserverPanel() {
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

  const saved = loadObserver();
  if (saved) {
    setObserver(saved, false);
    log('STATION', `OBSERVER RESTORED · ${formatLatLon(saved)}`);
  }
}
