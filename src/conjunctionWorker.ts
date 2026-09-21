/// <reference lib="webworker" />
import { sgp4, twoline2satrec, type SatRec } from 'satellite.js';
import type { Conjunction, ScreenRequest, ScreenMessage } from './conjunctions';

// Close-approach screening, run off the main thread.
//
// 1. Coarse sieve: every STEP_S seconds, propagate every object and bucket it in a 3D grid.
//    Two objects can only come within the threshold during the ±STEP_S/2 around that
//    instant if they are currently within threshold + (max closing speed × STEP_S/2), so
//    only pairs in neighbouring cells are compared. For those, the closest point of their
//    straight-line relative motion within the half-step is computed. (Two objects that are
//    close together feel almost the same gravity, so their relative motion is nearly
//    straight over a minute even though each orbit is curved.)
// 2. Refinement: each candidate's time of closest approach (TCA) is found exactly with a
//    golden-section search on the true SGP4 separation.
// 3. Pairs moving together (docked vehicles, formation flyers) are dropped by their low
//    relative speed: they are neighbours, not encounters.
//
// When intra-constellation pairs are skipped, Starlink members are kept in a separate list
// in each cell and never compared with each other at all: their dense shells would
// otherwise account for most of the pair comparisons.

const STEP_S = 60;
const STARLINK = 1; // matches the id in conjunctions.ts
const MAX_CLOSING_KMS = 16;
const FORMATION_KMS = 0.1;
const MIN_PER_DAY = 1440;

const post = (msg: ScreenMessage) => (self as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = (e: MessageEvent<ScreenRequest>) => {
  const t0 = performance.now();
  const { lines, startMs, hours, thresholdKm, groups, skipIntra } = e.data;
  const n = lines.length / 2;
  const satrecs: SatRec[] = [];
  for (let i = 0; i < n; i++) satrecs.push(twoline2satrec(lines[2 * i], lines[2 * i + 1]));

  const pos = new Float64Array(n * 3);
  const vel = new Float64Array(n * 3);
  const ok = new Uint8Array(n);
  const reach = thresholdKm + (MAX_CLOSING_KMS * STEP_S) / 2;
  const cell = reach;
  const half = STEP_S / 2;
  const screen2 = (3 * thresholdKm) ** 2;
  const candidates = new Map<number, { t: number; d2: number }>();
  const steps = Math.ceil((hours * 3600) / STEP_S);
  let pairsChecked = 0;

  for (let k = 0; k <= steps; k++) {
    const tMs = startMs + k * STEP_S * 1000;
    const jd = tMs / 86_400_000 + 2440587.5;

    // Propagate and bucket. Each cell holds [others, starlink] when Starlink pairs are skipped.
    const grid = new Map<number, [number[], number[]]>();
    for (let i = 0; i < n; i++) {
      const pv = sgp4(satrecs[i], (jd - satrecs[i].jdsatepoch) * MIN_PER_DAY);
      if (!pv || !Number.isFinite(pv.position.x)) {
        ok[i] = 0;
        continue;
      }
      ok[i] = 1;
      const j = i * 3;
      pos[j] = pv.position.x; pos[j + 1] = pv.position.y; pos[j + 2] = pv.position.z;
      vel[j] = pv.velocity.x; vel[j + 1] = pv.velocity.y; vel[j + 2] = pv.velocity.z;
      // Beyond the grid's range (only a few far highly-elliptical orbits); nothing to collide with out there.
      if (Math.abs(pos[j]) > 500_000 || Math.abs(pos[j + 1]) > 500_000 || Math.abs(pos[j + 2]) > 500_000) continue;
      const key = cellKey(Math.floor(pos[j] / cell), Math.floor(pos[j + 1] / cell), Math.floor(pos[j + 2] / cell));
      let bucket = grid.get(key);
      if (!bucket) grid.set(key, (bucket = [[], []]));
      bucket[skipIntra && groups[i] === STARLINK ? 1 : 0].push(i);
    }

    // Compare each cell with itself and its 13 "forward" neighbours, so every pair is seen once.
    // Lists: others×others, others×starlink and starlink×others; never starlink×starlink.
    const compare = (members: number[], other: number[], same: boolean) => {
      for (let a = 0; a < members.length; a++) {
        const i = members[a];
        const ia = i * 3;
        for (let b = same ? a + 1 : 0; b < other.length; b++) {
          const j = other[b];
          if (skipIntra && groups[i] !== 0 && groups[i] === groups[j]) continue;
          const jb = j * 3;
          pairsChecked++;
          const rx = pos[jb] - pos[ia], ry = pos[jb + 1] - pos[ia + 1], rz = pos[jb + 2] - pos[ia + 2];
          const r2 = rx * rx + ry * ry + rz * rz;
          if (r2 > reach * reach) continue;
          const vx = vel[jb] - vel[ia], vy = vel[jb + 1] - vel[ia + 1], vz = vel[jb + 2] - vel[ia + 2];
          const v2 = vx * vx + vy * vy + vz * vz;
          let s = v2 > 0 ? -(rx * vx + ry * vy + rz * vz) / v2 : 0;
          s = Math.max(-half, Math.min(half, s));
          const mx = rx + vx * s, my = ry + vy * s, mz = rz + vz * s;
          const d2 = mx * mx + my * my + mz * mz;
          if (d2 > screen2) continue;
          const pair = i < j ? i * n + j : j * n + i;
          const best = candidates.get(pair);
          if (!best || d2 < best.d2) candidates.set(pair, { t: tMs + s * 1000, d2 });
        }
      }
    };
    for (const [key, [others, starlink]] of grid) {
      const [cx, cy, cz] = cellCoords(key);
      for (const [dx, dy, dz] of HALF_NEIGHBOURS) {
        const self = dx === 0 && dy === 0 && dz === 0;
        const nb = self ? grid.get(key)! : grid.get(cellKey(cx + dx, cy + dy, cz + dz));
        if (!nb) continue;
        compare(others, nb[0], self);
        compare(others, nb[1], false);
        if (!self) compare(starlink, nb[0], false);
      }
    }
    if (k % 20 === 0) post({ type: 'progress', done: k, total: steps });
  }

  const events: Conjunction[] = [];
  for (const [pair, { t }] of candidates) {
    const a = Math.floor(pair / n);
    const b = pair % n;
    const refined = refine(satrecs[a], satrecs[b], t);
    if (!refined || refined.missKm > thresholdKm || refined.relSpeedKms < FORMATION_KMS) continue;
    if (refined.tcaMs < startMs || refined.tcaMs > startMs + hours * 3_600_000) continue;
    events.push({ a, b, ...refined });
  }
  events.sort((x, y) => x.missKm - y.missKm);
  post({
    type: 'result',
    events,
    screened: ok.reduce((sum, v) => sum + v, 0),
    pairsChecked,
    ms: performance.now() - t0,
  });
};

/** Golden-section search for the minimum true separation within ±45 s of the coarse estimate. */
function refine(sa: SatRec, sb: SatRec, guessMs: number) {
  const sep = (ms: number) => {
    const jd = ms / 86_400_000 + 2440587.5;
    const pa = sgp4(sa, (jd - sa.jdsatepoch) * MIN_PER_DAY);
    const pb = sgp4(sb, (jd - sb.jdsatepoch) * MIN_PER_DAY);
    if (!pa || !pb) return null;
    const dx = pb.position.x - pa.position.x, dy = pb.position.y - pa.position.y, dz = pb.position.z - pa.position.z;
    const vx = pb.velocity.x - pa.velocity.x, vy = pb.velocity.y - pa.velocity.y, vz = pb.velocity.z - pa.velocity.z;
    return { d: Math.hypot(dx, dy, dz), v: Math.hypot(vx, vy, vz) };
  };
  const g = (Math.sqrt(5) - 1) / 2;
  let lo = guessMs - 45_000;
  let hi = guessMs + 45_000;
  for (let it = 0; it < 32 && hi - lo > 5; it++) {
    const m1 = hi - g * (hi - lo);
    const m2 = lo + g * (hi - lo);
    const f1 = sep(m1);
    const f2 = sep(m2);
    if (!f1 || !f2) return null;
    if (f1.d < f2.d) hi = m2;
    else lo = m1;
  }
  const tcaMs = (lo + hi) / 2;
  const at = sep(tcaMs);
  return at && { tcaMs, missKm: at.d, relSpeedKms: at.v };
}

// Cells are packed into one number; ±1024 cells of ~500 km covers anything within 500,000 km.
function cellKey(x: number, y: number, z: number) {
  return ((x + 1024) * 2048 + (y + 1024)) * 2048 + (z + 1024);
}
function cellCoords(key: number): [number, number, number] {
  const z = (key % 2048) - 1024;
  const rest = Math.floor(key / 2048);
  return [Math.floor(rest / 2048) - 1024, (rest % 2048) - 1024, z];
}

const HALF_NEIGHBOURS: [number, number, number][] = [[0, 0, 0]];
for (let dx = -1; dx <= 1; dx++)
  for (let dy = -1; dy <= 1; dy++)
    for (let dz = -1; dz <= 1; dz++)
      if (dx > 0 || (dx === 0 && (dy > 0 || (dy === 0 && dz > 0)))) HALF_NEIGHBOURS.push([dx, dy, dz]);
