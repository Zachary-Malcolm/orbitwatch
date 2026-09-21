import { twoline2satrec, type SatRec } from 'satellite.js';
import { log, timedFetch } from './telemetry';

// CelesTrak publishes orbital elements (TLEs) by group. The data only updates every
// ~2 hours and CelesTrak blocks any IP that re-downloads a group sooner (HTTP 403),
// which would break the site for everyone sharing an office or phone-carrier IP.
// So the deployed site reads copies that the GitHub Pages workflow fetches from
// CelesTrak every few hours (the "mirror"). Local development, and the deployed site
// if the mirror is missing, fetch CelesTrak directly and cache each response in the
// browser's Cache API for 2 hours.
const celestrakGroup = (group: string) => `https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`;
const CACHE_NAME = 'tle-cache-v1';
const MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Debris clouds from the four largest fragmentation events that CelesTrak tracks as groups. */
export const DEBRIS_GROUPS = ['fengyun-1c-debris', 'cosmos-2251-debris', 'iridium-33-debris', 'cosmos-1408-debris'];

export type Category = 'station' | 'starlink' | 'oneweb' | 'navigation' | 'earth' | 'other' | 'debris';

export interface SatInfo {
  name: string;
  noradId: string;
  intlDesignator: string;
  category: Category;
  satrec: SatRec;
  /** Raw TLE lines, kept so the catalogue can be handed to the screening worker. */
  line1: string;
  line2: string;
}

export type TleSource = 'mirror' | 'live' | 'cache';

export interface TleLoadResult {
  sats: SatInfo[];
  fetchedAt: Date;
  source: TleSource;
}

interface TleText {
  text: string;
  fetchedAt: Date;
  source: TleSource;
}

/** Every active satellite. */
export async function loadSatellites(): Promise<TleLoadResult> {
  const mirrored = import.meta.env.PROD ? await loadMirror('active').catch(() => null) : null;
  const { text, fetchedAt, source } = mirrored ?? (await loadCelestrak('active'));
  return { sats: parseTle(text), fetchedAt, source };
}

/** Tracked debris fragments (not part of CelesTrak's "active" group). */
export async function loadDebris(): Promise<TleLoadResult> {
  const mirrored = import.meta.env.PROD ? await loadMirror('debris').catch(() => null) : null;
  if (mirrored) return { sats: parseTle(mirrored.text, 'debris'), fetchedAt: mirrored.fetchedAt, source: 'mirror' };
  const groups = await Promise.all(DEBRIS_GROUPS.map((g) => loadCelestrak(g)));
  return {
    sats: groups.flatMap((g) => parseTle(g.text, 'debris')),
    fetchedAt: new Date(Math.min(...groups.map((g) => g.fetchedAt.getTime()))),
    source: groups.every((g) => g.source === 'cache') ? 'cache' : 'live',
  };
}

/** A copy published alongside the site by .github/workflows/deploy.yml. */
async function loadMirror(name: string): Promise<TleText | null> {
  const base = `${import.meta.env.BASE_URL}data/`;
  const [meta, tle] = await Promise.all([
    timedFetch('MIRROR', `${base}${name}.json`),
    timedFetch('MIRROR', `${base}${name}.tle`),
  ]);
  if (!meta.ok || !tle.ok) return null;
  const { fetchedAt } = (await meta.json()) as { fetchedAt: string };
  const text = await tle.text();
  if (!/^1 /m.test(text)) return null;
  return { text, fetchedAt: new Date(fetchedAt), source: 'mirror' };
}

async function loadCelestrak(group: string): Promise<TleText> {
  const url = celestrakGroup(group);
  let stale: { text: string; fetchedAt: Date } | null = null;
  let cache: Cache | null = null;

  try {
    cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) {
      const fetchedAt = new Date(Number(hit.headers.get('x-fetched-at')) || 0);
      const text = await hit.text();
      if (Date.now() - fetchedAt.getTime() < MAX_AGE_MS) return { text, fetchedAt, source: 'cache' };
      stale = { text, fetchedAt };
    }
  } catch {
    // Cache API unavailable (e.g. insecure context) - fall through to network.
  }

  try {
    log('CELESTRAK', `REQUESTING ${group.toUpperCase()}`);
    const res = await timedFetch('CELESTRAK', url);
    const text = await res.text();
    if (!res.ok || !/^1 /m.test(text)) throw new Error(`CelesTrak returned ${res.status}: ${text.slice(0, 120)}`);
    const fetchedAt = new Date();
    await cache
      ?.put(url, new Response(text, { headers: { 'x-fetched-at': String(fetchedAt.getTime()) } }))
      .catch(() => {});
    return { text, fetchedAt, source: 'live' };
  } catch (err) {
    if (stale) {
      log('CELESTRAK', `UPLINK DOWN - STALE CACHE FOR ${group.toUpperCase()}`, 'warn');
      return { ...stale, source: 'cache' };
    }
    throw err;
  }
}

function parseTle(text: string, category?: Category): SatInfo[] {
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
      category: category ?? categorize(name),
      satrec,
      line1: l1,
      line2: l2,
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
