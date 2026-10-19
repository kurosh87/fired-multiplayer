import {test} from 'node:test';
import assert from 'node:assert/strict';
import {gatewayNodes,gatewayNode,httpRoutingKey,socketRoutingKey,publicGatewayPath,workerArtifactSignature} from '../apps/server/src/gateway-routing.ts';

const a='00000000-0000-4000-8000-000000000001',b='00000000-0000-4000-8000-000000000002',battle='00000000-0000-4000-8000-000000000003';
test('routing configuration accepts only unique stable workers with exact credential-free origins',()=>{
  const nodes=gatewayNodes([{id:'bravo',origin:'http://127.0.0.1:8002/'},{id:'alpha',origin:'https://worker.internal'}]);
  assert.equal(nodes[0]!.id,'alpha');assert.equal(nodes[1]!.origin,'http://127.0.0.1:8002');assert(Object.isFrozen(nodes));
  for(const value of [null,[],[{}],[{id:'a',origin:'file:///tmp/game'}],[{id:'a',origin:'http://user:pass@worker'}],
    [{id:'a',origin:'http://worker/path'}],[{id:'a',origin:'http://worker/?node=other'}],
    [{id:'a',origin:'http://worker/#token'}],[{id:'bad id',origin:'http://worker'}],
    [{id:'a',origin:'http://a'},{id:'a',origin:'http://b'}],[{id:'a',origin:'http://a'},{id:'b',origin:'http://a'}]])assert.throws(()=>gatewayNodes(value));
});

test('readiness fingerprints require both admitted editions and stable artifact identities',()=>{
  const engines=['firered','leafgreen'].map(version=>({version,available:true,manifest:{version,id:version+'-fixture',wasmSha256:'a'.repeat(64)}}));
  const status={protocol:1,accountsConfigured:true,engines};
  assert.equal(workerArtifactSignature(status),workerArtifactSignature({...status,engines:[...engines].reverse()}));
  assert.notEqual(workerArtifactSignature(status),workerArtifactSignature({...status,engines:[engines[0],{...engines[1],manifest:{...engines[1]!.manifest,wasmSha256:'b'.repeat(64)}}]}));
  for(const bad of [null,{}, {...status,protocol:2},{...status,accountsConfigured:false},{...status,engines:[engines[0]]},
    {...status,engines:[engines[0],engines[0]]},{...status,engines:[engines[0],{...engines[1],available:false}]}])assert.equal(workerArtifactSignature(bad),undefined);
});

test('owner routing is order-independent; adding a worker moves keys only to that new worker',()=>{
  const nodes=gatewayNodes([{id:'alpha',origin:'http://a'},{id:'bravo',origin:'http://b'}]);
  const extended=gatewayNodes([...nodes,{id:'charlie',origin:'http://c'}]);let moved=0;
  for(let i=0;i<100;i++){
    const key=`owner:${i}`,old=gatewayNode(nodes,key).id;
    assert.equal(gatewayNode([...nodes].reverse(),key).id,old);
    const next=gatewayNode(extended,key).id;if(next!==old){assert.equal(next,'charlie');moved++;}
  }
  assert(moved>0&&moved<100);
});

test('both battle participants route by battle id; adventure/trade routes use verified owner identity',()=>{
  for(const path of [`/api/battles/${battle}`,`/api/battles/${battle}/accept`,`/api/battles/${battle}/open`,`/api/battles/${battle}/forfeit`])
    assert.equal(httpRoutingKey(path,a),httpRoutingKey(path,b));
  assert.equal(httpRoutingKey('/api/battles/challenge',a),`owner:${a}`);
  assert.equal(httpRoutingKey('/api/battles/live',a),`owner:${a}`,'The live lobby list is owner-scoped, never a battle id.');
  assert.equal(httpRoutingKey('/api/battles/quick',a),`owner:${a}`);
  assert.equal(httpRoutingKey('/api/battles/quick/cancel',a),`owner:${a}`);
  assert.equal(httpRoutingKey('/api/battles',a),`owner:${a}`);
  assert.equal(httpRoutingKey(`/api/trades/${battle}/scene`,a),`owner:${a}`);
  assert.equal(socketRoutingKey('/api/play',a,{type:'authenticate',protocol:1,token:'fixture',sessionId:b,ownerId:b}),`owner:${a}`);
  assert.equal(socketRoutingKey('/api/play',a,{type:'authenticate',protocol:1,token:'fixture',sessionId:b,mode:'trade',tradeId:battle}),`owner:${a}`);
  assert.equal(socketRoutingKey('/api/battle-play',b,{type:'authenticate',protocol:1,token:'fixture',battleId:battle}),`battle:${battle}`);
  assert.equal(socketRoutingKey('/api/battle-play',b,{type:'authenticate',protocol:1,token:'fixture',battleId:battle,watch:{side:'a'}}),`battle:${battle}`,'Spectators follow the battle to its owning worker.');
  assert.equal(socketRoutingKey('/api/lobby-play',a,{type:'authenticate',protocol:1,token:'fixture'}),`owner:${a}`,'The presence stream is owner-scoped.');
  assert.throws(()=>socketRoutingKey('/api/play',a,{type:'input',protocol:1,token:'fixture',sessionId:b}));
  assert.throws(()=>httpRoutingKey('/api/battles/not-an-id',a));
  assert(publicGatewayPath('/api/engines/firered/manifest'));assert(publicGatewayPath(`/api/engines/leafgreen/${'a'.repeat(64)}.wasm`));
  assert(!publicGatewayPath('/api/sessions/private/checkpoint'));assert(!publicGatewayPath('/api/profile'));
});
