import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { PC98 } from '../dist/index.js';

const IMAGE = new URL('../../../fixtures/public/cache/freedos98-2hd.hdm', import.meta.url);
const skip = existsSync(IMAGE) ? false : 'run `pnpm fixtures` first';
const EPOCH = Date.UTC(1996, 0, 26, 12, 0, 0);
const PROMPT = /A:\\>\s*$/m;

async function bootToPrompt(cpu) {
  const pc = await PC98.create({ config: { cpu }, epochMs: EPOCH });
  pc.insertDisk('fdd', 0, 'freedos.hdm', new Uint8Array(readFileSync(IMAGE)));
  pc.reset();
  const ok = pc.runUntil((p) => PROMPT.test(p.textScreen()), 56 * 60);
  assert.ok(ok, `no prompt after 60 s:\n${pc.textScreen()}`);
  return pc;
}

for (const cpu of ['i386', 'i286']) {
  test(`${cpu}: boots FreeDOS(98) and runs DIR`, { skip }, async () => {
    const pc = await bootToPrompt(cpu);
    assert.match(pc.textScreen(), /FreeCom/);

    pc.typeText('dir\n');
    const listed = pc.runUntil((p) => /個のファイル/.test(p.textScreen()) && PROMPT.test(p.textScreen()), 56 * 20);
    assert.ok(listed, pc.textScreen());
  });
}

test('save and load state restore the screen and keep running', { skip }, async () => {
  const pc = await bootToPrompt('i386');
  const state = pc.saveState();
  const before = pc.textScreen();

  pc.typeText('ver\n');
  pc.runFrames(120);
  assert.notEqual(pc.textScreen(), before);

  pc.loadState(state);
  pc.runFrames(2);
  assert.equal(pc.textScreen(), before);

  pc.typeText('echo hola\n');
  assert.ok(pc.runUntil((p) => /^hola$/m.test(p.textScreen()), 56 * 5), pc.textScreen());
});

test('is deterministic for a fixed epoch', { skip }, async () => {
  const run = async () => {
    const pc = await bootToPrompt('i386');
    pc.typeText('dir\n');
    pc.runFrames(200);
    return { frames: pc.frames, text: pc.textScreen(), pixels: Buffer.from(pc.screen().rgba).toString('base64') };
  };
  assert.deepEqual(await run(), await run());
});

test('produces audio at the configured rate', { skip }, async () => {
  const pc = await bootToPrompt('i386');
  pc.drainAudio();
  let samples = 0;
  for (let i = 0; i < 56; i++) {
    pc.runFrame();
    samples += pc.drainAudio().length / 2;
  }
  const seconds = samples / pc.sampleRate * (56.42 / 56);
  assert.ok(Math.abs(seconds - 1) < 0.05, `got ${seconds}s of audio for ~1s of emulation`);
});
