import { createHash } from 'node:crypto';
import type { EngineManifest } from '../packages/engine/runtime.ts';

// A tiny real WASM module for testing the runtime contract. This is deliberately
// not Pokémon, is never shipped to the browser, and cannot pass a game audit.
// Input also changes a synthetic flash byte so persistence tests can distinguish
// verified game output from the cartridge originally loaded into the session.
function leb(value: number): number[] {
  const bytes = [];
  do { let byte = value & 0x7f; value >>>= 7; if (value) byte |= 0x80; bytes.push(byte); } while (value);
  return bytes;
}
const string = (value: string): number[] => [...leb(value.length), ...new TextEncoder().encode(value)];
const section = (id: number, bytes: number[]): number[] => [id, ...leb(bytes.length), ...bytes];
const constant = (value: number): number[] => [0x41, ...leb(value)];
const body = (instructions: number[]): number[] => { const bytes = [0, ...instructions, 0x0b]; return [...leb(bytes.length), ...bytes]; };

export function fixtureArtifact(): { bytes: Uint8Array; manifest: EngineManifest } {
  const names = ['kanto_abi_version','kanto_boot','kanto_step','kanto_frame','kanto_state_ptr',
    'kanto_state_size','kanto_flash_ptr','kanto_flash_size','kanto_after_restore',
    'kanto_render_frame','kanto_framebuffer_ptr','kanto_framebuffer_size'];
  const functions = [
    body(constant(1)),
    body([...constant(0),...constant(0),0x36,2,0, ...constant(4),0x20,0,0x36,2,0,...constant(0)]),
    body([...constant(0),...constant(0),0x28,2,0,0x20,1,0x6a,0x36,2,0,
      ...constant(8),...constant(8),0x28,2,0,0x20,0,0x6a,0x20,1,0x6a,0x36,2,0,
      ...constant(65536),0x20,0,0x3a,0,0,...constant(0)]),
    body([...constant(0),0x28,2,0]),
    body(constant(0)), body(constant(196608)), body(constant(65536)), body(constant(131072)), body(constant(0)),
    body(constant(0)), body(constant(196608)), body(constant(153600)),
  ];
  const exports = [...leb(names.length + 1), ...string('memory'),2,0,
    ...names.flatMap((name,index) => [...string(name),0,...leb(index)])];
  const bytes = new Uint8Array([
    0,97,115,109,1,0,0,0,
    ...section(1,[2,0x60,0,1,0x7f,0x60,2,0x7f,0x7f,1,0x7f]),
    ...section(3,[...leb(names.length),0,1,1,0,0,0,0,0,0,0,0,0]),
    ...section(5,[1,0,6]),
    ...section(7,exports),
    ...section(10,[...leb(functions.length),...functions.flat()]),
  ]);
  return { bytes, manifest: { id: 'fixture-only-never-a-game', version: 'firered', revision: 1, abi: 1,
    wasmSha256: createHash('sha256').update(bytes).digest('hex'), upstreamCommit: '0'.repeat(40), status: 'experimental',
    capabilities: { adventure: true, battle: false, trade: false, audio: false } } };
}
