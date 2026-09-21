import { describe, expect, it } from 'vitest';
import { sgp4, twoline2satrec } from 'satellite.js';
import { screen } from '../src/screening';
import { constellationOf, severity, type ScreenRequest } from '../src/conjunctions';
import type { SatInfo } from '../src/tle';
import { epochMs, makeTle, type Elements } from './fixtures';

// A tiny synthetic catalogue, all at ~400 km:
//   0, 1  cross paths: same ascending node, different inclinations, both at the node at the epoch,
//         so they arrive at the same point together (a near-collision at ~6 km/s).
//   2, 3  fly in formation on the opposite side of the Earth: 3's slightly more eccentric orbit makes it
//         loop slowly around 2, closest (~7 km) at the epoch at ~15 m/s. Close, but not an encounter.
const base = { year: 2024, day: 100, ecc: 0.0001, argpDeg: 0, meanAnomalyDeg: 0, meanMotion: 15.55 };
const elements: Elements[] = [
  { ...base, norad: 90001, incDeg: 51.6, raanDeg: 30 },
  { ...base, norad: 90002, incDeg: 97.5, raanDeg: 30 },
  { ...base, norad: 90003, incDeg: 51.6, raanDeg: 210 },
  { ...base, norad: 90004, incDeg: 51.6, raanDeg: 210, ecc: 0.0011 },
];
const lines = elements.flatMap(makeTle);
const satrecs = elements.map((_, i) => twoline2satrec(lines[2 * i], lines[2 * i + 1]));
const epoch = epochMs(base);
const startMs = epoch - 20 * 60_000;
const hours = 2 / 3;

const request = (over: Partial<ScreenRequest> = {}): ScreenRequest => ({
  lines,
  startMs,
  hours,
  thresholdKm: 25,
  groups: [0, 0, 0, 0],
  skipIntra: true,
  ...over,
});

function state(i: number, ms: number) {
  const pv = sgp4(satrecs[i], (ms - epoch) / 60_000);
  if (!pv) throw new Error('no solution');
  return pv;
}

/** Independent answer: the pair's separation sampled every 50 ms across the window. */
function bruteForce(a: number, b: number) {
  let best = { ms: 0, km: Infinity };
  for (let ms = startMs; ms <= startMs + hours * 3_600_000; ms += 50) {
    const pa = state(a, ms).position, pb = state(b, ms).position;
    const km = Math.hypot(pb.x - pa.x, pb.y - pa.y, pb.z - pa.z);
    if (km < best.km) best = { ms, km };
  }
  return best;
}

describe('close-approach screening', () => {
  const result = screen(request());

  it('finds the crossing pair and nothing else', () => {
    expect(result.screened).toBe(4);
    expect(result.events.map((e) => [e.a, e.b])).toEqual([[0, 1]]);
  });

  it('matches a brute-force search for the time and distance of closest approach', () => {
    const [ev] = result.events;
    const truth = bruteForce(0, 1);
    expect(Math.abs(ev.tcaMs - truth.ms)).toBeLessThan(100);
    expect(ev.missKm).toBeLessThanOrEqual(truth.km + 1e-6);
    expect(truth.km - ev.missKm).toBeLessThan(0.01);
    expect(Math.abs(ev.tcaMs - epoch)).toBeLessThan(60_000);
  });

  it('reports the relative speed at closest approach (~6 km/s for a 46° crossing)', () => {
    const [ev] = result.events;
    const va = state(0, ev.tcaMs).velocity, vb = state(1, ev.tcaMs).velocity;
    expect(ev.relSpeedKms).toBeCloseTo(Math.hypot(vb.x - va.x, vb.y - va.y, vb.z - va.z), 6);
    expect(ev.relSpeedKms).toBeGreaterThan(5.5);
    expect(ev.relSpeedKms).toBeLessThan(6.5);
  });

  it('drops the formation pair for its low relative speed, although it comes within the threshold', () => {
    const truth = bruteForce(2, 3);
    expect(truth.km).toBeLessThan(25);
    expect(Math.abs(truth.ms - epoch)).toBeLessThan(60_000); // well inside the window
    const va = state(2, truth.ms).velocity, vb = state(3, truth.ms).velocity;
    expect(Math.hypot(vb.x - va.x, vb.y - va.y, vb.z - va.z)).toBeLessThan(0.1);
  });

  it('skips pairs inside one constellation when asked, and keeps them otherwise', () => {
    for (const id of [1, 6]) {
      const groups = [id, id, 0, 0];
      expect(screen(request({ groups })).events).toHaveLength(0);
      expect(screen(request({ groups, skipIntra: false })).events.map((e) => [e.a, e.b])).toEqual([[0, 1]]);
    }
  });

  it('never compares Starlink with Starlink when skipping, even to reject them', () => {
    const all = screen(request({ groups: [1, 1, 1, 1], skipIntra: false })).pairsChecked;
    const skipped = screen(request({ groups: [1, 1, 1, 1] })).pairsChecked;
    expect(all).toBeGreaterThan(0);
    expect(skipped).toBe(0);
  });

  it('reports an encounter only when it is inside the threshold', () => {
    const miss = result.events[0].missKm;
    expect(screen(request({ thresholdKm: miss * 0.99 })).events).toHaveLength(0);
    expect(screen(request({ thresholdKm: miss * 1.01 })).events).toHaveLength(1);
  });

  it('reports progress through the window', () => {
    const calls: number[] = [];
    screen(request(), (done, total) => calls.push(done / total));
    expect(calls[0]).toBe(0);
    expect(calls.every((f, i) => i === 0 || f > calls[i - 1])).toBe(true);
  });
});

describe('conjunction labels', () => {
  const sat = (name: string, category: SatInfo['category'] = 'other') => ({ name, category }) as SatInfo;

  it('groups operator constellations, but not debris named after them', () => {
    expect(constellationOf(sat('STARLINK-1007'))).toBe(1);
    expect(constellationOf(sat('IRIDIUM 180'))).toBe(6);
    expect(constellationOf(sat('IRIDIUM 33 DEB'))).toBe(0);
    expect(constellationOf(sat('STARLINK-1007', 'debris'))).toBe(0);
    expect(constellationOf(sat('ISS (ZARYA)'))).toBe(0);
  });

  it('bands miss distances by severity', () => {
    expect([0.2, 1, 2.4, 2.5, 4.9].map(severity)).toEqual(['critical', 'high', 'high', 'watch', 'watch']);
  });
});
