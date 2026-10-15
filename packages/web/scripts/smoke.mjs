#!/usr/bin/env node
// Smoke-checks a deployed build: boots FreeDOS(98) in Chromium from the given URL.
// Usage: node scripts/smoke.mjs https://pc98.crafter.games/
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const url = process.argv[2];
if (!url) throw new Error('usage: smoke.mjs <url>');
const image = fileURLToPath(new URL('../../../fixtures/public/cache/freedos98-2hd.hdm', import.meta.url));

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.pc98, null, { timeout: 30_000 });
  await page.setInputFiles('label.drive:first-of-type input', image);
  await page.getByRole('button', { name: /Encender/ }).click();
  await page.waitForFunction(() => /A:\\>/.test(window.pc98.textScreen()), null, { timeout: 60_000 });
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log(`ok: FreeDOS(98) booted at ${url}`);
} finally {
  await browser.close();
}
