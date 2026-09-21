import * as THREE from 'three';
import { eciToGeodetic, degreesLat, degreesLong, gstime, jday, propagate, sunPos } from 'satellite.js';
import type { Category, SatInfo } from './tle';
import type { ModelSource } from './models';
import { EARTH_RADIUS_KM, eciToScene, PASSTHROUGH_ALPHA, type VisualMode } from './scene';

/**
 * One retro-CRT palette for both visual modes, chosen to contrast with the amber Earth
 * (none of the hues is close to amber, and red is reserved for the locked target).
 * Glyph shapes give a second cue, so categories stay distinguishable for colour-blind viewers.
 */
export const CATEGORIES: Record<Category, { label: string; color: string; glyph: string; shape: number; size: number }> = {
  station: { label: 'Space stations', color: '#ffffff', glyph: '□', shape: 1, size: 9 },
  starlink: { label: 'Starlink', color: '#3fd0ff', glyph: '·', shape: 0, size: 3 },
  oneweb: { label: 'OneWeb', color: '#c77dff', glyph: '◆', shape: 4, size: 5 },
  navigation: { label: 'Navigation (GPS, Galileo…)', color: '#39ff14', glyph: '✚', shape: 2, size: 7 },
  earth: { label: 'Earth observation & weather', color: '#ff5fa2', glyph: '▲', shape: 3, size: 6 },
  other: { label: 'Other', color: '#8fa3b8', glyph: '○', shape: 5, size: 5 },
};

const glyphVertex = /* glsl */ `
  attribute vec3 aColor;
  attribute float aShape;
  attribute float aSize;
  uniform float pixelRatio;
  varying vec3 vColor;
  varying float vShape;
  void main() {
    vColor = aColor;
    vShape = aShape;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    // Enlarged to make room for the dark outline drawn around each glyph.
    gl_PointSize = (aSize * 1.35 + 1.0) * pixelRatio;
  }
`;

// 0 dot, 1 hollow square, 2 plus, 3 triangle, 4 diamond, 5 ring.
// Each glyph gets a dark outline so it reads against a bright Earth as well as black space.
const glyphFragment = /* glsl */ `
  varying vec3 vColor;
  varying float vShape;

  bool glyph(vec2 p) {
    float box = max(abs(p.x), abs(p.y));
    float r = length(p);
    if (vShape < 0.5) return r < 1.0;
    if (vShape < 1.5) return box < 1.0 && box > 0.6;
    if (vShape < 2.5) return min(abs(p.x), abs(p.y)) < 0.28 && box < 1.0;
    if (vShape < 3.5) return p.y > -0.8 && abs(p.x) < (0.8 - p.y) * 0.62;
    if (vShape < 4.5) return abs(p.x) + abs(p.y) < 1.0;
    return r < 1.0 && r > 0.55;
  }

  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    p.y = -p.y;
    vec3 color;
    if (glyph(p * 1.35)) color = vColor;
    else if (glyph(p * 1.02) || glyph(p * 1.35 * vec2(0.8, 1.0)) || glyph(p * 1.35 * vec2(1.0, 0.8))) color = vec3(0.0025, 0.0035, 0.004);
    else discard;
    gl_FragColor = vec4(color, ${PASSTHROUGH_ALPHA.toFixed(2)});
    #include <colorspace_fragment>
  }
`;

const MU = 398600.4418; // km^3 / s^2
// Time spent per frame running full SGP4. Everything in between is extrapolated.
const PROPAGATION_BUDGET_MS = 4;

export interface SatDetails {
  latitude: number;
  longitude: number;
  altitudeKm: number;
  speedKms: number;
  periodMin: number;
  inclinationDeg: number;
  eccentricity: number;
  apogeeKm: number;
  perigeeKm: number;
  regime: string;
  tleAgeDays: number;
  sunlit: boolean;
  /** Fraction of the way from perigee round to the next perigee (mean anomaly / 2π). */
  orbitPhase: number;
}

/**
 * Renders every satellite as a point. Running SGP4 for ~12k satellites every frame
 * is too slow, so each frame re-propagates a time-boxed slice of them (round robin)
 * and moves the rest with a second-order Taylor step (position, velocity and
 * two-body gravity) from their last exact fix. The error stays well under a
 * kilometre at real-time speed.
 */
export class SatelliteLayer implements ModelSource {
  readonly points: THREE.Points;
  readonly hidden = new Set<Category>();
  selected = -1;

  private readonly n: number;
  private readonly p0: Float64Array;
  /** Velocity at each satellite's last exact fix, in scene units per second. */
  readonly velocities: Float64Array;
  private readonly a0: Float64Array;
  private readonly t0: Float64Array;
  private readonly valid: Uint8Array;
  readonly positions: Float32Array;
  private readonly positionAttr: THREE.BufferAttribute;
  private readonly colorAttr: THREE.BufferAttribute;
  private visualMode: VisualMode = 'phosphor';
  /** Full SGP4 runs since the counter was last reset (read by the performance gauges). */
  propagated = 0;
  private cursor = 0;
  private primed = false;

  readonly marker: THREE.Sprite;
  private readonly orbitLine: THREE.Line;
  private readonly nadirLine: THREE.Line;
  private orbitComputedAt = 0;

  private readonly tmp = new THREE.Vector3();

  readonly sats: SatInfo[];

  constructor(sats: SatInfo[], scene: THREE.Scene) {
    this.sats = sats;
    this.n = sats.length;
    this.p0 = new Float64Array(this.n * 3);
    this.velocities = new Float64Array(this.n * 3);
    this.a0 = new Float64Array(this.n * 3);
    this.t0 = new Float64Array(this.n);
    this.valid = new Uint8Array(this.n);
    this.positions = new Float32Array(this.n * 3);

    const geometry = new THREE.BufferGeometry();
    this.positionAttr = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    const meta = sats.map((s) => CATEGORIES[s.category]);
    const c = new THREE.Color();
    this.colorAttr = new THREE.BufferAttribute(new Float32Array(this.n * 3), 3);
    meta.forEach((m, i) => {
      c.set(m.color);
      this.colorAttr.setXYZ(i, c.r, c.g, c.b);
    });
    geometry.setAttribute('position', this.positionAttr);
    geometry.setAttribute('aColor', this.colorAttr);
    geometry.setAttribute('aShape', new THREE.BufferAttribute(Float32Array.from(meta, (m) => m.shape), 1));
    geometry.setAttribute('aSize', new THREE.BufferAttribute(Float32Array.from(meta, (m) => m.size), 1));
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1000);

    this.points = new THREE.Points(
      geometry,
      new THREE.ShaderMaterial({
        uniforms: { pixelRatio: { value: Math.min(window.devicePixelRatio, 2) } },
        vertexShader: glyphVertex,
        fragmentShader: glyphFragment,
        // Drawn in the transparent pass, after the Earth tiles and the atmosphere, and writing depth,
        // so nothing on the near side of the globe can paint over them. No blending, so the
        // pass-through alpha marker reaches the phosphor pass exactly.
        transparent: true,
        blending: THREE.NoBlending,
      }),
    );
    this.points.renderOrder = 5;
    scene.add(this.points);

    this.marker = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: ringTexture(), sizeAttenuation: false, depthTest: false, transparent: true }),
    );
    this.marker.scale.setScalar(0.045);
    this.marker.visible = false;
    this.marker.renderOrder = 10;
    scene.add(this.marker);

    this.orbitLine = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ transparent: true, opacity: 0.75 }),
    );
    this.orbitLine.visible = false;
    scene.add(this.orbitLine);

    // Dashed drop line from the selected satellite to the point on the ground directly below it.
    this.nadirLine = new THREE.Line(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3)),
      new THREE.LineDashedMaterial({ dashSize: 0.008, gapSize: 0.006, transparent: true, opacity: 0.8 }),
    );
    this.nadirLine.visible = false;
    this.nadirLine.frustumCulled = false;
    scene.add(this.nadirLine);
  }

  /** Glyph colours are the same in both modes; only the target lines change (red in phosphor mode). */
  setVisualMode(mode: VisualMode) {
    this.visualMode = mode;
    this.applyLineColors();
  }

  private applyLineColors() {
    if (this.selected < 0) return;
    const color = this.visualMode === 'phosphor' ? '#ff3333' : CATEGORIES[this.sats[this.selected].category].color;
    (this.orbitLine.material as THREE.LineBasicMaterial).color.set(color);
    (this.nadirLine.material as THREE.LineDashedMaterial).color.set(color);
  }

  /** Orbit regime counts for the census display. */
  regimeCounts(): Record<Regime, number> {
    const counts: Record<Regime, number> = { LEO: 0, MEO: 0, GEO: 0, HEO: 0 };
    for (const { satrec } of this.sats) {
      const periodMin = (2 * Math.PI) / satrec.no;
      const perigee = (1 - satrec.ecco) * semiMajorAxisKm(periodMin) - EARTH_RADIUS_KM;
      counts[regimeCode(periodMin, satrec.ecco, perigee)]++;
    }
    return counts;
  }

  /** How many shown satellites are sunlit, and how many are on screen and not behind the Earth. */
  liveCounts(camera: THREE.Camera, sunDir: THREE.Vector3): { sunlit: number; shown: number; inView: number } {
    let sunlit = 0;
    let shown = 0;
    let inView = 0;
    const cam = camera.position;
    const camLen2 = cam.lengthSq();
    const v = this.tmp;
    for (let j = 0; j < this.positions.length; j += 3) {
      const x = this.positions[j], y = this.positions[j + 1], z = this.positions[j + 2];
      if (x === 0 && y === 0 && z === 0) continue;
      shown++;
      const along = x * sunDir.x + y * sunDir.y + z * sunDir.z;
      if (along > 0 || x * x + y * y + z * z - along * along > 1) sunlit++;
      v.set(x, y, z).project(camera);
      if (v.z > 1 || Math.abs(v.x) > 1 || Math.abs(v.y) > 1) continue;
      const dx = x - cam.x, dy = y - cam.y, dz = z - cam.z;
      const a = dx * dx + dy * dy + dz * dz;
      const b = cam.x * dx + cam.y * dy + cam.z * dz;
      const disc = b * b - a * (camLen2 - 1);
      if (disc > 0) {
        const t = (-b - Math.sqrt(disc)) / a;
        if (t > 0 && t < 1) continue;
      }
      inView++;
    }
    return { sunlit, shown, inView };
  }

  update(simMs: number) {
    const date = new Date(simMs);

    // First frame: propagate everything once so no satellite starts at the origin.
    const budget = this.primed ? PROPAGATION_BUDGET_MS : Infinity;
    this.primed = true;
    const start = performance.now();
    let done = 0;
    while (done < this.n && performance.now() - start < budget) {
      for (let k = 0; k < 64 && done < this.n; k++, done++) {
        this.refresh(this.cursor, date, simMs);
        this.cursor = (this.cursor + 1) % this.n;
      }
    }

    const { p0, velocities: v0, a0, t0, valid, positions } = this;
    for (let i = 0; i < this.n; i++) {
      const j = i * 3;
      if (!valid[i] || this.hidden.has(this.sats[i].category)) {
        // Parked at the Earth's centre, where the globe hides it.
        positions[j] = positions[j + 1] = positions[j + 2] = 0;
        continue;
      }
      const dt = (simMs - t0[i]) / 1000;
      const h = 0.5 * dt * dt;
      positions[j] = p0[j] + v0[j] * dt + a0[j] * h;
      positions[j + 1] = p0[j + 1] + v0[j + 1] * dt + a0[j + 1] * h;
      positions[j + 2] = p0[j + 2] + v0[j + 2] * dt + a0[j + 2] * h;
    }
    this.positionAttr.needsUpdate = true;

    const sel = this.selected;
    if (sel >= 0 && valid[sel] && !this.hidden.has(this.sats[sel].category)) {
      this.marker.position.fromArray(positions, sel * 3);
      this.marker.visible = this.orbitLine.visible = this.nadirLine.visible = true;
      const line = this.nadirLine.geometry.attributes.position as THREE.BufferAttribute;
      const ground = this.tmp.copy(this.marker.position).normalize();
      line.setXYZ(0, this.marker.position.x, this.marker.position.y, this.marker.position.z);
      line.setXYZ(1, ground.x, ground.y, ground.z);
      line.needsUpdate = true;
      this.nadirLine.computeLineDistances();
      if (Math.abs(simMs - this.orbitComputedAt) > 20_000) this.computeOrbit(simMs);
    } else {
      this.marker.visible = this.orbitLine.visible = this.nadirLine.visible = false;
    }
  }

  select(index: number, simMs: number) {
    this.selected = index;
    if (index >= 0) {
      this.applyLineColors();
      this.computeOrbit(simMs);
    }
  }

  positionOf(index: number, out: THREE.Vector3): THREE.Vector3 {
    return out.fromArray(this.positions, index * 3);
  }

  /** Nearest visible satellite within `radiusPx` of a screen point, or -1. */
  pick(px: number, py: number, camera: THREE.Camera, width: number, height: number, radiusPx = 10): number {
    const cam = camera.position;
    const camLen2 = cam.lengthSq();
    let best = -1;
    let bestD2 = radiusPx * radiusPx;
    const v = this.tmp;
    for (let i = 0; i < this.n; i++) {
      const j = i * 3;
      const x = this.positions[j], y = this.positions[j + 1], z = this.positions[j + 2];
      if (x === 0 && y === 0 && z === 0) continue;
      v.set(x, y, z).project(camera);
      if (v.z > 1) continue;
      const dx = (v.x * 0.5 + 0.5) * width - px;
      const dy = (-v.y * 0.5 + 0.5) * height - py;
      const d2 = dx * dx + dy * dy;
      if (d2 >= bestD2) continue;
      // Skip satellites hidden behind the globe (does the camera->sat segment hit the unit sphere?).
      const ddx = x - cam.x, ddy = y - cam.y, ddz = z - cam.z;
      const a = ddx * ddx + ddy * ddy + ddz * ddz;
      const b = cam.x * ddx + cam.y * ddy + cam.z * ddz;
      const disc = b * b - a * (camLen2 - 1);
      if (disc > 0) {
        const t = (-b - Math.sqrt(disc)) / a;
        if (t > 0 && t < 1) continue;
      }
      best = i;
      bestD2 = d2;
    }
    return best;
  }

  details(index: number, simMs: number): SatDetails | null {
    const { satrec } = this.sats[index];
    const date = new Date(simMs);
    const pv = propagate(satrec, date);
    if (!pv) return null;
    const geo = eciToGeodetic(pv.position, gstime(date));
    const { x, y, z } = pv.velocity;
    const periodMin = (2 * Math.PI) / satrec.no;
    const a = semiMajorAxisKm(periodMin);
    const perigee = (1 - satrec.ecco) * a - EARTH_RADIUS_KM;
    return {
      latitude: degreesLat(geo.latitude),
      longitude: degreesLong(geo.longitude),
      altitudeKm: geo.height,
      speedKms: Math.hypot(x, y, z),
      periodMin,
      inclinationDeg: (satrec.inclo * 180) / Math.PI,
      eccentricity: satrec.ecco,
      apogeeKm: (1 + satrec.ecco) * a - EARTH_RADIUS_KM,
      perigeeKm: perigee,
      regime: orbitRegime(periodMin, satrec.ecco, perigee),
      tleAgeDays: jday(new Date()) - satrec.jdsatepoch,
      sunlit: isSunlit(pv.position, date),
      orbitPhase: (((pv.meanElements.mm / (2 * Math.PI)) % 1) + 1) % 1,
    };
  }

  counts(): Record<Category, number> {
    const counts = Object.fromEntries(Object.keys(CATEGORIES).map((k) => [k, 0])) as Record<Category, number>;
    for (const s of this.sats) counts[s.category]++;
    return counts;
  }

  private refresh(i: number, date: Date, simMs: number) {
    const pv = propagate(this.sats[i].satrec, date);
    this.propagated++;
    if (!pv) {
      this.valid[i] = 0;
      return;
    }
    const { position: p, velocity: v } = pv;
    const j = i * 3;
    const r = Math.hypot(p.x, p.y, p.z);
    const g = -MU / (r * r * r);
    // Store in scene axes (x, z, -y), scaled to Earth radii.
    const s = 1 / EARTH_RADIUS_KM;
    this.p0[j] = p.x * s; this.p0[j + 1] = p.z * s; this.p0[j + 2] = -p.y * s;
    this.velocities[j] = v.x * s; this.velocities[j + 1] = v.z * s; this.velocities[j + 2] = -v.y * s;
    this.a0[j] = g * p.x * s; this.a0[j + 1] = g * p.z * s; this.a0[j + 2] = -g * p.y * s;
    this.t0[i] = simMs;
    this.valid[i] = 1;
  }

  private computeOrbit(simMs: number) {
    const { satrec } = this.sats[this.selected];
    const periodMs = ((2 * Math.PI) / satrec.no) * 60_000;
    const steps = 256;
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= steps; k++) {
      const pv = propagate(satrec, new Date(simMs + (k / steps) * periodMs));
      if (pv) pts.push(eciToScene(pv.position.x, pv.position.y, pv.position.z, new THREE.Vector3()));
    }
    this.orbitLine.geometry.dispose();
    this.orbitLine.geometry = new THREE.BufferGeometry().setFromPoints(pts);
    this.orbitComputedAt = simMs;
  }
}

/** Cylindrical Earth-shadow model: in shadow if behind the Earth and within one radius of the sun line. */
function isSunlit(p: { x: number; y: number; z: number }, date: Date): boolean {
  const { rsun } = sunPos(jday(date));
  const len = Math.hypot(rsun.x, rsun.y, rsun.z);
  const along = (p.x * rsun.x + p.y * rsun.y + p.z * rsun.z) / len;
  if (along > 0) return true;
  const perp2 = p.x * p.x + p.y * p.y + p.z * p.z - along * along;
  return perp2 > EARTH_RADIUS_KM * EARTH_RADIUS_KM;
}

function semiMajorAxisKm(periodMin: number): number {
  const t = periodMin * 60;
  return Math.cbrt((MU * t * t) / (4 * Math.PI * Math.PI));
}

export type Regime = 'LEO' | 'MEO' | 'GEO' | 'HEO';

const REGIME_LABELS: Record<Regime, string> = {
  HEO: 'Highly elliptical (HEO)',
  GEO: 'Geosynchronous (GEO)',
  LEO: 'Low Earth orbit (LEO)',
  MEO: 'Medium Earth orbit (MEO)',
};

function regimeCode(periodMin: number, ecc: number, perigeeKm: number): Regime {
  if (ecc > 0.25) return 'HEO';
  if (Math.abs(periodMin - 1436) < 30) return 'GEO';
  if (perigeeKm < 2000) return 'LEO';
  return 'MEO';
}

function orbitRegime(periodMin: number, ecc: number, perigeeKm: number): string {
  return REGIME_LABELS[regimeCode(periodMin, ecc, perigeeKm)];
}

function ringTexture(): THREE.Texture {
  // HUD-style targeting reticle: four corner brackets.
  const size = 128;
  const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
  const ctx = canvas.getContext('2d')!;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 5;
  const m = 4, l = 26;
  for (const [x, y, dx, dy] of [[m, m, 1, 1], [size - m, m, -1, 1], [m, size - m, 1, -1], [size - m, size - m, -1, -1]]) {
    ctx.beginPath();
    ctx.moveTo(x, y + dy * l);
    ctx.lineTo(x, y);
    ctx.lineTo(x + dx * l, y);
    ctx.stroke();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
