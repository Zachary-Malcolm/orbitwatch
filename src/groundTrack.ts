import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { gstime, propagate } from 'satellite.js';
import type { SatRec } from 'satellite.js';
import { EARTH_RADIUS_KM, PASSTHROUGH_ALPHA, eciToScene } from './scene';

// Ground track and coverage footprint for the selected satellite, drawn on the Earth's surface.
//
// Everything here lives in the Earth mesh's own (Earth-fixed) frame, so it turns with the planet.
// A track point at time t is the satellite's inertial position rotated back by Greenwich sidereal
// time at t, then projected straight down onto the surface: that is what makes each orbit's track
// land further west as the Earth turns underneath it.
//
// The lines use the phosphor pass-through alpha with no blending, so they keep the target's
// category colour in phosphor mode.

/** Lift above the imagery tiles so the lines never sink into the terrain texture. */
const SURFACE = 1.0015;
/** Minimum elevation for the inner "usable coverage" ring (typical for radio links). */
const MIN_ELEVATION_DEG = 10;
const RING_POINTS = 160;

export interface Coverage {
  /** Ground distance from the sub-satellite point to the edge of the 0° footprint, km. */
  horizonRadiusKm: number;
  /** Share of the Earth's surface that can see the satellite above the horizon. */
  earthFraction: number;
}

export class GroundTrack {
  readonly group = new THREE.Group();
  showTrack = true;
  showFootprint = true;

  private satrec: SatRec | null = null;
  private computedAt = -Infinity;
  private footprintAt = 0;
  private coverage: Coverage | null = null;
  private stepMs = 30_000;
  private readonly future: Line2;
  private readonly past: Line2;
  private readonly horizonRing: Line2;
  private readonly elevationRing: Line2;
  private readonly materials: LineMaterial[] = [];
  private readonly earth: THREE.Object3D;
  private readonly local = new THREE.Vector3();
  private readonly u = new THREE.Vector3();
  private readonly v = new THREE.Vector3();

  constructor(earth: THREE.Object3D) {
    this.earth = earth;
    const make = (width: number, dashed: boolean) => {
      const material = new LineMaterial({
        linewidth: width,
        transparent: true,
        opacity: PASSTHROUGH_ALPHA,
        blending: THREE.NoBlending,
        dashed,
        dashSize: 0.012,
        gapSize: 0.01,
      });
      this.materials.push(material);
      const line = new Line2(new LineGeometry(), material);
      line.frustumCulled = false;
      line.renderOrder = 6;
      this.group.add(line);
      return line;
    };
    this.future = make(2.2, false);
    this.past = make(1.4, true);
    this.horizonRing = make(1.6, false);
    this.elevationRing = make(1.2, true);
    this.group.visible = false;
    earth.add(this.group);
  }

  /** Follow a satellite (null hides everything), drawn in `color`. */
  setTarget(satrec: SatRec | null, color = '#ffffff') {
    this.satrec = satrec;
    this.computedAt = -Infinity;
    this.footprintAt = 0;
    this.group.visible = satrec !== null;
    if (!satrec) return;
    const c = new THREE.Color(color);
    const [future, past, horizon, elevation] = this.materials;
    future.color.copy(c);
    past.color.copy(c).multiplyScalar(0.55);
    horizon.color.copy(c);
    elevation.color.copy(c).multiplyScalar(0.7);
    // Sample finely enough for a smooth curve: ~200 points per orbit, 10 s to 5 min apart.
    const periodMs = ((2 * Math.PI) / satrec.no) * 60_000;
    this.stepMs = THREE.MathUtils.clamp(periodMs / 200, 10_000, 300_000);
  }

  /**
   * @param satPos the satellite's current scene position (null if it isn't drawn)
   * @param viewport canvas size in pixels, for the line widths
   */
  update(simMs: number, satPos: THREE.Vector3 | null, viewport: { width: number; height: number }): Coverage | null {
    if (!this.satrec) return null;
    for (const m of this.materials) m.resolution.set(viewport.width, viewport.height);

    this.future.visible = this.past.visible = this.showTrack;
    if (this.showTrack && Math.abs(simMs - this.computedAt) > this.stepMs) this.computeTrack(simMs);

    // The rings are rebuilt at most 20 times a second: a LEO satellite moves under 400 m in that time.
    const now = performance.now();
    if (!satPos || satPos.lengthSq() === 0) this.coverage = null;
    else if (now - this.footprintAt > 50) {
      this.footprintAt = now;
      this.coverage = this.computeFootprint(satPos);
    }
    this.horizonRing.visible = this.elevationRing.visible = this.showFootprint && this.coverage !== null;
    return this.coverage;
  }

  private computeTrack(simMs: number) {
    const satrec = this.satrec!;
    const periodMs = ((2 * Math.PI) / satrec.no) * 60_000;
    // Half an orbit behind and one and a half ahead, capped for slow (GEO/HEO) orbits.
    const pastMs = Math.min(periodMs / 2, 6 * 3_600_000);
    const futureMs = Math.min(periodMs * 1.5, 24 * 3_600_000);
    this.setLine(this.past, this.trackPoints(simMs - pastMs, simMs));
    this.setLine(this.future, this.trackPoints(simMs, simMs + futureMs));
    this.computedAt = simMs;
  }

  private trackPoints(fromMs: number, toMs: number): number[] {
    const pts: number[] = [];
    const p = new THREE.Vector3();
    for (let t = fromMs; t <= toMs + 1; t += this.stepMs) {
      const date = new Date(Math.min(t, toMs));
      const pv = propagate(this.satrec!, date);
      if (!pv) continue;
      eciToScene(pv.position.x, pv.position.y, pv.position.z, p);
      // Undo the Earth's rotation at that instant (the mesh is rotated about Y by GMST).
      p.applyAxisAngle(THREE.Object3D.DEFAULT_UP, -gstime(date)).setLength(SURFACE);
      pts.push(p.x, p.y, p.z);
    }
    return pts;
  }

  private computeFootprint(satPos: THREE.Vector3): Coverage {
    const c = this.local.copy(satPos);
    this.earth.updateMatrixWorld();
    this.earth.worldToLocal(c);
    const r = c.length(); // Earth radii
    c.divideScalar(r);
    // Angular radius (from the Earth's centre) of the region seeing the satellite at elevation ≥ ε:
    // λ = acos(cos ε / r) − ε.
    const reach = (elevDeg: number) => {
      const e = THREE.MathUtils.degToRad(elevDeg);
      return Math.max(0, Math.acos(Math.min(1, Math.cos(e) / r)) - e);
    };
    const horizon = reach(0);

    // Two unit vectors perpendicular to the sub-satellite direction span the ring's plane.
    this.u.set(0, 1, 0).cross(c);
    if (this.u.lengthSq() < 1e-8) this.u.set(1, 0, 0).cross(c);
    this.u.normalize();
    this.v.crossVectors(c, this.u);
    const ring = (lambda: number) => {
      const pts: number[] = [];
      const cosL = Math.cos(lambda), sinL = Math.sin(lambda);
      for (let k = 0; k <= RING_POINTS; k++) {
        const th = (k / RING_POINTS) * Math.PI * 2;
        const x = c.x * cosL + (this.u.x * Math.cos(th) + this.v.x * Math.sin(th)) * sinL;
        const y = c.y * cosL + (this.u.y * Math.cos(th) + this.v.y * Math.sin(th)) * sinL;
        const z = c.z * cosL + (this.u.z * Math.cos(th) + this.v.z * Math.sin(th)) * sinL;
        pts.push(x * SURFACE, y * SURFACE, z * SURFACE);
      }
      return pts;
    };
    if (this.showFootprint) {
      this.setLine(this.horizonRing, ring(horizon));
      this.setLine(this.elevationRing, ring(reach(MIN_ELEVATION_DEG)));
    }
    return { horizonRadiusKm: horizon * EARTH_RADIUS_KM, earthFraction: (1 - Math.cos(horizon)) / 2 };
  }

  private setLine(line: Line2, positions: number[]) {
    if (positions.length < 6) {
      line.visible = false;
      return;
    }
    line.geometry.dispose();
    const geometry = new LineGeometry();
    geometry.setPositions(positions);
    line.geometry = geometry;
    line.computeLineDistances();
  }
}
