import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter, once } from 'node:events';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { createAuthenticator } from '../apps/server/src/auth.ts';
import { registerBattleApi } from '../apps/server/src/battle-api.ts';
import type { BattleSessions } from '../apps/server/src/battle-sessions.ts';
import { DomainError } from '../packages/protocol/index.ts';

/** Real WebSocket route and Supabase getUser client; battle state is a small
 * fixture, not original-game or hosted-account qualification. */
for(const scenario of ['renew','account-change','expired','unconfirmed','suspended','injected-controls','rate-limit'] as const)
test(`battle authentication renewal: ${scenario}`,async()=>{
  let authQueries=0,profileQueries=0;
  const provider=createServer((request,response)=>{
    response.setHeader('Content-Type','application/json');authQueries++;
    const value=request.headers.authorization;
    if(value==='Bearer expired'){response.writeHead(401);response.end('{"message":"expired fixture"}');return;}
    response.end(JSON.stringify({id:value==='Bearer bob'?'bob':'alice',aud:'authenticated',email:'auth-fixture@example.invalid',
      email_confirmed_at:value==='Bearer unconfirmed'?null:'2026-10-16T00:00:00Z',app_metadata:{},user_metadata:{},identities:[],created_at:'2026-10-16T00:00:00Z'}));
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const address=provider.address();assert(address&&typeof address!=='string');
  const authenticate=createAuthenticator(`http://127.0.0.1:${address.port}`,'fixture-publishable-key');
  const service=Object.assign(new EventEmitter(),{
    epoch:7,inputCalls:0,connectCalls:0,disconnectCalls:0,
    async get(){return {status:'active'};},
    async connect(){this.connectCalls++;return {epoch:this.epoch,nextSequence:4,frame:12};},
    async screen(){return {pixels:new Uint8Array(240*160*4),frame:12};},
    async input(_owner:string,_battle:string,epoch:number,body:any){assert.equal(epoch,this.epoch);this.inputCalls++;return {type:'buttons-accepted',sequence:body.sequence,operationId:body.operationId};},
    async disconnect(){this.disconnectCalls++;},async tick(){},async expire(){},async close(){},
  });
  const app=Fastify();await app.register(websocket);
  const stop=registerBattleApi(app,service as unknown as BattleSessions,'https://kanto-fixture.invalid',async authorization=>{
    const owner=await authenticate(authorization);profileQueries++;
    if(scenario==='suspended'&&profileQueries>1)throw new DomainError('ACCOUNT_SUSPENDED','This account cannot enter online play.',403);
    return owner;
  });
  app.addHook('onClose',stop);
  let connection:WebSocket|undefined;
  const messages:any[]=[];
  try{
    const base=await app.listen({host:'127.0.0.1',port:0});
    connection=new WebSocket(base.replace('http:','ws:')+'/api/battle-play',{origin:'https://kanto-fixture.invalid'});
    connection.on('message',(data,binary)=>{if(!binary)messages.push(JSON.parse(data.toString()));});
    const waitType=async(type:string)=>{
      const end=Date.now()+3000;
      while(!messages.some(value=>value.type===type)){assert(Date.now()<end,`No ${type} response`);await new Promise(resolve=>setTimeout(resolve,5));}
      return messages.find(value=>value.type===type);
    };
    await once(connection,'open');connection.send(JSON.stringify({type:'authenticate',protocol:1,token:'alice',battleId:'fixture-battle'}));
    await waitType('ready');assert.equal(authQueries,1);assert.equal(profileQueries,1);
    const body:any={type:'refresh-auth',protocol:1,token:scenario==='account-change'?'bob':scenario==='expired'?'expired':scenario==='unconfirmed'?'unconfirmed':'alice'};
    if(scenario==='injected-controls')body.buttons=1;
    const closed=once(connection,'close');connection.send(JSON.stringify(body));
    if(scenario==='renew'||scenario==='rate-limit'){
      assert.deepEqual(await waitType('auth-refreshed'),{type:'auth-refreshed',protocol:1});
      assert.equal(service.connectCalls,1);assert.equal(service.epoch,7);assert.equal(service.inputCalls,0);
      assert.equal(authQueries,2);assert.equal(profileQueries,2);
      if(scenario==='renew'){
        connection.send(JSON.stringify({type:'buttons',protocol:1,sequence:4,operationId:'same-game',buttons:1}));
        assert.equal((await waitType('buttons-accepted')).operationId,'same-game');
        assert.equal(service.inputCalls,1);connection.close();await closed;
      }else{
        connection.send(JSON.stringify(body));await waitType('error');assert.equal((await closed)[0],1008);
        assert.equal(messages.find(value=>value.type==='error').error,'RATE_LIMITED');assert.equal(authQueries,2);
      }
    }else{
      // Pipeline a game command behind the rejected authorization. It must not
      // reach the private battle while the close handshake is in progress.
      connection.send(JSON.stringify({type:'buttons',protocol:1,sequence:4,operationId:'denied',buttons:1}));
      const error=await waitType('error');assert.equal((await closed)[0],1008);
      assert.equal(error.error,{'account-change':'ACCOUNT_CHANGED',expired:'UNAUTHENTICATED',unconfirmed:'EMAIL_UNVERIFIED',suspended:'ACCOUNT_SUSPENDED','injected-controls':'INVALID_AUTH_REFRESH'}[scenario]);
      assert.equal(service.inputCalls,0);assert.equal(service.connectCalls,1);
      assert.equal(authQueries,scenario==='injected-controls'?1:2);
    }
  }finally{
    connection?.terminate();await app.close();await new Promise<void>(resolve=>provider.close(()=>resolve()));
  }
});
