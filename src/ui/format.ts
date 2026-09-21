// Number, time and distance formatting shared by the terminal panels.

export const fmt = (n: number, digits: number) =>
  n.toLocaleString('en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Duration as [N D ]HH:MM:SS (sign dropped). */
export function hms(ms: number) {
  const s = Math.floor(Math.abs(ms) / 1000);
  const days = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, '0');
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${days ? `${days}D ` : ''}${hh}:${mm}:${ss}`;
}

export const fmtKm = (km: number) => `${fmt(km, km < 10 ? 2 : 0)} KM`;

/** Countdown to a real-time moment, or PASSED. */
export const untilText = (ms: number) => (ms >= Date.now() ? `T+${hms(ms - Date.now()).slice(0, -3)}` : 'PASSED');

/** "21 SEP · 14:05" in the visitor's own time zone. */
export const localTime = (ms: number) =>
  new Date(ms)
    .toLocaleString('en-GB', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .toUpperCase()
    .replace(',', ' ·');
