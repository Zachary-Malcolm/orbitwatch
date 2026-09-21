import { CATEGORIES } from '../satellites';
import { app } from './context';
import { $ } from './dom';
import { select } from './selection';

// Search by name or NORAD ID, and the quick-target buttons.

export function initSearch() {
  const search = $<HTMLInputElement>('search');
  const results = $('results');

  search.addEventListener('input', () => {
    results.replaceChildren();
    const q = search.value.trim().toUpperCase();
    const layer = app.layer;
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
    const i = app.layer?.sats.findIndex((s) => s.noradId === norad) ?? -1;
    if (i >= 0) select(i);
  });
}

/** Enable the search box once the catalogue has loaded. */
export function enableSearch() {
  $<HTMLInputElement>('search').disabled = false;
}
