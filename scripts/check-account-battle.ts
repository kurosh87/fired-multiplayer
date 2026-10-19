import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { Database } from '../apps/server/src/database.ts';
import { checkBattleUi } from '../tests/battle-ui-qualification.ts';
import type { createPreviewCloud } from '../apps/server/src/preview-cloud.ts';

type Account = {id:string;cookie:string;email:string;token:string};
/** Real Better Auth accounts + actual C battle. The prototype game schema and
 * input-earned cartridges below are explicit isolated fixtures, not a hosted
 * migration, a production identity-import routine or verified user uploads. */
export async function checkAccountBattle(owner:pg.Client,accountDatabaseUrl:string,origin:string,secret:string,
  cloud:ReturnType<typeof createPreviewCloud>,accounts:[Account,Account,Account],password:string) {
  const [a,b,c]=accounts;
  assert(process.env.KANTO_BATTLE_UI_EVIDENCE_TAG,'Use a fresh retained evidence tag.');
  assert.equal((await owner.query("select to_regclass('public.profiles') as profiles")).rows[0].profiles,null);
  const slots=await Promise.all([cloud.store.overview(a.id),cloud.store.overview(b.id)]);
  const saves:[string,string]=[slots[0]!.slots.find(s=>s.version==='firered'&&s.slot===0)!.id,
    slots[1]!.slots.find(s=>s.version==='leafgreen'&&s.slot===0)!.id];
  await owner.query('update kanto_auth."user" set "emailVerified"=false where id=$1',[c.id]);
  await owner.query('begin');
  try {
    await owner.query(`do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
      do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
      create schema auth;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$
        select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;`);
    await owner.query(await readFile('supabase/schemas/001_kanto.sql','utf8'));
    await owner.query('insert into auth.users(id) values($1),($2)',[a.id,b.id]);
    await owner.query('insert into public.profiles(id,handle) values($1,$2),($3,$4)',[a.id,slots[0]!.profile!.handle,b.id,slots[1]!.profile!.handle]);
    await owner.query("insert into private.adventures(id,owner_id,version) values($1,$2,'firered'),($3,$4,'leafgreen')",[saves[0],a.id,saves[1],b.id]);
    let sequence=0;
    const database=Object.assign(Object.create(Database.prototype),{
      pool:{query:owner.query.bind(owner)},
      async transaction<T>(body:(client:pg.PoolClient)=>Promise<T>):Promise<T>{
        const name='account_battle_'+(++sequence);await owner.query('savepoint '+name);
        try {const result=await body(owner as unknown as pg.PoolClient);await owner.query('release savepoint '+name);return result;}
        catch(error){await owner.query('rollback to savepoint '+name);throw error;}
      },
    }) as Database;
    await checkBattleUi(database,[a.id,b.id],saves,{
      config:{accountOrigin:origin,accountSecret:secret,accountDatabaseUrl},tokens:[a.token,b.token],unconfirmedToken:c.token,
      reauthenticate:async()=>{
        const logout=await cloud.fetch(new Request(origin+'/api/cloud/auth/sign-out',{method:'POST',headers:{Origin:origin,Cookie:a.cookie,'Content-Type':'application/json'},body:'{}'}),'192.0.2.20');
        assert.equal(logout.status,200);
        const login=await cloud.fetch(new Request(origin+'/api/cloud/auth/sign-in/email',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},
          body:JSON.stringify({email:a.email,password})}),'192.0.2.20');
        assert.equal(login.status,200);
        a.cookie=login.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ');
        a.token=(await login.json()).token;assert(a.cookie&&a.token);return a.token;
      },
    });
  }finally{
    await owner.query('rollback');
    await owner.query('update kanto_auth."user" set "emailVerified"=true where id=$1',[c.id]);
  }
}
