import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { SatInfo } from './tle';
import { log } from './telemetry';

// Spacecraft models from NASA's 3D Resources collection (github.com/nasa/NASA-3D-Resources),
// compressed with glTF-Transform (meshopt geometry, WebP textures) into public/models.
// A model is either exact (the actual spacecraft) or representative (a close relative,
// such as the Landsat 8 model standing in for its near-identical successor Landsat 9).

export const NASA_MODEL_NAMES = {
  iss: 'International Space Station',
  hubble: 'Hubble Space Telescope',
  aqua: 'Aqua',
  aura: 'Aura',
  chandra: 'Chandra X-ray Observatory',
  cubesat: 'Generic CubeSat',
  cygnss: 'CYGNSS',
  fermi: 'Fermi Gamma-ray Space Telescope',
  goes: 'GOES weather satellite',
  gpm: 'Global Precipitation Measurement',
  grace: 'GRACE',
  hinode: 'Hinode (Solar-B)',
  icesat2: 'ICESat-2',
  jason: 'OSTM / Jason-2',
  landsat8: 'Landsat 8',
  mms: 'Magnetospheric Multiscale',
  npp: 'Suomi NPP',
  oco2: 'Orbiting Carbon Observatory-2',
  sdo: 'Solar Dynamics Observatory',
  sentinel6: 'Sentinel-6 Michael Freilich',
  ssl1300: 'SSL-1300 geostationary satellite bus',
  swift: 'Swift Observatory',
  tdrs: 'Tracking and Data Relay Satellite',
  tess: 'TESS',
  themis: 'THEMIS',
} as const;

export type NasaModelKey = keyof typeof NASA_MODEL_NAMES;

export interface ModelMatch {
  key: NasaModelKey;
  exact: boolean;
}

const BY_NORAD: Record<string, NasaModelKey> = {
  '20580': 'hubble',
  '27424': 'aqua',
  '28376': 'aura',
  '25867': 'chandra',
  '33053': 'fermi',
  '39574': 'gpm',
  '29479': 'hinode',
  '43613': 'icesat2',
  '39084': 'landsat8',
  '37849': 'npp',
  '40059': 'oco2',
  '36395': 'sdo',
  '28485': 'swift',
  '43435': 'tess',
};

const BY_NAME: [RegExp, NasaModelKey, boolean][] = [
  [/^ISS \(/, 'iss', true],
  [/^SENTINEL-6/, 'sentinel6', true],
  [/^MMS \d/, 'mms', true],
  [/^THEMIS/, 'themis', true],
  [/^CYGFM/, 'cygnss', true],
  [/^TDRS [3-7]$/, 'tdrs', true],
  [/^TDRS/, 'tdrs', false], // later TDRS generations use a different bus
  [/^GOES \d/, 'goes', false], // the NASA model is an earlier GOES generation
  [/^GRACE-FO/, 'grace', false],
  [/^JASON-3/, 'jason', false],
  [/^LANDSAT 9/, 'landsat8', false],
  [/^NOAA 2[01]/, 'npp', false], // JPSS satellites share Suomi NPP's Ball bus
  [/CUBESAT|^FLOCK|^LEMUR|^DOVE/, 'cubesat', false],
];

export function matchModel(sat: SatInfo): ModelMatch | null {
  const key = BY_NORAD[sat.noradId];
  if (key) return { key, exact: true };
  for (const [re, k, exact] of BY_NAME) if (re.test(sat.name)) return { key: k, exact };
  // Geostationary communications satellites: a typical commercial GEO bus.
  const periodMin = (2 * Math.PI) / sat.satrec.no;
  if (sat.category === 'other' && Math.abs(periodMin - 1436) < 30 && sat.satrec.ecco < 0.05) {
    return { key: 'ssl1300', exact: false };
  }
  return null;
}

/**
 * Loads NASA models on first use and hands out clones positioned by a matrix.
 * Each template is centred and scaled so its longest side is 1, matching the
 * procedural models, so the same on-screen sizing applies to both.
 */
export class NasaModelLayer {
  private readonly loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  private readonly templates = new Map<NasaModelKey, THREE.Object3D | 'loading' | 'failed'>();
  private readonly pools = new Map<NasaModelKey, THREE.Object3D[]>();
  private readonly used = new Map<NasaModelKey, number>();
  private readonly scene: THREE.Scene;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  begin() {
    this.used.clear();
  }

  /** Place a model; returns false while it is still loading (draw a placeholder instead). */
  place(key: NasaModelKey, matrix: THREE.Matrix4): boolean {
    const template = this.templates.get(key);
    if (!template) {
      this.load(key);
      return false;
    }
    if (template === 'loading' || template === 'failed') return false;

    let pool = this.pools.get(key);
    if (!pool) this.pools.set(key, (pool = []));
    const i = this.used.get(key) ?? 0;
    if (i === pool.length) {
      const clone = template.clone();
      clone.matrixAutoUpdate = false;
      this.scene.add(clone);
      pool.push(clone);
    }
    const obj = pool[i];
    obj.matrix.copy(matrix);
    obj.matrixWorldNeedsUpdate = true;
    obj.visible = true;
    this.used.set(key, i + 1);
    return true;
  }

  end() {
    for (const [key, pool] of this.pools) {
      const used = this.used.get(key) ?? 0;
      for (let i = used; i < pool.length; i++) pool[i].visible = false;
    }
  }

  get loadedCount(): number {
    return [...this.templates.values()].filter((t) => typeof t === 'object').length;
  }

  private load(key: NasaModelKey) {
    this.templates.set(key, 'loading');
    const t0 = performance.now();
    this.loader.load(
      `${import.meta.env.BASE_URL}models/${key}.glb`,
      (gltf) => {
        const inner = gltf.scene;
        const box = new THREE.Box3().setFromObject(inner);
        const size = box.getSize(new THREE.Vector3());
        const k = 1 / Math.max(size.x, size.y, size.z);
        inner.scale.setScalar(k);
        inner.position.copy(box.getCenter(new THREE.Vector3())).multiplyScalar(-k);
        const pivot = new THREE.Group();
        pivot.add(inner);
        this.templates.set(key, pivot);
        log('NASA-3D', `${key.toUpperCase()}.GLB ONLINE (${Math.round(performance.now() - t0)} MS)`, 'ok');
      },
      undefined,
      () => {
        this.templates.set(key, 'failed');
        log('NASA-3D', `${key.toUpperCase()}.GLB FAILED TO LOAD`, 'warn');
      },
    );
  }
}
