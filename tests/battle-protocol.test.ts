import {test} from 'node:test';
import assert from 'node:assert/strict';
import {battleInput} from '../packages/battles/protocol.ts';
import {decisionState} from '../apps/server/src/battle-run-store.ts';

test('battle controls reject client authority over frames, outcomes and private consoles',()=>{
  const input={type:'buttons',protocol:1,sequence:0,operationId:'operation',buttons:1};
  assert.deepEqual(battleInput({buttons:1,operationId:'operation',sequence:0,protocol:1,type:'buttons'}),input);
  for(const extra of [{frame:999},{winner:'a'},{opponentButtons:1},{snapshot:[1]},{choice:{kind:'move',slot:0}}])
    assert.throws(()=>battleInput({...input,...extra}),{code:'INVALID_BATTLE_INPUT'});
  for(const buttons of [-1,1024,1.5,NaN,'1'])assert.throws(()=>battleInput({...input,buttons}),{code:'INVALID_BATTLE_INPUT'});
});

test('private decision metadata canonicalizes Postgres JSON and rejects ambiguous deadlines',()=>{
  assert.deepEqual(decisionState({deadline:90000,epoch:1,mask:3,kind:'turn'}),{kind:'turn',mask:3,epoch:1,deadline:90000});
  for(const value of [{kind:null,mask:1,epoch:0,deadline:null},{kind:'turn',mask:3,epoch:1,deadline:90000.5},
    {kind:'turn',mask:3,epoch:1,deadline:null},{kind:'turn',mask:3,epoch:-1,deadline:90000}])
    assert.throws(()=>decisionState(value),{code:'INVALID_BATTLE_STATE'});
});
