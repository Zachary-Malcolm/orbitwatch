import { CATEGORIES } from '../satellites';
import { log } from '../telemetry';
import { beginFlight, isGlobalView } from './camera';
import { simNow } from './clock';
import { renderTargetConjunctions } from './conjunctionPanel';
import { app, groundTrack } from './context';
import { showDossier, updateDetails } from './dossier';
import { $ } from './dom';
import { clearEncounter } from './encounter';
import { toggleCategory } from './legend';
import { updateHash } from './links';
import { refreshPasses } from './passesPanel';
import { sfx } from './sound';
import { showTab } from './tabs';

// Locking onto a target (index ≥ 0) or releasing it (−1), and everything that follows from that.

export function select(index: number, keepEncounter = false) {
  const layer = app.layer;
  if (!layer) return;
  const previous = layer.selected;
  layer.select(index, simNow());
  if (!keepEncounter) clearEncounter();
  showTab(index >= 0 ? 'target' : undefined);
  groundTrack.setTarget(index >= 0 ? layer.sats[index].satrec : null, index >= 0 ? CATEGORIES[layer.sats[index].category].color : undefined);
  if (index < 0) {
    if (previous >= 0) {
      log('TRACK', `TARGET RELEASED · ${layer.sats[previous].name}`);
      sfx.release();
    }
    if (!isGlobalView()) beginFlight('to-earth');
    updateHash();
    return;
  }
  const sat = layer.sats[index];
  if (layer.hidden.has(sat.category)) toggleCategory(sat.category, true);
  log('TRACK', `TARGET LOCK · ${sat.name} [${sat.noradId}]`, 'ok');
  sfx.lock();
  showDossier(index);
  beginFlight('to-sat');
  updateDetails();
  renderTargetConjunctions(index);
  refreshPasses();
  updateHash();
}

export function initSelection() {
  $('close-details').addEventListener('click', () => select(-1));
  $('release').addEventListener('click', () => select(-1));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') select(-1);
  });
}
