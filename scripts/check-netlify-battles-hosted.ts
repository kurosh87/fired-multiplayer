import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFile,writeFile,readdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {homedir} from 'node:os';
import pg from 'pg';
import {createPreviewCloud,type CloudEmail} from '../apps/server/src/preview-cloud.ts';
import {Database} from '../apps/server/src/database.ts';
import {seedBattleLobby} from '../tests/battle-ui-qualification.ts';
import {originalGameProvider} from '../tests/original-game-provider.ts';
import {decodeBattleResponse,type RequestBattleController} from '../packages/battles/request-protocol.ts';
import {BattleScreenDecoder} from '../packages/battles/screen.ts';
import {BattleConsolePool} from '../packages/battles/console-pool.ts';
import {EngineRegistry} from '../packages/engine/registry.ts';
import {BattleRunStore} from '../apps/server/src/battle-run-store.ts';
import type {BattleArtifact} from '../packages/battles/original-pair.ts';
import {PRIVATE_BATTLE_PINS} from '../packages/battles/private-artifacts.ts';
import {pathToFileURL} from 'node:url';

const [origin,outputArg]=process.argv.slice(2),output=resolve(outputArg??'');
assert(origin&&/^https:\/\/[a-f0-9]{24}--kanto-online-preview\.netlify\.app$/.test(origin));
assert(output.startsWith(resolve('build')+'/'));
assert.equal(execFileSync(resolve(homedir(),'.local/bin/mini-build-guard'),['--is-owned']).length,0);
const stage=resolve(homedir(),'.local/share/kanto-netlify-accounts-v1'),branch='kanto-battle-check';
assert.equal(JSON.parse(await readFile(stage+'/.netlify/state.json','utf8')).siteId,'4fcf6389-9abb-4239-8134-d99fa08b85d8');
let connection:string;
try{
  const status=JSON.parse(execFileSync('/opt/homebrew/bin/netlify',['database','status','--branch',branch,'--show-credentials','--json'],{cwd:stage,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60000}));
  assert.equal(status.target,branch);assert.equal(status.pending.length,0);
  assert.equal(status.applied.length,(await readdir('netlify/database/migrations')).length);
  connection=status.database.connectionString;assert(typeof connection==='string'&&!connection.includes('***'));
}catch{throw new Error('Preview configuration lookup failed; credential output suppressed.');}
// Only the fixture SDK uses this ephemeral key. Confirmation is handled by
// that same real SDK with captured mail; hosted login then creates a fresh
// session using the deployment's own secret, which is never extracted.
const secret=randomBytes(48).toString('base64url');
const accountPool=new pg.Pool({connectionString:connection,max:2,connectionTimeoutMillis:8000,statement_timeout:5000});
accountPool.on('error',()=>{});
const game=new Database(connection,()=>{},'netlify',{managedGameRole:true}),emails:CloudEmail[]=[];
const cloud=createPreviewCloud(accountPool,origin,secret,async value=>{emails.push(value);});
const accounts:{id:string;token:string;cookie:string}[]=[],password=randomBytes(32).toString('base64url');
const timings:{path:string;status:number;milliseconds:number}[]=[],stamp=Date.now();
const report:Record<string,unknown>={origin,branch,hosted:true,productionChanged:false,externalEmailsSent:0,
  fixtures:'Two new SDK-created preview accounts and retained input-earned cartridges; no uploaded-save promotion.',
  confirmation:'Captured SDK confirmation callbacks; hosted email delivery is not exercised.',credentialsPersisted:false};
let phase='boundary';
const okay=async(response:Response,status=200)=>{assert.equal(response.status,status,await response.clone().text());return response;};
const http=async(path:string,body?:unknown,side?:number)=>{
  const start=performance.now(),response=await fetch(origin+path,{signal:AbortSignal.timeout(45000),
    method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json',
      ...(side===undefined?{}:{Authorization:'Bearer '+accounts[side]!.token,Cookie:accounts[side]!.cookie})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  timings.push({path:path.includes('/step')?'step':path.replace(/[a-f0-9-]{36}/g,':battle'),status:response.status,milliseconds:Math.round(performance.now()-start)});
  return response;
};
try{
  const denied=await okay(await http('/api/online/battles'),401);
  assert.deepEqual(denied.headers.get('cache-control')?.split(',').map(value=>value.trim()).sort(),['no-store','private']);
  for(const path of ['/build/netlify-battle-runtime/firered.wasm','/build/netlify-battle-runtime/battle-worker.mjs'])
    await okay(await fetch(origin+path,{signal:AbortSignal.timeout(15000)}),404);
  phase='accounts';
  console.error('Hosted battle check: actual SDK accounts and hosted login.');
  for(const side of [0,1]){
    const email=`kanto-function-${stamp}-${side}@example.invalid`;
    await okay(await cloud.fetch(new Request(origin+'/api/cloud/auth/sign-up/email',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
      body:JSON.stringify({name:'Preview qualification',email,password,callbackURL:origin})}),'192.0.2.'+(150+side)));
    const link=emails.find(item=>item.to===email)?.text.match(/https?:\/\/\S+/)?.[0];assert(link);
    await okay(await cloud.fetch(new Request(link),'192.0.2.'+(150+side)),302);
    const login=await okay(await http('/api/cloud/auth/sign-in/email',{email,password}));
    const data=await login.json(),cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
    assert(data.token&&data.user.id&&data.user.emailVerified&&cookie);
    accounts.push({id:data.user.id,token:data.token,cookie});
    report.fixtureAccountIds=accounts.map(account=>account.id);
    await okay(await http('/api/cloud/profile',{handle:'Fn'+randomUUID().replaceAll('-','').slice(0,12)},side));
  }
  phase='fixture admission';
  const saves=await Promise.all(accounts.map(async(account,side)=>(await game.adventures(account.id)).find(item=>item.version===(side?'leafgreen':'firered')&&item.slot===0)!.id)) as [string,string];
  await seedBattleLobby(game,accounts.map(a=>a.id) as [string,string],saves,await originalGameProvider());
  const canonical=(await game.pool.query('select id,revision,flash from private.adventures where id=any($1::uuid[]) order by id',[saves])).rows;
  phase='original battle';
  console.error('Hosted battle check: original-C worker and durable replies.');
  const battle=await(await okay(await http('/api/online/battles',{trainerId:accounts[1]!.id},0))).json();
  report.fixtureBattleId=battle.id;
  const accepted=await(await okay(await http(`/api/online/battles/${battle.id}/accept`,{},1))).json();assert.equal(accepted.frame,0);
  const controllers:RequestBattleController[]=[],sequences=[0,0];
  for(const side of [0,1])controllers.push((await(await okay(await http(`/api/online/battles/${battle.id}/open`,{connectionId:randomUUID(),expectedEpoch:0},side))).json()).controller);
  let latest:ReturnType<typeof decodeBattleResponse>|undefined,first:{body:unknown;bytes:Buffer}|undefined;
  for(let index=0;index<8;index++){
    const side=index%2,body={protocol:1,action:'step',operationId:randomUUID(),sequence:sequences[side]!,controller:controllers[side],runs:[{buttons:0,frames:15}]};
    const response=await okay(await http(`/api/online/battles/${battle.id}/step`,body,side));
    assert.equal(response.headers.get('content-type'),'application/vnd.kanto.battle-response');
    // Real HTTP fetch has already decompressed the Function's gzip envelope.
    const bytes=Buffer.from(await response.arrayBuffer()),decoded=decodeBattleResponse(bytes);
    sequences[side]=sequences[side]!+1;
    assert.equal(decoded.metadata.side,side?'b':'a');assert.equal(decoded.metadata.nextSequence,sequences[side]);
    latest=decoded;
    if(index===0){
      first={body,bytes};const retry=Buffer.from(await(await okay(await http(`/api/online/battles/${battle.id}/step`,body,side))).arrayBuffer());assert.deepEqual(retry,bytes);
      await okay(await http(`/api/online/battles/${battle.id}/step`,{...body,runs:[]},side),409);
    }
  }
  assert(first&&latest&&latest.metadata.frame>0);
  phase='checkpoint and picture parity';
  console.error('Hosted battle check: independent checkpoint and personal picture parity.');
  const run=await new BattleRunStore(game).row(accounts[0]!.id,battle.id);
  const directory=stage+'/build/netlify-battle-runtime',registry=new EngineRegistry();await registry.loadPrivateBattle(directory,PRIVATE_BATTLE_PINS);
  const pool=new BattleConsolePool(1,{url:pathToFileURL(directory+'/battle-worker.mjs'),transport:'thread'});
  try{
    const versions=[run.version_a,run.version_b];assert(run.checkpoint_a&&run.checkpoint_b);
    const pair=await pool.restore(versions.map(version=>({manifest:registry.manifest(version),bytes:registry.artifact(version),seed:Number(run.seed)})) as [BattleArtifact,BattleArtifact],
      Number(run.frame),[run.checkpoint_a,run.checkpoint_b]);
    const screen=new BattleScreenDecoder();for(const packet of latest.packets)screen.apply(packet);
    assert(screen.frame<=Number(run.frame));assert.deepEqual(Buffer.from(screen.pixels),Buffer.from((await pair.screens(['b']))[0]!));
    await pair.close();
  }finally{await pool.close();}
  phase='tab fencing';
  const replacement=(await(await okay(await http(`/api/online/battles/${battle.id}/open`,{connectionId:randomUUID(),expectedEpoch:controllers[0]!.epoch},0))).json()).controller;
  await okay(await http(`/api/online/battles/${battle.id}/step`,first.body,0),409);
  phase='forfeit';
  const terminal=decodeBattleResponse(Buffer.from(await(await okay(await http(`/api/online/battles/${battle.id}/step`,{
    protocol:1,action:'forfeit',operationId:randomUUID(),sequence:sequences[0],controller:replacement,runs:[]},0))).arrayBuffer()));
  assert.deepEqual(terminal.metadata.result,{winner:'b',reason:'forfeit'});
  assert.deepEqual((await game.pool.query('select id,revision,flash from private.adventures where id=any($1::uuid[]) order by id',[saves])).rows,canonical);
  phase='logout';
  await okay(await http('/api/cloud/auth/sign-out',{},0));await okay(await http(`/api/online/battles/${battle.id}`,undefined,0),401);
  report.passed=true;report.actualHostedAuth=true;report.confirmedSdkAccounts=true;report.originalCWorker=true;
  report.exactLostReplyRetry=true;report.tabReplacementFencesOldReceipt=true;report.checkpointAndPersonalPictureMatch=true;
  report.canonicalCartridgesUnchanged=true;report.atomicForfeit=true;report.logoutRevokesBattleAccess=true;
  report.privateAssetsNotPublic=true;report.advancedFrames=latest.metadata.frame;report.publicReleaseQualified=false;
}catch(error){report.passed=false;report.failedPhase=phase;report.errorCode=(error as {code?:string}).code??(error instanceof Error?error.name:'UNKNOWN');report.message=error instanceof Error?error.message.slice(0,2000):'Unknown failure';}
finally{
  report.timings=timings;report.checkedAt=new Date().toISOString();
  await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});
  await Promise.all([game.close(),accountPool.end()]);console.log(JSON.stringify(report));
  if(!report.passed)process.exitCode=1;
}
