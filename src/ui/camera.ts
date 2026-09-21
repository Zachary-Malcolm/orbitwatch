import * as THREE from 'three';
import { app, canvas, globe, models } from './context';

// Camera flights and target tracking.
// 'earth': orbiting the globe. 'to-sat' / 'to-earth': animated transitions.
// 'tracking': the orbit controls pivot around the selected satellite, and the camera's
// offset is held in the satellite's local frame (along-track, radial, cross-track) so
// the view of the Earth below stays put as it orbits.

type CameraMode = 'earth' | 'to-sat' | 'tracking' | 'to-earth';
const MODE_LABELS: Record<CameraMode, string> = {
  earth: 'GLOBAL ORBIT',
  'to-sat': 'SLEWING ▶ TARGET',
  tracking: 'TARGET TRACK',
  'to-earth': 'SLEWING ▶ GLOBAL',
};
let mode: CameraMode = 'earth';
let flyStart = 0;
const FLY_MS = 1800;
const TRACK_OFFSET = new THREE.Vector3(-0.14, 0.06, 0.07); // behind, above and beside, ~1,100 km
const localOffset = new THREE.Vector3();
const startCam = new THREE.Vector3();
const startTarget = new THREE.Vector3();
const endCam = new THREE.Vector3();
const satPos = new THREE.Vector3();
const basis = { t: new THREE.Vector3(), r: new THREE.Vector3(), n: new THREE.Vector3() };
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const q = new THREE.Quaternion();
const ease = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2);

export const cameraModeLabel = () => MODE_LABELS[mode];
export const isGlobalView = () => mode === 'earth';

export function beginFlight(next: CameraMode) {
  mode = next;
  flyStart = performance.now();
  startCam.copy(globe.camera.position);
  startTarget.copy(globe.controls.target);
  globe.controls.enabled = false;
}

function satFrame(index: number): boolean {
  const layer = app.layer;
  if (!layer) return false;
  layer.positionOf(index, satPos);
  if (satPos.lengthSq() === 0) return false;
  basis.r.copy(satPos).normalize();
  const j = index * 3;
  basis.t.fromArray(layer.velocities, j);
  basis.t.addScaledVector(basis.r, -basis.t.dot(basis.r)).normalize();
  basis.n.crossVectors(basis.t, basis.r);
  return true;
}

const localToWorld = (local: THREE.Vector3, out: THREE.Vector3) =>
  out
    .copy(satPos)
    .addScaledVector(basis.t, local.x)
    .addScaledVector(basis.r, local.y)
    .addScaledVector(basis.n, local.z);

/** Interpolate around the Earth's centre (direction + radius) so the path never cuts through the globe. */
function arcLerp(from: THREE.Vector3, to: THREE.Vector3, e: number, out: THREE.Vector3) {
  const r = THREE.MathUtils.lerp(from.length(), to.length(), e);
  q.setFromUnitVectors(tmp.copy(from).normalize(), tmp2.copy(to).normalize());
  q.slerp(new THREE.Quaternion(), 1 - e);
  return out.copy(from).normalize().applyQuaternion(q).multiplyScalar(r);
}

export function updateCamera() {
  const cam = globe.camera.position;
  const controls = globe.controls;
  const sel = app.layer?.selected ?? -1;
  const e = ease(Math.min(1, (performance.now() - flyStart) / FLY_MS));

  if (mode === 'tracking') {
    // Capture the offset *before* moving the satellite: the controls apply zoom and drag
    // immediately in their event handlers, so the camera may have moved since last frame.
    // `basis` and `controls.target` still hold last frame's satellite frame here.
    tmp.subVectors(cam, controls.target);
    localOffset.set(tmp.dot(basis.t), tmp.dot(basis.r), tmp.dot(basis.n));
  }

  if ((mode === 'to-sat' || mode === 'tracking') && (sel < 0 || !satFrame(sel))) {
    beginFlight('to-earth');
  }

  if (mode === 'to-sat') {
    arcLerp(startCam, localToWorld(TRACK_OFFSET, endCam), e, cam);
    controls.target.lerpVectors(startTarget, satPos, e);
    if (e >= 1) {
      mode = 'tracking';
      localOffset.copy(TRACK_OFFSET);
      controls.enabled = true;
      controls.minDistance = 0.02;
    }
  } else if (mode === 'tracking') {
    localToWorld(localOffset, cam);
    controls.target.copy(satPos);
    controls.update();
  } else if (mode === 'to-earth') {
    arcLerp(startCam, endCam.copy(startCam).setLength(Math.max(startCam.length(), 3.2)), e, cam);
    controls.target.copy(startTarget).multiplyScalar(1 - e);
    if (e >= 1) {
      mode = 'earth';
      controls.enabled = true;
      controls.minDistance = 1.3;
    }
  } else {
    controls.update();
  }
  globe.camera.lookAt(controls.target);
}

/** Size the reticle so it frames the 3D model when close, and stays a fixed size when far. */
export function updateReticle() {
  const layer = app.layer;
  if (!layer || layer.selected < 0) return;
  layer.positionOf(layer.selected, tmp);
  const d = tmp.distanceTo(globe.camera.position);
  const px = Math.max(models.pixels(layer.selected, d) * 1.4, 36);
  // Once the model fills the view the brackets just get in the way.
  if (px > 320) layer.marker.visible = false;
  const worldPerPx = (2 * Math.tan(THREE.MathUtils.degToRad(globe.camera.fov) / 2)) / canvas.clientHeight;
  layer.marker.scale.setScalar(px * worldPerPx);
}
