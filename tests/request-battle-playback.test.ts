import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {BattleInputBuffer,RequestBattlePlayback} from '../apps/web/src/lib/request-battle-playback.ts';
import {encodeBattleResponse,type RequestBattleInput} from '../packages/battles/request-protocol.ts';
import {BattleScreenEncoder,BATTLE_SCREEN_BYTES} from '../packages/battles/screen.ts';

test('HTTP viewer bounds queued personal input while preserving one-frame taps and lead limits',()=>{
  const buffer=new BattleInputBuffer();buffer.sample(1);buffer.sample(0);
  for(let index=0;index<28;index++)assert(buffer.sample(0));
  assert.equal(buffer.sample(2),false);
  assert.deepEqual(buffer.take(1),[{buttons:1,frames:1}]);
  assert.deepEqual(buffer.take(),[{buttons:0,frames:15}]);
  buffer.clear();assert.deepEqual(buffer.take(),[]);
});

test('HTTP pictures reject another connection, replayed replies and corrupt packets without rewinding visible state',()=>{
  const battleId=randomUUID(),controller={connectionId:randomUUID(),epoch:2};
  const request=(sequence:number):RequestBattleInput=>({protocol:1,controller,sequence,operationId:randomUUID(),action:'step',runs:[]});
  const viewer=new RequestBattlePlayback(battleId,'a',controller),pixels=new Uint8Array(BATTLE_SCREEN_BYTES);
  const body=(input:RequestBattleInput,frame:number)=>{
    pixels[0]=frame;const encoder=new BattleScreenEncoder();
    return encodeBattleResponse({protocol:1,battleId,controller:input.controller,sequence:input.sequence,nextSequence:input.sequence+1,operationId:input.operationId,side:'a',frame,inputThrough:frame,result:null},[encoder.encode(pixels,frame)!]);
  };
  const first=request(0),initial=body(first,4);assert(viewer.accept(initial,first));assert.equal(viewer.next(0)?.pixels[0],4);
  const newer=request(2);assert(viewer.accept(body(newer,12),newer));
  assert.equal(viewer.pending,true);
  const late=request(1);assert.equal(viewer.accept(body(late,8),late),null);assert.equal(viewer.accept(initial,first),null);
  assert.equal(viewer.next(1000)?.frame,12);assert.equal(viewer.pending,false);assert.equal(viewer.next(2000),undefined);
  const foreign={...request(3),controller:{connectionId:randomUUID(),epoch:3}};
  assert.throws(()=>viewer.accept(body(foreign,16),foreign));
  const next=request(3),valid=body(next,16);
  // A structurally corrupt independent packet must not consume its sequence.
  assert.throws(()=>viewer.accept(valid.subarray(0,valid.length-1),next));
  assert(viewer.accept(valid,next));assert.equal(viewer.next(3000)?.pixels[0],16);
});
