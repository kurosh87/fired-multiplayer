import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_CREDIT, MAX_REQUEST_CREDIT, refillRequestClock, requestClockFrames, spendRequestClock } from '../packages/battles/request-clock.ts';
import { requestBattleInput, encodeBattleResponse, decodeBattleResponse } from '../packages/battles/request-protocol.ts';
import { randomUUID } from 'node:crypto';

test('durable clock keeps fractional GBA credit, caps idle credit and rejects accelerated spending',()=>{
  let clock={atUs:0n,credit:0n};
  for(let step=1;step<=1000;step++)clock=refillRequestClock({...clock},BigInt(step)*1000n);
  assert.equal(requestClockFrames(clock,60),59);
  clock=spendRequestClock(clock,59);assert(clock.credit>0n&&clock.credit<FRAME_CREDIT);
  const restored=refillRequestClock({...clock},clock.atUs);assert.deepEqual(restored,clock);
  assert.throws(()=>spendRequestClock(restored,1));
  const reversed=refillRequestClock(clock,clock.atUs-100n);assert.deepEqual(reversed,clock);
  const idle=refillRequestClock(clock,clock.atUs+10_000_000n);assert.equal(idle.credit,MAX_REQUEST_CREDIT);
  const spent=spendRequestClock(idle,60);assert.equal(spent.credit,15n*FRAME_CREDIT);
  assert.equal(refillRequestClock({...spent},spent.atUs).credit,spent.credit);
});

test('request input is personal, bounded and canonical; response rejects hidden metadata and corrupt lengths',()=>{
  const operationId=randomUUID(),battleId=randomUUID(),controller={connectionId:randomUUID(),epoch:1};
  const input=requestBattleInput({runs:[{frames:1,buttons:1},{buttons:0,frames:14}],sequence:0,operationId,controller,action:'step',protocol:1});
  assert.deepEqual(Object.keys(input),['protocol','operationId','sequence','controller','action','runs']);
  for(const invalid of [{...input,frame:1000},{...input,ownerId:randomUUID()},{...input,runs:[{buttons:0,frames:16}]},
    {...input,runs:[{buttons:1024,frames:1}]},{...input,action:'forfeit'},{...input,sequence:-1},
    {...input,controller:undefined},{...input,controller:{...controller,epoch:0}},{...input,controller:{...controller,ownerId:randomUUID()}}])assert.throws(()=>requestBattleInput(invalid));
  const metadata={protocol:1 as const,battleId,operationId,controller,sequence:0,nextSequence:1,side:'a' as const,frame:1,inputThrough:15,result:null};
  const encoded=encodeBattleResponse(metadata,[new Uint8Array([1,2,3])]);
  const decoded=decodeBattleResponse(encoded);assert.deepEqual(decoded.metadata,metadata);assert.deepEqual([...decoded.packets[0]!],[1,2,3]);
  assert.throws(()=>decodeBattleResponse(encoded.subarray(0,encoded.length-1)));
  const extra=new Uint8Array(encoded.length+1);extra.set(encoded);assert.throws(()=>decodeBattleResponse(extra));
  assert.throws(()=>decodeBattleResponse(encodeBattleResponse({...metadata,opponentButtons:1} as typeof metadata,[])));
});
