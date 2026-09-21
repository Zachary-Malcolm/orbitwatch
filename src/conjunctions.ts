import type { SatInfo } from './tle';

// Close-approach ("conjunction") screening across the whole catalogue, run in a Web Worker
// (see conjunctionWorker.ts for the method). Indices refer to the catalogue array passed in.

export interface ScreenRequest {
  /** TLE line pairs, flattened: [line1, line2, line1, line2, ...]. */
  lines: string[];
  startMs: number;
  hours: number;
  thresholdKm: number;
  /** Constellation id per object (0 = none). Pairs sharing a non-zero id are skipped when skipIntra is set. */
  groups: number[];
  skipIntra: boolean;
}

export interface Conjunction {
  a: number;
  b: number;
  /** Time of closest approach. */
  tcaMs: number;
  missKm: number;
  relSpeedKms: number;
}

export type ScreenMessage =
  | { type: 'progress'; done: number; total: number }
  | { type: 'result'; events: Conjunction[]; screened: number; pairsChecked: number; ms: number };

export interface ScreenResult {
  events: Conjunction[];
  screened: number;
  pairsChecked: number;
  ms: number;
  startMs: number;
  hours: number;
  thresholdKm: number;
  skipIntra: boolean;
  /** Parallel workers used. */
  workers: number;
}

// Operators fly their own mega-constellations and manage approaches between their own satellites,
// so those pairs are usually left out. Starlink must stay id 1: the worker gives it special
// handling because its dense shells dominate the pair count.
const CONSTELLATIONS: [RegExp, number][] = [
  [/^STARLINK/, 1],
  [/^ONEWEB/, 2],
  [/^KUIPER/, 3],
  [/^QIANFAN|^THOUSAIL/, 4],
  [/^GUOWANG|^HULIANWANG/, 5],
  [/^IRIDIUM(?! 33 DEB)/, 6],
  [/^GLOBALSTAR/, 7],
  [/^ORBCOMM/, 8],
  [/^FLOCK/, 9],
  [/^LEMUR/, 10],
  [/^O3B/, 11],
];

export function constellationOf(sat: SatInfo): number {
  if (sat.category === 'debris') return 0;
  return CONSTELLATIONS.find(([re]) => re.test(sat.name))?.[1] ?? 0;
}

let running: Worker[] = [];

/**
 * Screen every object against every other; resolves with encounters closest-first.
 * The window is split into equal time slices screened in parallel, one Web Worker per
 * spare CPU core, and the results merged (keeping each pair's closest approach).
 */
export function screenConjunctions(
  sats: SatInfo[],
  opts: { startMs: number; hours: number; thresholdKm: number; skipIntra: boolean },
  onProgress: (fraction: number) => void,
): Promise<ScreenResult> {
  running.forEach((w) => w.terminate());
  const t0 = performance.now();
  const slices = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const lines = sats.flatMap((s) => [s.line1, s.line2]);
  const groups = sats.map(constellationOf);
  const progress = new Array<number>(slices).fill(0);
  const workers = Array.from({ length: slices }, () => new Worker(new URL('./conjunctionWorker.ts', import.meta.url), { type: 'module' }));
  running = workers;

  const parts = workers.map(
    (w, k) =>
      new Promise<ScreenMessage & { type: 'result' }>((resolve, reject) => {
        w.onmessage = (e: MessageEvent<ScreenMessage>) => {
          const msg = e.data;
          if (msg.type === 'progress') {
            progress[k] = msg.done / msg.total;
            onProgress(progress.reduce((a, b) => a + b, 0) / slices);
          } else {
            w.terminate();
            resolve(msg);
          }
        };
        w.onerror = (err) => reject(err);
        const request: ScreenRequest = {
          lines,
          groups,
          thresholdKm: opts.thresholdKm,
          skipIntra: opts.skipIntra,
          startMs: opts.startMs + (k * opts.hours * 3_600_000) / slices,
          hours: opts.hours / slices,
        };
        w.postMessage(request);
      }),
  );

  return Promise.all(parts)
    .then((results) => {
      const best = new Map<string, Conjunction>();
      for (const ev of results.flatMap((r) => r.events)) {
        const key = `${ev.a}:${ev.b}`;
        const prev = best.get(key);
        if (!prev || ev.missKm < prev.missKm) best.set(key, ev);
      }
      return {
        events: [...best.values()].sort((x, y) => x.missKm - y.missKm),
        screened: Math.max(...results.map((r) => r.screened)),
        pairsChecked: results.reduce((sum, r) => sum + r.pairsChecked, 0),
        ms: performance.now() - t0,
        workers: slices,
        ...opts,
      };
    })
    .finally(() => {
      workers.forEach((w) => w.terminate());
      if (running === workers) running = [];
    });
}

/** Pairs inside one operator's own constellation, whose operator manages them together. */
export function isIntraConstellation(a: SatInfo, b: SatInfo): boolean {
  const g = constellationOf(a);
  return g !== 0 && g === constellationOf(b);
}

/** Rough severity bands used for colouring and labels. */
export function severity(missKm: number): 'critical' | 'high' | 'watch' {
  if (missKm < 1) return 'critical';
  if (missKm < 2.5) return 'high';
  return 'watch';
}
