// Real-time check with a real game: Shizuku (Leaf, 1996) from your own dump in
// fixtures/private/shizuku. Skipped when the disks are not there.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { launchBrowser } from './launch.mjs';

const D = fileURLToPath(new URL('../../../fixtures/private/shizuku/', import.meta.url));
const skip = existsSync(`${D}sizuku_a.hdm`) && existsSync(`${D}sizuku_b.hdm`) ? false : 'private Shizuku fixtures not present';

test('Shizuku runs at full speed in the browser and takes keyboard input', { skip, timeout: 120_000 }, async () => {
  const server = await preview({ root: fileURLToPath(new URL('..', import.meta.url)), preview: { port: 0 }, logLevel: 'silent' });
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(server.resolvedUrls.local[0]);
    await page.waitForFunction(() => window.pc98);
    await page.setInputFiles('input[type=file][multiple]', [`${D}sizuku_a.hdm`, `${D}sizuku_b.hdm`]);
    await page.getByRole('button', { name: /Encender/ }).click();

    const sample = () => page.evaluate(() => [performance.now(), window.pc98.elapsedMs]);
    const [w0, e0] = await sample();
    await page.waitForTimeout(15_000);
    const [w1, e1] = await sample();
    const speed = (e1 - e0) / (w1 - w0);
    assert.ok(speed > 0.97, `ran at ${speed.toFixed(3)}x real time`);

    // A quick tap on Enter picks FM on the sound menu; the intro then draws graphics.
    const menu = await page.evaluate(() => window.pc98.screenVersion);
    await page.locator('canvas').press('Enter');
    await page.waitForFunction((v) => window.pc98.screenVersion > v + 30, menu, { timeout: 20_000 });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise((r) => server.httpServer.close(r));
  }
});
