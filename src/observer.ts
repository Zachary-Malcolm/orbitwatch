import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { ecfToLookAngles, eciToEcf, gstime, jday, propagate, sunPos } from 'satellite.js';
import type { SatRec } from 'satellite.js';
import { PASSTHROUGH_ALPHA } from './scene';
import { isSunlit } from './satellites';
import { latLonToVec } from './earthTiles';

// The observer station: a place on the ground, and predictions of when satellites pass over it.

export interface Observer {
  latDeg: number;
  lonDeg: number;
  source: 'gps' | 'globe' | 'manual';
}

const STORAGE_KEY = 'orbitwatch.observer';
const AU_KM = 149_597_870.7;
const DEG = Math.PI / 180;

/** Passes whose highest point is lower than this are skipped: they skim the horizon behind terrain and haze. */
export const MIN_PASS_ELEVATION_DEG = 10;

// ---- Persistence (this browser only; never sent anywhere or put in shared links) ----

export function loadObserver(): Observer | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const o = raw ? (JSON.parse(raw) as Observer) : null;
    return o && Number.isFinite(o.latDeg) && Number.isFinite(o.lonDeg) ? o : null;
  } catch {
    return null;
  }
}

export function saveObserver(o: Observer | null) {
  try {
    if (o) localStorage.setItem(STORAGE_KEY, JSON.stringify(o));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage unavailable (private mode etc.): the station just won't be remembered.
  }
}

/** Ask the browser for the device's position. */
export function locate(): Promise<Observer> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation unsupported'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latDeg: p.coords.latitude, lonDeg: p.coords.longitude, source: 'gps' }),
      reject,
      { enableHighAccuracy: false, timeout: 15_000, maximumAge: 600_000 },
    );
  });
}

/** Parse "51.48, -0.001" or "51.48N 0.001W". */
export function parseLatLon(text: string): Observer | null {
  const m = text.trim().toUpperCase().match(/^(-?\d+(?:\.\d+)?)\s*°?\s*([NS])?[\s,]+(-?\d+(?:\.\d+)?)\s*°?\s*([EW])?$/);
  if (!m) return null;
  let lat = Number(m[1]);
  let lon = Number(m[3]);
  if (m[2] === 'S') lat = -Math.abs(lat);
  if (m[4] === 'W') lon = -Math.abs(lon);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { latDeg: lat, lonDeg: lon, source: 'manual' };
}

export function formatLatLon(o: Observer, digits = 2): string {
  return `${Math.abs(o.latDeg).toFixed(digits)}°${o.latDeg >= 0 ? 'N' : 'S'} ${Math.abs(o.lonDeg).toFixed(digits)}°${o.lonDeg >= 0 ? 'E' : 'W'}`;
}

// ---- Geometry ----

const geodetic = (o: Observer) => ({ latitude: o.latDeg * DEG, longitude: o.lonDeg * DEG, height: 0 });

export interface Look {
  azDeg: number;
  elDeg: number;
  rangeKm: number;
  sunlit: boolean;
}

/** Where the satellite appears in the observer's sky at `date`. */
export function lookAt(satrec: SatRec, o: Observer, date: Date): Look | null {
  const pv = propagate(satrec, date);
  if (!pv) return null;
  const look = ecfToLookAngles(geodetic(o), eciToEcf(pv.position, gstime(date)));
  return {
    azDeg: ((look.azimuth / DEG) % 360 + 360) % 360,
    elDeg: look.elevation / DEG,
    rangeKm: look.rangeSat,
    sunlit: isSunlit(pv.position, date),
  };
}

/** The Sun's elevation above the observer's horizon, in degrees. */
export function sunElevation(o: Observer, date: Date): number {
  const { rsun } = sunPos(jday(date));
  const sun = { x: rsun.x * AU_KM, y: rsun.y * AU_KM, z: rsun.z * AU_KM };
  return ecfToLookAngles(geodetic(o), eciToEcf(sun, gstime(date))).elevation / DEG;
}

export function skyCondition(sunEl: number): string {
  if (sunEl > 0) return 'DAYLIGHT';
  if (sunEl > -6) return 'CIVIL TWILIGHT';
  if (sunEl > -12) return 'NAUTICAL TWILIGHT';
  if (sunEl > -18) return 'ASTRO TWILIGHT';
  return 'NIGHT';
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
export const compass = (azDeg: number) => COMPASS[Math.round(azDeg / 22.5) % 16];

// ---- Pass prediction ----

export interface Pass {
  riseMs: number;
  riseAz: number;
  maxMs: number;
  maxEl: number;
  maxAz: number;
  setMs: number;
  setAz: number;
  /** Already above the horizon when the search started. */
  inProgress: boolean;
  /** Naked-eye visible for part of the pass: sunlit, dark sky, and over 10° up. */
  visible: boolean;
}

export type PassForecast =
  | { kind: 'passes'; passes: Pass[] }
  | { kind: 'always'; azDeg: number; elDeg: number }
  | { kind: 'never' };

/**
 * Find passes in [startMs, startMs + days] by stepping elevation in coarse steps, bisecting each
 * horizon crossing to the second, and golden-section searching for the highest point.
 */
export function predictPasses(satrec: SatRec, o: Observer, startMs: number, days = 3, maxPasses = 8): PassForecast {
  const el = (ms: number) => lookAt(satrec, o, new Date(ms))?.elDeg ?? -90;
  const periodMin = (2 * Math.PI) / satrec.no;

  // Geostationary and other slow orbits barely move in the sky: say where they are instead.
  if (periodMin > 600) {
    const samples = Array.from({ length: 25 }, (_, h) => el(startMs + h * 3_600_000));
    if (samples.every((e) => e > 0)) {
      const now = lookAt(satrec, o, new Date(startMs))!;
      return { kind: 'always', azDeg: now.azDeg, elDeg: now.elDeg };
    }
    if (samples.every((e) => e <= 0)) return { kind: 'never' };
  }

  const stepMs = THREE.MathUtils.clamp((periodMin * 60_000) / 180, 20_000, 600_000);
  const endMs = startMs + days * 86_400_000;
  const crossing = (lo: number, hi: number, rising: boolean) => {
    for (let i = 0; i < 14; i++) {
      const mid = (lo + hi) / 2;
      if (el(mid) > 0 === rising) hi = mid;
      else lo = mid;
    }
    return (lo + hi) / 2;
  };

  const passes: Pass[] = [];
  let prevMs = startMs;
  let prevEl = el(startMs);
  let riseMs: number | null = prevEl > 0 ? startMs : null;
  for (let t = startMs + stepMs; t <= endMs && passes.length < maxPasses; t += stepMs) {
    const e = el(t);
    if (riseMs === null && prevEl <= 0 && e > 0) riseMs = crossing(prevMs, t, true);
    else if (riseMs !== null && prevEl > 0 && e <= 0) {
      const setMs = crossing(prevMs, t, false);
      const pass = describePass(satrec, o, riseMs, setMs, riseMs === startMs);
      if (pass.maxEl >= MIN_PASS_ELEVATION_DEG) passes.push(pass);
      riseMs = null;
    }
    prevMs = t;
    prevEl = e;
  }
  return { kind: 'passes', passes };
}

function describePass(satrec: SatRec, o: Observer, riseMs: number, setMs: number, inProgress: boolean): Pass {
  const at = (ms: number) => lookAt(satrec, o, new Date(ms))!;
  // Highest point: golden-section search (elevation rises then falls during a pass).
  const g = (Math.sqrt(5) - 1) / 2;
  let lo = riseMs;
  let hi = setMs;
  for (let i = 0; i < 30 && hi - lo > 500; i++) {
    const m1 = hi - g * (hi - lo);
    const m2 = lo + g * (hi - lo);
    if (at(m1).elDeg < at(m2).elDeg) lo = m1;
    else hi = m2;
  }
  const maxMs = (lo + hi) / 2;
  const top = at(maxMs);

  // Naked-eye visibility: sample the pass every 10 s.
  let visible = false;
  for (let t = riseMs; t <= setMs && !visible; t += 10_000) {
    const look = at(t);
    visible = look.elDeg > MIN_PASS_ELEVATION_DEG && look.sunlit && sunElevation(o, new Date(t)) < -6;
  }
  return {
    riseMs,
    riseAz: at(riseMs).azDeg,
    maxMs,
    maxEl: top.elDeg,
    maxAz: top.azDeg,
    setMs,
    setAz: at(setMs).azDeg,
    inProgress,
    visible,
  };
}

// ---- Globe marker and line of sight ----

/** A crosshair ring on the ground at the observer, and a beam to the target while it's above the horizon. */
export class ObserverMarker {
  private readonly marker = new THREE.Group();
  private readonly beam: Line2;
  private readonly materials: LineMaterial[] = [];
  private readonly earth: THREE.Object3D;
  private readonly world = new THREE.Vector3();
  private readonly normal = new THREE.Vector3();

  constructor(scene: THREE.Scene, earth: THREE.Object3D) {
    this.earth = earth;
    const material = (width: number, dashed: boolean) => {
      const m = new LineMaterial({
        color: '#ffffff',
        linewidth: width,
        transparent: true,
        opacity: PASSTHROUGH_ALPHA,
        blending: THREE.NoBlending,
        dashed,
        dashSize: 0.01,
        gapSize: 0.008,
      });
      this.materials.push(m);
      return m;
    };
    const line = (points: number[], m: LineMaterial) => {
      const g = new LineGeometry();
      g.setPositions(points);
      const l = new Line2(g, m);
      l.computeLineDistances();
      l.frustumCulled = false;
      l.renderOrder = 7;
      return l;
    };

    // Drawn in the XY plane (unit radius) and turned to face out of the ground at the station.
    const ring: number[] = [];
    for (let k = 0; k <= 48; k++) {
      const a = (k / 48) * Math.PI * 2;
      ring.push(Math.cos(a), Math.sin(a), 0);
    }
    const solid = material(2, false);
    this.marker.add(line(ring, solid));
    for (const [x, y] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) this.marker.add(line([x * 0.45, y * 0.45, 0, x * 1.6, y * 1.6, 0], solid));
    this.marker.visible = false;
    earth.add(this.marker);

    this.beam = line([0, 0, 0, 0, 0, 1], material(1.5, true));
    this.beam.visible = false;
    scene.add(this.beam);
  }

  setObserver(o: Observer | null) {
    this.marker.visible = o !== null;
    if (!o) {
      this.beam.visible = false;
      return;
    }
    latLonToVec(o.latDeg * DEG, o.lonDeg * DEG, this.normal);
    this.marker.position.copy(this.normal).multiplyScalar(1.002);
    this.marker.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.normal);
  }

  /** Observer position in scene (inertial) coordinates, on the unit sphere. */
  worldPosition(out: THREE.Vector3): THREE.Vector3 {
    this.earth.updateMatrixWorld();
    return out.copy(this.normal).applyMatrix4(this.earth.matrixWorld);
  }

  update(camera: THREE.Camera, viewport: { width: number; height: number }, target: THREE.Vector3 | null) {
    for (const m of this.materials) m.resolution.set(viewport.width, viewport.height);
    if (!this.marker.visible) return;
    const obs = this.worldPosition(this.world);
    // Keep the marker a readable size on screen at any zoom (roughly 14 px radius).
    this.marker.scale.setScalar(THREE.MathUtils.clamp(camera.position.distanceTo(obs) * 0.012, 0.0015, 0.05));

    // Line of sight while the target is above this horizon: (target − station) · up > 0.
    const up = obs.clone().normalize();
    const visible = target !== null && target.lengthSq() > 0 && target.clone().sub(obs).dot(up) > 0;
    this.beam.visible = visible;
    if (visible) {
      (this.beam.geometry as LineGeometry).setPositions([obs.x, obs.y, obs.z, target.x, target.y, target.z]);
      this.beam.computeLineDistances();
    }
  }
}
