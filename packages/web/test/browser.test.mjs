// Runs the production build in Chromium: real-time boot, and local persistence
// (OPFS + IndexedDB) across page reloads and through export/import.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { chromium } from 'playwright';

const IMAGE = fileURLToPath(new URL('../../../fixtures/public/cache/freedos98-2hd.hdm', import.meta.url));
const skip = existsSync(IMAGE) ? false : 'run `pnpm fixtures` first';
const SHOTS = process.env.PC98_SCREENSHOTS;
const PROMPT = /A:\\>\s*$/m;

let server, browser, url;

before(async () => {
  if (skip) return;
  server = await preview({ root: fileURLToPath(new URL('..', import.meta.url)), preview: { port: 0 }, logLevel: 'silent' });
  url = server.resolvedUrls.local[0];
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
});

// On failure, keep what each open page looked like (CI uploads PC98_SCREENSHOTS).
afterEach(async (t) => {
  if (SHOTS && t.passed === false) {
    let i = 0;
    for (const page of opened) {
      if (!page.isClosed()) await page.screenshot({ path: `${SHOTS}/failed-${t.name.replace(/\W+/g, '-')}-${i++}.png`, fullPage: true }).catch(() => {});
    }
  }
  opened.clear();
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((r) => server.httpServer.close(r));
});

const opened = new Set();
async function open(context) {
  const page = await context.newPage();
  opened.add(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.pc98, null, { timeout: 30_000 });
  return { page, errors };
}

const textScreen = (page) => page.evaluate(() => window.pc98.textScreen());
async function waitText(page, re, timeout = 60_000) {
  try {
    await page.waitForFunction((src) => new RegExp(src, 'm').test(window.pc98.textScreen()), re.source, { timeout, polling: 200 });
  } catch (e) {
    throw new Error(`Timed out waiting for ${re} on screen:\n${await textScreen(page)}`);
  }
}

async function powerOn(page) {
  await page.getByRole('button', { name: /Encender|Continuar/ }).first().click();
  await waitText(page, PROMPT);
}

// Types like a person on a keyboard: shifted characters hold Shift (the
// emulator maps physical keys, as on a real PC-98).
const SHIFTED = { '>': 'Period', '<': 'Comma', '?': 'Slash' };
async function type(page, text) {
  await page.locator('canvas').click();
  for (const ch of text) {
    const code = SHIFTED[ch] ?? (/[A-Z]/.test(ch) ? `Key${ch}` : undefined);
    if (code) {
      await page.keyboard.down('Shift');
      await page.keyboard.press(code);
      await page.keyboard.up('Shift');
    } else {
      await page.keyboard.type(ch);
    }
  }
  await page.keyboard.press('Enter');
}

test('boots FreeDOS(98) in real time from the library', { skip, timeout: 120_000 }, async () => {
  const context = await browser.newContext();
  const { page, errors } = await open(context);
  await page.setInputFiles('input[type=file][multiple]', IMAGE);
  await page.locator('.list strong', { hasText: 'freedos98-2hd.hdm' }).waitFor();

  const t0 = Date.now();
  await powerOn(page);
  const wall = (Date.now() - t0) / 1000;
  const emulated = await page.evaluate(() => window.pc98.elapsedMs / 1000);
  assert.ok(emulated > wall * 0.8, `emulated ${emulated}s in ${wall}s wall: too slow`);

  await type(page, 'ver');
  await waitText(page, /A:\\>ver\s*\n\s*\nFreeCom ver/, 15_000);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/browser-freedos.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
});

test('guest disk writes, mounted disks and quick saves survive a reload', { skip, timeout: 180_000 }, async () => {
  const context = await browser.newContext({ acceptDownloads: true });
  let { page, errors } = await open(context);
  await page.setInputFiles('input[type=file][multiple]', IMAGE);
  await powerOn(page);

  await type(page, 'echo persisted> P.TXT');
  await waitText(page, /echo persisted> P\.TXT\s*\n\s*A:\\>/, 15_000);
  // Write-back is debounced by 1 s.
  await page.getByText(/con partidas guardadas/).waitFor({ timeout: 10_000 });

  await type(page, 'cls');
  await page.waitForTimeout(500);
  await page.locator('canvas').press('Control+Shift+KeyS');
  await page.getByText('Estado guardado').waitFor();
  const savedScreen = await textScreen(page);
  assert.deepEqual(errors, []);

  // Reload: the disk is still in FDD 1 and has the file.
  await page.close();
  ({ page, errors } = await open(context));
  await page.getByRole('combobox', { name: 'Disco en FDD 1' }).filter({ hasText: 'freedos98-2hd.hdm' }).waitFor();
  await powerOn(page);
  await type(page, 'type P.TXT');
  await waitText(page, /^persisted$/, 15_000);

  // The quick save restores the exact screen from before the reload.
  await page.getByRole('button', { name: 'Cargar' }).click();
  await page.getByText('Estado cargado').waitFor();
  await page.waitForTimeout(300);
  assert.equal(await textScreen(page), savedScreen);

  // Export everything, then import it into a fresh browser profile.
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Exportar' }).click()]);
  const zip = join(mkdtempSync(join(tmpdir(), 'pc98-backup-')), 'backup.zip');
  await download.saveAs(zip);
  assert.deepEqual(errors, []);
  await context.close();

  const fresh = await browser.newContext();
  const other = await open(fresh);
  await other.page.locator('input[type=file][accept=".zip"]').setInputFiles(zip);
  await other.page.getByText(/Importados 1 discos y 1 estados/).waitFor();
  await other.page.getByText(/con partidas guardadas/).waitFor();
  await other.page.getByRole('combobox', { name: 'Disco en FDD 1' }).selectOption({ label: 'freedos98-2hd.hdm' });
  await other.page.getByRole('button', { name: 'Reset' }).click();
  await powerOn(other.page);
  await type(other.page, 'type P.TXT');
  await waitText(other.page, /^persisted$/, 15_000);
  if (SHOTS) await other.page.screenshot({ path: `${SHOTS}/browser-imported.png`, fullPage: true });
  assert.deepEqual(other.errors, []);
  await fresh.close();
});

test('works offline, keeps hardware settings, and the virtual keyboard types', { skip, timeout: 180_000 }, async () => {
  const context = await browser.newContext();
  let { page, errors } = await open(context);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.setInputFiles('input[type=file][multiple]', IMAGE);

  // Hardware settings persist and rebuild the machine.
  await page.getByRole('button', { name: 'Ajustes' }).click();
  await page.getByLabel('CPU').selectOption('i286');
  await page.getByRole('button', { name: 'Aplicar y reiniciar' }).click();
  await page.getByText('Máquina reiniciada').waitFor();
  assert.equal(await page.evaluate(() => window.pc98.config.cpu), 'i286');

  // Offline reload: everything comes from the service worker cache and OPFS.
  await context.setOffline(true);
  await page.close();
  ({ page, errors } = await open(context));
  assert.equal(await page.evaluate(() => window.pc98.config.cpu), 'i286');
  await powerOn(page);

  await page.getByRole('button', { name: 'Teclas PC-98' }).click();
  for (const k of ['V', 'E', 'R']) {
    await page.locator('canvas').press(`Key${k}`);
  }
  await page.locator('.vkbd button', { hasText: 'RETURN' }).dispatchEvent('pointerdown', { pointerId: 1 });
  await page.waitForTimeout(150);
  await page.locator('.vkbd button', { hasText: 'RETURN' }).dispatchEvent('pointerup', { pointerId: 1 });
  await waitText(page, /A:\\>ver\s*\n\s*\nFreeCom ver/, 15_000);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/browser-m4.png`, fullPage: true });
  assert.deepEqual(errors, []);
  await context.close();
});
