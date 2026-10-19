import {test} from 'node:test';
import assert from 'node:assert/strict';
import { BattleScreenEncoder,BattleScreenDecoder,BATTLE_SCREEN_BYTES } from '../packages/battles/screen.ts';

test('battle screen keyframes and sparse tiles preserve every visible pixel, including strided edges',()=> {
  const encode=new BattleScreenEncoder(),decode=new BattleScreenDecoder();
  const pixels=Uint8Array.from({length:BATTLE_SCREEN_BYTES},(_,i)=>(i*31+Math.floor(i/960))&255);
  assert(decode.apply(encode.encode(pixels,0)!));assert.deepEqual(new Uint8Array(decode.pixels),pixels);
  assert.equal(encode.encode(pixels,1),undefined);
  for(const index of [0,3,239*4,159*960,159*960+239*4+3,9*960+17*4])pixels[index]=pixels[index]!^127;
  const delta=encode.encode(pixels,2)!;
  assert(delta.length<BATTLE_SCREEN_BYTES/10);assert(decode.apply(delta));assert.equal(decode.frame,2);
  assert.deepEqual(new Uint8Array(decode.pixels),pixels);assert.equal(decode.apply(delta),false);
});

test('battle screens copy only the framebuffer view and retain no alias into private core memory',()=> {
  const secret=new TextEncoder().encode('PRIVATE OPPONENT CHOICE AND CORE MEMORY');
  const memory=new Uint8Array(secret.length+BATTLE_SCREEN_BYTES+secret.length);memory.set(secret);memory.set(secret,secret.length+BATTLE_SCREEN_BYTES);
  const pixels=memory.subarray(secret.length,secret.length+BATTLE_SCREEN_BYTES);pixels.fill(80);
  const encoder=new BattleScreenEncoder(),packet=encoder.encode(pixels,0)!;
  assert.equal(Buffer.from(packet).includes(Buffer.from(secret)),false);
  pixels[100]=99;const delta=encoder.encode(pixels,1)!;assert(delta.length<BATTLE_SCREEN_BYTES);
  const decoder=new BattleScreenDecoder();decoder.apply(packet);assert.equal(decoder.pixels[100],80);
  decoder.apply(delta);assert.equal(decoder.pixels[100],99);
});

test('malformed screen deltas never partially update a viewer and a fresh keyframe repairs a missed frame',()=> {
  const encoder=new BattleScreenEncoder(),decoder=new BattleScreenDecoder(),pixels=new Uint8Array(BATTLE_SCREEN_BYTES);
  decoder.apply(encoder.encode(pixels,0)!);pixels[0]=1;pixels[pixels.length-1]=2;
  const delta=encoder.encode(pixels,1)!;
  const initial=decoder.pixels.slice();
  for(const corrupt of [
    (p:Uint8Array)=>p.subarray(0,p.length-1),
    (p:Uint8Array)=>{p[0]=0;return p;},
    (p:Uint8Array)=>{new DataView(p.buffer).setUint16(24+258,0,true);return p;},
    (p:Uint8Array)=>{new DataView(p.buffer).setUint16(24+258,600,true);return p;},
    (p:Uint8Array)=>{new DataView(p.buffer).setUint32(12,9,true);return p;},
  ]){
    assert.throws(()=>decoder.apply(corrupt(delta.slice())));assert.deepEqual(decoder.pixels,initial);assert.equal(decoder.frame,0);
  }
  pixels[500]=3;const later=encoder.encode(pixels,2)!;assert.throws(()=>decoder.apply(later));
  assert(decoder.apply(encoder.encode(pixels,3,true)!));assert.deepEqual(new Uint8Array(decoder.pixels),pixels);
  assert.throws(()=>encoder.encode(pixels,2));
});
