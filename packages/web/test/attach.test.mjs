// An MCP agent attaches to a real browser tab and plays there in real time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { preview } from 'vite';
import { launchBrowser } from './launch.mjs';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const IMAGE = fileURLToPath(new URL('../../../fixtures/public/cache/freedos98-2hd.hdm', import.meta.url));
const CLI = createRequire(import.meta.url).resolve('pc98-mcp/package.json').replace(/package\.json$/, 'dist/cli.js');
const skip = existsSync(IMAGE) ? false : 'run `pnpm fixtures` first';

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  assert.ok(!res.isError, `${name} failed: ${text}`);
  return { text, image: res.content.find((c) => c.type === 'image') };
}

/** Opens a raw socket to the bridge and reports how it was closed. */
function tryConnect(wsUrl, origin) {
  const token = wsUrl.split('/').pop();
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl.replace(/[^/]+$/, ''), { origin });
    ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token })));
    ws.on('message', (d) => { if (JSON.parse(String(d)).type === 'welcome') { ws.close(); resolve('welcome'); } });
    ws.on('close', (code) => resolve(code));
    ws.on('error', () => {});
  });
}

test('an agent attaches to a browser tab and plays there in real time', { skip, timeout: 180_000 }, async () => {
  const server = await preview({ root: fileURLToPath(new URL('..', import.meta.url)), preview: { port: 0 }, logLevel: 'silent' });
  const appUrl = server.resolvedUrls.local[0];
  const browser = await launchBrowser();
  const client = new Client({ name: 'attach-agent', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [CLI, '--home', fileURLToPath(new URL('../../../node_modules/.cache/pc98-attach-test', import.meta.url)), '--attach-port', '0', '--app-url', appUrl],
    stderr: 'ignore',
  }));
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(appUrl);
    await page.waitForFunction(() => window.pc98);
    await page.setInputFiles('input[type=file][multiple]', IMAGE);
    await page.locator('.list strong', { hasText: 'freedos98-2hd.hdm' }).waitFor();

    // Security: wrong origins are refused before any token check.
    const pairing = await call(client, 'pair_browser');
    const wsUrl = /ws:\/\/127\.0\.0\.1:\d+\/\S+/.exec(pairing.text)[0];
    assert.equal(await tryConnect(wsUrl, 'https://evil.example'), 4003);

    // The user opens the link: the tab attaches with the one-time token.
    const link = /https?:\/\/\S+#agent=\S+/.exec(pairing.text)[0];
    await page.goto(link);
    await page.getByText(/Un agente controla esta pestaña/).waitFor({ timeout: 15_000 });
    assert.equal(await page.evaluate(() => location.hash), '', 'the token is removed from the address bar');
    assert.notEqual(await tryConnect(wsUrl, appUrl.replace(/\/$/, '')), 'welcome', 'the token works only once');

    const status = await call(client, 'status');
    assert.match(status.text, /browser tab at http:\/\/localhost/);
    assert.match(status.text, /"fdd1": "freedos98-2hd.hdm"/);

    // Time passes in real time in the tab; the agent waits for the prompt.
    const t0 = Date.now();
    const booted = await call(client, 'run', { until_text: 'A:\\\\>', seconds: 60 });
    assert.match(booted.text, /the text matched/);
    assert.ok(Date.now() - t0 > 8000, 'booting in a tab takes real time');
    assert.ok(booted.image);

    const ver = await call(client, 'type_text', { text: 'ver\n', wait_seconds: 1 });
    assert.match(ver.text, /A:\\>ver\s*\n\s*\nFreeCom ver/);

    await call(client, 'save_state', { name: 'from-agent' });
    await page.locator('.states .name', { hasText: 'from-agent' }).waitFor();
    assert.match((await call(client, 'list_states')).text, /from-agent .*fdd1=freedos98-2hd\.hdm/);

    const rec = await client.callTool({ name: 'record_audio', arguments: { seconds: 1, name: 'x' } });
    assert.ok(rec.isError, 'recording is headless-only');

    await call(client, 'detach_browser');
    await page.getByText(/Un agente controla/).waitFor({ state: 'detached' });
    assert.match((await call(client, 'status')).text, /headless machine/);
    assert.deepEqual(errors, []);
  } finally {
    await client.close();
    await browser.close();
    await new Promise((r) => server.httpServer.close(r));
  }
});
