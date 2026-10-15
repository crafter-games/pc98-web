// Plays the start of Shizuku (Leaf, 1996) through the MCP server, like an agent.
// Needs your own dump in fixtures/private/shizuku (sizuku_a..e.hdm); skipped otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inflateSync } from 'node:zlib';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const DISKS = fileURLToPath(new URL('../../../fixtures/private/shizuku', import.meta.url));
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const skip = ['a', 'b', 'c'].every((l) => existsSync(join(DISKS, `sizuku_${l}.hdm`))) ? false : 'private Shizuku fixtures not present';
const SHOTS = process.env.PC98_SCREENSHOTS;

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  assert.ok(!res.isError, `${name} failed: ${text}`);
  return { text, image: res.content.find((c) => c.type === 'image') };
}

const pngBytes = (image) => Buffer.from(image.data, 'base64').length;

/** Decodes the server's own PNGs (RGB, filter 0) to raw pixels. */
function pixels(image) {
  const png = Buffer.from(image.data, 'base64');
  const width = png.readUInt32BE(16);
  const idat = [];
  for (let o = 8; o < png.length;) {
    const len = png.readUInt32BE(o);
    if (png.toString('ascii', o + 4, o + 8) === 'IDAT') idat.push(png.subarray(o + 8, o + 8 + len));
    o += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 3 + 1;
  const out = [];
  for (let y = 0; y < raw.length / stride; y++) out.push(raw.subarray(y * stride + 1, (y + 1) * stride));
  return Buffer.concat(out);
}

/** Fraction of differing bytes; blinking cursors change a few hundred pixels. */
function diff(a, b) {
  const pa = pixels(a);
  const pb = pixels(b);
  let n = 0;
  for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) n++;
  return n / pa.length;
}

test('an agent plays Shizuku from power-on to the first dialogue, swapping disks', { skip, timeout: 300_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'pc98-shizuku-'));
  const client = new Client({ name: 'shizuku-agent', version: '0.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [CLI, '--home', home, '--disks', DISKS, '--epoch', '1996-01-26T12:00:00', '--fdd1', 'sizuku_a.hdm', '--fdd2', 'sizuku_b.hdm'],
    stderr: 'ignore',
  }));
  const shot = (name, image) => SHOTS && writeFileSync(join(SHOTS, `shizuku-${name}.png`), Buffer.from(image.data, 'base64'));
  try {
    // Boot to the sound-source menu and pick FM (the default choice).
    const menu = await call(client, 'run', { seconds: 60, until_stable_seconds: 3 });
    shot('1-sound-menu', menu.image);
    await call(client, 'press_key', { key: 'RETURN', wait_seconds: 1 });
    const music = await call(client, 'record_audio', { seconds: 3, name: 'intro' });
    assert.doesNotMatch(music.text, /silent/, 'FM music should be playing');

    // Intro animation, then the title menu.
    const title = await call(client, 'run', { seconds: 60, until_stable_seconds: 4 });
    shot('2-title', title.image);
    const step = async (name, key, wait) => shot(name, (await call(client, 'press_key', { key, wait_seconds: wait, screenshot: true })).image);
    await step('2a-main-menu', 'RETURN', 3);      // title -> main menu
    await step('2b-slots', 'RETURN', 3);          // ゲームを始める
    await step('2c-continue-or-new', 'RETURN', 3); // しおり 1
    await step('2d-new', 'DOWN', 0.5);            // 初めから始める
    await step('2e-confirm', 'RETURN', 0.5);

    // The game asks for disk C in the text layer.
    const ask = await call(client, 'run', { seconds: 30, until_text: 'ディスク\\s*Ｃ', screenshot: false });
    assert.match(ask.text, /text matched/);
    assert.match((await call(client, 'read_text')).text, /ドライブにディスク Ｃ を挿入して下さい/);
    await call(client, 'insert_disk', { drive: 'fdd2', name: 'sizuku_c.hdm' });
    await step('2f-after-disk', 'RETURN', 0.5);

    // First scene: dialogue drawn in graphics; advancing changes it.
    const first = await call(client, 'run', { seconds: 10 });
    shot('3-first-line', first.image);
    assert.ok(pngBytes(first.image) > 20_000, 'expected a full scene on screen');
    await call(client, 'save_state', { name: 'first-line' });

    const next = await call(client, 'press_key', { key: 'RETURN', wait_seconds: 3, screenshot: true });
    shot('4-next-line', next.image);
    assert.ok(diff(next.image, first.image) > 0.01, 'dialogue should advance');

    // The state brings back the exact first line.
    const again = await call(client, 'load_state', { name: 'first-line' });
    assert.ok(diff(again.image, first.image) < 0.005, 'state should restore the first line');
  } finally {
    await client.close();
  }
});
