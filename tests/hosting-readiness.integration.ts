import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import pg from 'pg';
import { Database } from '../apps/server/src/database.ts';
import { createApp } from '../apps/server/src/app.ts';
import { EngineRegistry } from '../packages/engine/registry.ts';
import { fixtureArtifact } from './fixture-engine.ts';

export function hostingFixtureRegistry():EngineRegistry{
  const registry=new EngineRegistry(),fixture=fixtureArtifact();
  registry.status=()=>['firered','leafgreen'].map(version=>({version:version as 'firered'|'leafgreen',available:true,reason:'isolated arithmetic fixture',manifest:{...fixture.manifest,version:version as 'firered'|'leafgreen'}}));
  return registry;
}

/** Never run against a hosted app: called only inside the marked native
 * disposable-cluster runner. Retires only the exact pool PID it just created. */
export async function checkActualDatabaseReadiness(url:string){
  const tag=process.env.KANTO_HOSTING_READINESS_EVIDENCE_TAG??'hosting-database';assert(/^[a-z0-9-]{1,40}$/.test(tag));
  const path=`build/${tag}-readiness.json`;assert(!existsSync(path),'Preserve retained hosting readiness evidence.');
  let idleErrors=0,ended=false;
  const database=new Database(url,()=>{idleErrors++;});
  const control=new pg.Client({connectionString:url,application_name:'kanto-readiness-fixture'});
  const app=await createApp({origin:'http://127.0.0.1:5173',engineDirectory:'unused-hosting-fixture',supabaseUrl:'https://fixture.invalid',publishableKey:'fixture-only',publicRelease:false},{database,registry:hostingFixtureRegistry()});
  try{
    await control.connect();
    assert.equal((await app.inject('/readyz')).statusCode,200);
    const pid=Number((await database.pool.query('select pg_backend_pid() as pid')).rows[0].pid);
    const owned=await control.query("select pid from pg_stat_activity where pid=$1 and pid<>pg_backend_pid() and application_name='kanto-online'",[pid]);assert.equal(owned.rowCount,1);
    const lost=once(database.poolEvents,'error',{signal:AbortSignal.timeout(5000)});
    assert.equal((await control.query('select pg_terminate_backend($1) as stopped',[pid])).rows[0].stopped,true);
    await lost;assert.equal(idleErrors,1);
    assert.equal((await app.inject('/readyz')).statusCode,200,'The pool did not reconnect after losing its own idle connection.');
    await database.close();ended=true;
    const unavailable=await app.inject('/readyz');assert.equal(unavailable.statusCode,503);assert.deepEqual(unavailable.json(),{ready:false});
    assert.equal((await app.inject('/healthz')).statusCode,200,'Database failure must not turn liveness into a restart loop.');
    await writeFile(path,JSON.stringify({realPostgres:true,ownIdleBackendRetired:true,idleErrorHandled:true,reconnectedReadiness:true,
      unavailablePoolReturns503:true,livenessStaysHealthy:true,artifactProvider:'isolated arithmetic status fixture',
      hostedAccountsQualified:false,realGameArtifactReadinessQualified:false,scope:'Local PostgreSQL transport/readiness behavior; no hosted provisioning, schema migration, SMTP, original-C load or global capacity qualification.'},null,2)+'\n');
    console.log(JSON.stringify({databaseReadiness:true,idleFailureRecovery:true,unavailable503:true}));
  }finally{await app.close();await control.end();if(!ended)await database.close();}
}
