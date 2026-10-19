import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeGameName } from '../packages/engine/game-text.ts';

test('original English name glyphs decode as presentation text and stop at the game terminator', () => {
  assert.equal(decodeGameName(new Uint8Array([0xbb, 0xd5, 0xa1, 0x1b, 0xb5, 0xff, 0xbc])), 'Aa0é♂');
  assert.equal(decodeGameName(new Uint8Array([0xf5, 0xf6, 0xb6, 0xff])), 'öü♀');
});
test('name decoding is bounded and does not treat game spaces as NUL terminators', () => {
  assert.equal(decodeGameName(new Uint8Array(20).fill(0xbb)), 'AAAAAAAAAA');
  assert.equal(decodeGameName(new Uint8Array([0xbb, 0x00, 0xbc, 0x00, 0xff])), 'A B');
  assert.equal(decodeGameName(new Uint8Array([0xfe, 0xff])), '�');
});
