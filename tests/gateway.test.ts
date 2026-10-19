import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import {createGateway} from '../apps/server/src/gateway.ts';
import {gatewayNode} from '../apps/server/src/gateway-routing.ts';
import {createAuthenticator} from '../apps/server/src/auth.ts';

const origin='http://gateway-client.invalid',battle='00000000-0000-4000-8000-000000001234';
const nodeIds=['alpha','bravo'];
const ownerFor=(wanted:string)=>{
  for(let i=1;i<100;i++){
    const owner=`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;
    if(gatewayNode(nodeIds.map(id=>({id,origin:`http://${id}`})),`owner:${owner}`).id===wanted)return owner;
  }
  throw new Error('No owner cohort found.');
};

test('gateway proxies authenticated owners to two nodes, co-locates battles and preserves binary frames and raw mutations',async()=>{
  const owners={alice:ownerFor('alpha'),bob:ownerFor('bravo')},backendRequests:{node:string;path:string;forwarded?:string}[]=[];
  let authRequests=0,commits=0,mismatch=false;
  const provider=createServer((request,response)=>{
    authRequests++;response.setHeader('Content-Type','application/json');
    const token=request.headers.authorization?.slice(7),id=token==='alice'||token==='bob'?owners[token]:token==='unconfirmed'?owners.alice:undefined;
    if(request.url!=='/auth/v1/user'||!id){response.writeHead(401);response.end('{}');return;}
    response.end(JSON.stringify({id,aud:'authenticated',email_confirmed_at:token==='unconfirmed'?null:'2026-10-16T00:00:00Z',
      user_metadata:{owner_id:owners.bob,node:'untrusted-choice'},app_metadata:{},identities:[],created_at:'2026-10-16T00:00:00Z'}));
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();assert(address&&typeof address!=='string');
  const authUrl=`http://127.0.0.1:${address.port}`,authorize=createAuthenticator(authUrl,'fixture-public-key');
  const screen=Buffer.alloc(153624,0x36),asset=Buffer.alloc(256*1024,0x72);
  const hash=(data:Uint8Array)=>createHash('sha256').update(data).digest('hex');
  const backends=[];
  for(const id of nodeIds){
    const app=Fastify({trustProxy:['127.0.0.1/32']});await app.register(websocket);
    app.removeContentTypeParser('application/json');app.addContentTypeParser('application/json',{parseAs:'buffer'},(_request,body,done)=>done(null,body));
    app.addHook('onRequest',async request=>{backendRequests.push({node:id,path:request.url,forwarded:request.headers['x-forwarded-for'] as string|undefined});});
    app.get('/readyz',async()=>({ready:true}));
    app.get('/api/status',async()=>({node:id,protocol:1,accountsConfigured:true,engines:['firered','leafgreen'].map(version=>({version,available:true,
      manifest:{version,id:version+'-fixture',wasmSha256:mismatch&&id==='bravo'?'0'.repeat(64):hash(asset)}}))}));
    app.get('/api/engines/firered/artifact',async(_request,reply)=>reply.type('application/wasm').header('Cache-Control','no-store').send(asset));
    app.get(`/api/engines/firered/${hash(asset)}.wasm`,async(_request,reply)=>reply.type('application/wasm').header('Cache-Control','public, max-age=31536000, immutable').send(asset));
    app.all('/api/*',async(request,reply)=>{
      const owner=await authorize(request.headers.authorization);
      if(request.url==='/api/trades/commit-once'){commits++;reply.hijack();reply.raw.destroy();return;}
      return {node:id,owner,path:request.url,body:Buffer.isBuffer(request.body)?request.body.toString():null,
        forwarded:request.headers['x-forwarded-for'],spoofedNode:request.headers['x-worker-node']??null,cookie:request.headers.cookie??null};
    });
    for(const path of ['/api/play','/api/battle-play','/api/lobby-play'])app.get(path,{websocket:true},(socket,request)=>{
      let owner:string|undefined;
      socket.on('message',(raw,binary)=>{
        void(async()=>{
          if(!owner){
            const body=JSON.parse(raw.toString());owner=await authorize(`Bearer ${body.token}`);
            assert.equal(request.headers.origin,origin);assert.equal(request.headers['x-forwarded-for'],'127.0.0.1');
            socket.send(JSON.stringify({type:'ready',node:id,owner,sessionId:body.sessionId,battleId:body.battleId,mode:body.mode}));
            if(path==='/api/battle-play')socket.send(screen,{binary:true});
          }else if(!binary&&JSON.parse(raw.toString()).type==='spam'){
            for(let i=0;i<40;i++)socket.send(screen,{binary:true});
          }else socket.send(raw,{binary});
        })().catch(()=>socket.close(1008,'Denied'));
      });
    });
    const base=await app.listen({host:'127.0.0.1',port:0});backends.push({id,origin:base,app});
  }
  const gateway=await createGateway({origin,nodes:backends.map(({id,origin})=>({id,origin})),supabaseUrl:authUrl,publishableKey:'fixture-public-key'});
  const sockets:WebSocket[]=[];
  try{
    const base=await gateway.listen({host:'127.0.0.1',port:0});
    const request=async(path:string,token:string,body?:string)=>{
      const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${token}`,origin,
        'x-forwarded-for':'203.0.113.99','x-worker-node':'attacker-choice',cookie:'should-not-forward=1',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body})});
      return {status:response.status,headers:response.headers,body:await response.json()};
    };
    for(const [token,owner] of Object.entries(owners)){
      const response=await request('/api/profile',token);assert.equal(response.status,200);
      assert.equal(response.body.node,token==='alice'?'alpha':'bravo');assert.equal(response.body.owner,owner);
      assert.equal(response.body.forwarded,'127.0.0.1');assert.equal(response.body.spoofedNode,null);assert.equal(response.body.cookie,null);
      assert.equal(response.headers.get('access-control-allow-origin'),origin);assert.equal(response.headers.get('cache-control'),'no-store');
    }
    const raw='{ "trainerId" : "'+owners.bob+'", "operationId" : "same-bytes" }';
    const mutation=await request('/api/battles/challenge','alice',raw);assert.equal(mutation.body.node,'alpha');assert.equal(mutation.body.body,raw);
    const live=await request('/api/battles/live','alice');assert.equal(live.body.node,'alpha','The live list is owner-routed, not treated as a battle id.');
    const queued=await request('/api/battles/quick','bob','{}');assert.equal(queued.body.node,'bravo','Quick match is owner-routed, not treated as a battle id.');
    const a=await request(`/api/battles/${battle}/open`,'alice','{}'),b=await request(`/api/battles/${battle}/open`,'bob','{}');assert.equal(a.body.node,b.body.node);
    assert.equal((await request('/api/profile','expired')).status,401);assert.equal((await request('/api/profile','unconfirmed')).status,403);
    const uncertain=await request('/api/trades/commit-once','alice','{}');assert.equal(uncertain.status,503);assert.equal(commits,1);
    const file=await fetch(`${base}/api/engines/firered/${hash(asset)}.wasm`);assert.equal(file.headers.get('cache-control'),'public, max-age=31536000, immutable');
    assert.equal(hash(new Uint8Array(await file.arrayBuffer())),hash(asset));
    assert.equal((await fetch(base+'/readyz')).status,200);
    mismatch=true;assert.equal((await fetch(base+'/readyz')).status,503);mismatch=false;
    const socket=async(path:string,token:string,extra:Record<string,unknown>)=>{
      const connection=new WebSocket(base.replace('http:','ws:')+path,{origin,headers:{'x-forwarded-for':'203.0.113.99'}});sockets.push(connection);
      const messages:{data:Buffer;binary:boolean}[]=[];
      connection.on('message',(data,binary)=>messages.push({data:Buffer.from(data as Buffer),binary}));
      await once(connection,'open');connection.send(JSON.stringify({type:'authenticate',protocol:1,token,...extra}));
      const wait=async(predicate:(message:{data:Buffer;binary:boolean})=>boolean)=>{
        const end=Date.now()+3000;while(!messages.some(predicate)){assert(Date.now()<end,'Gateway socket response timed out.');await new Promise(resolve=>setTimeout(resolve,5));}
        return messages.find(predicate)!;
      };
      const ready=await wait(message=>!message.binary&&JSON.parse(message.data.toString()).type==='ready');
      return {connection,messages,wait,ready:JSON.parse(ready.data.toString())};
    };
    const adventure=await socket('/api/play','alice',{sessionId:battle});assert.equal(adventure.ready.node,'alpha');
    const trade=await socket('/api/play','bob',{sessionId:battle,tradeId:battle,mode:'trade'});assert.equal(trade.ready.node,'bravo');assert.equal(trade.ready.mode,'trade');
    const battleA=await socket('/api/battle-play','alice',{battleId:battle}),battleB=await socket('/api/battle-play','bob',{battleId:battle});
    assert.equal(battleA.ready.node,battleB.ready.node);
    assert.equal(hash((await battleA.wait(message=>message.binary)).data),hash(screen));
    const presence=await socket('/api/lobby-play','alice',{});
    assert.equal(presence.ready.node,'alpha');
    assert.equal(presence.ready.sessionId,undefined);
    presence.connection.send('{"type":"refresh-auth"}');
    assert.equal((await presence.wait(message=>!message.binary&&message.data.toString().includes('refresh-auth'))).data.toString(),'{"type":"refresh-auth"}');
    adventure.connection.send('{"type":"input","sequence":7}');
    assert.equal((await adventure.wait(message=>!message.binary&&message.data.toString().includes('sequence'))).data.toString(),'{"type":"input","sequence":7}');
    const beforeDenied=authRequests;
    const denied=new WebSocket(base.replace('http:','ws:')+'/api/play',{origin:'https://unrelated.invalid'});sockets.push(denied);
    assert.equal((await once(denied,'close'))[0],1008);assert.equal(authRequests,beforeDenied);
    const overloaded=once(adventure.connection,'close');adventure.connection.send('{"type":"spam"}');
    assert.equal((await overloaded)[0],1013,'A relay must close instead of accumulating screen buffers.');
    for(const request of backendRequests)assert(!request.path.includes('token='));
    const stopped=[trade.connection,battleA.connection,battleB.connection,presence.connection].map(connection=>once(connection,'close'));
    await gateway.close();for(const closed of await Promise.all(stopped))assert.equal(closed[0],1001);
  }finally{
    for(const socket of sockets)socket.terminate();await gateway.close();
    for(const backend of backends)await backend.app.close();
    await new Promise<void>(resolve=>provider.close(()=>resolve()));
  }
});
