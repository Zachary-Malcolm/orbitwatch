import { defineConfig } from 'vite';

export default defineConfig({
  // satellite.js ships an optional multi-threaded WASM propagator whose worker uses
  // top-level await, which the default (iife) worker format can't bundle.
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
