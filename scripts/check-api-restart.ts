import assert from 'node:assert/strict';
import {fork,spawnSync,type ChildProcess} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import {readFile,readdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {setTimeout as sleep} from 'node:timers/promises';
import {gzipSync} from 'node:zlib';
import pg from 'pg';
import {Database} from '../apps/server/src/database.ts';
import {WasmEngine} from '../packages/engine/runtime.ts';
import {FRAME_MILLISECONDS,type GameVersion,type InputBatch} from '../packages/protocol/index.ts';
import {originalGameProvider} from '../tests/original-game-provider.ts';
import {RestartPlayClient} from '../tests/restart-play-client.ts';

const guard=resolve(homedir(),'.local/bin/mini-build-guard');
if(existsSync(guard))assert.equal(spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status,0,'Use the shared build guard.');
const tag=process.env.KANTO_RESTART_EVIDENCE_TAG??'api-restart';assert(/^[a-z0-9-]{1,40}$/.test(tag));
const output=`build/${tag}-report.json`;assert(!existsSync(output),'Preserve retained restart evidence; choose a fresh tag.');
const source=new URL(process.env.DATABASE_TEST_URL!);
assert.equal(source.protocol,'postgresql:');assert.equal(source.hostname,'localhost');assert.equal(source.username,'kanto_test');
assert.equal(source.pathname,'/postgres');assert.equal(source.searchParams.get('host'),resolve('build/postgres-test/socket'));
assert.deepEqual(JSON.parse(await readFile('build/postgres-test/.kanto-test-cluster.json','utf8')),{purpose:'kanto-disposable-contract-tests',major:17});
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const paths=['scripts/check-api-restart.ts','scripts/check-database.py','tests/api-restart-server.ts','tests/restart-play-client.ts','tests/original-game-provider.ts','supabase/schemas/001_kanto.sql',
  ...(await readdir('apps/server/src')).filter(n=>n.endsWith('.ts')).map(n=>`apps/server/src/${n}`),
  ...(await readdir('packages',{recursive:true})).filter(n=>n.endsWith('.ts')).map(n=>`packages/${n}`)];
const sourceSha256=Object.fromEntries(await Promise.all(paths.map(async path=>[path,hash(await readFile(path))])));
const admin=new pg.Client({connectionString:source.href});await admin.connect();
const databaseName=`kanto_restart_${Date.now()}`;await admin.query(`create database ${databaseName}`);
source.pathname=`/${databaseName}`;const database=new Database(source.href);
const origin='http://127.0.0.1:5173',owners=[randomUUID(),randomUUID()],tokens=['restart-alice','restart-bob'];
const versions:GameVersion[]=['firered','leafgreen'];
const provider=createServer((request,response)=>{
  response.setHeader('Content-Type','application/json');const index=tokens.findIndex(token=>request.headers.authorization===`Bearer ${token}`);
  if(request.url!=='/auth/v1/user'||index<0){response.writeHead(401);response.end('{}');return;}
  response.end(JSON.stringify({id:owners[index],aud:'authenticated',email_confirmed_at:'2026-10-16T00:00:00Z',
    app_metadata:{},user_metadata:{},identities:[],created_at:'2026-10-16T00:00:00Z'}));
});
type Child={process:ChildProcess;base:string;events:any[];ask:(operation:string,sessionId?:string)=>Promise<any>};
const children:Child[]=[],peers:RestartPlayClient[]=[],references:WasmEngine[]=[],cases:any[]=[];
let authUrl='';
async function event(child:Child,predicate:(body:any)=>boolean,timeout=15000):Promise<any>{
  const until=Date.now()+timeout;
  while(Date.now()<until){const index=child.events.findIndex(predicate);if(index>=0)return child.events.splice(index,1)[0];
    assert.equal(child.process.exitCode,null,'The test API exited before its expected event.');await sleep(10);}
  throw new Error('Private API process event timed out.');
}
async function start():Promise<Child>{
  const processChild=fork(new URL('../tests/api-restart-server.ts',import.meta.url),[],{execArgv:['--experimental-strip-types'],serialization:'advanced',
    env:{...(process.env.NODE_OPTIONS?{NODE_OPTIONS:process.env.NODE_OPTIONS}:{}),DATABASE_TEST_URL:source.href,
      GAME_WORKER_TRANSPORT:'process',KANTO_TEST_AUTH_URL:authUrl,KANTO_TEST_WEB_ORIGIN:origin},stdio:['ignore','pipe','pipe','ipc']});
  processChild.stdout!.on('data',data=>process.stdout.write(data));processChild.stderr!.on('data',data=>process.stderr.write(data));
  let id=0;
  const child:Child={process:processChild,base:'',events:[],ask:async(operation,sessionId)=>{
    const next=++id;processChild.send({id:next,operation,sessionId});const reply=await event(child,body=>body.event==='reply'&&body.id===next);
    assert(!reply.error,reply.error);return reply.data;}};
  children.push(child);processChild.on('message',body=>child.events.push(body));
  const ready=await event(child,body=>body.event==='listening',30000);assert.equal(ready.pid,processChild.pid);child.base=ready.base;
  assert.equal((await fetch(child.base+'/healthz')).status,200);return child;
}
async function stop(child:Child,signal:'SIGTERM'|'SIGKILL'):Promise<void>{
  if(child.process.exitCode!==null||child.process.signalCode!==null)return;
  const closed=new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error(`API ${signal} did not finish.`)),15000);
    child.process.once('close',()=>{clearTimeout(timer);resolve();});});
  assert(child.process.kill(signal));await closed;
  if(signal==='SIGTERM')assert.equal(child.process.exitCode,0);else assert.equal(child.process.signalCode,signal);
}
async function api(child:Child,index:number,path:string,body?:unknown){
  const response=await fetch(child.base+path,{method:body===undefined?'GET':'POST',signal:AbortSignal.timeout(10000),
    headers:{authorization:`Bearer ${tokens[index]}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  return {status:response.status,body:await response.json() as any};
}
async function boot(child:Child,index:number){const result=await api(child,index,'/api/sessions',{version:versions[index]});assert.equal(result.status,200,JSON.stringify(result.body));return result.body;}
async function connect(child:Child,index:number,sessionId:string){const peer=new RestartPlayClient(child.base,origin);peers.push(peer);await peer.open(tokens[index]!,sessionId);return peer;}
const batch=(id:string,sequence:number,frame:number,frames=16):InputBatch=>({type:'input',protocol:1,sessionId:id,sequence,operationId:randomUUID(),startFrame:frame,runs:[{buttons:0,frames}]});
async function advance(peer:RestartPlayClient,sessionId:string,sequence:number,reference:WasmEngine){
  await sleep(16*FRAME_MILLISECONDS+5);const input=batch(sessionId,sequence,reference.frame);
  const ack=await peer.request(input);assert.equal(ack.type,'verified',JSON.stringify(ack));reference.advance(input.runs);
  assert.equal(ack.frame,reference.frame);assert.equal(ack.digest,reference.digest());return {input,ack};
}
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(error){if((error as NodeJS.ErrnoException).code==='ESRCH')return false;throw error;}};
try{
  await database.pool.query(`do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
  await database.pool.query(await readFile('supabase/schemas/001_kanto.sql','utf8'));
  const registry=await originalGameProvider(false,true),sessionIds:string[]=[];
  for(const [index,version] of versions.entries()){
    await database.pool.query('insert into auth.users(id) values($1)',[owners[index]]);await database.createProfile(owners[index]!,index?'RestartBob':'RestartAlice');
    const report=JSON.parse(await readFile(`build/game-source/${version}/audio-16/audio-report.json`,'utf8'));
    const replay=JSON.parse(await readFile(`tests/replays/${version}-audio-pc-storage.json`,'utf8'));
    const reference=await WasmEngine.create(registry.artifact(version),registry.manifest(version),replay.seed);references.push(reference);
    reference.restore(new Uint8Array(await readFile(`build/game-source/${version}/audio-16/route-audio-pc-desktop.checkpoint`)));
    assert.equal(reference.frame,report.fullAdventureReplayFrames);assert.equal(reference.digest(),report.digest);
    const bridge=JSON.parse(await readFile(`build/adventure-exploration/${version}/storage-field-return/report.json`,'utf8'));
    for(const run of bridge.runs)reference.advance([run]);
    const flash=reference.flash();assert.equal(hash(flash),report.savedPhases.withdraw.flashSha256);
    const id=randomUUID();sessionIds.push(id);
    const saved=(await database.pool.query('update private.adventures set flash=$3 where owner_id=$1 and version=$2 returning id,revision',[owners[index],version,flash])).rows[0];
    await database.pool.query(`insert into private.game_sessions(id,owner_id,adventure_id,artifact_id,seed,base_revision,status,initial_flash,frame,checkpoint,checkpoint_frame,checkpoint_sequence,lease_expires_at)
      values($1,$2,$3,$4,$5,$6,'adventure',$7,$8,$9,$8,0,clock_timestamp()-interval '1 second')`,
      [id,owners[index],saved.id,registry.manifest(version).id,replay.seed,saved.revision,flash,reference.frame,gzipSync(registry.encodeCheckpoint(version,reference.snapshot()),{level:1})]);
  }
  const canonical=(await database.pool.query('select id,revision,flash from private.adventures order by id')).rows;
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();assert(address&&typeof address!=='string');authUrl=`http://127.0.0.1:${address.port}`;
  let child=await start(),sequence=[0,0],last:{input:InputBatch;ack:any}[]=[];
  let clients=await Promise.all(versions.map(async(_,i)=>{const point=await boot(child,i);assert.equal(point.digest,references[i]!.digest());return connect(child,i,point.id);}));
  const next=async(peer:RestartPlayClient,index:number)=>{const value=await advance(peer,sessionIds[index]!,sequence[index]!,references[index]!);sequence[index]=sequence[index]!+1;return value;};
  for(let round=0;round<4;round++)last=await Promise.all(clients.map(next));
  const before=(await database.pool.query('select id,frame,next_sequence,fence,checkpoint_frame from private.game_sessions order by id')).rows;
  assert(before.every(row=>Number(row.frame)>Number(row.checkpoint_frame)),'A real committed journal tail is required.');
  const resources=await child.ask('resources'),workerPids:number[]=resources.flatMap((pool:any)=>pool.workers.map((worker:any)=>worker.pid));
  assert.equal(new Set(workerPids).size,2);assert(workerPids.every(pid=>pid!==child.process.pid));
  await Promise.all(sessionIds.map(id=>child.ask('block-next-append',id)));await sleep(16*FRAME_MILLISECONDS+5);
  const speculative=sessionIds.map((id,i)=>batch(id,sequence[i]!,references[i]!.frame));
  const outcomes=clients.map((peer,i)=>peer.request(speculative[i]).then(()=>true,()=>false));
  for(let i=0;i<2;i++){const blocked=await event(child,body=>body.event==='append-blocked'&&body.sessionId===sessionIds[i]);assert.equal(blocked.frame,references[i]!.frame+16);}
  await stop(child,'SIGKILL');assert.deepEqual(await Promise.all(outcomes),[false,false],'Uncommitted input received a response.');
  const workerDeadline=Date.now()+5000;while(workerPids.some(alive)&&Date.now()<workerDeadline)await sleep(25);
  assert(workerPids.every(pid=>!alive(pid)),'A game process survived the killed API.');
  assert.deepEqual((await database.pool.query('select id,frame,next_sequence,fence,checkpoint_frame from private.game_sessions order by id')).rows,before);
  assert.equal(Number((await database.pool.query('select count(*) as count from private.input_journal where operation_id=any($1::text[])',[speculative.map(input=>input.operationId)])).rows[0].count),0);
  child=await start();
  for(let i=0;i<2;i++){const denied=await api(child,i,'/api/sessions',{version:versions[i]});assert.equal(denied.status,409);assert.equal(denied.body.error,'SESSION_ACTIVE_ELSEWHERE');}
  const waitStarted=Date.now();
  console.log(JSON.stringify({apiRestart:'waiting-for-real-lease-expiry',database:databaseName}));
  while(true){const remaining=Number((await database.pool.query('select greatest(0,extract(epoch from max(lease_expires_at)-clock_timestamp())*1000) as ms from private.game_sessions')).rows[0].ms);
    if(!remaining)break;assert(Date.now()-waitStarted<70000,'Lease did not expire naturally.');await sleep(Math.min(1000,remaining+10));}
  const leaseWaitMs=Date.now()-waitStarted;
  clients=await Promise.all(versions.map(async(_,i)=>{
    const point=await boot(child,i);assert.equal(point.frame,references[i]!.frame);assert.equal(point.digest,references[i]!.digest());assert.equal(point.nextSequence,sequence[i]);
    const peer=await connect(child,i,point.id);assert.deepEqual(await peer.request(last[i]!.input),last[i]!.ack);return peer;
  }));
  const accelerated=await clients[0]!.request(batch(sessionIds[0]!,sequence[0]!,references[0]!.frame,60));
  assert.equal(accelerated.type,'error');assert.equal(accelerated.error,'INPUT_TOO_FAST','Offline lease wait minted game-clock credit.');
  const reconnected=await boot(child,0);assert.equal(reconnected.digest,references[0]!.digest());
  clients[0]=await connect(child,0,reconnected.id);
  for(const [i,peer] of clients.entries())last[i]=await next(peer,i);
  const beforeGraceful=(await database.pool.query('select id,frame,next_sequence,fence from private.game_sessions order by id')).rows;
  await stop(child,'SIGTERM');
  const afterGraceful=(await database.pool.query('select id,frame,next_sequence,fence,checkpoint_frame,checkpoint_sequence,lease_expires_at<=clock_timestamp() as expired from private.game_sessions order by id')).rows;
  for(let i=0;i<2;i++){assert.equal(afterGraceful[i].frame,beforeGraceful[i].frame);assert.equal(afterGraceful[i].checkpoint_frame,afterGraceful[i].frame);
    assert.equal(afterGraceful[i].checkpoint_sequence,afterGraceful[i].next_sequence);assert.equal(afterGraceful[i].expired,true);
    assert.equal(Number(afterGraceful[i].fence),Number(beforeGraceful[i].fence)+1,'Shutdown did not revoke its old writer fence.');}
  assert.deepEqual((await database.pool.query('select id,revision,flash from private.adventures order by id')).rows,canonical);
  child=await start();
  for(const [i,version] of versions.entries()){
    const point=await boot(child,i);assert.equal(point.digest,references[i]!.digest());assert.equal(point.frame,references[i]!.frame);assert.equal(point.nextSequence,sequence[i]);
    const peer=await connect(child,i,point.id);last[i]=await next(peer,i);
    assert.equal((await peer.request({type:'exit'})).type,'exited');
    cases.push({version,artifactId:registry.manifest(version).id,fieldFrameBeforeCrash:Number(before.find(row=>row.id===point.id).frame),finalFrame:references[i]!.frame,
      originalC:true,acknowledgedJournalRecovered:true,unacknowledgedAdvanceDiscarded:true,duplicateAckIdempotent:true,
      postCrashAndGracefulContinuationDigestMatches:true,saveExitAfterRecovery:true});
  }
  await stop(child,'SIGTERM');
  for(const path of paths)assert.equal(hash(await readFile(path)),sourceSha256[path],`Source changed during restart check: ${path}`);
  await writeFile(output,JSON.stringify({measuredAt:new Date().toISOString(),database:databaseName,retainedForInspection:true,sourceSha256,cases,
    transport:'process',apiProcesses:children.map(child=>child.process.pid),killedApiWorkers:workerPids,orphanWorkersAbsent:true,
    speculativeWriteFault:'original C advanced; API killed before real database append',leaseWaitMs,leaseExpiryNotModified:true,
    earlyTakeoverRejected:true,offlineTimeCannotMintClockCredit:true,gracefulShutdownCheckpointsAndExpiresLease:true,shutdownRevokesWriterFence:true,canonicalSavesUnchangedUntilExit:true,
    realPostgres:true,realHttpWebSocket:true,realWallClock:true,auth:'isolated getUser fixture; no hosted signup or email',
    hostingMainEntryQualified:false,battleTradeApiRestartQualified:false,physicalDevicesQualified:false,capacity1000Qualified:false,publicReleaseQualified:false},null,2)+'\n');
  console.log(JSON.stringify({apiRestart:true,output,leaseWaitMs,cases:cases.length}));
}finally{
  for(const peer of peers)peer.terminate();
  for(const child of children)if(child.process.exitCode===null&&child.process.signalCode===null)await stop(child,'SIGKILL');
  for(const reference of references)reference.close();
  await new Promise<void>(resolve=>provider.listening?provider.close(()=>resolve()):resolve());await database.close();await admin.end();
}
