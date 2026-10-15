import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { BrowserBridge } from '../dist/index.js';

const get = (port, path) => new Promise((resolve, reject) => {
  // Raw path on purpose: fetch() would normalize it.
  const req = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body }));
  });
  req.on('error', reject);
  req.end();
});

test('the bridge serves the app on 127.0.0.1 and nothing outside it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'pc98-app-'));
  writeFileSync(join(root, 'index.html'), '<title>app</title>');
  writeFileSync(join(tmpdir(), 'pc98-secret.txt'), 'secret');
  const bridge = new BrowserBridge({ port: 0, appDir: root });
  const pairing = await bridge.pair();
  const port = Number(new URL(pairing.wsUrl.replace('ws:', 'http:')).port);
  try {
    assert.match(pairing.localUrl, /^http:\/\/127\.0\.0\.1:\d+\/#agent=/);
    const index = await get(port, '/');
    assert.equal(index.status, 200);
    assert.match(index.type, /text\/html/);
    for (const path of ['/../pc98-secret.txt', '/..%2fpc98-secret.txt', '/%2e%2e/pc98-secret.txt', '/..%5cpc98-secret.txt']) {
      const r = await get(port, path);
      assert.ok(!r.body.includes('secret'), `${path} leaked a file outside the app`);
    }
  } finally {
    await bridge.close();
  }
});
