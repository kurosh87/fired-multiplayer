import assert from 'node:assert/strict';
import {fork,spawnSync,type ChildProcess} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {readFile,readdir,writeFile,mkdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import pg from 'pg';
import WebSocket from 'ws';
import {Database} from '../apps/server/src/database.ts';
import {createGateway} from '../apps/server/src/gateway.ts';
import {gatewayNodes,gatewayNode} from '../apps/server/src/gateway-routing.ts';
import {WasmEngine} from '../packages/engine/runtime.ts';
import {BattleScreenDecoder} from '../packages/battles/screen.ts';
import {FRAME_MILLISECONDS,type InputBatch} from '../packages/protocol/index.ts';
import {OriginalTradeCore,type PartyMon} from '../packages/trading/original-core.ts';
import {originalGameProvider} from '../tests/original-game-provider.ts';
import {originalGameProgress} from '../tests/original-game-progress.ts';

const guard=resolve(homedir(),'.local/bin/mini-build-guard');
if(existsSync(guard))assert.equal(spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status,0,'Use the shared build guard.');
const tag=process.env.KANTO_GATEWAY_EVIDENCE_TAG;assert(tag&&/^[a-z0-9-]{1,40}$/.test(tag),'Set a fresh evidence tag.');
const output=`build/${tag}-report.json`;assert(!existsSync(output),'Preserve retained gateway evidence.');
assert([undefined,'1'].includes(process.env.KANTO_GATEWAY_BATTLE_TEXT));
const repaired=process.env.KANTO_GATEWAY_BATTLE_TEXT==='1',evidenceDirectory=resolve('build/gateway-qualification',tag);
if(repaired)assert(!existsSync(evidenceDirectory),'Preserve retained post-trade artifacts.');
const source=new URL(process.env.DATABASE_TEST_URL!);
assert.equal(source.protocol,'postgresql:');assert.equal(source.hostname,'localhost');assert.equal(source.username,'kanto_test');
assert.equal(source.pathname,'/postgres');assert.equal(source.searchParams.get('host'),resolve('build/postgres-test/socket'));
assert.deepEqual(JSON.parse(await readFile('build/postgres-test/.kanto-test-cluster.json','utf8')),{purpose:'kanto-disposable-contract-tests',major:17});
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const paths=['scripts/check-gateway-game.ts','scripts/check-database.py','tests/gateway-game-server.ts','tests/original-game-provider.ts','tests/original-game-progress.ts','supabase/schemas/001_kanto.sql',
  ...(await readdir('apps/server/src')).filter(n=>n.endsWith('.ts')).map(n=>`apps/server/src/${n}`),
  ...(await readdir('packages',{recursive:true})).filter(n=>n.endsWith('.ts')).map(n=>`packages/${n}`)];
const sourceSha256=Object.fromEntries(await Promise.all(paths.map(async path=>[path,hash(await readFile(path))])));
const admin=new pg.Client({connectionString:source.href});await admin.connect();
const databaseName=`kanto_gateway_${Date.now()}`;await admin.query(`create database ${databaseName}`);
source.pathname=`/${databaseName}`;const database=new Database(source.href);
const origin='http://127.0.0.1:5173',owners=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
const tokens=['gateway-alice','gateway-bob'],versions=['firered','leafgreen'] as const;
const provider=createServer((request,response)=>{
  response.setHeader('Content-Type','application/json');const side=tokens.findIndex(token=>request.headers.authorization===`Bearer ${token}`);
  if(request.url!=='/auth/v1/user'||side<0){response.writeHead(401);response.end('{}');return;}
  response.end(JSON.stringify({id:owners[side],aud:'authenticated',email_confirmed_at:'2026-10-16T00:00:00Z',
    app_metadata:{},user_metadata:{worker:'forged-node'},identities:[],created_at:'2026-10-16T00:00:00Z'}));
});
async function until(predicate:()=>boolean|Promise<boolean>,description:string,timeout=15_000){
  const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await sleep(20);}throw new Error(`Timed out: ${description}`);
}
class Peer{
  socket:WebSocket;messages:any[]=[];screens=0;decoder=new BattleScreenDecoder();failure:unknown;
  constructor(base:string,battle=false){
    this.socket=new WebSocket(base.replace('http:','ws:')+(battle?'/api/battle-play':'/api/play'),{origin});
    this.socket.on('error',error=>{this.failure=error;});
    this.socket.on('message',(raw,binary)=>{
      try{if(binary){assert(battle);this.decoder.apply(new Uint8Array(raw as Buffer));this.screens++;}
        else this.messages.push(JSON.parse(raw.toString()));}catch(error){this.failure=error;}
    });
  }
  async take(type:string){
    await until(()=>{if(this.failure)throw this.failure;const error=this.messages.find(body=>body.type==='error');assert(!error,JSON.stringify(error));return this.messages.some(body=>body.type===type);},`WebSocket ${type}`);
    return this.messages.splice(this.messages.findIndex(body=>body.type===type),1)[0];
  }
  async open(body:unknown){await until(()=>{assert.notEqual(this.socket.readyState,WebSocket.CLOSED);return this.socket.readyState===WebSocket.OPEN;},'WebSocket open');this.socket.send(JSON.stringify(body));return this.take('ready');}
  async request(body:unknown,type:string){this.socket.send(JSON.stringify(body));return this.take(type);}
}
type Child={process:ChildProcess;base:string;events:any[];requests:{path:string;method:string}[];errors:{level:number;msg?:string}[];ask:()=>Promise<any>};
const children:Child[]=[],peers:Peer[]=[],references:WasmEngine[]=[],tradeReferences:OriginalTradeCore[]=[],cases:any[]=[];
const seedProofs:any[]=[],initialProgress:ReturnType<typeof originalGameProgress>[]=[],originalStarterRecords:Uint8Array[]=[];
let gateway:Awaited<ReturnType<typeof createGateway>>|undefined,base='',authUrl='',phase='setup';
const resources:any[]=[],workerPids=new Set<number>();
async function event(child:Child,predicate:(body:any)=>boolean){
  await until(()=>{assert.equal(child.process.exitCode,null);assert.equal(child.process.signalCode,null);return child.events.some(predicate);},'private API event',30_000);
  return child.events.splice(child.events.findIndex(predicate),1)[0];
}
async function start():Promise<Child>{
  const processChild=fork(new URL('../tests/gateway-game-server.ts',import.meta.url),[],{execArgv:['--experimental-strip-types'],serialization:'advanced',
    env:{...(process.env.NODE_OPTIONS?{NODE_OPTIONS:process.env.NODE_OPTIONS}:{}),DATABASE_TEST_URL:source.href,
      GAME_WORKER_TRANSPORT:'process',KANTO_TEST_AUTH_URL:authUrl,KANTO_TEST_WEB_ORIGIN:origin,
      ...(repaired?{KANTO_GATEWAY_BATTLE_TEXT:'1'}:{})},stdio:['ignore','pipe','pipe','ipc']});
  let id=0;const child:Child={process:processChild,base:'',events:[],requests:[],errors:[],ask:async()=>{
    const next=++id;processChild.send({id:next,operation:'resources'});const reply=await event(child,body=>body.event==='reply'&&body.id===next);assert(!reply.error);return reply.data;
  }};children.push(child);
  let line='';
  processChild.stdout!.on('data',data=>{
    process.stdout.write(data);line+=data.toString();assert(line.length<=1024*1024,'Private API log line exceeded its bound.');
    for(let end;(end=line.indexOf('\n'))>=0;){
      const complete=line.slice(0,end);line=line.slice(end+1);
      try{const entry=JSON.parse(complete);if(entry.level>=50)child.errors.push({level:entry.level,msg:entry.msg});}
      catch{/* Non-JSON startup diagnostics are retained in the outer log. */}
    }
  });
  processChild.stderr!.on('data',data=>process.stderr.write(data));
  processChild.on('message',(body:any)=>{if(body.event==='request')child.requests.push({path:body.path,method:body.method});else child.events.push(body);});
  const ready=await event(child,body=>body.event==='listening');assert.equal(ready.pid,processChild.pid);child.base=ready.base;return child;
}
async function stop(child:Child,signal:'SIGTERM'|'SIGKILL'){
  if(child.process.exitCode!==null||child.process.signalCode!==null)return;
  const closed=new Promise<void>((done,reject)=>{const timer=setTimeout(()=>reject(new Error('API shutdown timed out.')),15_000);
    child.process.once('close',()=>{clearTimeout(timer);done();});});
  assert(child.process.kill(signal));await closed;if(signal==='SIGTERM')assert.equal(child.process.exitCode,0);
}
async function api(side:number,path:string,body?:unknown){
  const response=await fetch(base+path,{method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(15_000),
    headers:{authorization:`Bearer ${tokens[side]}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json() as any;assert.equal(response.status,200,JSON.stringify({path,...result}));return result;
}
const batch=(id:string,sequence:number,frame:number):InputBatch=>({type:'input',protocol:1,sessionId:id,sequence,operationId:randomUUID(),startFrame:frame,runs:[{buttons:0,frames:5}]});
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}};
try{
  await database.pool.query(`do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
  await database.pool.query(await readFile('supabase/schemas/001_kanto.sql','utf8'));
  const registry=await originalGameProvider(false,true,repaired),sessionIds:string[]=[],saves:string[]=[];
  for(const [side,version] of versions.entries()){
    await database.pool.query('insert into auth.users(id) values($1)',[owners[side]]);await database.createProfile(owners[side]!,side?'GatewayBob':'GatewayAlice');
    const folder=`build/adventure-qualification/${version}-brock-v2`;
    const reportPath=repaired?folder+'/report.json':`build/game-source/${version}/audio-16/audio-report.json`;
    const report=JSON.parse(await readFile(reportPath,'utf8'));
    const replay=JSON.parse(await readFile(repaired?folder+'/replay.json':`tests/replays/${version}-audio-pc-storage.json`,'utf8'));
    const reference=await WasmEngine.create(registry.artifact(version),registry.manifest(version),replay.seed);references.push(reference);
    if(repaired){
      assert(report.firstGymQualified&&report.browserQualified&&report.independentGbaReadback);
      assert.equal(report.artifactId,registry.manifest(version).id);assert.equal(report.wasmSha256,hash(registry.artifact(version)));
      reference.restore(registry.decodeCheckpoint(version,new Uint8Array(gunzipSync(await readFile(folder+'/checkpoint.gz')))));
      assert.equal(reference.digest(),report.digest);assert.equal(reference.frame,report.frames);
      assert.equal(hash(reference.flash()),report.flashSha256);
      const progress=originalGameProgress(reference);assert.equal(progress.trades,0);
      for(const name of ['map','position','badges','brockDefeated','brockTrainer','liamDefeated','tm39Received','tm39','teachyTv','balls','pokedex','money','storageSha256'] as const)
        assert.deepEqual(progress[name],report.expected[name]);
      initialProgress.push(progress);seedProofs.push({version,path:reportPath,sha256:hash(await readFile(reportPath)),artifactId:report.artifactId,frame:report.frames});
    }else{
      reference.restore(new Uint8Array(await readFile(`build/game-source/${version}/audio-16/route-audio-pc-desktop.checkpoint`)));
      assert.equal(reference.digest(),report.digest);assert.equal(reference.frame,report.fullAdventureReplayFrames);
      const bridge=JSON.parse(await readFile(`build/adventure-exploration/${version}/storage-field-return/report.json`,'utf8'));
      for(const run of bridge.runs)reference.advance([run]);
      assert.equal(hash(reference.flash()),report.savedPhases.withdraw.flashSha256);
    }
    const flash=reference.flash();
    const saved=(await database.pool.query('update private.adventures set flash=$3 where owner_id=$1 and version=$2 returning id,revision',[owners[side],version,flash])).rows[0];saves.push(saved.id);
    const id=randomUUID();sessionIds.push(id);
    await database.pool.query(`insert into private.game_sessions(id,owner_id,adventure_id,artifact_id,seed,base_revision,status,initial_flash,frame,checkpoint,checkpoint_frame,checkpoint_sequence,lease_expires_at)
      values($1,$2,$3,$4,$5,$6,'adventure',$7,$8,$9,$8,0,clock_timestamp()-interval '1 second')`,
      [id,owners[side],saved.id,registry.manifest(version).id,replay.seed,saved.revision,flash,reference.frame,gzipSync(registry.encodeCheckpoint(version,reference.snapshot()),{level:1})]);
  }
  const canonical=(await database.pool.query('select id,revision,flash from private.adventures order by id')).rows;
  await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));const address=provider.address();assert(address&&typeof address!=='string');authUrl=`http://127.0.0.1:${address.port}`;
  await start();await start();assert.notEqual(children[0]!.process.pid,children[1]!.process.pid);
  const nodes=gatewayNodes(children.map((child,side)=>({id:side?'bravo':'alpha',origin:child.base})));
  assert.equal(gatewayNode(nodes,`owner:${owners[0]}`).id,'alpha');assert.equal(gatewayNode(nodes,`owner:${owners[1]}`).id,'bravo');
  const openGateway=async(reverse=false)=>{
    gateway=await createGateway({origin,nodes:reverse?[...nodes].reverse():nodes,supabaseUrl:authUrl,publishableKey:'gateway-fixture-only'});
    base=await gateway.listen({host:'127.0.0.1',port:0});
    assert.equal((await fetch(base+'/healthz')).status,200);
    // Trusted local provider executes experimental artifacts, but leaves every
    // public release/admission capability unchanged. It must stay unready.
    assert.equal((await fetch(base+'/readyz')).status,503);
  };
  await openGateway();phase='adventures';const last:{input:InputBatch;ack:any}[]=[];
  for(const [side,version] of versions.entries()){
    const boot=await api(side,'/api/sessions',{version});assert.equal(boot.id,sessionIds[side]);assert.equal(boot.digest,references[side]!.digest());
    const response=await fetch(base+`/api/sessions/${boot.id}/checkpoint`,{headers:{authorization:`Bearer ${tokens[side]}`},signal:AbortSignal.timeout(10_000)});
    assert.equal(response.status,200);const packed=new Uint8Array(await response.arrayBuffer());
    references[side]!.restore(registry.decodeCheckpoint(version,packed));assert.equal(references[side]!.digest(),boot.digest);
    const peer=new Peer(base);peers.push(peer);await peer.open({type:'authenticate',protocol:1,token:tokens[side],sessionId:boot.id});
    const input=batch(boot.id,boot.nextSequence,boot.frame),ack=await peer.request(input,'verified');references[side]!.advance(input.runs);
    assert.equal(ack.digest,references[side]!.digest());assert.equal(ack.frame,references[side]!.frame);last.push({input,ack});
    assert.deepEqual(await peer.request(input,'verified'),ack);
    cases.push({version,node:nodes[side]!.id,artifactId:boot.manifest.id,frame:ack.frame,digest:ack.digest,checkpointBytes:packed.byteLength});
  }
  assert.deepEqual((await database.pool.query('select id,revision,flash from private.adventures order by id')).rows,canonical);
  phase='gateway-restart';await gateway!.close();gateway=undefined;
  await until(async()=>Number((await database.pool.query('select count(*)::int as n from private.game_sessions where id=any($1::uuid[]) and lease_expires_at<=clock_timestamp()',[sessionIds])).rows[0].n)===2,'both adventure leases released');
  await openGateway(true);
  for(const [side,version] of versions.entries()){
    const boot=await api(side,'/api/sessions',{version});assert.equal(boot.id,sessionIds[side]);assert.equal(boot.digest,last[side]!.ack.digest);assert.equal(boot.nextSequence,1);
    const peer=new Peer(base);peers.push(peer);await peer.open({type:'authenticate',protocol:1,token:tokens[side],sessionId:boot.id});
    assert.deepEqual(await peer.request(last[side]!.input,'verified'),last[side]!.ack);
    await sleep(150);const input=batch(boot.id,boot.nextSequence,boot.frame),ack=await peer.request(input,'verified');references[side]!.advance(input.runs);
    assert.equal(ack.digest,references[side]!.digest());assert.equal(ack.frame,references[side]!.frame);
    await api(side,`/api/sessions/${boot.id}/lobby`,{});
    cases[side].recoveredFrame=boot.frame;cases[side].continuedFrame=ack.frame;
  }
  phase='lobby-trade-offers';const lobbies=[await api(0,'/api/lobby'),await api(1,'/api/lobby')];
  for(let side=0;side<2;side++){assert(lobbies[side].trainers.some((trainer:any)=>trainer.id===owners[1-side]));assert.equal(lobbies[side].lobby.party.length,2);}
  let trade=await api(0,'/api/trades',{trainerId:owners[1]});
  for(let side=0;side<2;side++){
    const lobby=lobbies[side].lobby,mon=lobby.party[1];
    trade=await api(side,`/api/trades/${trade.id}/offer`,{offerRevision:trade.offerRevision,partySlot:1,pokemonDigest:mon.digest,saveRevision:lobby.saveRevision});
  }
  const peerTrade=await api(0,`/api/trades/${trade.id}`);assert(peerTrade.offerA&&peerTrade.offerB);
  await api(1,`/api/trades/${trade.id}/cancel`,{});
  phase='original-battle';const beforeBattle=(await database.pool.query('select id,revision,flash from private.adventures order by id')).rows;
  const challenge=await api(0,'/api/battles/challenge',{trainerId:owners[1]});const accepted=await api(1,`/api/battles/${challenge.id}/accept`,{});
  assert.equal(accepted.battle.status,'active');const battleNode=gatewayNode(nodes,`battle:${challenge.id}`);
  const viewers:Peer[]=[];
  for(let side=0;side<2;side++){
    const peer=new Peer(base,true);peers.push(peer);viewers.push(peer);
    const ready=await peer.open({type:'authenticate',protocol:1,token:tokens[side],battleId:challenge.id});
    const input={type:'buttons',protocol:1,sequence:ready.nextSequence,operationId:randomUUID(),buttons:0};
    const ack=await peer.request(input,'buttons-accepted');assert.deepEqual(await peer.request(input,'buttons-accepted'),ack);
  }
  await until(()=>viewers.every(peer=>{if(peer.failure)throw peer.failure;return peer.screens>=2&&peer.decoder.frame>accepted.frame;}),'both original battle screens advance');
  const result=await api(0,`/api/battles/${challenge.id}/forfeit`,{});assert.equal(result.reason,'forfeit');
  for(const peer of viewers)await peer.take('finished');
  assert.deepEqual((await database.pool.query('select id,revision,flash from private.adventures order by id')).rows,beforeBattle);
  for(let side=0;side<2;side++)assert((await api(side,'/api/lobby')).lobby);
  await sleep(50);const battlePaths=children.map(child=>child.requests.filter(request=>request.path==='/api/battle-play'));
  const selected=nodes.findIndex(node=>node.id===battleNode.id);assert.equal(battlePaths[selected]!.length,2);assert.equal(battlePaths[1-selected]!.length,0);
  phase='full-trade';const beforeTrade=(await database.pool.query('select id,revision,flash from private.adventures order by id')).rows;
  const originalParties:PartyMon[][]=[];
  for(const [side,version] of versions.entries()){
    const saved=beforeTrade.find(row=>row.id===saves[side]);assert(saved);
    const inspect=await OriginalTradeCore.create(registry.artifact(version),registry.manifest(version),0,saved.flash);
    try{
      originalParties.push(inspect.party());
      if(repaired){assert.deepEqual(originalGameProgress(inspect.engine),initialProgress[side]);originalStarterRecords.push(inspect.monBytes(0));}
    }finally{inspect.close();}
  }
  const identity=(mon:PartyMon)=>({species:mon.species,personality:mon.personality,trainerId:mon.trainerId,level:mon.level,heldItem:mon.heldItem,moves:mon.moves,pp:mon.pp,isEgg:mon.isEgg});
  assert.notDeepEqual(identity(originalParties[0]![1]!),identity(originalParties[1]![1]!));
  trade=await api(0,'/api/trades',{trainerId:owners[1]});
  for(let side=0;side<2;side++){
    const {lobby}=await api(side,'/api/lobby'),mon=lobby.party[1];
    trade=await api(side,`/api/trades/${trade.id}/offer`,{offerRevision:trade.offerRevision,partySlot:1,pokemonDigest:mon.digest,saveRevision:lobby.saveRevision});
  }
  await api(0,`/api/trades/${trade.id}/confirm`,{offerRevision:trade.offerRevision});
  await api(1,`/api/trades/${trade.id}/confirm`,{offerRevision:trade.offerRevision});
  const scenePeers:Peer[]=[],sceneBoots:any[]=[];
  for(const [side,version] of versions.entries()){
    const boot=await api(side,`/api/trades/${trade.id}/scene`,{offerRevision:trade.offerRevision});assert.equal(boot.mode,'trade');sceneBoots.push(boot);
    const response=await fetch(base+`/api/trades/${trade.id}/scene/checkpoint`,{headers:{authorization:`Bearer ${tokens[side]}`},signal:AbortSignal.timeout(10_000)});
    assert.equal(response.status,200);
    const core=await OriginalTradeCore.restore(registry.artifact(version),registry.manifest(version),boot.seed,registry.decodeCheckpoint(version,new Uint8Array(await response.arrayBuffer())));
    tradeReferences.push(core);assert.equal(core.engine.digest(),boot.digest);
    const peer=new Peer(base);peers.push(peer);scenePeers.push(peer);
    await peer.open({type:'authenticate',protocol:1,token:tokens[side],sessionId:boot.id,mode:'trade',tradeId:trade.id});
  }
  const sceneSequences=sceneBoots.map(boot=>boot.nextSequence),sceneCounts=[0,0];
  for(let side=0;side<2;side++){
    const core=tradeReferences[side]!,peer=scenePeers[side]!,boot=sceneBoots[side];
    while(core.phase===2&&core.engine.frame<5000){
      await sleep(15*FRAME_MILLISECONDS+5);
      const start=core.engine.frame,runs=Array.from({length:15},(_,i)=>({buttons:(start+i)%61===0?1:0,frames:1}));
      const input:InputBatch={type:'input',protocol:1,sessionId:boot.id,sequence:sceneSequences[side]!,operationId:randomUUID(),startFrame:start,runs};
      const ack=await peer.request(input,'verified');core.engine.advance(runs);
      assert.equal(ack.digest,core.engine.digest());assert.equal(ack.frame,core.engine.frame);sceneSequences[side]!++;sceneCounts[side]!++;
    }
    assert.equal(core.phase,3,'The original cross-node trade scene did not finish.');
    const finished=await peer.take('trade-scene-done');assert.equal(finished.done,side===1);
    if(side===0)assert.deepEqual((await database.pool.query('select id,revision,flash from private.adventures order by id')).rows,beforeTrade,'One completed scene changed canonical saves.');
  }
  const receipt=await api(0,`/api/trades/${trade.id}/finish`,{});assert.equal(receipt.done,true);assert(receipt.receipt);
  assert.deepEqual(await api(1,`/api/trades/${trade.id}/finish`,{}),receipt);
  const afterTrade=(await database.pool.query('select id,revision,flash from private.adventures order by id')).rows;
  const committed:any[]=[];
  if(repaired)await mkdir(evidenceDirectory,{recursive:true});
  for(const [side,version] of versions.entries()){
    const saved=afterTrade.find(row=>row.id===saves[side]),prior=beforeTrade.find(row=>row.id===saves[side]);assert(saved&&prior);
    assert.equal(Number(saved.revision),Number(prior.revision)+1);assert.deepEqual(saved.flash,Buffer.from(tradeReferences[side]!.engine.flash()));
    const inspect=await OriginalTradeCore.create(registry.artifact(version),registry.manifest(version),0,saved.flash);
    try{
      const party=inspect.party();assert.equal(party.length,2);assert(party.every(mon=>!mon.badEgg));
      assert.deepEqual(identity(party[0]!),identity(originalParties[side]![0]!));
      assert.deepEqual(identity(party[1]!),identity(originalParties[1-side]![1]!));
      let progress:ReturnType<typeof originalGameProgress>|undefined,artifacts:Record<string,string>|undefined;
      if(repaired){
        progress=originalGameProgress(inspect.engine);
        assert.deepEqual({...progress,trades:initialProgress[side]!.trades},initialProgress[side],'Online exchange changed earned progress.');
        assert.equal(progress.trades,initialProgress[side]!.trades+1,'The original game must count exactly one completed trade.');
        assert.deepEqual(inspect.monBytes(0),originalStarterRecords[side],'Trading the caught Pokemon changed the earned starter.');
        const c=inspect.engine.bindExtension<any>('kanto_lobby_save_abi_version',1,[]),m=new DataView(c.memory.buffer);
        const data={cartridge:Buffer.from(saved.flash),party:Buffer.from(c.memory.buffer,c.gPlayerParty.value,200),
          storage:Buffer.from(c.memory.buffer,m.getUint32(c.gPokemonStoragePtr.value,true),0x83d0)};
        artifacts={};for(const [name,bytes] of Object.entries(data)){
          const file=resolve(evidenceDirectory,`${version}-${name}.${name==='cartridge'?'sav':'bin'}`);await writeFile(file,bytes);artifacts[name]=file;artifacts[name+'Sha256']=hash(bytes);
        }
        const continueMovie=JSON.parse(await readFile(`build/adventure-qualification/${version}-brock-v2/continue-party.json`,'utf8'));
        const continuation=resolve(evidenceDirectory,`${version}-continue-party.json`);await writeFile(continuation,JSON.stringify(continueMovie,null,2)+'\n');artifacts.continuation=continuation;
      }
      committed.push({version,revision:Number(saved.revision),flashSha256:hash(saved.flash),party:party.map(identity),...(repaired?{progress,artifacts}:{} )});
    }finally{inspect.close();}
  }
  for(let side=0;side<2;side++){
    assert(children[side]!.requests.some(request=>request.method==='POST'&&request.path==='/api/sessions'));
    const pools=await children[side]!.ask();resources.push({apiPid:children[side]!.process.pid,pools});
    for(const pool of pools)for(const worker of pool.workers){assert.equal(worker.transport,'process');assert.notEqual(worker.pid,children[side]!.process.pid);workerPids.add(worker.pid);}
  }
  phase='cleanup';await gateway!.close();gateway=undefined;
  for(const child of children)await stop(child,'SIGTERM');
  await until(()=>[...workerPids].every(pid=>!alive(pid)),'private worker cleanup');
  assert.deepEqual(children.map(child=>child.errors),[[],[]],'Private APIs logged an error during verified play or shutdown.');
  for(const path of paths)assert.equal(hash(await readFile(path)),sourceSha256[path],`Source changed during gateway qualification: ${path}`);
  await writeFile(output,JSON.stringify({measuredAt:new Date().toISOString(),database:databaseName,retainedForInspection:true,sourceSha256,cases,
    apiProcesses:children.map(child=>child.process.pid),workerPids:[...workerPids],resources,orphanWorkersAbsent:true,apiErrorLogsAbsent:true,
    verifiedOwnersOnDifferentApiProcesses:true,realOriginalC:true,realPostgres:true,realWallClock:true,realHttpWebSocket:true,
    gatewayRestartWithReorderedTopologyRecoversBothAdventures:true,acknowledgedDigestsPreserved:true,duplicateInputsIdempotent:true,
    canonicalUnchangedBeforeLobby:true,crossNodeLobbyVisibility:true,crossNodeTradeOffers:true,tradeMovieAndCommitQualified:true,
    trade:{id:trade.id,scenesOnDifferentApiProcesses:true,frames:tradeReferences.map(core=>core.engine.frame),verifiedBatches:sceneCounts,oneSidedCompletionPreservesBothSaves:true,atomicCommit:true,duplicateFinishIdempotent:true,earnedStartersPreserved:true,distinctCaughtPokemonExchanged:true,committed},
    battle:{id:challenge.id,node:battleNode.id,bothPlayersOnSameApi:true,originalScreensDecoded:true,screenCounts:viewers.map(peer=>peer.screens),frames:viewers.map(peer=>peer.decoder.frame),result,canonicalUnchanged:true,fullBattleFinishQualified:false},
    auth:'isolated confirmed getUser fixture; no hosted signup or email',publicArtifactsStillUnadmitted:true,
    ...(repaired?{repairedBattleText:true,seedProofs,initialProgress,earnedFirstGymProgressPreserved:true,originalTradeCounterIncrementedOnce:true,independentPostTradeGbaReadback:false}:{}),
    hostedDeploymentQualified:false,capacity1000Qualified:false,publicReleaseQualified:false},null,2)+'\n');
  console.log(JSON.stringify({gatewayOriginalGame:true,output,apiProcesses:children.map(child=>child.process.pid),battleNode:battleNode.id}));
}catch(error){
  await writeFile(`build/${tag}-failure.json`,JSON.stringify({phase,database:databaseName,error:String(error),stack:error instanceof Error?error.stack:undefined,requests:children.map(child=>({pid:child.process.pid,requests:child.requests}))},null,2)+'\n');throw error;
}finally{
  for(const peer of peers)peer.socket.terminate();
  await gateway?.close();
  for(const child of children)if(child.process.exitCode===null&&child.process.signalCode===null)await stop(child,'SIGKILL');
  for(const reference of references)reference.close();
  for(const reference of tradeReferences)reference.close();
  await new Promise<void>(done=>provider.listening?provider.close(()=>done()):done());await database.close();await admin.end();
}
