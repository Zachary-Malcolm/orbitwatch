import { describe, expect, it } from 'vitest';
import { eciToGeodetic, gstime, propagate, sgp4, twoline2satrec } from 'satellite.js';
import { parseTle } from '../src/tle';
import { ISS_EPOCH_MS, ISS_TLE, VALLADO_00005, makeTle } from './fixtures';

describe('SGP4 propagation', () => {
  it('reproduces the published Vallado verification states to the millimetre', () => {
    const satrec = twoline2satrec(VALLADO_00005.line1, VALLADO_00005.line2);
    for (const { min, r, v } of VALLADO_00005.expected) {
      const pv = sgp4(satrec, min);
      if (!pv) throw new Error(`no solution at ${min} min`);
      const { position: p, velocity: w } = pv;
      expect([p.x, p.y, p.z].map((x, i) => Math.abs(x - r[i]))).toEqual([0, 0, 0].map(() => expect.closeTo(0, 5)));
      expect([w.x, w.y, w.z].map((x, i) => Math.abs(x - v[i]))).toEqual([0, 0, 0].map(() => expect.closeTo(0, 8)));
    }
  });

  it('puts the ISS where it physically is: ~350 km up at ~7.7 km/s, never beyond its 51.6° inclination', () => {
    const [iss] = parseTle(ISS_TLE);
    const periodMin = (2 * Math.PI) / iss.satrec.no;
    expect(periodMin).toBeCloseTo(91.6, 1);
    let maxLat = 0;
    for (let min = 0; min <= periodMin; min += 0.5) {
      const date = new Date(ISS_EPOCH_MS + min * 60_000);
      const pv = propagate(iss.satrec, date);
      if (!pv) throw new Error('no solution');
      const altKm = eciToGeodetic(pv.position, gstime(date)).height;
      const speed = Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z);
      expect(altKm).toBeGreaterThan(320);
      expect(altKm).toBeLessThan(390);
      expect(speed).toBeGreaterThan(7.6);
      expect(speed).toBeLessThan(7.8);
      maxLat = Math.max(maxLat, Math.abs(eciToGeodetic(pv.position, gstime(date)).latitude));
    }
    // Over a whole orbit the ground track reaches (almost exactly) the orbital inclination.
    expect((maxLat * 180) / Math.PI).toBeCloseTo(51.6, 0);
  });
});

describe('parseTle', () => {
  it('reads name, NORAD ID, international designator and category', () => {
    const [iss] = parseTle(ISS_TLE);
    expect(iss).toMatchObject({ name: 'ISS (ZARYA)', noradId: '25544', intlDesignator: '98067A', category: 'station' });
    expect(iss.satrec.error).toBe(0);
  });

  it('handles CRLF line endings, skips junk, and categorises by name', () => {
    const [l1, l2] = makeTle({ norad: 44713, year: 2024, day: 100, incDeg: 53, raanDeg: 10, ecc: 0.0001, argpDeg: 90, meanAnomalyDeg: 0, meanMotion: 15.06 });
    const [g1, g2] = makeTle({ norad: 28474, year: 2024, day: 100, incDeg: 55, raanDeg: 10, ecc: 0.005, argpDeg: 90, meanAnomalyDeg: 0, meanMotion: 2.0056 });
    const text = ['STARLINK-1007', l1, l2, 'not a TLE', '1 garbage', 'GPS BIIR-13 (PRN 02)', g1, g2, ''].join('\r\n');
    const sats = parseTle(text);
    expect(sats.map((s) => [s.name, s.noradId, s.category])).toEqual([
      ['STARLINK-1007', '44713', 'starlink'],
      ['GPS BIIR-13 (PRN 02)', '28474', 'navigation'],
    ]);
  });

  it('applies a forced category (used for the debris groups)', () => {
    expect(parseTle(ISS_TLE, 'debris')[0].category).toBe('debris');
  });

  it('builds column-exact synthetic element sets for the other tests', () => {
    const [l1, l2] = makeTle({ norad: 1, year: 2024, day: 100.5, incDeg: 51.6, raanDeg: 30, ecc: 0.0001, argpDeg: 0, meanAnomalyDeg: 0, meanMotion: 15.55 });
    expect(l1).toHaveLength(69);
    expect(l2).toHaveLength(69);
    const satrec = twoline2satrec(l1, l2);
    expect(satrec.error).toBe(0);
    expect((satrec.inclo * 180) / Math.PI).toBeCloseTo(51.6, 6);
    // SGP4 converts the TLE's (Kozai) mean motion to Brouwer's, which differs by ~0.01%.
    expect((satrec.no * 1440) / (2 * Math.PI)).toBeCloseTo(15.55, 2);
  });
});
