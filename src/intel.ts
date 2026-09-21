import { LAUNCH_SITES, OWNERS } from './codes';
import type { SatInfo } from './tle';
import { timedFetch } from './telemetry';

// Background information for a selected satellite, gathered from three public APIs:
//  - CelesTrak SATCAT: owner, launch date/site, object type, status, radar size
//  - Wikidata: maps the NORAD catalogue number (property P377) to a Wikipedia article
//  - Wikipedia REST API: summary text and photo for that article

export interface CatalogInfo {
  owner: { code: string; name: string; flag?: string };
  objectType: string;
  status: string;
  operational: boolean | null;
  launchDate: Date | null;
  launchSite: string;
  rcsM2: number | null;
}

export interface WikiInfo {
  title: string;
  extract: string;
  imageUrl?: string;
  /** Set when the image was borrowed from a programme or type article (a representative image). */
  imageFrom?: string;
  pageUrl: string;
  /** Whether the article is about this satellite, its programme, or its general type. */
  context: 'own' | 'programme' | 'type';
}

/** Each part resolves independently (Wikidata is often a few seconds slower than CelesTrak). */
export interface Intel {
  catalog: Promise<CatalogInfo | null>;
  wiki: Promise<WikiInfo | null>;
}

const cache = new Map<string, Intel>();

export function fetchIntel(sat: SatInfo): Intel {
  let intel = cache.get(sat.noradId);
  if (!intel) {
    intel = {
      catalog: fetchCatalog(sat.noradId).catch(() => null),
      wiki: fetchWiki(sat).catch(() => null),
    };
    cache.set(sat.noradId, intel);
  }
  return intel;
}

const OBJECT_TYPES: Record<string, string> = {
  PAY: 'Payload',
  'R/B': 'Rocket body',
  DEB: 'Debris',
  UNK: 'Unknown',
};

const STATUS: Record<string, [string, boolean | null]> = {
  '+': ['Operational', true],
  '-': ['Non-operational', false],
  P: ['Partially operational', true],
  B: ['Backup / standby', true],
  S: ['Spare', true],
  X: ['Extended mission', true],
  D: ['Decayed', false],
  '?': ['Unknown', null],
};

async function fetchCatalog(noradId: string): Promise<CatalogInfo | null> {
  const res = await timedFetch('SATCAT', `https://celestrak.org/satcat/records.php?CATNR=${noradId}&FORMAT=json`);
  if (!res.ok) return null;
  const [rec] = (await res.json()) as Record<string, string | number | null>[];
  if (!rec) return null;
  const ownerCode = String(rec.OWNER ?? 'UNK');
  const [status, operational] = STATUS[String(rec.OPS_STATUS_CODE ?? '?')] ?? STATUS['?'];
  const siteCode = String(rec.LAUNCH_SITE ?? '');
  return {
    owner: { code: ownerCode, ...(OWNERS[ownerCode] ?? { name: ownerCode }) },
    objectType: OBJECT_TYPES[String(rec.OBJECT_TYPE)] ?? String(rec.OBJECT_TYPE ?? 'Unknown'),
    status,
    operational,
    launchDate: rec.LAUNCH_DATE ? new Date(`${rec.LAUNCH_DATE}T00:00:00Z`) : null,
    launchSite: LAUNCH_SITES[siteCode] ?? (siteCode || 'Unknown'),
    rcsM2: typeof rec.RCS === 'number' ? rec.RCS : null,
  };
}

// Mega-constellation members rarely have their own article; fall back to the programme's.
const PROGRAMME_ARTICLES: [RegExp, string][] = [
  [/^STARLINK/, 'Starlink'],
  [/^ONEWEB/, 'Eutelsat_OneWeb'],
  [/^KUIPER/, 'Project_Kuiper'],
  [/^QIANFAN|^THOUSAIL/, 'Qianfan'],
  [/^IRIDIUM/, 'Iridium_satellite_constellation'],
  [/^GLOBALSTAR/, 'Globalstar'],
  [/^ORBCOMM/, 'Orbcomm'],
  [/NAVSTAR|^GPS /, 'Global_Positioning_System'],
  [/GLONASS/, 'GLONASS'],
  [/GALILEO|^GSAT0/, 'Galileo_(satellite_navigation)'],
  [/BEIDOU/, 'BeiDou'],
  [/^FLOCK|^DOVE/, 'Planet_Labs'],
  [/^LEMUR/, 'Spire_Global'],
  [/^SKYSAT/, 'SkySat'],
  [/^YAOGAN/, 'Yaogan'],
  [/^COSMOS/, 'Kosmos_(satellite)'],
  [/^O3B/, 'O3b_Networks'],
  [/^SWARM/, 'Swarm_Technologies'],
];

/** Article describing what kind of spacecraft this is, used when nothing more specific exists. */
function typeArticle(sat: SatInfo): string {
  if (/CUBESAT|^FLOCK|^LEMUR|^DOVE/.test(sat.name)) return 'CubeSat';
  if (sat.category === 'station') return 'Space_station';
  if (sat.category === 'navigation') return 'Satellite_navigation';
  if (sat.category === 'earth') return 'Earth_observation_satellite';
  const periodMin = (2 * Math.PI) / sat.satrec.no;
  if (Math.abs(periodMin - 1436) < 30) return 'Communications_satellite';
  return 'Satellite';
}

/**
 * Every satellite gets a briefing and a picture: its own article when Wikidata links one,
 * otherwise its programme's (e.g. Starlink), otherwise one about its type of spacecraft.
 * An own article without a photo borrows the fallback's image, marked as representative.
 */
async function fetchWiki(sat: SatInfo): Promise<WikiInfo | null> {
  const title = await findArticleForNorad(sat.noradId).catch(() => null);
  const own = title ? await fetchSummary(title, 'own').catch(() => null) : null;
  if (own?.imageUrl) return own;

  const programme = PROGRAMME_ARTICLES.find(([re]) => re.test(sat.name))?.[1];
  const fallback =
    (programme && (await fetchSummary(programme, 'programme').catch(() => null))) ||
    (await fetchSummary(typeArticle(sat), 'type').catch(() => null));
  if (!own) return fallback && { ...fallback, imageFrom: fallback.imageUrl ? fallback.title : undefined };
  return fallback?.imageUrl ? { ...own, imageUrl: fallback.imageUrl, imageFrom: fallback.title } : own;
}

async function findArticleForNorad(noradId: string): Promise<string | null> {
  // Wikidata's search index finds items by statement value in well under a second
  // (an equivalent SPARQL query can take 10s+).
  const api = 'https://www.wikidata.org/w/api.php?format=json&origin=*';
  const search = await timedFetch('WIKIDATA', `${api}&action=query&list=search&srlimit=5&srsearch=haswbstatement:P377=${noradId}`);
  if (!search.ok) return null;
  const ids: string[] = ((await search.json()).query?.search ?? []).map((r: { title: string }) => r.title);
  if (!ids.length) return null;

  // Several items can share a catalogue number (e.g. the ISS and its Zarya module);
  // the one with the most language editions is almost always the one people mean.
  const res = await timedFetch('WIKIDATA', `${api}&action=wbgetentities&props=sitelinks&ids=${ids.join('|')}`);
  if (!res.ok) return null;
  const entities = Object.values((await res.json()).entities ?? {}) as { sitelinks?: Record<string, { title: string }> }[];
  const best = entities
    .filter((e) => e.sitelinks?.enwiki)
    .sort((a, b) => Object.keys(b.sitelinks!).length - Object.keys(a.sitelinks!).length)[0];
  return best?.sitelinks!.enwiki.title ?? null;
}

async function fetchSummary(title: string, context: WikiInfo['context']): Promise<WikiInfo | null> {
  const res = await timedFetch('WIKIPEDIA', `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replaceAll(" ", "_"))}`);
  if (!res.ok) return null;
  const json = await res.json();
  if (json.type === 'disambiguation' || !json.extract) return null;
  return {
    title: json.title,
    extract: json.extract,
    imageUrl: panelImage(json),
    pageUrl: json.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    context,
  };
}

/** The summary thumbnail is only ~330px wide. Wikimedia serves fixed thumbnail steps, so ask for 500px. */
function panelImage(json: { thumbnail?: { source: string }; originalimage?: { source: string; width: number } }) {
  const original = json.originalimage;
  if (!json.thumbnail || !original) return json.thumbnail?.source;
  if (original.width <= 500) return original.source;
  return json.thumbnail.source.replace(/\/\d+px-/, '/500px-');
}
