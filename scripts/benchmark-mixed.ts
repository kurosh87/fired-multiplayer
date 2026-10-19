import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {createServer} from 'node:http';
import {cpus,homedir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {performance,monitorEventLoopDelay} from 'node:perf_hooks';
import {setTimeout as sleep} from 'node:timers/promises';
import {gunzipSync} from 'node:zlib';
import pg from 'pg';
import WebSocket from 'ws';
import {Database} from '../apps/server/src/database.ts';
import {createApp} from '../apps/server/src/app.ts';
import {originalGameProvider,originalGameDirectory} from '../tests/original-game-provider.ts';
import {OriginalTradeCore} from '../packages/trading/original-core.ts';
import {BattleScreenDecoder} from '../packages/battles/screen.ts';
import {WasmEngine} from '../packages/engine/runtime.ts';
import {FRAME_MILLISECONDS,type GameVersion} from '../packages/protocol/index.ts';
import {WorkerResourceSampler} from './worker-resource-sampler.ts';
import {privateWorkerTransport} from '../packages/engine/private-worker-transport.ts';

// Only the project-owned Unix-socket test cluster is admitted. This command
// never accepts the application's DATABASE_URL or a hosted project URL.
const guard=join(homedir(),'.local/bin/mini-build-guard');
if(existsSync(guard)&&spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status!==0)throw new Error('Use the shared build guard.');
const transport=privateWorkerTransport(),evidenceTag=process.env.KANTO_BENCH_EVIDENCE_TAG;
if(evidenceTag)assert(/^[a-z0-9-]{1,40}$/.test(evidenceTag));
const reportPath=`build/${evidenceTag?evidenceTag+'-':''}mixed-benchmark.json`;
assert(!existsSync(reportPath),'Preserve retained benchmark evidence; choose a fresh KANTO_BENCH_EVIDENCE_TAG.');
const resourceSampler=new WorkerResourceSampler();
const source=new URL(process.env.DATABASE_TEST_URL??'http://invalid');
assert.equal(source.protocol,'postgresql:');assert.equal(source.username,'kanto_test');
assert.equal(source.hostname,'localhost');assert.equal(source.pathname,'/postgres');
assert.equal(source.searchParams.get('host'),resolve('build/postgres-test/socket'));
assert.deepEqual(JSON.parse(await readFile('build/postgres-test/.kanto-test-cluster.json','utf8')),
  {purpose:'kanto-disposable-contract-tests',major:17});
const durationSeconds=Number(process.env.KANTO_MIXED_SECONDS??45);
assert(Number.isInteger(durationSeconds)&&durationSeconds>=40&&durationSeconds<=180);
const name=`kanto_mixed_${Date.now()}`,admin=new pg.Client({connectionString:source.href});
await admin.connect();
// Retain each small benchmark database for inspection. Never reset or reuse a
// database that might contain evidence from an interrupted run.
await admin.query(`create database ${name}`);
source.pathname=`/${name}`;
const database=new Database(source.href),origin='http://127.0.0.1:5173';
const owners=Array.from({length:8},()=>randomUUID()),tokens=owners.map((_,i)=>`local-mixed-${i}`);
const versions:GameVersion[]=['firered','leafgreen','firered','leafgreen','firered','leafgreen','firered','leafgreen'];
const sockets:Peer[]=[],failures:string[]=[],httpMs:number[]=[],adventureMs:number[]=[],tradeMs:number[]=[],buttonMs:number[]=[],reconnectMs:number[]=[];
let activeConnections=0,peakConnections=0,peakWaiting=0,peakRss=process.memoryUsage().rss,measuring=false;
database.poolEvents.on('acquire',()=>{activeConnections++;if(measuring)peakConnections=Math.max(peakConnections,activeConnections);});
database.poolEvents.on('release',()=>{activeConnections--;});
database.poolEvents.on('error',error=>failures.push(error.message));
const provider=createServer((request,response)=>{
  const index=tokens.findIndex(token=>request.headers.authorization===`Bearer ${token}`);
  response.setHeader('Content-Type','application/json');
  if(request.url!=='/auth/v1/user'||index<0){response.writeHead(401);response.end('{}');return;}
  response.end(JSON.stringify({id:owners[index],aud:'authenticated',email_confirmed_at:'2026-10-16T00:00:00Z',
    app_metadata:{},user_metadata:{},identities:[],created_at:'2026-10-16T00:00:00Z'}));
});
let app:Awaited<ReturnType<typeof createApp>>|undefined,base='',tradeId='',battleId='',metricsTimer:ReturnType<typeof setInterval>|undefined;
const hash=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const sourcePaths=['scripts/worker-resource-sampler.ts','package-lock.json','scripts/benchmark-mixed.ts','scripts/check-database.py','supabase/schemas/001_kanto.sql',
  ...(await readdir('apps/server/src')).filter(n=>n.endsWith('.ts')).map(n=>`apps/server/src/${n}`),
  ...(await readdir('packages',{recursive:true})).filter(n=>n.endsWith('.ts')).map(n=>`packages/${n}`),'tests/original-game-provider.ts'];
const sourceSha256=Object.fromEntries(await Promise.all(sourcePaths.map(async path=>[path,hash(await readFile(path))])));
const batchPeriod=16*FRAME_MILLISECONDS+2;
async function waitUntil(time:number):Promise<void>{while(performance.now()<time)await sleep(Math.max(1,Math.ceil(time-performance.now())));}
const stats=(values:number[])=>{const sorted=values.slice().sort((a,b)=>a-b);return {count:values.length,
  p50:sorted[Math.ceil(sorted.length*.5)-1]??0,p95:sorted[Math.ceil(sorted.length*.95)-1]??0,
  p99:sorted[Math.ceil(sorted.length*.99)-1]??0,max:sorted.at(-1)??0};};
async function api(owner:number,path:string,body?:unknown):Promise<any>{
  const started=performance.now(),response=await fetch(base+path,{method:body===undefined?'GET':'POST',
    signal:AbortSignal.timeout(15_000),headers:{authorization:`Bearer ${tokens[owner]}`,...(body===undefined?{}:{'Content-Type':'application/json'})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  const result=await response.json() as any;if(measuring)httpMs.push(performance.now()-started);
  assert(response.ok,`${path}: ${response.status} ${JSON.stringify(result)}`);return result;
}
class Peer{
  socket:WebSocket;decoder=new BattleScreenDecoder();screenCount=0;screenFrame=0;done=false;
  received:any[]=[];wake:(()=>void)|undefined;error:Error|undefined;closed=false;expectedClose=false;
  constructor(path:string){
    this.socket=new WebSocket(base.replace('http:','ws:')+path,{origin,perMessageDeflate:true,maxPayload:160*1024});sockets.push(this);
    this.socket.on('message',(raw,binary)=>{
      try{
        if(binary){this.decoder.apply(new Uint8Array(raw as Buffer));this.screenCount++;this.screenFrame=this.decoder.frame;return;}
        const body=JSON.parse(raw.toString());
        if(body.type==='error')throw new Error(`${body.error}: ${body.message}`);
        if(body.type==='trade-scene-done'||body.type==='finished')this.done=true;
        this.received.push(body);this.wake?.();
      }catch(error){this.error=error as Error;this.wake?.();}
    });
    this.socket.on('error',error=>{this.error=error;this.wake?.();});
    this.socket.on('close',(code)=>{this.closed=true;if(!this.expectedClose&&code!==1000)this.error??=new Error(`Unexpected socket close ${code}`);this.wake?.();});
  }
  async open(body:unknown):Promise<any>{
    if(this.socket.readyState!==WebSocket.OPEN)await new Promise<void>((resolve,reject)=>{this.socket.once('open',resolve);this.socket.once('error',reject);});
    return this.request(body,'ready');
  }
  async request(body:unknown,type:string):Promise<any>{
    this.socket.send(JSON.stringify(body));const deadline=performance.now()+15_000;
    while(true){
      if(this.error)throw this.error;
      const index=this.received.findIndex(value=>value.type===type);
      if(index>=0)return this.received.splice(index,1)[0];
      assert(!this.closed,`Socket closed before ${type}`);assert(performance.now()<deadline,`Timed out awaiting ${type}`);
      await new Promise<void>(resolve=>{const timer=setTimeout(()=>{this.wake=undefined;resolve();},100);
        this.wake=()=>{clearTimeout(timer);this.wake=undefined;resolve();};});
    }
  }
  async close():Promise<void>{this.expectedClose=true;if(this.closed)return;this.socket.close(1000,'Benchmark reconnect');
    await new Promise<void>(resolve=>this.socket.once('close',()=>resolve()));}
}
try{
  await database.pool.query(`do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;`);
  await database.pool.query(await readFile('supabase/schemas/001_kanto.sql','utf8'));
  const registry=await originalGameProvider(),battleRegistry=await originalGameProvider(true);
  const tradeSaves:Buffer[]=[];
  for(const [side,version] of (['firered','leafgreen'] as const).entries()){
    const stem=`${originalGameDirectory(version)}/exchange-checks/ordinary-${side===0?'a':'b'}`;
    const meta=JSON.parse(await readFile(`${stem}-inputs.json`,'utf8'));
    const core=await OriginalTradeCore.restore(registry.artifact(version),registry.manifest(version),meta.seed,
      registry.decodeCheckpoint(version,gunzipSync(await readFile(`${stem}-start.checkpoint.gz`))));
    try{tradeSaves.push(Buffer.from(core.engine.flash()));}finally{core.close();}
  }
  for(let i=0;i<owners.length;i++){
    await database.pool.query('insert into auth.users(id) values($1)',[owners[i]]);
    await database.createProfile(owners[i]!,`Mixed${i}`);
    const flash=i===4||i===5?tradeSaves[i-4]:await readFile(`${originalGameDirectory(versions[i]!)}/gameplay.sav`);
    await database.pool.query('update private.adventures set flash=$3 where owner_id=$1 and version=$2',[owners[i],versions[i],flash]);
    if(i>=2)await database.pool.query(`insert into private.game_sessions(id,owner_id,adventure_id,artifact_id,seed,base_revision,status,lease_expires_at)
      select gen_random_uuid(),owner_id,id,$3,0,revision,'lobby',clock_timestamp()+interval '60 seconds'
      from private.adventures where owner_id=$1 and version=$2`,[owners[i],versions[i],registry.manifest(versions[i]!).id]);
  }
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();assert(address&&typeof address!=='string');
  app=await createApp({origin,engineDirectory:'unused-local-qualification',publicRelease:false,adventureWorkers:2,battleWorkers:1,
    tradeWorkers:2,inspectionWorkers:2,supabaseUrl:`http://127.0.0.1:${address.port}`,publishableKey:'local-mixed-fixture'},
    {database,registry,battleRegistry});base=await app.listen({host:'127.0.0.1',port:0});
  const initial=(await database.pool.query('select id,owner_id,version,revision,flash from private.adventures order by id')).rows;
  const adventureBoots=await Promise.all([0,1].map(i=>api(i,'/api/sessions',{version:versions[i]})));
  const adventurePeers=await Promise.all([0,1].map(async i=>{const peer=new Peer('/api/play');
    await peer.open({type:'authenticate',protocol:1,token:tokens[i],sessionId:adventureBoots[i].id});return peer;}));
  const challenge=await api(2,'/api/battles/challenge',{trainerId:owners[3]});battleId=challenge.id;
  await api(3,`/api/battles/${battleId}/accept`,{});
  const battlePeers=await Promise.all([2,3].map(async i=>{const peer=new Peer('/api/battle-play');
    const ready=await peer.open({type:'authenticate',protocol:1,token:tokens[i],battleId});return {peer,sequence:ready.nextSequence};}));
  const trade=await api(4,'/api/trades',{trainerId:owners[5]});tradeId=trade.id;
  for(let side=0;side<2;side++){
    const lobby=(await api(4+side,'/api/lobby')).lobby;
    await api(4+side,`/api/trades/${tradeId}/offer`,{offerRevision:side,partySlot:1,
      pokemonDigest:lobby.party[1].digest,saveRevision:lobby.saveRevision});
  }
  await api(4,`/api/trades/${tradeId}/confirm`,{offerRevision:2});await api(5,`/api/trades/${tradeId}/confirm`,{offerRevision:2});
  const tradeBoots=await Promise.all([4,5].map(i=>api(i,`/api/trades/${tradeId}/scene`,{offerRevision:2})));
  const tradePeers=await Promise.all([4,5].map(async(i)=>{const peer=new Peer('/api/play');
    await peer.open({type:'authenticate',protocol:1,token:tokens[i],sessionId:tradeBoots[i-4].id,mode:'trade',tradeId});return peer;}));
  // Warm both inspection slots before fixing the measured process set.
  await Promise.all([6,7].map(owner=>api(owner,'/api/lobby')));
  await resourceSampler.start();
  const lag=monitorEventLoopDelay({resolution:10});lag.enable();measuring=true;
  const started=performance.now(),cpu=process.cpuUsage(),mainCpu=process.threadCpuUsage?.();
  metricsTimer=setInterval(()=>{peakWaiting=Math.max(peakWaiting,database.waitingConnections);peakRss=Math.max(peakRss,process.memoryUsage().rss);},25);
  const deadline=started+durationSeconds*1000;
  const drive=async(index:number,isTrade:boolean)=>{
    let boot=isTrade?tradeBoots[index]:adventureBoots[index],peer=isTrade?tradePeers[index]!:adventurePeers[index]!;
    let frame=boot.frame,sequence=boot.nextSequence,next=performance.now()+batchPeriod,reconnected=false;
    while(performance.now()<deadline&&!peer.done){
      await waitUntil(next);if(peer.done)break;
      const runs=Array.from({length:16},(_,i)=>({buttons:(frame+i)%61===0?1:0,frames:1}));
      const batch={type:'input',protocol:1,sessionId:boot.id,sequence,operationId:randomUUID(),startFrame:frame,runs};
      const start=performance.now(),ack=await peer.request(batch,'verified');(isTrade?tradeMs:adventureMs).push(performance.now()-start);
      assert.equal(ack.sequence,sequence);assert.equal(ack.frame,frame+16);assert.match(ack.digest,/^[0-9a-f]{64}$/);
      sequence++;frame=ack.frame;
      // Check committed state using a different pooled connection after ACK.
      if(sequence%20===0){
        const table=isTrade?'private.trade_input_journal':'private.input_journal',key=isTrade?'scene_id':'session_id';
        const row=await database.pool.query(`select acknowledgement from ${table} where ${key}=$1 and sequence=$2`,[boot.id,sequence-1]);
        assert.deepEqual(row.rows[0]?.acknowledgement,ack,'An acknowledgement preceded its durable commit.');
      }
      if(!isTrade&&index===0&&!reconnected&&performance.now()-started>20000){
        const start=performance.now();await peer.close();await sleep(100);
        boot=await api(index,'/api/sessions',{version:versions[index]});assert.equal(boot.frame,frame);assert.equal(boot.nextSequence,sequence);assert.equal(boot.digest,ack.digest);
        peer=new Peer('/api/play');adventurePeers[index]=peer;
        await peer.open({type:'authenticate',protocol:1,token:tokens[index],sessionId:boot.id});
        reconnectMs.push(performance.now()-start);reconnected=true;next=performance.now()+batchPeriod;
      }else next=Math.max(next+batchPeriod,performance.now());
    }
    return {frames:frame,batches:sequence,reconnected,completed:peer.done};
  };
  const tasks=[drive(0,false),drive(1,false),drive(0,true),drive(1,true),
    ...battlePeers.map(async({peer,sequence},side)=>{let buttons=0,next=performance.now();
      while(performance.now()<deadline&&!peer.done){await sleep(Math.max(0,next-performance.now()));if(peer.done)break;
        buttons=buttons?0:1;const start=performance.now();await peer.request({type:'buttons',protocol:1,sequence,operationId:randomUUID(),buttons},'buttons-accepted');
        buttonMs.push(performance.now()-start);sequence++;next=performance.now()+180;}
      return {side,screens:peer.screenCount,frame:peer.screenFrame,inputs:sequence};}),
    ...[6,7].map(async owner=>{let polls=0;while(performance.now()<deadline){await api(owner,'/api/lobby');polls++;await sleep(3500);}return {owner,polls};})];
  const settled=await Promise.allSettled(tasks);for(const result of settled)if(result.status==='rejected')failures.push(String(result.reason));
  const elapsedMs=performance.now()-started,processCpu=process.cpuUsage(cpu),threadCpu=mainCpu?process.threadCpuUsage(mainCpu):null;
  measuring=false;clearInterval(metricsTimer);lag.disable();
  const resources=await resourceSampler.stop();
  assert.deepEqual(failures,[]);
  const results=settled.map(result=>{assert.equal(result.status,'fulfilled');return (result as PromiseFulfilledResult<any>).value;});
  assert(results[0].reconnected);assert(results[2].completed&&results[3].completed,'The original trade did not complete during the mixed load.');
  assert(battlePeers.every(({peer})=>peer.screenCount>20));assert(peakConnections>=2,'No overlapping pooled database connections were observed.');
  const receipt=await api(4,`/api/trades/${tradeId}/finish`,{});assert(receipt.done&&receipt.receipt);
  assert.deepEqual(await api(5,`/api/trades/${tradeId}/finish`,{}),receipt);
  for(let i=0;i<2;i++){
    const checkpoint=await fetch(base+`/api/sessions/${adventureBoots[i].id}/checkpoint`,{headers:{authorization:`Bearer ${tokens[i]}`}});assert(checkpoint.ok);
    const decoded=registry.decodeCheckpoint(versions[i]!,new Uint8Array(await checkpoint.arrayBuffer()));
    const reference=await WasmEngine.create(registry.artifact(versions[i]!),registry.manifest(versions[i]!),adventureBoots[i].seed);
    try{reference.restore(decoded);assert.equal(reference.frame,results[i].frames);
      const row=await database.pool.query('select acknowledgement from private.input_journal where session_id=$1 order by sequence desc limit 1',[adventureBoots[i].id]);
      assert.equal(reference.digest(),row.rows[0].acknowledgement.digest);}finally{reference.close();}
  }
  const after=(await database.pool.query('select id,owner_id,version,revision,flash from private.adventures order by id')).rows;
  for(let i=0;i<initial.length;i++){
    const before=initial[i],row=after[i];assert.equal(row.id,before.id);
    if([owners[4],owners[5]].includes(row.owner_id)&&row.version===versions[owners.indexOf(row.owner_id)]){
      assert.equal(Number(row.revision),Number(before.revision)+1);assert(!row.flash.equals(before.flash));
    }else assert.deepEqual(row,before,'Mixed runtime activity changed a canonical cartridge.');
  }
  const journals=(await database.pool.query(`select 'adventure' as kind,count(*)::int as batches from private.input_journal
    union all select 'trade',count(*)::int from private.trade_input_journal
    union all select 'battle',count(*)::int from private.battle_input_journal`)).rows;
  const dbStats=(await database.pool.query('select deadlocks,pg_database_size(datid)::text as bytes from pg_stat_database where datname=current_database()')).rows[0];
  assert.equal(Number(dbStats.deadlocks),0);
  await api(2,`/api/battles/${battleId}/forfeit`,{});
  for(const path of sourcePaths)assert.equal(hash(await readFile(path)),sourceSha256[path],`Source changed during benchmark: ${path}`);
  const report={schemaVersion:2,transport,measuredAt:new Date().toISOString(),database:name,retainedForInspection:true,sourceSha256,
    hardware:{model:cpus()[0]?.model,logicalCpus:cpus().length,node:process.version},
    artifacts:{adventure:['firered','leafgreen'].map(v=>registry.manifest(v as GameVersion).id),battle:['firered','leafgreen'].map(v=>battleRegistry.manifest(v as GameVersion).id)},
    workload:{durationSeconds,adventures:2,battlePlayers:2,tradePlayers:2,lobbyPollers:2,realWallClock:true,originalC:true,
      qualificationMemoryMiB:Number(process.env.KANTO_QUALIFICATION_MEMORY_MIB??64),
      adventure:'saved cartridge boot with scripted A pulses',battle:'earned-level singles with scripted A pulses; partial match then forfeit',trade:'ordinary cross-version original C fixture',
      workers:{adventure:2,battle:1,trade:2,inspection:2},auth:'isolated getUser fixture; no hosted signup/email',network:'loopback WebSockets/HTTP; private Unix socket Postgres'},
    elapsedMs,apiProcessCpuMicroseconds:processCpu,mainThreadCpuMicroseconds:threadCpu,peakApiProcessRssBytes:peakRss,resources,
    cpuIncludesLocalClientsAndAuthFixture:true,postgresCpuMeasured:false,adventureBrowserSimulationMeasured:false,
    timingsMs:{adventureAcknowledgement:stats(adventureMs),tradeAcknowledgement:stats(tradeMs),battleButtons:stats(buttonMs),http:stats(httpMs),reconnect:stats(reconnectMs)},
    eventLoopDelayMs:{p95:lag.percentile(95)/1e6,p99:lag.percentile(99)/1e6,max:lag.max/1e6},
    databasePool:{limit:10,peakSimultaneousCheckouts:peakConnections,peakWaiting,deadlocks:Number(dbStats.deadlocks),retainedDatabaseBytes:Number(dbStats.bytes)},
    journals,results,durableAcknowledgementsSampled:true,checkpointDigestsChecked:true,reconnectPreservedProgress:true,
    tradeCommittedExactlyOnce:true,unrelatedCanonicalSavesUnchanged:true,battlePersonalScreensDecoded:true,
    capacity1000Qualified:false,hostedAccountsQualified:false,publicReleaseQualified:false};
  await writeFile(reportPath,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({mixedBenchmark:true,transport,reportPath,database:name,elapsedMs,timingsMs:report.timingsMs,peakConnections,peakApiRss:peakRss,peakTotalRss:resources.peakSampledTotalRssBytes,cpuMicroseconds:resources.cpuMicroseconds,processes:resources.distinctProcessCount}));
}finally{
  clearInterval(metricsTimer);for(const peer of sockets){peer.expectedClose=true;peer.socket.terminate();}
  await resourceSampler.close();
  try{await app?.close();}finally{await new Promise<void>(resolve=>provider.listening?provider.close(()=>resolve()):resolve());await database.close();await admin.end();}
}
