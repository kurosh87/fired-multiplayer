import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import Fastify,{type FastifyInstance} from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import {registerLobbyApi,type LobbyPresenceLike} from '../apps/server/src/lobby-api.ts';
import type {LobbyPresenceMessage} from '../apps/server/src/lobby-presence.ts';
import {DomainError,type LobbyTrainer} from '../packages/protocol/index.ts';
import type {LiveBattle} from '../packages/battles/protocol.ts';

const ORIGIN='https://kanto-fixture.invalid';
const ALICE='00000000-0000-4000-8000-000000000001';
const BOB='00000000-0000-4000-8000-000000000002';

const trainer=(id:string,handle:string,values:Partial<LobbyTrainer>={}):LobbyTrainer=>(
  {id,handle,version:'firered',party:[],maxLevel:null,...values});
const liveBattle=(id:string,frame=0):LiveBattle=>({id,playerA:{handle:'Alice',version:'firered'},
  playerB:{handle:'Bob',version:'leafgreen'},frame,startedAt:1_760_000_000_000});

function fakePresence(trainers:LobbyTrainer[]=[],live?:LiveBattle[]){
  const subscribers=new Set<(message:LobbyPresenceMessage)=>void>();
  const service={
    started:true,
    start:async()=>{},
    snapshot:()=>[...trainers],
    ...(live===undefined?{}:{liveSnapshot:()=>[...live]}),
    subscribe(subscriber:(message:LobbyPresenceMessage)=>void){subscribers.add(subscriber);return()=>{subscribers.delete(subscriber);};},
    emit:(message:LobbyPresenceMessage)=>{for(const subscriber of [...subscribers])subscriber(message);},
  };
  return service;
}

class Client{
  messages:{type:string;error?:string;[key:string]:unknown}[]=[];
  readonly socket:WebSocket;
  readonly closed:Promise<{code:number;reason:string}>;
  constructor(socket:WebSocket){
    this.socket=socket;
    socket.on('message',(data,binary)=>{if(!binary)this.messages.push(JSON.parse(data.toString()));});
    this.closed=new Promise(resolve=>socket.once('close',(code,reason)=>resolve({code,reason:String(reason)})));
  }
  send(body:unknown){this.socket.send(JSON.stringify(body));}
  async wait(type:string,count=1){
    const deadline=Date.now()+3_000;
    const matches=()=>this.messages.filter(message=>message.type===type);
    while(matches().length<count){
      assert(Date.now()<deadline,`No ${type} response`);
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    return matches().at(-1)!;
  }
  quiet(type:string,ms=40){
    return new Promise<void>(resolve=>setTimeout(()=>{
      assert.equal(this.messages.some(message=>message.type===type),false,`Unexpected ${type} message`);
      resolve();
    },ms));
  }
}

async function setup(options:{presence?:LobbyPresenceLike|undefined;ensureLobby?:(ownerId:string)=>Promise<void>}={}){
  const app=Fastify();
  await app.register(websocket);
  const presence=options.presence;
  const stop=registerLobbyApi(app,presence,ORIGIN,async authorization=>{
    const token=authorization?.replace('Bearer ','');
    if(token==='alice')return ALICE;
    if(token==='bob')return BOB;
    if(token==='suspended')throw new DomainError('ACCOUNT_SUSPENDED','This account cannot enter online play.',403);
    throw new DomainError('UNAUTHENTICATED','Sign in again to continue.',401);
  },options.ensureLobby??(async()=>{}));
  app.addHook('onClose',stop);
  const base=await app.listen({host:'127.0.0.1',port:0});
  const open=(origin=ORIGIN)=>{
    const socket=new WebSocket(base.replace('http:','ws:')+'/api/lobby-play',{origin});
    return new Client(socket);
  };
  const clients:Client[]=[];
  return {
    app,
    open:(origin?:string)=>{const client=open(origin);clients.push(client);return client;},
    async close(){for(const client of clients)client.socket.terminate();await app.close();},
  };
}

const authenticate=(client:Client,token='alice')=>
  client.send({type:'authenticate',protocol:1,token});

test('the directory stream syncs without the caller and forwards other trainers',async()=>{
  const presence=fakePresence([
    trainer(ALICE,'Alice'),
    trainer(BOB,'Scout002'),
  ]);
  const {open,close}=await setup({presence});
  const client=open();
  try{
    await once(client.socket,'open');
    authenticate(client);
    await client.wait('ready');
    const sync=await client.wait('sync');
    assert.deepEqual(sync.trainers,[trainer(BOB,'Scout002')],'The caller never sees their own row.');

    presence.emit({type:'put',trainer:trainer(ALICE,'Alice',{maxLevel:9})});
    await client.quiet('put');

    presence.emit({type:'put',trainer:trainer(BOB,'Scout002',{maxLevel:22})});
    const put=await client.wait('put');
    assert.equal(put.protocol,1);
    assert.deepEqual(put.trainer,trainer(BOB,'Scout002',{maxLevel:22}));

    presence.emit({type:'del',ownerId:ALICE});
    await client.quiet('del');
    presence.emit({type:'del',ownerId:BOB});
    assert.deepEqual(await client.wait('del'),{type:'del',protocol:1,ownerId:BOB});

    presence.emit({type:'sync',trainers:[trainer(ALICE,'Alice'),trainer(BOB,'Scout002')]});
    const resync=await client.wait('sync',2);
    assert.deepEqual(resync.trainers,[trainer(BOB,'Scout002')]);
  }finally{
    await close();
  }
});

test('the stream carries the live battle list and its replacements',async()=>{
  const first=liveBattle('00000000-0000-4000-8000-0000000000c1',1);
  const presence=fakePresence([], [first]);
  const {open,close}=await setup({presence});
  const client=open();
  try{
    await once(client.socket,'open');
    authenticate(client);
    await client.wait('ready');
    await client.wait('sync');
    const baseline=await client.wait('live');
    assert.equal(baseline.protocol,1);
    assert.deepEqual(baseline.battles,[first]);
    const second=liveBattle('00000000-0000-4000-8000-0000000000c2',4);
    presence.emit({type:'live',battles:[second]});
    const pushed=await client.wait('live',2);
    assert.deepEqual(pushed.battles,[second],'A started or finished battle replaces the visible list.');
  }finally{
    await close();
  }
});

test('a session that left the lobby closes the stream instead of leaking rows',async()=>{
  const {open,close}=await setup({
    presence:fakePresence(),
    ensureLobby:async()=>{throw new DomainError('LOBBY_NOT_FOUND','Your lobby session has changed. Reopen the lobby.',409);},
  });
  const client=open();
  try{
    await once(client.socket,'open');
    authenticate(client);
    const error=await client.wait('error');
    assert.equal(error.error,'LOBBY_NOT_FOUND');
    assert.equal((await client.closed).code,1008);
  }finally{
    await close();
  }
});

test('bad credentials and bad envelopes fail closed before any data',async()=>{
  const {open,close}=await setup({presence:fakePresence([trainer(BOB,'Scout002')])});
  const suspended=open();
  const expired=open();
  const wrong=open();
  const resume=open();
  try{
    await Promise.all([once(suspended.socket,'open'),once(expired.socket,'open'),once(wrong.socket,'open'),once(resume.socket,'open')]);
    authenticate(suspended,'suspended');
    assert.equal((await suspended.wait('error')).error,'ACCOUNT_SUSPENDED');
    assert.equal((await suspended.closed).code,1008);
    authenticate(expired,'expired');
    assert.equal((await expired.wait('error')).error,'UNAUTHENTICATED');
    assert.equal((await expired.closed).code,1008);
    assert.equal(suspended.messages.some(message=>message.type==='sync'),false);
    wrong.send({type:'authenticate',protocol:1,token:'alice',sessionId:ALICE});
    assert.equal((await wrong.wait('error')).error,'UNAUTHENTICATED');
    assert.equal((await wrong.closed).code,1008);
    resume.send({type:'authenticate',protocol:2,token:'alice'});
    assert.equal((await resume.wait('error')).error,'UNAUTHENTICATED');
    assert.equal((await resume.closed).code,1008);
  }finally{
    await close();
  }
});

test('the stream refuses game input and only renews authentication',async()=>{
  const {open,close}=await setup({presence:fakePresence()});
  const client=open();
  try{
    await once(client.socket,'open');
    authenticate(client);
    await client.wait('ready');
    await client.wait('sync');
    client.send({type:'refresh-auth',protocol:1,token:'alice'});
    assert.deepEqual(await client.wait('auth-refreshed'),{type:'auth-refreshed',protocol:1});
    client.send({type:'refresh-auth',protocol:1,token:'alice',buttons:1});
    assert.equal((await client.wait('error')).error,'INVALID_AUTH_REFRESH');
    assert.equal((await client.closed).code,1008);
  }finally{
    await close();
  }
});

test('a newer window takes over the owner stream',async()=>{
  const {open,close}=await setup({presence:fakePresence([trainer(BOB,'Scout002')])});
  const first=open();
  const second=open();
  try{
    await once(first.socket,'open');await once(second.socket,'open');
    authenticate(first);
    await first.wait('sync');
    authenticate(second);
    await second.wait('sync');
    const closed=await first.closed;
    assert.equal(closed.code,1008);
    assert.equal(closed.reason,'Presence resumed in another window');
    assert.equal(first.messages.some(message=>message.protocol!==1||!['ready','sync'].includes(message.type)),false);
  }finally{
    await close();
  }
});

test('presence is unavailable without a live listener and without the right origin',async()=>{
  const stopped=await setup({presence:{started:false,start:async()=>{throw new Error('The listener is down.');},snapshot:()=>[],subscribe:()=>()=>{}}});
  const missing=await setup({presence:undefined});
  const origin=await setup({presence:fakePresence()});
  try{
    const first=stopped.open();
    await once(first.socket,'open');
    authenticate(first);
    assert.equal((await first.closed).code,1013);
    assert.equal((await first.messages.find(message=>message.type==='error'))?.error,'PRESENCE_UNAVAILABLE');
    const second=missing.open();
    await once(second.socket,'open');
    assert.equal((await second.closed).code,1013);
    const third=origin.open('https://elsewhere.invalid');
    await once(third.socket,'open');
    assert.equal((await third.closed).code,1008);
  }finally{
    await stopped.close();await missing.close();await origin.close();
  }
});
