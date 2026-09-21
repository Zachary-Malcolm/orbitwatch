import { log } from '../telemetry';
import { app } from './context';
import { $ } from './dom';
import { select } from './selection';

// The guide for first-time visitors: a welcome card, then a short tour that highlights one panel at a
// time and ends by offering to lock onto the ISS. It opens by itself only on a first visit, and not
// for visitors arriving on a shared link; the [?] button in the status bar replays it. Whether it has
// been seen is remembered in this browser only (localStorage), like the observer station.

const STORAGE_KEY = 'orbitwatch.tour';
const ISS = '25544';

interface Step {
  /** The panel to highlight. */
  target: () => HTMLElement | null;
  title: string;
  text: () => string;
}

const q = (selector: string) => () => document.querySelector<HTMLElement>(selector);

const STEPS: Step[] = [
  {
    target: q('.viewport'),
    title: 'THE GLOBE',
    text: () => {
      const n = app.layer?.sats.length;
      const count = n ? `${n.toLocaleString('en-GB')} right now` : 'about 18,700';
      return `Every dot is a real object in orbit (${count}): active satellites plus debris from the four biggest break-ups, positioned in your browser from today's published orbital data. Drag to spin the globe, scroll or pinch to zoom, and click a dot to lock onto it.`;
    },
  },
  {
    target: q('.left > .layers'),
    title: 'WHAT THE SHAPES MEAN',
    text: () =>
      'Each kind of object has its own colour and shape, so you can tell them apart even in the all-amber display: space stations, Starlink, OneWeb, navigation, Earth observation, other satellites and debris. Click a row to hide or show that kind.',
  },
  {
    target: q('.left > .search'),
    title: 'FIND A SATELLITE',
    text: () => "Type a name or catalogue number, or use the quick buttons for the ISS, Hubble and China's Tiangong station.",
  },
  {
    target: q('.chrono'),
    title: 'TIME CONTROL',
    text: () =>
      'The terminal runs in real time. Drag the timeline to move anywhere in the next 24 hours, speed it up to watch the orbits move, pause it, or press NOW to return to the present.',
  },
  {
    target: q('.bottom > .log'),
    title: 'EVENT LOG',
    text: () =>
      "Everything the terminal does is logged here as it happens: data arriving, targets locked, satellites passing into Earth's shadow. The gauges around the screen are measured live too. Nothing is simulated.",
  },
  {
    target: q('#right-tabs'),
    title: 'APPROACHES AND NEWS',
    text: () =>
      'APPROACHES lists close passes between objects over the next 24 hours, found by checking every object against every other, right here in your browser. NEWS carries the latest spaceflight headlines: anything in blue comes from outside news sources.',
  },
  {
    target: q('.left > .observer'),
    title: 'WHEN CAN I SEE IT?',
    text: () =>
      'Set your location to see when the locked satellite passes over you, and whether it will be visible to the naked eye. Your location stays in this browser. It is never sent anywhere or put in links.',
  },
  {
    target: () => ($('details').hidden ? $('standby') : $('details')),
    title: 'TARGET DOSSIER',
    text: () =>
      'Locking onto an object flies the camera to it and opens its dossier here: who owns it, when it launched, its live altitude and speed, its passes over you and related news. Try it with the International Space Station.',
  },
];

let root: HTMLElement | null = null;
let spot: HTMLElement;
let card: HTMLElement;
let step = -1; // −1 = the welcome card
let raf = 0;

function seen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    localStorage.setItem(STORAGE_KEY, 'seen');
  } catch {
    // Storage unavailable (private mode etc.): the welcome will just appear again next visit.
  }
}

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = '') =>
  Object.assign(document.createElement(tag), { className, textContent: text });

function button(label: string, onClick: () => void, primary = false) {
  const b = make('button', primary ? 'primary' : '', label);
  b.addEventListener('click', onClick);
  return b;
}

function render() {
  const welcome = step < 0;
  root!.classList.toggle('welcome', welcome);
  spot.hidden = welcome;

  const heading = make('h2');
  heading.append(make('span', '', welcome ? 'ORBITWATCH // BRIEFING' : STEPS[step].title), make('i', '', welcome ? '' : `${step + 1}/${STEPS.length}`));
  heading.firstElementChild!.id = 'tour-title';
  const body: HTMLElement[] = [];
  const buttons = make('div', 'btn-row');

  if (welcome) {
    body.push(
      make('p', 'lead', 'Live tracking of everything in Earth orbit.'),
      make('p', '', "Every dot on the globe is a real satellite or piece of debris, positioned in your browser from today's published orbital data."),
      make('p', '', 'New here? The tour takes about a minute.'),
    );
    buttons.append(
      button('START TOUR', () => go(0), true),
      button('NOT NOW', () => close('later')),
      button("DON'T SHOW AGAIN", () => close('optout')),
    );
    body.push(buttons, make('p', 'hint', 'Reopen this guide any time with [?] at the top of the screen.'));
  } else {
    body.push(make('p', '', STEPS[step].text()));
    const last = step === STEPS.length - 1;
    if (!last) {
      buttons.append(button('SKIP TOUR', () => close('skipped')));
      if (step > 0) buttons.append(button('◀ BACK', () => go(step - 1)));
      buttons.append(button('NEXT ▶', () => go(step + 1), true));
    } else {
      buttons.append(button('◀ BACK', () => go(step - 1)), button('FINISH', () => close('finished')));
      const iss = app.byNorad.get(ISS);
      if (iss !== undefined) {
        buttons.append(
          button(
            'LOCK ON TO THE ISS',
            () => {
              close('finished');
              select(iss);
            },
            true,
          ),
        );
      }
    }
    body.push(buttons);
  }

  card.replaceChildren(heading, ...body);
  card.querySelector<HTMLButtonElement>('button.primary')?.focus({ preventScroll: true });
}

function go(next: number) {
  step = next;
  render();
  const target = STEPS[step].target();
  // On a phone the panels are stacked, so bring the next one up to the top of the screen.
  target?.scrollIntoView({ block: innerWidth <= 900 ? 'start' : 'nearest', behavior: 'smooth' });
}

/** Highlight the current panel and put the card beside it (each frame, so it follows scrolling). */
function place() {
  raf = requestAnimationFrame(place);
  const vw = innerWidth;
  const vh = innerHeight;
  const cw = card.offsetWidth;
  const ch = card.offsetHeight;
  const at = (x: number, y: number) => {
    card.style.left = `${Math.round(x)}px`;
    card.style.top = `${Math.round(y)}px`;
  };
  const target = step >= 0 ? STEPS[step].target() : null;
  if (!target) return at((vw - cw) / 2, (vh - ch) / 2);

  const r = target.getBoundingClientRect();
  const pad = 4;
  Object.assign(spot.style, {
    left: `${r.left - pad}px`,
    top: `${r.top - pad}px`,
    width: `${r.width + 2 * pad}px`,
    height: `${r.height + 2 * pad}px`,
  });

  // Phones: the card sits at the bottom of the screen, or at the top if the panel is down there.
  if (vw <= 900) return at((vw - cw) / 2, r.top > vh / 2 ? 12 : vh - ch - 12);

  // Otherwise beside the panel if there's room (right, left, below, above), else in the middle.
  const gap = 12;
  const m = 8;
  const clampY = (y: number) => Math.min(Math.max(y, m), vh - ch - m);
  const clampX = (x: number) => Math.min(Math.max(x, m), vw - cw - m);
  if (r.right + gap + cw <= vw - m) return at(r.right + gap, clampY(r.top));
  if (r.left - gap - cw >= m) return at(r.left - gap - cw, clampY(r.top));
  if (r.bottom + gap + ch <= vh - m) return at(clampX(r.left), r.bottom + gap);
  if (r.top - gap - ch >= m) return at(clampX(r.left), r.top - gap - ch);
  at((vw - cw) / 2, (vh - ch) / 2);
}

function onKey(e: KeyboardEvent) {
  // The tour owns the keyboard while it's open (Escape would otherwise also release the target).
  if (!['Escape', 'ArrowRight', 'ArrowLeft'].includes(e.key)) return;
  e.stopImmediatePropagation();
  e.preventDefault();
  if (e.key === 'Escape') close(step < 0 ? 'later' : 'skipped');
  else if (e.key === 'ArrowRight' && step < STEPS.length - 1) go(step + 1);
  else if (e.key === 'ArrowLeft' && step > 0) go(step - 1);
}

export function openTour() {
  if (root) return;
  root = make('div', 'tour');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-labelledby', 'tour-title');
  spot = make('div', 'tour-spot');
  card = make('section', 'mod tour-card');
  root.append(spot, card);
  document.body.append(root);
  step = -1;
  render();
  window.addEventListener('keydown', onKey, true);
  place();
}

function close(how: 'later' | 'optout' | 'skipped' | 'finished') {
  if (!root) return;
  cancelAnimationFrame(raf);
  window.removeEventListener('keydown', onKey, true);
  root.remove();
  root = null;
  const offerAgain = how === 'later' && !seen();
  if (how !== 'later') markSeen();
  const messages = {
    later: offerAgain ? 'GUIDE DEFERRED · WILL OFFER AGAIN NEXT VISIT' : 'GUIDE CLOSED',
    optout: 'GUIDE DISABLED · REOPEN WITH [?]',
    skipped: 'TOUR SKIPPED · REOPEN WITH [?]',
    finished: 'TOUR COMPLETE',
  };
  log('GUIDE', messages[how], how === 'finished' ? 'ok' : 'info');
}

/** Offer the guide on a first visit, unless the visitor came from a shared link. */
export function offerTour() {
  if (!seen() && !new URLSearchParams(location.hash.slice(1)).has('norad')) openTour();
}

export function initTour() {
  $('guide-btn').addEventListener('click', openTour);
}
