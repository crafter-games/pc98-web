// Drives pc98-mcp over stdio with the official MCP client, like an agent would.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const CACHE = fileURLToPath(new URL('../../../fixtures/public/cache', import.meta.url));
const IMAGE = join(CACHE, 'freedos98-2hd.hdm');
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const skip = existsSync(IMAGE) ? false : 'run `pnpm fixtures` first';
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

async function connect(home, extra = []) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, '--home', home, '--disks', CACHE, '--epoch', '1996-01-26T12:00:00', ...extra],
    stderr: 'ignore',
  });
  const client = new Client({ name: 'test-agent', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const texts = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  assert.ok(!res.isError, `${name} failed: ${texts}`);
  return { ...res, text: texts, images: res.content.filter((c) => c.type === 'image') };
}

test('an agent boots FreeDOS, runs DIR, and its disk writes persist across sessions', { skip, timeout: 120_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), 'pc98-mcp-'));
  const before = sha(IMAGE);

  let client = await connect(home, ['--fdd1', 'freedos98-2hd.hdm']);
  try {
    const { tools } = await client.listTools();
    for (const name of ['screenshot', 'read_text', 'press_key', 'type_text', 'mouse', 'run', 'list_disks', 'insert_disk',
      'eject_disk', 'save_state', 'load_state', 'list_states', 'reset', 'status', 'read_memory', 'write_memory', 'record_audio']) {
      assert.ok(tools.some((t) => t.name === name), `missing tool ${name}`);
    }

    const booted = await call(client, 'run', { until_text: 'A:\\\\>', seconds: 60 });
    assert.match(booted.text, /text matched/);
    assert.equal(booted.images.length, 1);
    assert.equal(booted.images[0].mimeType, 'image/png');

    const dir = await call(client, 'type_text', { text: 'dir\n', wait_seconds: 2 });
    assert.match(dir.text, /個のファイル/);

    await call(client, 'type_text', { text: 'echo agent was here> NOTE.TXT\n', wait_seconds: 3 });
    const status = await call(client, 'status');
    assert.match(status.text, /"fdd1": "freedos98-2hd.hdm"/);

    await call(client, 'save_state', { name: 'prompt' });
    await call(client, 'type_text', { text: 'cls\n', wait_seconds: 1 });
    const loaded = await call(client, 'load_state', { name: 'prompt' });
    assert.equal(loaded.images.length, 1);
    assert.match((await call(client, 'read_text')).text, /NOTE\.TXT/);

    const mem = await call(client, 'read_memory', { address: '0xA0000', length: 32 });
    assert.match(mem.text, /^a0000: /);

    const rec = await call(client, 'record_audio', { seconds: 0.5, name: 'beep' });
    assert.match(rec.text, /Recorded 0\.\d+s/);
    assert.ok(existsSync(join(home, 'recordings', 'beep.wav')));

    const bad = await client.callTool({ name: 'insert_disk', arguments: { drive: 'fdd2', name: 'nope.fdi' } });
    assert.ok(bad.isError);
    assert.match(bad.content[0].text, /Available: .*freedos98-2hd\.hdm/);
  } finally {
    await client.close();
  }

  // The original image is untouched; the write lives in the save overlay.
  assert.equal(sha(IMAGE), before);
  assert.ok(existsSync(join(home, 'saves', 'freedos98-2hd.hdm')));

  client = await connect(home, ['--fdd1', 'freedos98-2hd.hdm']);
  try {
    await call(client, 'run', { until_text: 'A:\\\\>', seconds: 60, screenshot: false });
    const typed = await call(client, 'type_text', { text: 'type NOTE.TXT\n', wait_seconds: 2 });
    assert.match(typed.text, /agent was here/);
    const disks = await call(client, 'list_disks');
    assert.match(disks.text, /freedos98-2hd\.hdm\s+\[fdd, 1232 KB, has saves, in fdd1\]/);
  } finally {
    await client.close();
  }
});
