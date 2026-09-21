import { CATEGORIES } from '../satellites';
import { log } from '../telemetry';
import type { Category } from '../tle';
import { app } from './context';
import { $ } from './dom';

// The layer filter: one row per category, click to show or hide it.

export function buildLegend(counts: Record<Category, number>) {
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

export function toggleCategory(cat: Category, forceVisible = false) {
  const layer = app.layer;
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
