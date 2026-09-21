import { latestNews, timeAgo, type Article, type ObjectNews } from '../news';
import { log } from '../telemetry';
import { $ } from './dom';

// News uplink. The ticker types out the latest headlines one at a time; the NEWS tab lists them; the
// dossier shows news about the selected object. New stories are polled every 5 minutes.

const NEWS_POLL_MS = 5 * 60_000;
let feed: Article[] = [];
const seenArticles = new Set<number>();
const arrivedLive = new Set<number>();

/** Fresh = published in the last hour, or arrived since this page was opened. */
const isFresh = (a: Article) => arrivedLive.has(a.id) || Date.now() - a.publishedMs < 3_600_000;

function newsItem(a: Article, withSummary: boolean): HTMLLIElement {
  const li = document.createElement('li');
  const link = Object.assign(document.createElement('a'), { href: a.url, target: '_blank', rel: 'noopener' });
  const meta = Object.assign(document.createElement('span'), { className: 'meta', textContent: `${timeAgo(a.publishedMs)} · ${a.site}` });
  if (isFresh(a)) meta.append(Object.assign(document.createElement('span'), { className: 'new', textContent: ' · ◉ NEW' }));
  link.append(meta, Object.assign(document.createElement('span'), { className: 'ttl', textContent: a.title }));
  if (withSummary && a.summary) link.append(Object.assign(document.createElement('span'), { className: 'sum', textContent: a.summary }));
  li.append(link);
  return li;
}

function renderFeed() {
  const list = $('news-list');
  list.replaceChildren(...feed.map((a) => newsItem(a, true)));
  if (!feed.length) list.innerHTML = '<li class="empty">NEWS UPLINK UNAVAILABLE</li>';
  $('news-count').textContent = String(feed.filter(isFresh).length || feed.length);
}

async function refreshNews() {
  try {
    const latest = await latestNews(20);
    if (!latest.length) throw new Error('empty');
    const incoming = latest.filter((a) => !seenArticles.has(a.id));
    const firstSync = seenArticles.size === 0;
    for (const a of incoming) {
      seenArticles.add(a.id);
      if (!firstSync) {
        arrivedLive.add(a.id);
        log('NEWS', `${a.site} · ${a.title}`, 'ok');
      }
    }
    if (firstSync) log('NEWS', `UPLINK ESTABLISHED · ${latest.length} STORIES · LATEST ${timeAgo(latest[0].publishedMs)}`);
    feed = latest;
    $('news-sync').textContent = new Date().toISOString().slice(11, 19) + ' UTC';
    renderFeed();
  } catch {
    log('NEWS', 'NEWS UPLINK UNAVAILABLE · WILL RETRY', 'warn');
  }
}

// Teletype: type the headline a character at a time, hold it, then move to the next.
let tickerIndex = -1;
let tickerChars = 0;
let tickerHoldUntil = 0;

function tickTicker() {
  if (!feed.length) return;
  const now = performance.now();
  const current = feed[tickerIndex];
  if (!current || (tickerChars >= current.title.length && now > tickerHoldUntil)) {
    tickerIndex = (tickerIndex + 1) % Math.min(feed.length, 12);
    tickerChars = 0;
    const next = feed[tickerIndex];
    const ticker = $<HTMLAnchorElement>('ticker');
    ticker.href = next.url;
    ticker.classList.toggle('fresh', isFresh(next));
    ticker.querySelector('.tk-tag')!.textContent = isFresh(next) ? '◉ NEW' : next.site.toUpperCase();
    return;
  }
  if (tickerChars < current.title.length) {
    tickerChars = Math.min(current.title.length, tickerChars + 2);
    $('ticker-text').textContent = current.title.slice(0, tickerChars);
    if (tickerChars === current.title.length) tickerHoldUntil = now + 7000;
  }
}

/** The dossier's NEWS section for the locked target. */
export function showObjectNews(n: ObjectNews | null) {
  const list = $('d-news');
  if (!n) {
    $('d-news-title').textContent = 'NEWS';
    list.innerHTML = '<li class="empty">NO SPECIFIC COVERAGE FOR THIS OBJECT</li>';
    return;
  }
  $('d-news-title').textContent = `NEWS · ${n.topic}${n.programme ? ' PROGRAMME' : ''}`;
  list.replaceChildren(...n.articles.slice(0, 5).map((a) => newsItem(a, false)));
}

export function initNews() {
  setInterval(tickTicker, 40);
  refreshNews();
  setInterval(refreshNews, NEWS_POLL_MS);
}
