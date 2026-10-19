import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import pg from 'pg';
import {Database} from '../apps/server/src/database.ts';

/** Reproduce the hosted ADMIN=true, SET=false membership with a real
 * non-superuser login, then apply the exact versioned role-switch migration. */
export async function checkNetlifyGameRole(owner:pg.Client,url:string,output:string){
  const login='kanto_role_probe_'+Date.now(),migration='netlify/database/migrations/20261017160200_game-runtime-role-switch/migration.sql';
  const connection=new URL(url);connection.username=login;connection.password='';
  let client:pg.Client|undefined,game:Database|undefined,created=false;
  try{
    await owner.query(`create role "${login}" login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);created=true;
    await owner.query(`grant kanto_game_runtime to "${login}" with admin true`);
    await owner.query(`grant kanto_game_runtime to "${login}" with set false`);
    client=new pg.Client({connectionString:connection.href});await client.connect();
    const before=(await client.query("select pg_has_role(current_user,'kanto_game_runtime','MEMBER') as member,pg_has_role(current_user,'kanto_game_runtime','SET') as can_set,pg_has_role(current_user,'kanto_game_runtime','USAGE') as inherits")).rows[0];
    assert.deepEqual(before,{member:true,can_set:false,inherits:false});
    await assert.rejects(client.query('set role kanto_game_runtime'),{code:'42501'});
    await client.query(await readFile(migration,'utf8'));
    const after=(await client.query("select pg_has_role(current_user,'kanto_game_runtime','SET') as can_set,pg_has_role(current_user,'kanto_game_runtime','USAGE') as inherits")).rows[0];
    assert.deepEqual(after,{can_set:true,inherits:false});
    await client.query('begin read only');await client.query('set local role kanto_game_runtime');
    const role=(await client.query('select current_user as role')).rows[0].role;assert.equal(role,'kanto_game_runtime');
    await client.query('select battle_id from private.battle_request_runs limit 0');
    for(const sql of ['select * from kanto_auth."user"','select flash from kanto_preview.adventures']){
      await client.query('savepoint denied');await assert.rejects(client.query(sql),{code:'42501'});await client.query('rollback to savepoint denied');
    }
    await client.query('rollback');assert.equal((await client.query('select current_user as role')).rows[0].role,login);
    await assert.rejects(client.query('select battle_id from private.battle_request_runs limit 0'),{code:'42501'});
    // Model the extra owner privileges of the managed login. A role-membership
    // grant alone does not make this login safe for game queries.
    await owner.query(`grant usage on schema kanto_auth,kanto_preview to "${login}"`);
    await owner.query(`grant select on kanto_auth."user" to "${login}"`);
    await owner.query(`grant select(flash) on kanto_preview.adventures to "${login}"`);
    await client.query('select * from kanto_auth."user" limit 0');
    await client.query('select flash from kanto_preview.adventures limit 0');
    game=new Database(connection.href,()=>{},'netlify',{managedGameRole:true});
    const probe=async()=>{
      const value=(await game!.pool.query("select current_user as role,current_setting('lock_timeout') as lock_timeout,row_security_active('private.battle_request_runs') as rls")).rows[0];
      assert.deepEqual(value,{role:'kanto_game_runtime',lock_timeout:'0',rls:true});
    };
    await Promise.all(Array.from({length:6},probe));
    for(const sql of ['select * from kanto_auth."user"','select flash from kanto_preview.adventures'])
      await assert.rejects(game.pool.query(sql),{code:'42501'});
    await assert.rejects(game.transaction(async tx=>{
      assert.equal((await tx.query('select current_user as role')).rows[0].role,'kanto_game_runtime');
      await tx.query("set local lock_timeout='37ms'");
      await tx.query('select 1/0');
    }),{code:'22012'});
    await game.transaction(async tx=>{
      assert.equal((await tx.query('select current_user as role')).rows[0].role,'kanto_game_runtime');
      await tx.query('select battle_id from private.battle_request_runs limit 0');
    });
    await Promise.all(Array.from({length:6},probe));
    // The independent base connection retains its original owner privilege;
    // game restrictions are applied by the adapter on each transaction.
    assert.equal((await client.query('select current_user as role')).rows[0].role,login);
    await client.query('select * from kanto_auth."user" limit 0');
    assert.equal((await owner.query("select pg_has_role('kanto_netlify_runtime','kanto_game_runtime','MEMBER') as member")).rows[0].member,false);
    const report={actualNonSuperuserLogin:true,reproducedAdminWithoutSet:true,versionedMigrationApplied:true,explicitGameRoleSwitch:true,
      gamePrivilegesNotInherited:true,authAndSoloFlashDenied:true,transactionLocalRoleRestored:true,accountRoleStillIsolated:true,
      managedAdapterRestrictsPrivilegedLogin:true,managedAdapterConcurrentQueries:true,managedAdapterRollbackAndReuse:true,hosted:false};
    await writeFile(output+'/game-role-switch-report.json',JSON.stringify(report,null,2)+'\n');return report;
  }finally{await game?.close();await client?.end();if(created)await owner.query(`alter role "${login}" nologin`);}
}
