import { app } from './context';
import { $ } from './dom';

// Right-column tabs: target dossier (or standby radar), close approaches, news.

export type Tab = 'target' | 'conj' | 'news';
let tab: Tab = 'target';

/** Show a tab; with no argument, refresh the current one (e.g. swap the dossier for standby). */
export function showTab(next: Tab = tab) {
  tab = next;
  const sel = app.layer?.selected ?? -1;
  document.querySelectorAll<HTMLButtonElement>('#right-tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tab);
  });
  $('conj').hidden = tab !== 'conj';
  $('news').hidden = tab !== 'news';
  $('details').hidden = tab !== 'target' || sel < 0;
  $('standby').hidden = tab !== 'target' || sel >= 0;
}

export function initTabs() {
  $('right-tabs').addEventListener('click', (e) => {
    const next = (e.target as HTMLElement).closest('button')?.dataset.tab as Tab | undefined;
    if (next) showTab(next);
  });
}
