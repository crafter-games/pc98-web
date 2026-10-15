#!/usr/bin/env node
// Downloads freely redistributable test images into fixtures/public/cache.
// Commercial software never goes here: see fixtures/README.md for private fixtures.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CACHE = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/public/cache');

const FIXTURES = [
  {
    // FreeDOS(98) by the FreeDOS(98) porting project, GPLv2. https://github.com/lpproj/fdkernel
    name: 'freedos98-2hd.hdm',
    url: 'https://github.com/lpproj/fdkernel/releases/download/test-20220120-cherrypick/fd98_2hd144_20220123.zip',
    sha256: 'ad12a889bae25dde5be566fccc44188f21762e241b7ff14ced3d2eac5114f5fa',
    member: 'fd98_2hd.img',
  },
];

mkdirSync(CACHE, { recursive: true });
for (const f of FIXTURES) {
  const out = join(CACHE, f.name);
  if (existsSync(out)) {
    console.log(`ok   ${f.name}`);
    continue;
  }
  console.log(`get  ${f.url}`);
  const res = await fetch(f.url);
  if (!res.ok) throw new Error(`${f.url}: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== f.sha256) throw new Error(`${f.name}: sha256 mismatch (${hash})`);
  const tmp = mkdtempSync(join(tmpdir(), 'pc98-fixture-'));
  const zip = join(tmp, 'download.zip');
  writeFileSync(zip, bytes);
  execFileSync('unzip', ['-o', '-q', zip, f.member, '-d', tmp]);
  copyFileSync(join(tmp, f.member), out);
  console.log(`ok   ${f.name}`);
}
