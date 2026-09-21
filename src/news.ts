import { timedFetch } from './telemetry';
import type { SatInfo } from './tle';
import type { WikiInfo } from './intel';

// Spaceflight news from the Spaceflight News API (api.spaceflightnewsapi.net): headlines and
// short summaries aggregated from ~40 outlets, free and without a key. Articles are shown as a
// headline, source and time, and link out to the original; nothing is republished.

const API = 'https://api.spaceflightnewsapi.net/v4/articles/';

export interface Article {
  id: number;
  title: string;
  summary: string;
  url: string;
  site: string;
  publishedMs: number;
}

interface ApiArticle {
  id: number;
  title: string;
  summary: string;
  url: string;
  news_site: string;
  published_at: string;
}

const toArticle = (a: ApiArticle): Article => ({
  id: a.id,
  title: a.title.trim(),
  summary: a.summary.trim(),
  url: a.url,
  site: a.news_site,
  publishedMs: Date.parse(a.published_at),
});

async function query(params: Record<string, string>): Promise<Article[]> {
  const url = `${API}?${new URLSearchParams({ ordering: '-published_at', ...params })}`;
  const res = await timedFetch('NEWS', url);
  if (!res.ok) return [];
  const json = (await res.json()) as { results: ApiArticle[] };
  return json.results.map(toArticle);
}

/** The latest headlines across all outlets. */
export const latestNews = (limit = 20) => query({ limit: String(limit) });

// ---- News about one object ----

export interface ObjectNews {
  /** What was searched for, e.g. "Hubble" or "Starlink". */
  topic: string;
  /** True when the news is about the object's programme or constellation rather than the object itself. */
  programme: boolean;
  articles: Article[];
}

// Catalogue names that news never uses.
const ALIASES: [RegExp, string][] = [
  [/^ISS \(/, 'International Space Station'],
  [/^HST$/, 'Hubble'],
  [/^CSS \(/, 'Tiangong'],
  [/^CXO$/, 'Chandra'],
  [/^FGRST/, 'Fermi'],
];

// Constellations: individual members are never in the news, their programme is.
const PROGRAMMES: [RegExp, string][] = [
  [/^STARLINK/, 'Starlink'],
  [/^ONEWEB/, 'OneWeb'],
  [/^KUIPER/, 'Kuiper'],
  [/^QIANFAN|^THOUSAIL/, 'Qianfan'],
  [/^IRIDIUM(?! 33 DEB)/, 'Iridium'],
  [/^GLOBALSTAR/, 'Globalstar'],
  [/^FLOCK|^DOVE/, 'Planet Labs'],
  [/NAVSTAR|^GPS /, 'GPS'],
  [/GALILEO/, 'Galileo'],
  [/GLONASS/, 'GLONASS'],
  [/BEIDOU/, 'BeiDou'],
];

const cache = new Map<string, Promise<Article[]>>();

function search(term: string): Promise<Article[]> {
  let pending = cache.get(term);
  if (!pending) {
    pending = query({ search: term, limit: '6' }).catch(() => []);
    cache.set(term, pending);
  }
  return pending;
}

/**
 * News for a selected object: by its common name (an alias or its own Wikipedia article),
 * otherwise by its constellation or programme. Objects only described by a generic
 * article ("Communications satellite") get no news rather than unrelated stories.
 */
export async function newsFor(sat: SatInfo, wiki: WikiInfo | null): Promise<ObjectNews | null> {
  const alias = ALIASES.find(([re]) => re.test(sat.name))?.[1];
  const own = alias ?? (wiki?.context === 'own' ? wiki.title.replace(/\s*\(.*\)$/, '') : undefined);
  if (own) {
    const articles = await search(own);
    if (articles.length) return { topic: own, programme: false, articles };
  }
  const programme = PROGRAMMES.find(([re]) => re.test(sat.name))?.[1];
  if (programme) {
    const articles = await search(programme);
    if (articles.length) return { topic: programme, programme: true, articles };
  }
  return null;
}

export function timeAgo(ms: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - ms) / 60_000));
  if (min < 60) return `${min}M AGO`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h}H AGO`;
  return `${Math.round(h / 24)}D AGO`;
}
