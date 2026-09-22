import { CATEGORIES } from '../satellites';
import { fetchIntel, type CatalogInfo, type WikiInfo } from '../intel';
import { newsFor } from '../news';
import { log } from '../telemetry';
import { blocks } from '../terminal';
import { clockJumps, simNow } from './clock';
import { app, models } from './context';
import { $ } from './dom';
import { fmt } from './format';
import { showObjectNews } from './newsPanel';
import { sfx } from './sound';

// The target dossier: identity, catalogue record, Wikipedia briefing and live telemetry.

const CATALOG_FIELDS = ['d-owner', 'd-type', 'd-status', 'd-launch', 'd-site', 'd-rcs'];
let lastSunlit: boolean | null = null;
let sunlitJumps = 0;

/** Fill the dossier header for a newly locked target and start fetching its intel. */
export function showDossier(index: number) {
  const sat = app.layer!.sats[index];
  lastSunlit = null;
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
  resetIntel();
  const intel = fetchIntel(sat);
  intel.catalog.then((c) => {
    if (app.layer?.selected !== index) return;
    showCatalog(c);
    if (c) {
      log('SATCAT', `${sat.noradId} · ${c.owner.code} · ${c.objectType} · ${c.status}`);
      sfx.modem();
    }
  });
  intel.wiki
    .then((w) => newsFor(sat, w))
    .then((n) => app.layer?.selected === index && showObjectNews(n));
  intel.wiki.then((w) => {
    if (app.layer?.selected !== index) return;
    showWiki(w);
    if (w) sfx.modem();
    log('WIKI', w ? `BRIEFING RETRIEVED · ${w.title}${w.context === 'own' ? '' : ` (${w.context})`}` : 'NO BRIEFING ON FILE', w ? 'info' : 'warn');
  });
}

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
  const layer = app.layer;
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

function formatCospar(designator: string): string {
  // "98067A" -> "1998-067A"
  const yy = Number(designator.slice(0, 2));
  if (Number.isNaN(yy)) return designator;
  return `${yy < 57 ? 2000 + yy : 1900 + yy}-${designator.slice(2)}`;
}

/** Live telemetry for the locked target (refreshed 4 times a second). */
export function updateDetails() {
  const layer = app.layer;
  if (!layer || layer.selected < 0) return;
  const d = layer.details(layer.selected, simNow());
  const set = (id: string, text: string) => ($(id).textContent = text);
  if (!d) {
    set('d-regime', 'PROPAGATION FAILED — ELEMENTS STALE OR OBJECT DECAYED');
    $('d-regime').classList.add('warn');
    return;
  }
  const coverage = app.coverage;
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
  // After a clock jump the target may be on the other side of the terminator, but it didn't cross it.
  if (sunlitJumps !== clockJumps()) {
    sunlitJumps = clockJumps();
    lastSunlit = null;
  }
  if (lastSunlit !== null && lastSunlit !== d.sunlit) {
    log('ORBIT', `${layer.sats[layer.selected].name} ${d.sunlit ? 'EXITED' : 'ENTERED'} EARTH SHADOW`, d.sunlit ? 'ok' : 'warn');
    sfx.eclipse(!d.sunlit);
  }
  lastSunlit = d.sunlit;
}

export function initDossier() {
  $<HTMLImageElement>('d-img').addEventListener('error', () => ($('d-figure').hidden = true));
}
