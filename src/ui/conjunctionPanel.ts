import { isIntraConstellation, screenConjunctions, severity, type Conjunction, type ScreenResult } from '../conjunctions';
import { log } from '../telemetry';
import { blocks } from '../terminal';
import { app } from './context';
import { $ } from './dom';
import { openEncounter } from './encounter';
import { fmt, fmtKm, untilText } from './format';
import { sfx } from './sound';

// The APPROACHES tab and the dossier's close-approach list: runs screening and lists the results.

export const THRESHOLD_KM = 5;
let conj: ScreenResult | null = null;
let screening = false;
let windowHours = 24;
let includeIntra = false;

/** The latest screening result (for the dev console). */
export const getConj = () => conj;

function visibleEvents(): Conjunction[] {
  const layer = app.layer;
  if (!conj || !layer) return [];
  const sats = layer.sats;
  return includeIntra && !conj.skipIntra
    ? conj.events
    : conj.events.filter((ev) => !isIntraConstellation(sats[ev.a], sats[ev.b]));
}

/** One list row. With `perspective`, only the other object is named. */
function conjRow(ev: Conjunction, rank: number, perspective = -1): HTMLLIElement {
  const sats = app.layer!.sats;
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

export function renderTargetConjunctions(index: number) {
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

export async function runScreening() {
  const layer = app.layer;
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
    sfx.done();
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

export function initConjunctionPanel() {
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
      const layer = app.layer;
      if (layer && layer.selected >= 0) renderTargetConjunctions(layer.selected);
    }
  });
}
