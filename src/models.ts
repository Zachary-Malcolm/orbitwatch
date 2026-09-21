import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { Category, SatInfo } from './tle';
import { matchModel, NASA_MODEL_NAMES, NasaModelLayer, type ModelMatch } from './nasaModels';

// Procedural low-poly spacecraft, drawn as instanced meshes for satellites near the camera.
// Model axes: +X = direction of travel, +Y = away from Earth, +Z = orbit normal.
// Real spacecraft are far too small to see at planetary scale, so models are drawn at a
// size measured in screen pixels that grows as the camera closes in.

type Kind = 'station' | 'tiangong' | 'starlink' | 'navigation' | 'generic';

const MAX_INSTANCES = 400;
/** Satellites closer to the camera than this (in Earth radii, ~5,700 km) become models. */
export const MODEL_RANGE = 0.9;

const GOLD = '#c9a13b';
const FOIL = '#b08a2e';
const SILVER = '#b9c0c9';
const WHITE = '#e8ebef';
const PANEL = '#1c3f94';
const PANEL_ISS = '#b7862f';
const DARK = '#3a414b';

function part(geometry: THREE.BufferGeometry, color: string, x = 0, y = 0, z = 0, rot?: THREE.Euler) {
  const g = geometry.toNonIndexed();
  if (rot) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(rot));
  g.translate(x, y, z);
  const c = new THREE.Color(color);
  const colors = new Float32Array(g.attributes.position.count * 3);
  for (let i = 0; i < colors.length; i += 3) colors.set([c.r, c.g, c.b], i);
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.deleteAttribute('uv');
  return g;
}

const box = (w: number, h: number, d: number) => new THREE.BoxGeometry(w, h, d);
const cyl = (rTop: number, rBottom: number, h: number, seg = 12) => new THREE.CylinderGeometry(rTop, rBottom, h, seg);
const alongX = new THREE.Euler(0, 0, Math.PI / 2);
const alongZ = new THREE.Euler(Math.PI / 2, 0, 0);

/** Merge the parts and scale so the longest dimension is 1. */
function build(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts)!;
  g.computeBoundingBox();
  const size = g.boundingBox!.getSize(new THREE.Vector3());
  const k = 1 / Math.max(size.x, size.y, size.z);
  g.scale(k, k, k);
  g.computeVertexNormals();
  return g;
}

function genericSat() {
  const wing = (side: 1 | -1) => [
    part(cyl(0.008, 0.008, 0.12), SILVER, 0, 0, side * 0.21, alongZ),
    part(box(0.2, 0.006, 0.4), PANEL, 0, 0, side * 0.47),
  ];
  return build([
    part(box(0.22, 0.24, 0.3), GOLD),
    part(box(0.23, 0.02, 0.31), FOIL, 0, 0.12, 0),
    part(cyl(0.11, 0.02, 0.05, 20), WHITE, 0.02, -0.16, 0),
    part(cyl(0.006, 0.006, 0.08), SILVER, 0.02, -0.2, 0),
    ...wing(1),
    ...wing(-1),
  ]);
}

function starlink() {
  // Flat-packed bus with a single long solar array.
  return build([
    part(box(0.32, 0.05, 0.2), DARK),
    part(box(0.31, 0.012, 0.19), SILVER, 0, -0.03, 0),
    part(cyl(0.008, 0.008, 0.1), SILVER, 0, 0.02, 0.15, alongZ),
    part(box(0.3, 0.006, 0.95), PANEL, 0, 0.02, 0.68),
  ]);
}

function navigation() {
  const wing = (side: 1 | -1) => [
    part(cyl(0.01, 0.01, 0.14), SILVER, 0, 0, side * 0.22, alongZ),
    part(box(0.26, 0.006, 0.26), PANEL, 0, 0, side * 0.43),
    part(box(0.26, 0.006, 0.26), PANEL, 0, 0, side * 0.7),
  ];
  return build([
    part(box(0.26, 0.26, 0.3), GOLD),
    part(box(0.18, 0.05, 0.18), WHITE, 0, -0.155, 0),
    part(cyl(0.02, 0.02, 0.06), WHITE, 0.06, -0.2, 0.06),
    part(cyl(0.02, 0.02, 0.06), WHITE, -0.06, -0.2, -0.06),
    ...wing(1),
    ...wing(-1),
  ]);
}

function station() {
  // ISS-like: a long truss with four pairs of arrays at each end and pressurised modules in the middle.
  const parts = [
    part(box(0.035, 0.035, 1.1), SILVER),
    part(cyl(0.045, 0.045, 0.55, 16), WHITE, 0, 0, 0, alongX),
    part(cyl(0.04, 0.04, 0.2, 16), WHITE, 0.08, 0, 0.1, alongZ),
    part(cyl(0.04, 0.04, 0.2, 16), WHITE, -0.12, 0, -0.1, alongZ),
    part(box(0.2, 0.006, 0.08), WHITE, 0, 0.09, 0.2),
    part(box(0.2, 0.006, 0.08), WHITE, 0, 0.09, -0.2),
  ];
  // Arrays stand edge-on to the direction of travel, as the ISS's usually do while tracking the sun.
  for (const z of [-0.5, -0.4, 0.4, 0.5]) {
    for (const side of [1, -1]) parts.push(part(box(0.004, 0.3, 0.075), PANEL_ISS, 0, side * 0.19, z));
  }
  return build(parts);
}

/** Stations are the showpiece, so draw them larger than the rest. */
const KIND_SCALE: Record<Kind, number> = { station: 1.7, tiangong: 1.5, starlink: 1, navigation: 1.1, generic: 1 };

function tiangong() {
  // Tiangong: the Tianhe core with Wentian and Mengtian docked either side in a T,
  // each lab carrying a long pair of solar wings.
  const parts = [
    part(cyl(0.05, 0.05, 0.42, 16), WHITE, 0.05, 0, 0, alongX),
    part(cyl(0.035, 0.05, 0.1, 16), WHITE, 0.3, 0, 0, alongX),
    part(cyl(0.05, 0.05, 0.4, 16), WHITE, -0.15, 0, 0.23, alongZ),
    part(cyl(0.05, 0.05, 0.4, 16), WHITE, -0.15, 0, -0.23, alongZ),
    part(box(0.12, 0.004, 0.3), PANEL, 0.12, 0.12, 0),
  ];
  for (const z of [0.22, -0.22]) {
    for (const side of [1, -1]) parts.push(part(box(0.004, 0.45, 0.07), PANEL, -0.15, side * 0.28, z * 1.3));
  }
  return build(parts);
}

/** ~10 km, in Earth radii. */
const DOCKED_RANGE = 0.0016;

const KIND_OF: Record<Category, Kind> = {
  station: 'station',
  starlink: 'starlink',
  navigation: 'navigation',
  oneweb: 'generic',
  earth: 'generic',
  other: 'generic',
};

/** On-screen size of a model in pixels at camera distance `d` (0 when out of range). */
export function modelPixels(d: number): number {
  if (d >= MODEL_RANGE) return 0;
  // 9/d px is a constant size in the world (~37 km: exaggerated, but real spacecraft would be
  // invisible), so models grow naturally as you approach. Never smaller than 14px, and they
  // fade in near the edge of range so they don't pop.
  const px = Math.max(9 / d, 14);
  const edge = 1 - THREE.MathUtils.smoothstep(d, MODEL_RANGE * 0.75, MODEL_RANGE);
  return px * edge;
}

export interface ModelSource {
  readonly positions: Float32Array;
  readonly velocities: Float64Array;
}

export type ModelDescription =
  | { source: 'nasa'; name: string; exact: boolean }
  | { source: 'procedural'; name: string };

const PROCEDURAL_NAMES: Record<Kind, string> = {
  station: 'ISS-style station',
  tiangong: 'Tiangong station',
  starlink: 'Starlink satellite',
  navigation: 'Navigation satellite',
  generic: 'Generic satellite',
};

export class ModelLayer {
  readonly meshes: Record<Kind, THREE.InstancedMesh>;
  private readonly nasa: NasaModelLayer;
  private kinds: Kind[] = [];
  private matches: (ModelMatch | null)[] = [];
  private scales: Float32Array = new Float32Array(0);
  private stations: number[] = [];
  private readonly near: { i: number; d2: number }[] = [];
  private readonly m = new THREE.Matrix4();
  private readonly r = new THREE.Vector3();
  private readonly t = new THREE.Vector3();
  private readonly n = new THREE.Vector3();
  private readonly p = new THREE.Vector3();
  private readonly s = new THREE.Vector3();
  private readonly q = new THREE.Quaternion();

  constructor(scene: THREE.Scene) {
    const material = new THREE.MeshStandardMaterial({ vertexColors: true, metalness: 0.35, roughness: 0.45 });
    const make = (g: THREE.BufferGeometry) => {
      const mesh = new THREE.InstancedMesh(g, material, MAX_INSTANCES);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.count = 0;
      scene.add(mesh);
      return mesh;
    };
    this.nasa = new NasaModelLayer(scene);
    this.meshes = {
      station: make(station()),
      tiangong: make(tiangong()),
      starlink: make(starlink()),
      navigation: make(navigation()),
      generic: make(genericSat()),
    };
  }

  get nasaModelsLoaded(): number {
    return this.nasa.loadedCount;
  }

  /** Decide once per satellite which model it gets. */
  setCatalog(sats: SatInfo[]) {
    this.kinds = sats.map((s) => (/^CSS \(/.test(s.name) ? 'tiangong' : KIND_OF[s.category]));
    this.matches = sats.map(matchModel);
    this.scales = Float32Array.from(this.kinds, (k) => KIND_SCALE[k]);
    this.stations = this.kinds.flatMap((k, i) => (k === 'station' || k === 'tiangong' ? [i] : []));
  }

  /** Docked ships and modules (Dragon, Progress, Poisk…) have their own catalogue entries; don't draw them inside the station. */
  private isDocked(i: number, positions: Float32Array): boolean {
    const j = i * 3;
    for (const s of this.stations) {
      const k = s * 3;
      const dx = positions[j] - positions[k], dy = positions[j + 1] - positions[k + 1], dz = positions[j + 2] - positions[k + 2];
      if (dx * dx + dy * dy + dz * dz < DOCKED_RANGE * DOCKED_RANGE) return true;
    }
    return false;
  }

  describe(index: number): ModelDescription {
    const m = this.matches[index];
    if (m) return { source: 'nasa', name: NASA_MODEL_NAMES[m.key], exact: m.exact };
    return { source: 'procedural', name: PROCEDURAL_NAMES[this.kinds[index]] };
  }

  /** On-screen size of satellite `index`'s model at camera distance `d`. */
  pixels(index: number, d: number): number {
    return modelPixels(d) * (this.scales[index] ?? 1);
  }

  update(src: ModelSource, camera: THREE.PerspectiveCamera, viewportHeight: number) {
    const cam = camera.position;
    const { positions, velocities } = src;
    const range2 = MODEL_RANGE * MODEL_RANGE;

    this.near.length = 0;
    for (let i = 0, j = 0; j < positions.length; i++, j += 3) {
      const x = positions[j], y = positions[j + 1], z = positions[j + 2];
      if (x === 0 && y === 0 && z === 0) continue;
      const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < range2) this.near.push({ i, d2 });
    }
    if (this.near.length > MAX_INSTANCES) {
      this.near.sort((a, b) => a.d2 - b.d2);
      this.near.length = MAX_INSTANCES;
    }

    for (const mesh of Object.values(this.meshes)) mesh.count = 0;
    this.nasa.begin();
    const pxToWorld = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / viewportHeight;

    for (const { i, d2 } of this.near) {
      const isStation = this.kinds[i] === 'station' || this.kinds[i] === 'tiangong';
      if (!isStation && this.isDocked(i, positions)) continue;
      const d = Math.sqrt(d2);
      const size = this.pixels(i, d) * pxToWorld * d;

      const j = i * 3;
      this.p.set(positions[j], positions[j + 1], positions[j + 2]);
      this.r.copy(this.p).normalize();
      this.t.set(velocities[j], velocities[j + 1], velocities[j + 2]);
      this.t.addScaledVector(this.r, -this.t.dot(this.r)).normalize();
      this.n.crossVectors(this.t, this.r);
      this.m.makeBasis(this.t, this.r, this.n);
      this.q.setFromRotationMatrix(this.m);
      this.m.compose(this.p, this.q, this.s.setScalar(size));

      const match = this.matches[i];
      if (match && this.nasa.place(match.key, this.m)) continue;
      const mesh = this.meshes[this.kinds[i]];
      mesh.setMatrixAt(mesh.count++, this.m);
    }
    for (const mesh of Object.values(this.meshes)) mesh.instanceMatrix.needsUpdate = true;
    this.nasa.end();
  }
}
