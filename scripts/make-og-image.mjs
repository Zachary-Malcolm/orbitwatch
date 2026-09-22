// Renders the link-preview card (scripts/og-card.html) to public/og-image.jpg at 1200x630,
// the size LinkedIn, iMessage, Slack and others use. Drives a locally installed Chrome.
// Usage: npm run og-image
import { chromium } from 'playwright-core';
import { pathToFileURL } from 'node:url';

const browser = await chromium.launch({ channel: 'chrome' });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.goto(pathToFileURL('scripts/og-card.html').href);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(500);
await page.screenshot({ path: 'public/og-image.jpg', type: 'jpeg', quality: 88 });
await browser.close();
console.log('Wrote public/og-image.jpg');
