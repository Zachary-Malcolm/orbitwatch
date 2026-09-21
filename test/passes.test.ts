import { describe, expect, it } from 'vitest';
import { eciToGeodetic, gstime, propagate, twoline2satrec } from 'satellite.js';
import { parseTle } from '../src/tle';
import {
  MIN_PASS_ELEVATION_DEG,
  compass,
  lookAt,
  parseLatLon,
  predictPasses,
  skyCondition,
  sunElevation,
  type Observer,
} from '../src/observer';
import { ISS_EPOCH_MS, ISS_TLE, epochMs, makeTle } from './fixtures';

const london: Observer = { latDeg: 51.48, lonDeg: -0.0015, source: 'manual' };
const [iss] = parseTle(ISS_TLE);
const el = (ms: number, o = london) => lookAt(iss.satrec, o, new Date(ms))!.elDeg;

describe('predictPasses (ISS over Greenwich)', () => {
  const start = ISS_EPOCH_MS;
  const forecast = predictPasses(iss.satrec, london, start, 1, 50);
  if (forecast.kind !== 'passes') throw new Error(`expected passes, got ${forecast.kind}`);
  const { passes } = forecast;

  it('finds passes, in order, each a few minutes long', () => {
    expect(passes.length).toBeGreaterThan(1);
    for (const [i, p] of passes.entries()) {
      expect(p.riseMs).toBeLessThan(p.maxMs);
      expect(p.maxMs).toBeLessThan(p.setMs);
      expect(p.setMs - p.riseMs).toBeGreaterThan(60_000);
      expect(p.setMs - p.riseMs).toBeLessThan(12 * 60_000);
      expect(p.maxEl).toBeGreaterThanOrEqual(MIN_PASS_ELEVATION_DEG);
      expect(p.maxEl).toBeLessThanOrEqual(90);
      if (i > 0) expect(p.riseMs).toBeGreaterThan(passes[i - 1].setMs);
    }
  });

  it('times rise and set to the horizon crossing', () => {
    for (const p of passes) {
      expect(Math.abs(el(p.riseMs))).toBeLessThan(0.01);
      expect(Math.abs(el(p.setMs))).toBeLessThan(0.01);
    }
  });

  it('agrees with a brute-force scan of the elevation every second', () => {
    // Independent answer: sample the whole day at 1 s and collect every above-horizon interval.
    const found: { riseMs: number; setMs: number; maxEl: number }[] = [];
    let cur: (typeof found)[number] | null = null;
    for (let t = start; t <= start + 86_400_000; t += 1000) {
      const e = el(t);
      if (e > 0 && !cur) cur = { riseMs: t, setMs: t, maxEl: e };
      if (e > 0 && cur) {
        cur.setMs = t;
        cur.maxEl = Math.max(cur.maxEl, e);
      }
      if (e <= 0 && cur) {
        if (cur.maxEl >= MIN_PASS_ELEVATION_DEG) found.push(cur);
        cur = null;
      }
    }
    expect(passes).toHaveLength(found.length);
    for (const [i, p] of passes.entries()) {
      expect(Math.abs(p.riseMs - found[i].riseMs)).toBeLessThan(1000);
      expect(Math.abs(p.setMs - found[i].setMs)).toBeLessThan(1000);
      // The search can only find a higher peak than 1 s sampling (which can straddle it on a
      // near-overhead pass, where elevation changes fastest), and only slightly higher.
      expect(p.maxEl).toBeGreaterThanOrEqual(found[i].maxEl - 1e-6);
      expect(p.maxEl - found[i].maxEl).toBeLessThan(0.05);
    }
  });

  it('reports rise, peak and set directions that match the sky position at those times', () => {
    for (const p of passes) {
      expect(lookAt(iss.satrec, london, new Date(p.riseMs))!.azDeg).toBeCloseTo(p.riseAz, 6);
      expect(lookAt(iss.satrec, london, new Date(p.maxMs))!.azDeg).toBeCloseTo(p.maxAz, 6);
      expect(lookAt(iss.satrec, london, new Date(p.setMs))!.azDeg).toBeCloseTo(p.setAz, 6);
    }
  });

  it('marks a pass already under way at the start time as in progress', () => {
    const p = passes[0];
    const mid = predictPasses(iss.satrec, london, (p.riseMs + p.setMs) / 2, 1);
    if (mid.kind !== 'passes') throw new Error(mid.kind);
    expect(mid.passes[0].inProgress).toBe(true);
    expect(mid.passes[0].setMs).toBeCloseTo(p.setMs, -3);
  });
});

describe('predictPasses (geostationary)', () => {
  const elements = { norad: 99001, year: 2024, day: 100, incDeg: 0.01, raanDeg: 0, ecc: 0.0001, argpDeg: 0, meanAnomalyDeg: 0, meanMotion: 1.0027 };
  const satrec = twoline2satrec(...makeTle(elements));
  const start = epochMs(elements);
  const date = new Date(start);
  const sub = eciToGeodetic(propagate(satrec, date)!.position, gstime(date));
  const subLon = (sub.longitude * 180) / Math.PI;

  it('says where it hangs in the sky for a station that can see it', () => {
    const f = predictPasses(satrec, { latDeg: 0, lonDeg: subLon, source: 'manual' }, start);
    expect(f.kind).toBe('always');
    if (f.kind === 'always') expect(f.elDeg).toBeGreaterThan(85);
  });

  it('says never for a station on the far side of the Earth', () => {
    const f = predictPasses(satrec, { latDeg: 0, lonDeg: ((subLon + 360) % 360) - 180, source: 'manual' }, start);
    expect(f.kind).toBe('never');
  });
});

describe('sun and sky', () => {
  it('puts the midsummer Sun at 90° − latitude ± 23.4° over Greenwich at noon and midnight', () => {
    expect(sunElevation(london, new Date(Date.UTC(2024, 5, 20, 12, 2)))).toBeCloseTo(90 - 51.48 + 23.44, 0);
    expect(sunElevation(london, new Date(Date.UTC(2024, 5, 21, 0, 2)))).toBeCloseTo(-(90 - 51.48 - 23.44), 0);
  });

  it('names the twilight bands', () => {
    expect([5, -3, -9, -15, -30].map(skyCondition)).toEqual(['DAYLIGHT', 'CIVIL TWILIGHT', 'NAUTICAL TWILIGHT', 'ASTRO TWILIGHT', 'NIGHT']);
  });
});

describe('observer input and labels', () => {
  it('parses decimal and hemisphere coordinates', () => {
    expect(parseLatLon('51.48, -0.001')).toMatchObject({ latDeg: 51.48, lonDeg: -0.001 });
    expect(parseLatLon('33.87S 151.21E')).toMatchObject({ latDeg: -33.87, lonDeg: 151.21 });
    expect(parseLatLon('40.7°N, 74.0°W')).toMatchObject({ latDeg: 40.7, lonDeg: -74 });
  });

  it('rejects out-of-range or malformed input', () => {
    expect(parseLatLon('91, 0')).toBeNull();
    expect(parseLatLon('0, 181')).toBeNull();
    expect(parseLatLon('London')).toBeNull();
  });

  it('maps azimuths to 16-point compass directions', () => {
    expect([0, 22.5, 90, 180, 247.5, 348.75, 359].map(compass)).toEqual(['N', 'NNE', 'E', 'S', 'WSW', 'N', 'N']);
  });
});
