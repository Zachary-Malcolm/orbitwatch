import { onLog, type LogEntry } from './telemetry';

// Text-mode widgets for the terminal UI: segmented block bars, block sparklines,
// the scrolling event log and the standby radar sweep.

/** Render a segmented bar like [■■■■■□□□□□] into `el`. */
export function blocks(el: HTMLElement, fraction: number, warn = false, segments = 20) {
  const on = Math.round(Math.min(1, Math.max(0, fraction)) * segments);
  el.innerHTML = `[<span class="on">${'■'.repeat(on)}</span><span class="off">${'□'.repeat(segments - on)}</span>]`;
  el.classList.toggle('warn', warn);
}

const SPARK = '▁▂▃▄▅▆▇█';

/** Rolling history drawn as a row of block characters, scaled to its own peak. */
export class Sparkline {
  private readonly values: number[] = [];
  private readonly el: HTMLElement;
  private readonly length: number;

  constructor(el: HTMLElement, length = 30) {
    this.el = el;
    this.length = length;
  }

  push(value: number) {
    this.values.push(value);
    if (this.values.length > this.length) this.values.shift();
    const max = Math.max(...this.values, 1e-9);
    const bars = this.values.map((v) => SPARK[Math.min(SPARK.length - 1, Math.floor((v / max) * (SPARK.length - 1)))]);
    this.el.textContent = bars.join('').padStart(this.length, ' ');
  }
}

const MAX_LOG_LINES = 120;

/** Stream telemetry log entries into an <ol>, newest at the bottom. */
export function mountLog(list: HTMLElement) {
  onLog((entry: LogEntry) => {
    const li = document.createElement('li');
    li.className = `fresh ${entry.level} src-${entry.source.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    const cells = [entry.time.toISOString().slice(11, 19), entry.source, entry.message];
    cells.forEach((text, i) => {
      const span = document.createElement('span');
      if (i === 0) span.className = 't';
      span.textContent = text;
      li.append(span);
    });
    list.append(li);
    while (list.children.length > MAX_LOG_LINES) list.firstElementChild!.remove();
    list.scrollTop = list.scrollHeight;
  });
}

/** One frame of an ASCII radar sweep (purely decorative standby animation). */
export function radarFrame(angle: number, cols = 27, rows = 13): string {
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  let out = '';
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const dx = (c - cx) / cx;
      const dy = (r - cy) / cy;
      const d = Math.hypot(dx, dy);
      const behind = (((angle - Math.atan2(dy, dx)) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      let ch = ' ';
      if (Math.abs(d - 1) < 0.08) ch = '·';
      else if (Math.abs(d - 0.5) < 0.06) ch = '·';
      else if (d < 1 && behind < 0.12) ch = '█';
      else if (d < 1 && behind < 0.45) ch = '▓';
      else if (d < 1 && behind < 0.9) ch = '░';
      else if (r === Math.round(cy) && d < 1) ch = '-';
      else if (c === Math.round(cx) && d < 1) ch = '¦';
      out += ch;
    }
    out += '\n';
  }
  return out;
}
