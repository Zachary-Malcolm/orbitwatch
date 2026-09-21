import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { latLonToVec, tileBounds, tileLatLon } from '../src/earthTiles';
import { EARTH_RADIUS_KM, eciToScene } from '../src/scene';

const DEG = Math.PI / 180;
/** Web Mercator's latitude limit, where the square map ends. */
const MERCATOR_LIMIT = Math.atan(Math.sinh(Math.PI));

describe('latLonToVec', () => {
  it('uses the scene convention: lon 0 on +X, north on +Y, 90°E on −Z', () => {
    const v = (lat: number, lon: number) => latLonToVec(lat * DEG, lon * DEG).toArray().map((x) => Math.round(x * 1e9) / 1e9 + 0);
    expect(v(0, 0)).toEqual([1, 0, 0]);
    expect(v(90, 0)).toEqual([0, 1, 0]);
    expect(v(0, 90)).toEqual([0, 0, -1]);
  });

  it('matches eciToScene for Earth-fixed coordinates, so imagery lines up with satellites', () => {
    for (const [lat, lon] of [[51.5, -0.1], [-33.9, 151.2], [64, -150]]) {
      const ecef = new THREE.Vector3(Math.cos(lat * DEG) * Math.cos(lon * DEG), Math.cos(lat * DEG) * Math.sin(lon * DEG), Math.sin(lat * DEG)).multiplyScalar(EARTH_RADIUS_KM);
      const scene = eciToScene(ecef.x, ecef.y, ecef.z, new THREE.Vector3());
      expect(scene.distanceTo(latLonToVec(lat * DEG, lon * DEG))).toBeLessThan(1e-12);
    }
  });
});

describe('tile quadtree', () => {
  it('covers the whole Web-Mercator square at zoom 0', () => {
    expect(tileLatLon(0, 0, 0, 0, 0)).toEqual([expect.closeTo(MERCATOR_LIMIT, 12), expect.closeTo(-Math.PI, 12)]);
    expect(tileLatLon(0, 0, 0, 1, 1)).toEqual([expect.closeTo(-MERCATOR_LIMIT, 12), expect.closeTo(Math.PI, 12)]);
    expect(tileLatLon(0, 0, 0, 0.5, 0.5)).toEqual([expect.closeTo(0, 12), expect.closeTo(0, 12)]);
    expect(MERCATOR_LIMIT / DEG).toBeCloseTo(85.0511, 4);
  });

  it('splits each tile into four children that exactly tile their parent', () => {
    for (const [z, x, y] of [[2, 1, 1], [3, 7, 0], [5, 17, 12], [7, 100, 64]]) {
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        for (const [u, v] of [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]]) {
          const child = tileLatLon(z + 1, 2 * x + dx, 2 * y + dy, u, v);
          const parent = tileLatLon(z, x, y, (dx + u) / 2, (dy + v) / 2);
          expect(child[0]).toBeCloseTo(parent[0], 12);
          expect(child[1]).toBeCloseTo(parent[1], 12);
        }
      }
    }
  });

  // Culling drops a tile when its bounding cone is out of view and never looks at its children,
  // so the cone must contain the whole tile. (With the exact split above, that also guarantees
  // nothing inside a culled tile's children could have been visible.)
  const sample = [[2, 0, 0], [2, 1, 1], [3, 4, 0], [4, 9, 6], [6, 40, 20], [8, 200, 3]];

  it('bounds every point of a tile inside its cone', () => {
    const p = new THREE.Vector3();
    for (const [z, x, y] of sample) {
      const { center, angRadius } = tileBounds(z, x, y);
      for (let i = 0; i <= 16; i++) {
        for (let j = 0; j <= 16; j++) {
          const [lat, lon] = tileLatLon(z, x, y, i / 16, j / 16);
          expect(center.angleTo(latLonToVec(lat, lon, p))).toBeLessThanOrEqual(angRadius + 1e-9);
        }
      }
    }
  });

  it('estimates the width of one texel (which drives the split decision) to within 1%', () => {
    for (const [z, x, y] of sample) {
      const { center, texelWorld } = tileBounds(z, x, y);
      const [lat, lon] = tileLatLon(z, x, y, 0.5 + 1 / 256, 0.5);
      expect(center.distanceTo(latLonToVec(lat, lon)) / texelWorld).toBeCloseTo(1, 2);
    }
  });
});
