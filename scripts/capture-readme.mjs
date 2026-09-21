// Regenerates the README screenshots and fly-in GIF from the live site.
//
//   npm run capture              (uses the deployed site)
//   npm run capture -- <url>     (any other build, e.g. a `vite preview`)
//
// Drives the locally installed Chrome through Playwright (no browser download), performs the
// same clicks a visitor would, and writes docs/media/*.jpg and docs/media/flyin.gif.
// The pass-predictor shot uses Greenwich as the observer station, never a real location.

import { chromium } from 'playwright-core';
import gifenc from 'gifenc';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { GIFEncoder, quantize, applyPalette } = gifenc;

const SITE = process.argv[2] ?? 'https://zachary-malcolm.github.io/orbitwatch/';
const OUT = fileURLToPath(new URL('../docs/media/', import.meta.url));
const VIEWPORT = { width: 1600, height: 900 };
const GREENWICH = { latDeg: 51.4779, lonDeg: -0.0015, source: 'manual' };

mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({
  channel: 'chrome',
  headless: true,
  args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
page.on('pageerror', (err) => console.error('page error:', err.message));
await page.addInitScript((station) => localStorage.setItem('orbitwatch.observer', JSON.stringify(station)), GREENWICH);

/** Load the site, wait for the catalogue, the close-approach screen and the imagery to settle. */
async function open(hash = '') {
  await page.goto(`${SITE}?capture=${Date.now()}${hash}`);
  await page.waitForFunction(() => document.querySelectorAll('#legend li').length > 0, null, { timeout: 60_000 });
  await page.waitForFunction(() => /FOUND|FAILED/.test(document.getElementById('cj-status').textContent), null, { timeout: 120_000 });
  await sleep(4000);
}

const click = (selector) => page.evaluate((s) => document.querySelector(s).click(), selector);
const wheel = async (delta, times) => {
  const box = await page.locator('#globe canvas').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (let i = 0; i < times; i++) {
    await page.mouse.wheel(0, delta);
    await sleep(60);
  }
};
/** Drag the view (orbit the camera) by dx, dy pixels. */
const drag = async (dx, dy) => {
  const box = await page.locator('#globe canvas').boundingBox();
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) await page.mouse.move(x + (dx * i) / 12, y + (dy * i) / 12);
  await page.mouse.up();
};
/** Scroll a dossier section into view in the right-hand column. */
const reveal = (selector) => page.evaluate((s) => document.querySelector(s).scrollIntoView({ block: 'start' }), selector);
const shot = async (name) => {
  // Park the pointer over a panel so no hover tooltip appears on the globe.
  await page.mouse.move(8, 8);
  await sleep(300);
  await page.screenshot({ path: join(OUT, name), type: 'jpeg', quality: 88 });
  console.log('wrote', name);
};

// 1. Hero: the whole terminal, global phosphor view.
await open();
await shot('hero.jpg');

// 2. Fly-in GIF: the viewport only, from the global view to tracking the ISS.
{
  const box = await page.locator('.viewport').boundingBox();
  const clip = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width) & ~1, height: Math.round(box.height) & ~1 };
  const scale = 2; // halve the resolution to keep the GIF small
  const gif = GIFEncoder();
  const frames = [];
  const record = async (ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const t = Date.now();
      frames.push({ png: await page.screenshot({ clip, type: 'png' }), t });
    }
  };
  await record(900);
  await click('#quick [data-norad="25544"]');
  await record(4200);
  await wheel(-120, 6);
  await page.mouse.move(8, 8);
  await record(2200);
  for (let i = 0; i < frames.length; i++) {
    const img = PNG.sync.read(frames[i].png);
    const w = Math.floor(img.width / scale);
    const h = Math.floor(img.height / scale);
    const rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const s = ((y * scale) * img.width + x * scale) * 4;
        rgba.set(img.data.subarray(s, s + 4), (y * w + x) * 4);
      }
    }
    const palette = quantize(rgba, 128);
    const delay = i + 1 < frames.length ? frames[i + 1].t - frames[i].t : 1200;
    gif.writeFrame(applyPalette(rgba, palette), w, h, { palette, delay });
  }
  gif.finish();
  writeFileSync(join(OUT, 'flyin.gif'), gif.bytes());
  console.log(`wrote flyin.gif (${frames.length} frames)`);
}

// 3. Target dossier: ISS close-up with the NASA model, turned so space is behind it.
await wheel(-120, 4);
await drag(0, -170);
await sleep(2500);
await shot('dossier.jpg');

// 4. True colour: Hubble in NASA imagery.
await open('#norad=20580');
await sleep(3000);
await click('#vis-toggle [data-vis="true"]');
await wheel(-120, 6);
await sleep(4000);
await shot('true-colour.jpg');

// 5. Ground track, footprint and passes over Greenwich (ISS, zoomed out).
await open('#norad=25544');
await sleep(3000);
await wheel(300, 16);
await reveal('#p-body');
await sleep(3000);
await shot('ground-track.jpg');

// 6. Close-approach encounter held at the moment of closest approach.
await open();
await click('#right-tabs [data-tab="conj"]');
await sleep(500);
await shot('conjunctions.jpg');
await click('#cj-list li');
await page.waitForFunction(() => document.getElementById('h-tca').textContent === 'NOW', null, { timeout: 60_000 });
await reveal('#d-encounter');
await sleep(1500);
await shot('encounter.jpg');

await browser.close();
