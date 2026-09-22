import { CATEGORIES } from '../satellites';
import { app } from './context';
import { $ } from './dom';
import { select } from './selection';
import { sfx } from './sound';
import { showTab } from './tabs';

// The phone layout (900 px and narrower; wider screens are untouched). The globe fills the screen and
// the panels live in a bottom sheet opened from a tab bar, so whatever is being adjusted, its effect is
// visible on the globe above. The globe shrinks to stay whole above the open sheet, which can be
// dragged by its grip between closed, half and nearly full height. On the globe itself, a chip shows
// the locked target with a release button. Locking onto something closes the sheet so the camera's
// flight is seen, and the dossier's long sections start folded.
//
// The panels are the desktop ones, moved into the sheet on phones and back into their columns if the
// window widens, so everything wired to them keeps working.

const PHONE = matchMedia('(max-width: 900px)');

type Page = 'target' | 'layers' | 'find' | 'time' | 'more';
type SheetState = 'closed' | 'half' | 'full';

/** Which panels each tab shows, in order. */
const PAGES: Record<Page, string[]> = {
  target: ['#right-tabs', '#news', '#conj', '#standby', '#details'],
  layers: ['.mod.layers'],
  find: ['.mod.search'],
  time: ['.mod.chrono', '.mod.log'],
  more: ['.mod.observer', '#sys-perf', '#sys-census', '#sys-links', '.mod.graphs'],
};

/** Dossier sections that start folded on phones (by their heading's id). */
const FOLDED_AT_START = ['d-conj-title', 'd-about-title', 'd-news-title'];

/** Keep at least this much globe visible above a fully open sheet. */
const MIN_GLOBE_PX = 150;

let page: Page = 'target';
let state: SheetState = 'closed';
let homes: { el: HTMLElement; parent: HTMLElement; index: number }[] = [];

export const isPhone = () => PHONE.matches;

function sheetHeight(s: SheetState): number {
  if (s === 'closed') return 0;
  const half = Math.round(innerHeight * 0.46);
  if (s === 'half') return half;
  return Math.max(half, innerHeight - 30 - $('tabbar').offsetHeight - MIN_GLOBE_PX);
}

function setSheetHeight(px: number) {
  document.documentElement.style.setProperty('--sheet-h', `${Math.round(px)}px`);
}

function render() {
  setSheetHeight(sheetHeight(state));
  document.querySelectorAll<HTMLElement>('#tabbar button').forEach((b) => b.classList.toggle('active', state !== 'closed' && b.dataset.page === page));
  document.querySelectorAll<HTMLElement>('.sheet-page').forEach((p) => (p.hidden = p.dataset.page !== page));
}

/** Open the sheet on a tab (half height, or keep it full if it already is). */
export function openSheet(next: Page, s: SheetState = state === 'full' ? 'full' : 'half') {
  if (!PHONE.matches) return;
  page = next;
  state = s;
  render();
}

export function closeSheet() {
  if (!PHONE.matches || state === 'closed') return;
  state = 'closed';
  render();
}

/** On phones, bring a panel into view: open the sheet on its tab, or close the sheet for the globe. */
export function revealOnPhone(el: Element | null) {
  if (!PHONE.matches || !el) return;
  const pageEl = el.closest<HTMLElement>('.sheet-page');
  if (pageEl) openSheet(pageEl.dataset.page as Page);
  else closeSheet();
}

// ---- Moving the panels between the desktop columns and the sheet ----

function toPhone() {
  if (!homes.length) {
    for (const selectors of Object.values(PAGES)) {
      for (const sel of selectors) {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el?.parentElement) continue;
        homes.push({ el, parent: el.parentElement, index: [...el.parentElement.children].indexOf(el) });
      }
    }
  }
  for (const [p, selectors] of Object.entries(PAGES) as [Page, string[]][]) {
    const container = document.querySelector<HTMLElement>(`.sheet-page[data-page="${p}"]`)!;
    for (const sel of selectors) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el) container.append(el);
    }
  }
  $('p-none').textContent = 'SET AN OBSERVER STATION (MORE TAB) TO PREDICT WHEN THIS OBJECT PASSES OVERHEAD.';
  render();
}

function toDesktop() {
  // Every child of each column was moved, so appending them in their original order restores it exactly.
  for (const { el, parent } of [...homes].sort((a, b) => a.index - b.index)) parent.append(el);
  $('p-none').textContent = 'SET AN OBSERVER STATION (LEFT PANEL) TO PREDICT WHEN THIS OBJECT PASSES OVERHEAD.';
  state = 'closed';
  setSheetHeight(0);
}

// ---- Dragging the sheet by its grip ----

function initDrag() {
  const grip = $('sheet-grip');
  let startY = 0;
  let startH = 0;
  let dragging = false;
  grip.addEventListener('pointerdown', (e) => {
    dragging = true;
    startY = e.clientY;
    startH = sheetHeight(state);
    grip.setPointerCapture(e.pointerId);
    document.body.classList.add('sheet-dragging');
  });
  grip.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setSheetHeight(Math.min(sheetHeight('full'), Math.max(0, startH + startY - e.clientY)));
  });
  const end = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove('sheet-dragging');
    // Snap to whichever height is nearest where it was let go.
    const h = startH + startY - e.clientY;
    const snaps: SheetState[] = ['closed', 'half', 'full'];
    state = snaps.reduce((best, s) => (Math.abs(sheetHeight(s) - h) < Math.abs(sheetHeight(best) - h) ? s : best));
    render();
  };
  grip.addEventListener('pointerup', end);
  grip.addEventListener('pointercancel', end);
}

// ---- Folding dossier sections ----

/** The elements after a section heading, up to the next heading (or the dossier's closing buttons). */
function sectionOf(h4: HTMLElement): HTMLElement[] {
  const members: HTMLElement[] = [];
  for (let el = h4.nextElementSibling as HTMLElement | null; el && el.tagName !== 'H4' && !el.querySelector('#release'); el = el.nextElementSibling as HTMLElement | null) {
    members.push(el);
  }
  return members;
}

function setFolded(h4: HTMLElement, folded: boolean) {
  h4.classList.toggle('shut', folded);
  h4.setAttribute('aria-expanded', String(!folded));
  for (const el of sectionOf(h4)) el.classList.toggle('folded', folded);
}

function initFolds() {
  // Only phone styles make these visible (a ▸/▾ marker, and folded sections hidden); desktop ignores them.
  for (const h4 of document.querySelectorAll<HTMLElement>('#details > h4')) {
    h4.classList.add('fold-h');
    setFolded(h4, FOLDED_AT_START.includes(h4.id));
    h4.addEventListener('click', () => {
      if (!PHONE.matches) return;
      const open = h4.classList.contains('shut');
      setFolded(h4, !open);
      sfx.toggle(open);
    });
  }
}

// ---- Target chip on the globe ----

/** Show the locked target on the globe (4 times a second, and whenever the target changes). */
export function updateTargetChip() {
  const layer = app.layer;
  const sel = layer?.selected ?? -1;
  const chip = $('target-chip');
  chip.hidden = !layer || sel < 0;
  if (!layer || sel < 0) return;
  const sat = layer.sats[sel];
  const meta = CATEGORIES[sat.category];
  const glyph = $('chip-glyph');
  glyph.textContent = meta.glyph;
  glyph.style.color = meta.color;
  $('chip-name').textContent = sat.name;
  $('chip-alt').textContent = $('d-alt').textContent ? ` · ${$('d-alt').textContent}` : '';
}

export function initMobile() {
  initFolds();
  initDrag();
  document.querySelectorAll<HTMLButtonElement>('#tabbar button').forEach((b) =>
    b.addEventListener('click', () => {
      const p = b.dataset.page as Page;
      if (state !== 'closed' && p === page) closeSheet();
      else openSheet(p);
    }),
  );
  $('chip-open').addEventListener('click', () => {
    showTab('target');
    openSheet('target');
  });
  $('chip-release').addEventListener('click', () => select(-1));
  if (PHONE.matches) toPhone();
  PHONE.addEventListener('change', () => (PHONE.matches ? toPhone() : toDesktop()));
  addEventListener('resize', () => PHONE.matches && render());
}
