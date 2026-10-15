import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PC98 } from '../dist/index.js';

// ド = JIS 0x2549 -> left cell [0x25 - 0x20, 0x49]
const cells = (...pairs) => Uint8Array.from(pairs.flat());

test('decodes ANK and both kanji right-half conventions from text VRAM', async () => {
  const pc = await PC98.create({ epochMs: 0 });
  pc.runFrames(5);
  const row = 0xa0000 + 10 * 160;
  pc.writeMemory(row, cells(
    [0x41, 0x00], [0x20, 0x00],
    [0x05, 0x49], [0x05, 0xc9], // right half flagged in the high byte (games)
    [0x05, 0x49], [0x85, 0x49], // right half flagged in the low byte (BIOS)
    [0x05, 0x49], [0x05, 0x49], // right half repeated unchanged
    [0x5c, 0x00], [0xb1, 0x00], // yen sign as backslash, half-width katakana
  ));
  pc.writeMemory(row + 0x2000, new Uint8Array(20).fill(0xe1));
  assert.equal(pc.textScreen().split('\n')[10], 'A ドドド\\ｱ');
});
