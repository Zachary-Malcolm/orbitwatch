import { twoline2satrec, type SatRec } from 'satellite.js';
import { log, timedFetch } from './telemetry';

// CelesTrak publishes every active satellite as TLE text. The data only updates
// every ~2 hours and CelesTrak blocks clients that re-download too often, so the
// response is cached in the browser's Cache API for that long.
const SOURCE_URL = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=tle';
const CACHE_NAME = 'tle-cache-v1';
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

export type Category = 'station' | 'starlink' | 'oneweb' | 'navigation' | 'earth' | 'other';

export interface SatInfo {
  name: string;
  noradId: string;
  intlDesignator: string;
  category: Category;
  satrec: SatRec;
}

export interface TleLoadResult {
  sats: SatInfo[];
  fetchedAt: Date;
  fromCache: boolean;
}

export async function loadSatellites(): Promise<TleLoadResult> {
  const { text, fetchedAt, fromCache } = await loadTleText();
  return { sats: parseTle(text), fetchedAt, fromCache };
}

async function loadTleText(): Promise<{ text: string; fetchedAt: Date; fromCache: boolean }> {
  let stale: { text: string; fetchedAt: Date } | null = null;
  let cache: Cache | null = null;

  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(SOURCE_URL);
    if (hit) {
      const fetchedAt = new Date(Number(hit.headers.get('x-fetched-at')) || 0);
      const text = await hit.text();
      if (Date.now() - fetchedAt.getTime() < MAX_AGE_MS) return { text, fetchedAt, fromCache: true };
      stale = { text, fetchedAt };
    }
  } catch {
    // Cache API unavailable (e.g. insecure context) - fall through to network.
  }

  try {
    log('CELESTRAK', 'REQUESTING ACTIVE CATALOGUE');
    const res = await timedFetch('CELESTRAK', SOURCE_URL);
    const text = await res.text();
    if (!res.ok || !/^1 /m.test(text)) throw new Error(`CelesTrak returned ${res.status}: ${text.slice(0, 120)}`);
    const fetchedAt = new Date();
    await cache
      ?.put(SOURCE_URL, new Response(text, { headers: { 'x-fetched-at': String(fetchedAt.getTime()) } }))
      .catch(() => {});
    return { text, fetchedAt, fromCache: false };
  } catch (err) {
    if (stale) {
      log('CELESTRAK', 'UPLINK DOWN - USING STALE CACHE', 'warn');
      return { ...stale, fromCache: true };
    }
    throw err;
  }
}

function parseTle(text: string): SatInfo[] {
  const lines = text.split(/\r?\n/).map((l) => l.trimEnd());
  const sats: SatInfo[] = [];
  for (let i = 0; i < lines.length - 2; i++) {
    const l1 = lines[i + 1];
    const l2 = lines[i + 2];
    if (!l1?.startsWith('1 ') || !l2?.startsWith('2 ')) continue;
    const name = lines[i].trim();
    const satrec = twoline2satrec(l1, l2);
    if (satrec.error) continue;
    sats.push({
      name,
      noradId: l1.slice(2, 7).trim(),
      intlDesignator: l1.slice(9, 17).trim(),
      category: categorize(name),
      satrec,
    });
    i += 2;
  }
  return sats;
}

function categorize(name: string): Category {
  if (/^STARLINK/.test(name)) return 'starlink';
  if (/^ONEWEB/.test(name)) return 'oneweb';
  if (/^ISS |ZARYA|TIANHE|WENTIAN|MENGTIAN|^CSS/.test(name)) return 'station';
  if (/NAVSTAR|GPS |GLONASS|GALILEO|BEIDOU|IRNSS|QZS/.test(name)) return 'navigation';
  if (/NOAA|GOES|METOP|METEOR|HIMAWARI|FENGYUN|SENTINEL|LANDSAT|WORLDVIEW|FLOCK|LEMUR|SKYSAT|TERRA|AQUA/.test(name))
    return 'earth';
  return 'other';
}
