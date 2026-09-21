import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { coverageAngle } from '../src/groundTrack';
import { EARTH_RADIUS_KM } from '../src/scene';

const r = (altKm: number) => 1 + altKm / EARTH_RADIUS_KM;
const DEG = Math.PI / 180;

describe('coverageAngle (footprint radius)', () => {
  it('gives the ISS a ~2,250 km horizon footprint', () => {
    expect(coverageAngle(r(420), 0) * EARTH_RADIUS_KM).toBeCloseTo(2255, -1);
  });

  it('lets a geostationary satellite see ~42% of the Earth, out to ~81°', () => {
    const lambda = coverageAngle(42_164 / EARTH_RADIUS_KM, 0);
    expect(lambda / DEG).toBeCloseTo(81.3, 1);
    expect((1 - Math.cos(lambda)) / 2).toBeCloseTo(0.424, 3);
  });

  it('puts the satellite exactly at the requested elevation from the edge of the ring', () => {
    // Independent check with vectors: stand on the ring's edge and measure the satellite's elevation.
    for (const alt of [300, 550, 1200, 20_200, 35_786]) {
      for (const elevDeg of [0, 10, 25, 45]) {
        const lambda = coverageAngle(r(alt), elevDeg);
        const sat = new THREE.Vector3(0, 0, r(alt));
        const ground = new THREE.Vector3(Math.sin(lambda), 0, Math.cos(lambda));
        const toSat = sat.clone().sub(ground).normalize();
        expect(Math.asin(toSat.dot(ground)) / DEG).toBeCloseTo(elevDeg, 9);
      }
    }
  });

  it('shrinks as the minimum elevation rises', () => {
    const angles = [0, 5, 10, 30, 60, 89].map((e) => coverageAngle(r(550), e));
    for (let i = 1; i < angles.length; i++) expect(angles[i]).toBeLessThan(angles[i - 1]);
  });

  it('is zero at or below the surface', () => {
    expect(coverageAngle(1, 0)).toBe(0);
    expect(coverageAngle(0.99, 10)).toBe(0);
  });
});
