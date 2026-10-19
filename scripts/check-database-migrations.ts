import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import pg from 'pg';
import { Database } from '../apps/server/src/database.ts';
import { PostgresTrades } from '../apps/server/src/trade-repository.ts';
import { BattleRepository } from '../apps/server/src/battle-repository.ts';
import { AtomicTrading } from '../packages/trading/atomic-trade.ts';
import { Sessions, type SessionOptions } from '../apps/server/src/sessions.ts';
import { EngineRegistry } from '../packages/engine/registry.ts';
import { fixtureArtifact } from '../tests/fixture-engine.ts';

const guard=resolve(homedir(),'.local/bin/mini-build-guard');
if(existsSync(guard))assert.equal(spawnSync(guard,['--is-owned'],{stdio:'ignore'}).status,0,'Use the project resource guard.');
const base=new URL(process.env.DATABASE_TEST_URL!);
assert.equal(base.hostname,'localhost');assert.equal(base.username,'kanto_test');assert.equal(base.pathname,'/postgres');
assert.equal(base.searchParams.get('host'),resolve('build/postgres-test/socket'));
assert.deepEqual(JSON.parse(await readFile('build/postgres-test/.kanto-test-cluster.json','utf8')),{purpose:'kanto-disposable-contract-tests',major:17});
const tag=process.env.KANTO_MIGRATION_EVIDENCE_TAG??'database-migrations-v1';assert(/^[a-z0-9-]{1,40}$/.test(tag));
const output=resolve('build',tag);assert(!existsSync(output),'Preserve prior evidence.');await mkdir(output);
const hash=(value:Uint8Array)=>createHash('sha256').update(value).digest('hex');
const stamp=Date.now(),names=[`kanto_migrations_${stamp}`,`kanto_declared_${stamp}`],login=`kanto_api_check_${stamp}`;
const url=(database:string,user='kanto_test')=>{const value=new URL(base);value.pathname='/'+database;value.username=user;value.searchParams.set('sslmode','disable');return value.href;};
const migrations=(await readdir('supabase/migrations')).filter(name=>/^\d{14}_.+\.sql$/.test(name)).sort();assert(migrations.length>0&&migrations.length<=1000);
const admin=new pg.Client({connectionString:base.href}),clients:pg.Client[]=[],sessions:Sessions[]=[];
let runtime:Database|undefined,loginCreated=false,completedReport:Record<string,unknown>|undefined;
async function sqlClient(database:string){const client=new pg.Client({connectionString:url(database)});await client.connect();clients.push(client);return client;}
async function applyCli(database:string,label:string){
  const log=await open(output+'/'+label+'.log','wx');
  try{const result=spawnSync('supabase',['migration','up','--include-all','--db-url',url(database)],{
    stdio:['ignore',log.fd,log.fd],timeout:60_000,env:{...process.env,DOCKER_HOST:'unix://'+output+'/no-docker-daemon.sock'}});
    assert.equal(result.status,0,`Migration CLI failed; inspect ${label}.log`);
  }finally{await log.close();}
}
async function dump(database:string){
  const result=spawnSync(resolve(process.env.KANTO_POSTGRES_BIN??'/opt/homebrew/opt/postgresql@17/bin','pg_dump'),
    ['--schema-only','--schema=public','--schema=private','--no-owner','--no-comments','--no-security-labels','--dbname',url(database)],{encoding:'utf8',maxBuffer:1024*1024});
  assert.equal(result.status,0,result.stderr);
  // pg_dump 17's fresh restrict/unrestrict key is transport metadata.
  return result.stdout.split('\n').filter(line=>!/^\\(?:un)?restrict\b/.test(line)).join('\n');
}
try{
  await admin.connect();
  for(const name of names){assert(/^[a-z0-9_]+$/.test(name));await admin.query(`create database "${name}"`);}
  await writeFile(output+'/owned-databases.json',JSON.stringify({cluster:'build/postgres-test',databases:names,fixtureLogin:login},null,2)+'\n');
  for(const name of names){
    const client=await sqlClient(name);
    await client.query(`do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticator nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role nologin bypassrls; exception when duplicate_object then null; end $$;
      create schema auth;create table auth.users(id uuid primary key,email text);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
      grant usage on schema auth to authenticated;grant execute on function auth.uid() to authenticated;
      grant create on schema public to public;
      create schema outside;create table outside.secret(value text);insert into outside.secret values('not-game-data');`);
  }
  await applyCli(names[0]!, 'migration-first-apply');
  const migrated=clients[0]!,declared=clients[1]!;
  const history=async()=> (await migrated.query('select version from supabase_migrations.schema_migrations order by version')).rows.map(row=>row.version);
  const versions=migrations.map(name=>name.slice(0,14));assert.deepEqual(await history(),versions);
  await applyCli(names[0]!, 'migration-second-apply');assert.deepEqual(await history(),versions);
  for(const name of (await readdir('supabase/schemas')).filter(name=>name.endsWith('.sql')).sort())await declared.query(await readFile('supabase/schemas/'+name,'utf8'));
  const actualDump=await dump(names[0]!),desiredDump=await dump(names[1]!);
  await writeFile(output+'/migrated-schema.sql',actualDump);await writeFile(output+'/declared-schema.sql',desiredDump);
  assert.equal(actualDump,desiredDump,'Ordered migrations must produce the complete declarative schema, policies and grants.');
  await migrated.query('create table private.future_secret(value text)');
  await admin.query(`create role "${login}" login inherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);loginCreated=true;
  await admin.query(`grant kanto_api_runtime to "${login}"`);
  runtime=new Database(url(names[0]!,login));
  const flags=(await runtime.pool.query('select rolname,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles where rolname=current_user')).rows[0];
  assert.equal(flags.rolname,login);for(const key of ['rolsuper','rolcreatedb','rolcreaterole','rolreplication','rolbypassrls'])assert.equal(flags[key],false);
  const owners=[randomUUID(),randomUUID(),randomUUID()];
  await migrated.query("insert into auth.users(id,email) values($1,'one@example.invalid'),($2,'two@example.invalid'),($3,'three@example.invalid')",owners);
  assert.equal((await runtime.createProfile(owners[0]!,'MigrationAlice')).handle,'MigrationAlice');
  assert.equal((await runtime.createProfile(owners[1]!,'MigrationBob')).handle,'MigrationBob');
  await assert.rejects(runtime.createProfile(owners[2]!,'mIgRaTiOnAlIcE'),{code:'HANDLE_UNAVAILABLE'});
  assert.equal(await runtime.profile(owners[2]!),undefined);assert.equal((await runtime.adventures(owners[2]!)).length,0);
  const adventures=await runtime.adventures(owners[0]!);assert.deepEqual(adventures.map(item=>item.version),['firered','leafgreen']);
  const denied:string[]=[];
  for(const [name,query] of [
    ['Auth reads','select * from auth.users'],['Auth writes',`insert into auth.users(id) values('${randomUUID()}')`],
    ['unrelated data','select * from outside.secret'],['future tables','select * from private.future_secret'],
    ['handle changes',`update public.profiles set handle='Renamed' where id='${owners[0]}'`],
    ['profile deletion',`delete from public.profiles where id='${owners[0]}'`],
    ['table truncation','truncate private.adventures'],['schema DDL','create table public.runtime_ddl(id int)'],
    ['table DDL','alter table private.adventures add column runtime_ddl integer'],
    ['service-role escalation','set role service_role'],['browser-role escalation','set role authenticated'],
    ['role creation',`create role kanto_forbidden_${stamp}`],['database creation',`create database kanto_forbidden_${stamp}`],
  ]){await assert.rejects(runtime.pool.query(query!),{code:'42501'},name);denied.push(name!);}
  const artifact=fixtureArtifact(),directory=output+'/fixture';await mkdir(directory);
  await writeFile(directory+'/firered.json',JSON.stringify(artifact.manifest));await writeFile(directory+'/firered.wasm',artifact.bytes);
  const registry=new EngineRegistry();await registry.load(directory,false);
  const options:SessionOptions={pool:1,inspection:registry,prepareLobby:async(version,seed,point)=>{
    const staged=await registry.prepareLobby(version,seed,registry.decodeCheckpoint(version,gunzipSync(point)));
    return {...staged,checkpoint:gzipSync(registry.encodeCheckpoint(version,staged.snapshot),{level:1})};
  }};
  const first=new Sessions(runtime,registry,options);sessions.push(first);
  const boot=await first.start(owners[0]!,'firered');first.resume(owners[0]!,boot.id);
  const ack=await first.accept(owners[0]!,boot.id,{type:'input',protocol:1,sessionId:boot.id,sequence:0,operationId:randomUUID(),startFrame:0,runs:[{buttons:16,frames:10}]});
  await first.pause(owners[0]!,boot.id);await first.close();
  const second=new Sessions(runtime,registry,options);sessions.push(second);
  const recovered=await second.start(owners[0]!,'firered');assert.equal(recovered.id,boot.id);assert.equal(recovered.frame,10);assert.equal(recovered.digest,ack.digest);
  await second.exit(owners[0]!,boot.id);await second.close();
  const saved=await runtime.adventures(owners[0]!);assert(saved.find(item=>item.version==='firered')!.hasSave);assert(!saved.find(item=>item.version==='leafgreen')!.hasSave);
  // These are data-access fixtures, not a substitute for original-C battle
  // and trade qualification. All operations use the actual restricted login.
  const aSave=(await runtime.pool.query("select id,revision,flash from private.adventures where owner_id=$1 and version='firered'",[owners[0]])).rows[0];
  const bSave=(await runtime.pool.query("update private.adventures set flash=$2 where owner_id=$1 and version='leafgreen' returning id,revision,flash",[owners[1],Buffer.alloc(131072,2)])).rows[0];
  for(const [owner,save] of [[owners[0],aSave],[owners[1],bSave]] as const)await runtime.pool.query(`insert into private.game_sessions(id,owner_id,adventure_id,artifact_id,seed,base_revision,status)
    values($1,$2,$3,'migration-fixture',123,$4,'lobby')`,[randomUUID(),owner,save.id,save.revision]);
  const battles=new BattleRepository(runtime),challenge=await battles.challenge(owners[0]!,owners[1]!);
  await assert.rejects(battles.get(owners[2]!,challenge.id),{code:'BATTLE_NOT_FOUND'});
  await battles.reserve(owners[1]!,challenge.id,['fixture-a','fixture-b'],123);await battles.releaseStarting(challenge.id);
  assert.equal((await battles.get(owners[0]!,challenge.id)).status,'cancelled');
  const unchanged=(await runtime.pool.query('select id,revision,flash from private.adventures where id=any($1::uuid[])',[ [aSave.id,bSave.id] ])).rows;
  for(const prior of [aSave,bSave]){const after=unchanged.find(row=>row.id===prior.id);assert.equal(after.revision,prior.revision);assert.deepEqual(after.flash,prior.flash);}
  const tradeId=randomUUID(),offer=(save:any)=>({partySlot:0,pokemonDigest:'a'.repeat(64),saveRevision:Number(save.revision)});
  await runtime.pool.query(`insert into private.trades(id,player_a,player_b,adventure_a,adventure_b,offer_a,offer_b,confirmed_a,confirmed_b)
    values($1,$2,$3,$4,$5,$6,$7,true,true)`,[tradeId,owners[0],owners[1],aSave.id,bSave.id,offer(aSave),offer(bSave)]);
  let swaps=0;
  const trades=new AtomicTrading(new PostgresTrades(runtime),{swap:async trade=>{swaps++;return {flashA:trade.saveB.flash,flashB:trade.saveA.flash,result:{fixtureOnly:true}};}});
  const receipt=await trades.complete(tradeId,owners[0]!,0);assert.equal(receipt.revisionA,Number(aSave.revision)+1);assert.equal(receipt.revisionB,Number(bSave.revision)+1);
  assert.deepEqual(await trades.complete(tradeId,owners[1]!,0),receipt);assert.equal(swaps,1);
  await assert.rejects(trades.complete(tradeId,owners[2]!,0),{code:'TRADE_NOT_FOUND'});
  const swapped=(await runtime.pool.query('select id,revision,flash from private.adventures where id=any($1::uuid[])',[[aSave.id,bSave.id]])).rows;
  assert.deepEqual(swapped.find(row=>row.id===aSave.id).flash,bSave.flash);assert.deepEqual(swapped.find(row=>row.id===bSave.id).flash,aSave.flash);
  for(const browserRole of ['anon','authenticated','authenticator']){
    assert.equal((await migrated.query('select pg_has_role($1,$2,\'MEMBER\') as member',[browserRole,'kanto_api_runtime'])).rows[0].member,false);
    await migrated.query('begin');
    try{
      await migrated.query("select set_config('request.jwt.claim.sub',$1,true)",[owners[0]]);await migrated.query(`set local role ${browserRole}`);
      if(browserRole==='authenticated')assert.deepEqual((await migrated.query('select id,handle,created_at from public.profiles')).rows.map(row=>row.id),[owners[0]]);
      await assert.rejects(migrated.query('select * from private.adventures'),{code:'42501'});
    }finally{await migrated.query('rollback');}
  }
  const sources=['scripts/check-database-migrations.ts','scripts/check-database.py','tests/fixture-engine.ts',
    ...(await readdir('apps/server/src',{recursive:true})).filter(name=>name.endsWith('.ts')).map(name=>'apps/server/src/'+name),
    ...(await readdir('packages',{recursive:true})).filter(name=>name.endsWith('.ts')).map(name=>'packages/'+name),...migrations.map(name=>'supabase/migrations/'+name),
    ...(await readdir('supabase/schemas')).filter(name=>name.endsWith('.sql')).map(name=>'supabase/schemas/'+name)];
  completedReport={checkedAt:new Date().toISOString(),databases:names,migrations:versions,actualSupabaseCliMigrationApply:true,
    secondApplyNoDuplicateHistory:true,migrationMatchesDeclarativeSchema:true,schemaSha256:hash(Buffer.from(actualDump)),runtimeLoginAttributes:flags,
    twoAdventureSlots:true,caseInsensitiveHandleCollision:true,failedProfileCreatesNoSlots:true,realRestrictedLoginSessionAndSaveRecovery:true,
    runtimeBattleAdmissionAndRelease:true,runtimeAtomicTradeAndDuplicateReceipt:true,otherAccountRepositoryAccessDenied:true,
    browserPrivateAccessDenied:true,unrelatedAndAuthDataDenied:true,deniedOperations:denied,fixtureLoginDisabledAfterCheck:true,
    sourceSha256:Object.fromEntries(await Promise.all(sources.map(async path=>[path,hash(await readFile(path))]))),
    scope:'Native PostgreSQL 17 and actual Supabase CLI; arithmetic session and synthetic save/ledger fixtures check database permissions, recovery and atomic transactions, not original Pokemon gameplay or hosted Auth.',
    hostedProjectChanged:false,hostedSignupQualified:false,linuxRuntimeQualified:false,capacity1000Qualified:false};
}finally{
  const cleanup=await Promise.allSettled(sessions.map(session=>session.close()));
  if(runtime)cleanup.push(...await Promise.allSettled([runtime.close()]));
  cleanup.push(...await Promise.allSettled(clients.map(client=>client.end())));
  try{if(loginCreated)await admin.query(`alter role "${login}" nologin`);}finally{await admin.end();}
  for(const result of cleanup)if(result.status==='rejected')throw result.reason;
}

assert(completedReport);await writeFile(output+'/report.json',JSON.stringify(completedReport,null,2)+'\n');
console.log(JSON.stringify({output,actualMigrationApply:true,schemaParity:true,restrictedRuntimeSaveRecovery:true,fixtureLoginDisabled:true}));
