import * as THREE from 'three';
import { makeEarthMaterial } from './earthShader';

// Streams NASA GIBS imagery onto the globe as a quadtree of Web-Mercator tiles:
// Blue Marble Next Generation by day (~500 m/px at the deepest level) and VIIRS
// Black Marble city lights by night. Each update picks the set of tiles whose texels
// land at about one screen pixel, drops tiles over the horizon or off screen, and
// draws the nearest loaded ancestor while a tile is still downloading. The low-res
// base globe sits just underneath and covers the poles (Mercator stops at ±85°).

const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const dayUrl = (z: number, x: number, y: number) =>
  `${GIBS}/BlueMarble_NextGeneration/default/GoogleMapsCompatible_Level8/${z}/${y}/${x}.jpeg`;
const nightUrl = (z: number, x: number, y: number) =>
  `${GIBS}/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/${z}/${y}/${x}.png`;

const TILE_PX = 256;
const MIN_Z = 2;
const MAX_Z = 8;
const MAX_LEAVES = 160;
const MAX_CONCURRENT = 8;
const CACHE_LIMIT = 360;
/** Split a tile once one of its texels would cover more than this many screen pixels. */
const SPLIT_PX = 1.3;
const UPDATE_MS = 120;

interface Tile {
  key: string;
  z: number;
  x: number;
  y: number;
  center: THREE.Vector3; // unit vector, Earth-fixed frame
  angRadius: number; // radians from centre to farthest edge
  texelWorld: number; // texel width at the tile centre, in Earth radii
  state: 'idle' | 'loading' | 'ready' | 'failed';
  mesh: THREE.Mesh | null;
  lastUsed: number;
}

/** Earth-fixed unit vector, matching the base sphere's texture mapping (lon 0 on +X, north on +Y). */
export function latLonToVec(lat: number, lon: number, out = new THREE.Vector3()) {
  const cl = Math.cos(lat);
  return out.set(cl * Math.cos(lon), Math.sin(lat), -cl * Math.sin(lon));
}

/** Latitude and longitude (radians) of the point (u, v) ∈ [0, 1]² inside Web-Mercator tile z/x/y. */
export function tileLatLon(z: number, x: number, y: number, u: number, v: number): [number, number] {
  const n = 2 ** z;
  const lon = ((x + u) / n) * 2 * Math.PI - Math.PI;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + v)) / n)));
  return [lat, lon];
}

/**
 * A tile's centre on the unit sphere, the angle from the centre to its farthest edge (so a cone
 * of that angle contains the whole tile, which is what the horizon and frustum culling rely on),
 * and the width of one texel at the centre in Earth radii (which drives the split decision).
 */
export function tileBounds(z: number, x: number, y: number) {
  const [latC, lonC] = tileLatLon(z, x, y, 0.5, 0.5);
  const center = latLonToVec(latC, lonC);
  let angRadius = 0;
  const p = new THREE.Vector3();
  for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]]) {
    const [lat, lon] = tileLatLon(z, x, y, u, v);
    angRadius = Math.max(angRadius, center.angleTo(latLonToVec(lat, lon, p)));
  }
  const texelWorld = ((2 * Math.PI) / 2 ** z / TILE_PX) * Math.cos(latC);
  return { center, angRadius, texelWorld };
}

export class EarthTiles {
  private readonly group = new THREE.Group();
  private readonly tiles = new Map<string, Tile>();
  private readonly loader = new THREE.TextureLoader().setCrossOrigin('anonymous');
  private readonly black = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1);
  private readonly frustum = new THREE.Frustum();
  private readonly projView = new THREE.Matrix4();
  private readonly sphere = new THREE.Sphere();
  private readonly camLocal = new THREE.Vector3();
  private queue: Tile[] = [];
  /** Tiles downloaded since the counter was last reset (read by the data-link gauges). */
  received = 0;
  private active = 0;
  private lastUpdate = 0;

  private readonly earth: THREE.Object3D;
  private readonly sunDir: THREE.Vector3;
  private readonly anisotropy: number;

  constructor(earth: THREE.Object3D, sunDir: THREE.Vector3, anisotropy: number) {
    this.earth = earth;
    this.sunDir = sunDir;
    this.anisotropy = anisotropy;
    this.black.needsUpdate = true;
    earth.add(this.group);
  }

  update(camera: THREE.PerspectiveCamera, viewportHeight: number) {
    const now = performance.now();
    if (now - this.lastUpdate < UPDATE_MS) return;
    this.lastUpdate = now;

    this.earth.updateMatrixWorld();
    camera.updateMatrixWorld();
    this.camLocal.copy(camera.position);
    this.earth.worldToLocal(this.camLocal);
    const camDist = this.camLocal.length();
    const camDir = this.camLocal.clone().divideScalar(camDist);
    const horizon = Math.acos(Math.min(1, 1 / camDist));
    this.projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projView);
    const pxPerRadian = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));

    const visible = (t: Tile) => {
      if (t.center.angleTo(camDir) - t.angRadius > horizon + 0.02) return false;
      this.sphere.center.copy(t.center).applyMatrix4(this.earth.matrixWorld);
      this.sphere.radius = 2 * Math.sin(Math.min(t.angRadius, Math.PI / 2) / 2) + 0.01;
      return this.frustum.intersectsSphere(this.sphere);
    };
    const needsSplit = (t: Tile) => {
      const chord = 2 * Math.sin(t.angRadius / 2);
      const dist = Math.max(t.center.distanceTo(this.camLocal) - chord, 1e-4);
      return (t.texelWorld / dist) * pxPerRadian > SPLIT_PX;
    };

    // Breadth-first so coarse levels are settled before the leaf budget runs out.
    const leaves: Tile[] = [];
    const pending: Tile[] = [];
    const n0 = 2 ** MIN_Z;
    for (let x = 0; x < n0; x++) for (let y = 0; y < n0; y++) pending.push(this.tile(MIN_Z, x, y));
    while (pending.length) {
      const t = pending.shift()!;
      if (!visible(t)) continue;
      if (t.z < MAX_Z && needsSplit(t) && leaves.length + pending.length + 4 <= MAX_LEAVES) {
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) pending.push(this.tile(t.z + 1, t.x * 2 + dx, t.y * 2 + dy));
      } else {
        leaves.push(t);
      }
    }

    // Draw each leaf, or its nearest loaded ancestor, and never a tile under a drawn ancestor.
    const drawn = new Set<Tile>();
    const wanted: Tile[] = [];
    for (const leaf of leaves) {
      leaf.lastUsed = now;
      let d: Tile | null = leaf;
      while (d && d.state !== 'ready') {
        if (d.state === 'idle') wanted.push(d);
        d = this.parent(d);
      }
      if (d) drawn.add(d);
    }
    for (const t of drawn) {
      for (let p = this.parent(t); p; p = this.parent(p)) {
        if (drawn.has(p)) {
          drawn.delete(t);
          break;
        }
      }
    }
    for (const t of this.tiles.values()) {
      if (!t.mesh) continue;
      t.mesh.visible = drawn.has(t);
      if (t.mesh.visible) t.lastUsed = now;
    }

    // Coarse tiles first so something sharp appears quickly everywhere.
    this.queue = [...new Set(wanted)].sort((a, b) => a.z - b.z);
    this.pump();
    this.evict();
  }

  stats() {
    let visible = 0;
    let loading = 0;
    let maxZ = 0;
    for (const t of this.tiles.values()) {
      if (t.state === 'loading') loading++;
      if (t.mesh?.visible) {
        visible++;
        maxZ = Math.max(maxZ, t.z);
      }
    }
    return { visible, loading, queued: this.queue.length, cached: this.group.children.length, maxZ };
  }

  private tile(z: number, x: number, y: number): Tile {
    const key = `${z}/${x}/${y}`;
    let t = this.tiles.get(key);
    if (!t) {
      t = { key, z, x, y, ...tileBounds(z, x, y), state: 'idle', mesh: null, lastUsed: 0 };
      this.tiles.set(key, t);
    }
    return t;
  }

  private parent(t: Tile): Tile | null {
    return t.z > MIN_Z ? this.tile(t.z - 1, t.x >> 1, t.y >> 1) : null;
  }

  private pump() {
    while (this.active < MAX_CONCURRENT && this.queue.length) {
      const t = this.queue.shift()!;
      if (t.state !== 'idle') continue;
      t.state = 'loading';
      this.active++;
      Promise.all([this.load(dayUrl(t.z, t.x, t.y)), this.load(nightUrl(t.z, t.x, t.y)).catch(() => this.black)])
        .then(([day, night]) => {
          t.mesh = new THREE.Mesh(tileGeometry(t), makeEarthMaterial(day, night, this.sunDir));
          t.mesh.visible = false;
          this.group.add(t.mesh);
          t.state = 'ready';
          this.received++;
        })
        .catch(() => (t.state = 'failed'))
        .finally(() => {
          this.active--;
          this.lastUpdate = 0; // re-evaluate the draw set on the next frame
          this.pump();
        });
    }
  }

  private async load(url: string) {
    const tex = await this.loader.loadAsync(url);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = this.anisotropy;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    return tex;
  }

  private evict() {
    const loaded = [...this.tiles.values()].filter((t) => t.mesh && !t.mesh.visible);
    const excess = this.group.children.length - CACHE_LIMIT;
    if (excess <= 0) return;
    loaded.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const t of loaded.slice(0, excess)) {
      const mesh = t.mesh!;
      const mat = mesh.material as THREE.ShaderMaterial;
      mat.uniforms.dayMap.value.dispose();
      if (mat.uniforms.nightMap.value !== this.black) mat.uniforms.nightMap.value.dispose();
      mat.dispose();
      mesh.geometry.dispose();
      this.group.remove(mesh);
      t.mesh = null;
      t.state = 'idle';
    }
  }
}

function tileGeometry(t: Tile): THREE.BufferGeometry {
  // Coarse tiles span a lot of curvature, so give them more segments.
  const seg = t.z <= 3 ? 32 : 16;
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const p = new THREE.Vector3();
  for (let j = 0; j <= seg; j++) {
    for (let i = 0; i <= seg; i++) {
      const u = i / seg;
      const v = j / seg;
      const [lat, lon] = tileLatLon(t.z, t.x, t.y, u, v);
      latLonToVec(lat, lon, p);
      positions.push(p.x, p.y, p.z);
      normals.push(p.x, p.y, p.z);
      uvs.push(u, 1 - v);
    }
  }
  const index: number[] = [];
  for (let j = 0; j < seg; j++) {
    for (let i = 0; i < seg; i++) {
      const a = j * (seg + 1) + i;
      const b = a + seg + 1;
      index.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(index);
  g.computeBoundingSphere();
  return g;
}
