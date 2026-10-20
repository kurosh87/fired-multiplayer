import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter, once} from 'node:events';
import Fastify from 'fastify';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import {registerBattleApi} from '../apps/server/src/battle-api.ts';
import {BattleScreenDecoder} from '../packages/battles/screen.ts';
import {DomainError} from '../packages/protocol/index.ts';
import type {BattleSessions} from '../apps/server/src/battle-sessions.ts';
import type {BattleView} from '../packages/battles/protocol.ts';

/** Socket contract only: the battle service is a deterministic fixture, so no
 * original-game pixels, saves or console qualification are implied here. */
const BATTLE='00000000-0000-4000-8000-000000000003';
const ORIGIN='https://kanto-fixture.invalid';
const pixels=(value:number)=>{const bytes=new Uint8Array(240*160*4);bytes.fill(value);return bytes;};
const view=(side:'a'|'b'):BattleView=>({id:BATTLE,side,status:'active',
  playerA:{id:'alice',handle:'Alice',version:'firered'},playerB:{id:'bob',handle:'Bob',version:'leafgreen'},
  rules:{format:'singles',levels:'earned',ranked:false},expiresAt:Date.now()+3_600_000,result:null,watchable:true});

function fixture(){
  return Object.assign(new EventEmitter(),{
    watchCalls:0,inputCalls:0,liveOwners:[] as string[],watchDenied:false,liveDenied:false,
    async liveBattlesFor(owner:string){
      this.liveOwners.push(owner);
      if(this.liveDenied)throw new DomainError('LOBBY_NOT_FOUND','Enter the lobby from your adventure first.',409);
      return [{id:BATTLE,playerA:{handle:'Alice',version:'firered'},
        playerB:{handle:'Bob',version:'leafgreen'},frame:12,startedAt:Date.now()}];
    },
    async list(){return [];},
    async get(){return view('a');},
    async connect(){return {epoch:7,nextSequence:4,frame:12};},
    async screen(){return {frame:12,pixels:pixels(5)};},
    async watch(_owner:string,_id:string,side:'a'|'b'){
      this.watchCalls++;
      if(this.watchDenied)throw new DomainError('WATCH_DISABLED','This trainer has not opened their battle to spectators.',403);
      return {frame:12,pixels:pixels(side==='a'?1:2),battle:view(side)};
    },
    challengeCalls:[] as boolean[],
    async challenge(_owner:string,_peer:string,watchable=false){this.challengeCalls.push(watchable);return view('a');},
    async input(){this.inputCalls++;return {type:'buttons-accepted',protocol:1,sequence:0,operationId:'ignored',frame:12};},
    async disconnect(){},async tick(){},async expire(){},async close(){},
  });
}

class Client{
  readonly socket:WebSocket;
  readonly json:any[]=[];
  readonly binary:Buffer[]=[];
  closed:{code:number;reason:string}|undefined;
  constructor(url:string){
    this.socket=new WebSocket(url,{origin:ORIGIN});
    this.socket.on('message',(data,binary)=>{
      if(binary)this.binary.push(Buffer.from(data as Buffer));
      else this.json.push(JSON.parse(data.toString()));
    });
    this.socket.on('close',(code,reason)=>{this.closed={code,reason:reason.toString()};});
  }
  static async open(url:string){return new Client(url).opened();}
  private async opened(){await once(this.socket,'open');return this;}
  send(value:unknown){this.socket.send(JSON.stringify(value));}
  async waitJson(type:string,timeout=3000){
    const end=Date.now()+timeout;
    while(!this.json.some(value=>value.type===type)){
      assert(Date.now()<end,`No ${type} response`);await new Promise(resolve=>setTimeout(resolve,5));
    }
    return this.json.find(value=>value.type===type);
  }
  async waitBinary(count:number,timeout=3000){
    const end=Date.now()+timeout;
    while(this.binary.length<count){
      assert(Date.now()<end,`Expected ${count} binary packets`);await new Promise(resolve=>setTimeout(resolve,5));
    }
    return this.binary[count-1]!;
  }
  async waitClosed(timeout=3000){
    const end=Date.now()+timeout;
    while(!this.closed){
      assert(Date.now()<end,'The socket did not close');await new Promise(resolve=>setTimeout(resolve,5));
    }
    return this.closed;
  }
}

async function harness(){
  const service=fixture();
  const app=Fastify();await app.register(websocket);
  app.setErrorHandler((error,_request,reply)=>{
    if(error instanceof DomainError)return reply.status(error.status).send({error:error.code,message:error.message});
    return reply.status(500).send({error:'INTERNAL',message:'Fixture failure.'});
  });
  const stop=registerBattleApi(app,service as unknown as BattleSessions,ORIGIN,async authorization=>{
    if(!authorization?.startsWith('Bearer '))throw new DomainError('UNAUTHENTICATED','Authenticate your battle connection.',401);
    return authorization.slice(7);
  });
  app.addHook('onClose',stop);
  const base=await app.listen({host:'127.0.0.1',port:0});
  return {service,app,url:base.replace('http:','ws:')+'/api/battle-play',
    close:async()=>{await app.close();}};
}

test('spectators receive only their chosen side and no owner traffic',async()=>{
  const {service,url,close}=await harness();
  const a=await Client.open(url),b=await Client.open(url);
  try{
    a.send({type:'authenticate',protocol:1,token:'watcher-a',battleId:BATTLE,watch:{side:'a'}});
    b.send({type:'authenticate',protocol:1,token:'watcher-b',battleId:BATTLE,watch:{side:'b'}});
    const readyA=await a.waitJson('ready'),readyB=await b.waitJson('ready');
    assert.equal(readyA.frame,12);assert.equal(readyA.battle.side,'a');assert.equal(readyB.battle.side,'b');
    const decoderA=new BattleScreenDecoder(),decoderB=new BattleScreenDecoder();
    assert(decoderA.apply(await a.waitBinary(1)));assert.equal(decoderA.pixels[0],1);
    assert(decoderB.apply(await b.waitBinary(1)));assert.equal(decoderB.pixels[0],2);
    service.emit('screen',{id:BATTLE,ownerId:'alice',side:0,frame:16,pixels:pixels(9)});
    service.emit('screen',{id:BATTLE,ownerId:'bob',side:1,frame:16,pixels:pixels(10)});
    assert(decoderA.apply(await a.waitBinary(2)));assert(decoderB.apply(await b.waitBinary(2)));
    assert.equal(decoderA.frame,16);assert.equal(decoderB.frame,16);
    assert.equal(decoderA.pixels[0],9);assert.equal(decoderB.pixels[0],10);
    assert.equal(a.binary.length,2);assert.equal(b.binary.length,2);
    assert.equal(service.inputCalls,0);assert.equal(service.watchCalls,2);
  }finally{a.socket.terminate();b.socket.terminate();await close();}
});

test('a battle that has not opted in rejects spectators',async()=>{
  const {service,url,close}=await harness();
  const watcher=await Client.open(url);
  try{
    service.watchDenied=true;
    watcher.send({type:'authenticate',protocol:1,token:'watcher',battleId:BATTLE,watch:{side:'a'}});
    const error=await watcher.waitJson('error');
    assert.equal(error.error,'WATCH_DISABLED');
    assert.equal(error.message,'This trainer has not opened their battle to spectators.');
    assert.equal((await watcher.waitClosed()).code,1008);
    assert.equal(service.watchCalls,1);
  }finally{watcher.socket.terminate();await close();}
});

test('watching is read-only and invalid watch requests are rejected',async()=>{
  const {service,url,close}=await harness();
  const a=await Client.open(url),b=await Client.open(url);
  try{
    a.send({type:'authenticate',protocol:1,token:'watcher',battleId:BATTLE,watch:{side:'a'}});
    await a.waitJson('ready');await a.waitBinary(1);
    a.send({type:'buttons',protocol:1,sequence:0,operationId:'injected',buttons:1});
    assert.equal((await a.waitJson('error')).error,'WATCH_READ_ONLY');
    assert.equal((await a.waitClosed()).code,1008);
    assert.equal(service.inputCalls,0);
    b.send({type:'authenticate',protocol:1,token:'watcher2',battleId:BATTLE,watch:{side:'c'}});
    assert.equal((await b.waitJson('error')).error,'INVALID_WATCH');
    assert.equal((await b.waitClosed()).code,1008);
    assert.equal(service.watchCalls,1,'An invalid side never reached the battle service.');
  }finally{a.socket.terminate();b.socket.terminate();await close();}
});

test('a battle admits at most ten simultaneous watchers',async()=>{
  const {url,close}=await harness(),clients:Client[]=[];
  try{
    for(let index=0;index<10;index++){
      const client=await Client.open(url);clients.push(client);
      client.send({type:'authenticate',protocol:1,token:`watcher-${index}`,battleId:BATTLE,watch:{side:'a'}});
      await client.waitJson('ready');
    }
    const eleventh=await Client.open(url);clients.push(eleventh);
    eleventh.send({type:'authenticate',protocol:1,token:'watcher-11',battleId:BATTLE,watch:{side:'a'}});
    assert.equal((await eleventh.waitJson('error')).error,'WATCH_LIMIT');
    assert.equal((await eleventh.waitClosed()).code,1013);
  }finally{for(const client of clients)client.socket.terminate();await close();}
});

test('one watch connection per account replaces the previous stream',async()=>{
  const {url,close}=await harness();
  const first=await Client.open(url),second=await Client.open(url);
  try{
    first.send({type:'authenticate',protocol:1,token:'same-account',battleId:BATTLE,watch:{side:'a'}});
    await first.waitJson('ready');
    second.send({type:'authenticate',protocol:1,token:'same-account',battleId:BATTLE,watch:{side:'b'}});
    await second.waitJson('ready');
    assert.equal((await first.waitClosed()).code,1008);
    assert.equal(first.closed!.reason,'Watch resumed in another window');
  }finally{first.socket.terminate();second.socket.terminate();await close();}
});

test('finishing rewards watchers with the result and closes them',async()=>{
  const {service,url,close}=await harness();
  const watcher=await Client.open(url);
  try{
    watcher.send({type:'authenticate',protocol:1,token:'watcher',battleId:BATTLE,watch:{side:'a'}});
    await watcher.waitJson('ready');await watcher.waitBinary(1);
    const result={winner:'a',reason:'finished'} as const;
    service.emit('finished',{id:BATTLE,owners:['alice','bob'],result});
    assert.deepEqual(await watcher.waitJson('finished'),{type:'finished',protocol:1,result});
    assert.equal((await watcher.waitClosed()).code,1000);
  }finally{watcher.socket.terminate();await close();}
});

test('a battle that needs recovery closes watchers with 1012',async()=>{
  const {service,url,close}=await harness();
  const watcher=await Client.open(url);
  try{
    watcher.send({type:'authenticate',protocol:1,token:'watcher',battleId:BATTLE,watch:{side:'a'}});
    await watcher.waitJson('ready');
    service.emit('recovery-required',{id:BATTLE,owners:['alice','bob']});
    assert.equal((await watcher.waitClosed()).code,1012);
  }finally{watcher.socket.terminate();await close();}
});

test('watch connections renew authentication without gaining controls',async()=>{
  const {service,url,close}=await harness();
  const watcher=await Client.open(url);
  try{
    watcher.send({type:'authenticate',protocol:1,token:'watcher',battleId:BATTLE,watch:{side:'a'}});
    await watcher.waitJson('ready');
    watcher.send({type:'refresh-auth',protocol:1,token:'watcher'});
    assert.deepEqual(await watcher.waitJson('auth-refreshed'),{type:'auth-refreshed',protocol:1});
    watcher.send({type:'buttons',protocol:1,sequence:0,operationId:'nope',buttons:1});
    assert.equal((await watcher.waitJson('error')).error,'WATCH_READ_ONLY');
    assert.equal(service.inputCalls,0);
  }finally{watcher.socket.terminate();await close();}
});

test('the challenge route validates and forwards the spectator choice',async()=>{
  const {service,app,close}=await harness();
  try{
    const trainer='00000000-0000-4000-8000-000000000004',headers={authorization:'Bearer alice'};
    const malformed=await app.inject({method:'POST',url:'/api/battles/challenge',headers,payload:{trainerId:trainer,watchable:'yes'}});
    assert.equal(malformed.statusCode,400,malformed.body);assert.equal(malformed.json().error,'INVALID_CHALLENGE');
    const extra=await app.inject({method:'POST',url:'/api/battles/challenge',headers,payload:{trainerId:trainer,watchable:true,side:'a'}});
    assert.equal(extra.statusCode,400,extra.body);assert.equal(extra.json().error,'INVALID_CHALLENGE');
    assert.deepEqual(service.challengeCalls,[]);
    assert.equal((await app.inject({method:'POST',url:'/api/battles/challenge',headers,payload:{trainerId:trainer,watchable:true}})).statusCode,200);
    assert.deepEqual(service.challengeCalls,[true]);
    assert.equal((await app.inject({method:'POST',url:'/api/battles/challenge',headers,payload:{trainerId:trainer}})).statusCode,200);
    assert.deepEqual(service.challengeCalls,[true,false],'A missing flag did not default to private.');
  }finally{await close();}
});

test('the live battle list requires authentication, lobby membership and public rows only',async()=>{
  const {service,app,close}=await harness();
  try{
    assert.equal((await app.inject({method:'GET',url:'/api/battles/live'})).statusCode,401);
    const response=await app.inject({method:'GET',url:'/api/battles/live',headers:{authorization:'Bearer watcher'}});
    assert.equal(response.statusCode,200,response.body);
    assert.deepEqual(response.json(),{battles:[{id:BATTLE,playerA:{handle:'Alice',version:'firered'},
      playerB:{handle:'Bob',version:'leafgreen'},frame:12,startedAt:response.json().battles[0].startedAt}]});
    assert(Number.isFinite(response.json().battles[0].startedAt));
    assert(!('artifact' in response.json().battles[0])&&!('seed' in response.json().battles[0]));
    assert.deepEqual(service.liveOwners,['watcher']);
    service.liveDenied=true;
    const denied=await app.inject({method:'GET',url:'/api/battles/live',headers:{authorization:'Bearer watcher'}});
    assert.equal(denied.statusCode,409,denied.body);
    assert.equal(denied.json().error,'LOBBY_NOT_FOUND');
  }finally{await close();}
});
