// Event log and link-latency bookkeeping for the terminal UI. Everything recorded here
// comes from real activity: network requests, data loads, selections and orbital events.

export type LogLevel = 'info' | 'ok' | 'warn';

export interface LogEntry {
  time: Date;
  source: string;
  message: string;
  level: LogLevel;
}

type Listener = (entry: LogEntry) => void;

const listeners: Listener[] = [];
const backlog: LogEntry[] = [];

/** Most recent round-trip time per data source, in ms. */
export const latency = new Map<string, number>();

export function onLog(listener: Listener) {
  listeners.push(listener);
  backlog.splice(0).forEach(listener);
}

export function log(source: string, message: string, level: LogLevel = 'info') {
  const entry = { time: new Date(), source, message, level };
  if (listeners.length) listeners.forEach((l) => l(entry));
  else backlog.push(entry);
}

/** fetch() that records the round-trip time for `source` and logs failures. */
export async function timedFetch(source: string, url: string): Promise<Response> {
  const t0 = performance.now();
  try {
    const res = await fetch(url);
    latency.set(source, performance.now() - t0);
    if (!res.ok) log(source, `HTTP ${res.status}`, 'warn');
    return res;
  } catch (err) {
    log(source, 'LINK FAILURE', 'warn');
    throw err;
  }
}
