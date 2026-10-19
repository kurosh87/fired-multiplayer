import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile,writeFile} from 'node:fs/promises';
import {homedir} from 'node:os';
import {resolve} from 'node:path';
import pg from 'pg';

const branch=process.argv[2],output=resolve(process.argv[3]??'');
assert(['kanto-account-check','production'].includes(branch??''));
assert(output.startsWith(resolve('build')+'/'));
const stage=resolve(homedir(),'.local/share/kanto-netlify-accounts-v1');
assert.equal(JSON.parse(await readFile(stage+'/.netlify/state.json','utf8')).siteId,'4fcf6389-9abb-4239-8134-d99fa08b85d8');
// Capture credentials in process memory only; never persist provider output.
let status;
try{
  status=JSON.parse(execFileSync('/opt/homebrew/bin/netlify',['database','status','--branch',branch!,'--show-credentials','--json'],
    {cwd:stage,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:60_000}));
}catch{throw new Error('Managed database metadata lookup failed; raw provider output suppressed.');}
assert.equal(status.target,branch);assert.equal(status.applied.length,6);assert.equal(status.pending.length,0);
const connection=status.database?.connectionString;assert(typeof connection==='string'&&!connection.includes('***'));
let client:pg.Client;
try{client=new pg.Client({connectionString:connection,connectionTimeoutMillis:8000,statement_timeout:1500,application_name:'kanto-readonly-game-runtime-check'});}
catch{throw new Error('Managed database connection configuration was rejected; credential details suppressed.');}
let phase='connect';const report:Record<string,unknown>={branch,readOnly:true,hostedRowsWritten:0,credentialsPersisted:false};
try{
  await client.connect();await client.query('begin read only');
  await client.query("set local transaction_timeout='8s';set local statement_timeout='1500ms';set local lock_timeout='500ms'");
  phase='runtime';
  const base=(await client.query("select current_user as role,current_setting('server_version_num') as version")).rows[0];
  report.databaseMajor=Math.floor(Number(base.version)/10000);assert.equal(report.databaseMajor,18);
  report.connectionRole=base.role;
  phase='role membership';
  const target=branch==='production'?process.env.KANTO_MANAGED_GAME_ROLE:base.role;assert(target);
  const membership=(await client.query("select pg_has_role($1,'kanto_game_runtime','SET') as can_set,pg_has_role($1,'kanto_game_runtime','USAGE') as inherits,pg_has_role('kanto_netlify_runtime','kanto_game_runtime','MEMBER') as account_inherits",[target])).rows[0];
  assert.deepEqual(membership,{can_set:true,inherits:false,account_inherits:false});
  report.managedRuntimeRole=target;report.explicitGameRoleGranted=true;report.gameRoleNotInherited=true;report.accountRoleIsolated=true;
  if(branch==='kanto-account-check'){
    phase='restricted transaction';await client.query('set local role kanto_game_runtime');
    const permissions=(await client.query("select current_user as role,has_schema_privilege(current_user,'kanto_auth','USAGE') as auth_access,has_column_privilege(current_user,'kanto_preview.adventures','flash','SELECT') as solo_access,has_table_privilege(current_user,'private.battle_request_runs','SELECT') as request_access,has_table_privilege(current_user,'private.battle_request_receipts','DELETE') as delete_receipts,row_security_active('private.battle_request_runs'::regclass) as row_security")).rows[0];
    assert.deepEqual(permissions,{role:'kanto_game_runtime',auth_access:false,solo_access:false,request_access:true,delete_receipts:false,row_security:true});
    report.restrictedRoleChecksPassed=true;
  }else{
    // The CLI intentionally supplies a read-only production connection.
    // Verify the writer's catalog membership without asking it to SET ROLE.
    report.productionReadonlyCatalogCheck=true;
  }
  await client.query('rollback');
  const restored=(await client.query("select current_user as role,current_setting('transaction_timeout') as timeout")).rows[0];
  assert.equal(restored.role,base.role);assert.equal(restored.timeout,'0');report.localSettingsRestored=true;
  report.checkedAt=new Date().toISOString();report.passed=true;
  await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));
}catch(error){
  report.failedPhase=phase;report.errorCode=(error as {code?:string}).code??(error instanceof Error?error.name:'UNKNOWN');report.passed=false;
  await writeFile(output,JSON.stringify(report,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(report));process.exitCode=1;
}finally{await client.end().catch(()=>{});}
