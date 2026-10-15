// Boots FreeDOS(98) in a real browser from the production build.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';

const IMAGE = fileURLToPath(new URL('../../../fixtures/public/cache/freedos98-2hd.hdm', import.meta.url));
const skip = existsSync(IMAGE) ? false : 'run `pnpm fixtures` first';
const SHOTS = process.env.PC98_SCREENSHOTS;

test('boots FreeDOS(98) in Chromium in real time', { skip, timeout: 120_000 }, async () => {
  const server = await preview({ root: fileURLToPath(new URL('..', import.meta.url)), preview: { port: 0 }, logLevel: 'silent' });
  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() => window.pc98, null, { timeout: 30_000 });

    await page.setInputFiles('label.drive:first-of-type input', IMAGE);
    await page.getByRole('button', { name: /Encender/ }).click();
    const t0 = Date.now();
    await page.waitForFunction(() => /A:\\>/.test(window.pc98.textScreen()), null, { timeout: 60_000, polling: 250 });
    const bootSeconds = (Date.now() - t0) / 1000;

    // Real-time pacing: emulated time should track wall time (FreeDOS needs ~15 s emulated).
    const emulated = await page.evaluate(() => window.pc98.elapsedMs / 1000);
    assert.ok(emulated > bootSeconds * 0.8, `emulated ${emulated}s in ${bootSeconds}s wall: too slow`);

    await page.locator('canvas').click();
    await page.keyboard.type('ver');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => /A:\\>ver\s*\n\s*\nFreeCom ver/.test(window.pc98.textScreen()), null, { timeout: 15_000 });
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/browser-freedos.png` });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((r) => server.httpServer.close(r));
  }
});
