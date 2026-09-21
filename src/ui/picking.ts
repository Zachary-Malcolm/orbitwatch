import * as THREE from 'three';
import { CATEGORIES } from '../satellites';
import { app, canvas, globe } from './context';
import { $ } from './dom';
import { fmt } from './format';
import { isPicking, setObserver, setPicking } from './passesPanel';
import { select } from './selection';

// Clicking and hovering on the globe: pick a satellite, place the observer station, and show the
// name under the cursor and the cursor's latitude/longitude.

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const hitPoint = new THREE.Vector3();
let down: { x: number; y: number } | null = null;
let hoverQueued: PointerEvent | null = null;

function pickAt(e: PointerEvent): number {
  const layer = app.layer;
  if (!layer) return -1;
  const rect = canvas.getBoundingClientRect();
  return layer.pick(e.clientX - rect.left, e.clientY - rect.top, globe.camera, rect.width, rect.height);
}

/** Latitude/longitude of the point on the globe under the cursor, or null for space. */
function cursorLatLon(e: PointerEvent): [number, number] | null {
  const rect = canvas.getBoundingClientRect();
  pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
  raycaster.setFromCamera(pointer, globe.camera);
  const hit = raycaster.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1), hitPoint);
  if (!hit) return null;
  const p = globe.earth.worldToLocal(hit.clone()).normalize();
  return [THREE.MathUtils.radToDeg(Math.asin(p.y)), THREE.MathUtils.radToDeg(Math.atan2(-p.z, p.x))];
}

/** Handle the latest pointer move (at most once per frame). */
export function updateHover() {
  if (!hoverQueued) return;
  const e = hoverQueued;
  hoverQueued = null;
  const ll = cursorLatLon(e);
  $('h-cursor').textContent = ll
    ? `${fmt(Math.abs(ll[0]), 2)}°${ll[0] >= 0 ? 'N' : 'S'} ${fmt(Math.abs(ll[1]), 2)}°${ll[1] >= 0 ? 'E' : 'W'}`
    : 'DEEP SPACE';
  const layer = app.layer;
  if (!layer || e.buttons) return;
  const hit = pickAt(e);
  const tooltip = $('tooltip');
  tooltip.hidden = hit < 0;
  canvas.style.cursor = hit >= 0 ? 'crosshair' : '';
  if (hit >= 0) {
    const s = layer.sats[hit];
    tooltip.textContent = `${CATEGORIES[s.category].glyph} ${s.name} · ${s.noradId}`;
    tooltip.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 10}px)`;
  }
}

export function initPicking() {
  canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY }));
  canvas.addEventListener('pointerup', (e) => {
    const layer = app.layer;
    if (!down || !layer) return;
    const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
    down = null;
    if (moved > 4) return;
    if (isPicking()) {
      const ll = cursorLatLon(e);
      if (!ll) return;
      setPicking(false);
      setObserver({ latDeg: ll[0], lonDeg: ll[1], source: 'globe' });
      return;
    }
    const hit = pickAt(e);
    if (hit >= 0 && hit !== layer.selected) select(hit);
  });
  canvas.addEventListener('pointermove', (e) => {
    hoverQueued = e;
  });
  canvas.addEventListener('pointerleave', () => {
    $('tooltip').hidden = true;
    $('h-cursor').textContent = '--';
  });
}
