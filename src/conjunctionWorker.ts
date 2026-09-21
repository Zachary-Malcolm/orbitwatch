/// <reference lib="webworker" />
import type { ScreenMessage, ScreenRequest } from './conjunctions';
import { screen } from './screening';

// Runs close-approach screening (screening.ts) off the main thread.

const post = (msg: ScreenMessage) => (self as DedicatedWorkerGlobalScope).postMessage(msg);

self.onmessage = (e: MessageEvent<ScreenRequest>) => {
  const result = screen(e.data, (done, total) => post({ type: 'progress', done, total }));
  post({ type: 'result', ...result });
};
