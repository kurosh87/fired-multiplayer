import assert from 'node:assert/strict';
import pg from 'pg';
import { Database } from '../apps/server/src/database.ts';
import { Sessions } from '../apps/server/src/sessions.ts';
import { originalGameProvider } from '../tests/original-game-provider.ts';
import { checkBattleUi,seedBattleLobby } from '../tests/battle-ui-qualification.ts';
import type { createPreviewCloud } from '../apps/server/src/preview-cloud.ts';
import { randomUUID } from 'node:crypto';
import {checkMainAccountsBrowser} from './check-main-accounts-browser.ts';
import {checkRequestBattlesHttp} from './check-request-battles-http.ts';
import {checkNetlifyBattlesLocal} from './check-netlify-battles-local.ts';

type Account={id:string;email:string;cookie:string;token:string};
/** Rehearse the actual game schema and restricted login. Cartridge fixtures
 * remain explicit; account/profile/adventure identities come from the real
 * SDK and metadata adapter, without a compatibility auth.users table. */
export async function checkGameAccounts(owner:pg.Client,accountDatabaseUrl:string,origin:string,secret:string,
  cloud:ReturnType<typeof createPreviewCloud>,accounts:[Account,Account,Account],password:string,output:string){
  const [a,b,c]=accounts,login='kanto_game_check_'+Date.now();
  assert.equal((await owner.query("select to_regclass('auth.users') as users")).rows[0].users,null);
  assert.equal((await owner.query("select relkind from pg_class where oid='public.profiles'::regclass")).rows[0].relkind,'v');
  await owner.query(`create role "${login}" login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls`);
  await owner.query(`grant kanto_game_runtime to "${login}" with inherit false`);
  await owner.query(`grant kanto_game_runtime to "${login}" with set true`);
  const url=new URL(accountDatabaseUrl);url.username=login;url.password='';
  const game=new Database(url.href,()=>{},'netlify',{managedGameRole:true}),accountPool=new pg.Pool({connectionString:accountDatabaseUrl,max:1});
  let sessions:Sessions|undefined;
  try{
    const flags=(await game.pool.query('select rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls from pg_roles where rolname=current_user')).rows[0];
    assert(Object.values(flags).every(value=>value===false));
    const snapshots=(await owner.query('select id,revision,flash,sha256 from kanto_preview.adventures order by id')).rows;
    const views=await Promise.all([game.adventures(a.id),game.adventures(a.id),game.adventures(b.id)]);
    const original=await cloud.store.overview(a.id);
    assert.deepEqual(views[0]!.map(v=>v.id),original.slots.map(v=>v.id));assert.deepEqual(views[0],views[1]);
    assert(views[0]!.every(v=>!v.hasSave&&v.revision===0));
    assert.deepEqual(await game.profile(a.id),{id:a.id,handle:original.profile!.handle});
    await assert.rejects(game.createProfile(a.id,'DifferentName'),{code:'ACCOUNT_PROFILE_REQUIRED'});
    await game.transaction(async client=>{await client.query('select id from public.profiles where id=$1 for update',[a.id]);});
    for(const sql of ['select * from kanto_auth."user"','select flash from kanto_preview.adventures',
      "update kanto_preview.profiles set handle='Changed'",'delete from private.adventures','truncate private.adventures',
      'create table private.unwanted(id integer)','set role kanto_netlify_runtime'])
      await assert.rejects(game.pool.query(sql),{code:'42501'});
    await assert.rejects(accountPool.query('select * from private.adventures'),{code:'42501'});
    const future=await cloud.store.createAdventure(b.id,'firered');
    const futureSlot=future.slots.find(v=>v.id===future.createdId)!;
    for(const values of [[futureSlot.id,a.id,'leafgreen',1],[futureSlot.id,b.id,'firered',2]])
      await assert.rejects(game.pool.query('insert into private.adventures(id,owner_id,version,slot) values($1,$2,$3,$4)',values),
        {code:'23503',constraint:'adventures_id_owner_id_version_slot_fkey'});
    const slots=(await game.adventures(a.id)).filter(v=>v.version==='firered');assert.equal(slots.length,3);
    sessions=new Sessions(game,await originalGameProvider(),{pool:1});
    await assert.rejects(sessions.start(a.id,'firered'),{code:'ADVENTURE_SELECTION_REQUIRED'});
    const selected=slots[2]!,other=slots[1]!;
    const start=await sessions.start(a.id,'firered',selected.id);assert.equal(start.adventureId,selected.id);
    const fence=sessions.connectionFence(a.id,start.id);sessions.resume(a.id,start.id,fence);
    await sessions.accept(a.id,start.id,{type:'input',protocol:1,sessionId:start.id,sequence:0,operationId:randomUUID(),startFrame:0,runs:[{buttons:0,frames:15}]},fence);
    await assert.rejects(sessions.start(a.id,'firered',other.id),{code:'ADVENTURE_ACTIVE'});
    assert.equal(sessions.connectionFence(a.id,start.id),fence);await sessions.exit(a.id,start.id);
    const next=await sessions.start(a.id,'firered',other.id);assert.equal(next.adventureId,other.id);assert.equal(next.frame,0);
    await sessions.exit(a.id,next.id);await sessions.close();sessions=undefined;
    assert.deepEqual((await owner.query('select id,revision,flash,sha256 from kanto_preview.adventures where id=any($1::uuid[]) order by id',[snapshots.map(v=>v.id)])).rows,snapshots);
    const bSlots=await game.adventures(b.id),saved:[string,string]=[views[0]!.find(v=>v.version==='firered'&&v.slot===0)!.id,bSlots.find(v=>v.version==='leafgreen'&&v.slot===0)!.id];
    if(process.env.KANTO_CHECK_NETLIFY_BATTLES==='1')await checkNetlifyBattlesLocal(game,owner,accountDatabaseUrl,origin,secret,[a,b],saved,output);
    if(process.env.KANTO_CHECK_REQUEST_BATTLES==='1')await checkRequestBattlesHttp(game,owner,accountDatabaseUrl,origin,secret,cloud,accounts,password,saved,output);
    if(process.env.KANTO_CHECK_MAIN_ACCOUNTS==='1'){
      await seedBattleLobby(game,[a.id,b.id],saved,await originalGameProvider());
      await checkMainAccountsBrowser(game,accountDatabaseUrl,secret,[a,b],password,output);
    }
    await owner.query('update kanto_auth."user" set "emailVerified"=false where id=$1',[c.id]);
    if(process.env.KANTO_CHECK_BETTER_AUTH_BATTLE==='1')await checkBattleUi(game,[a.id,b.id],saved,{
      ownedDatabase:true,config:{accountOrigin:origin,accountSecret:secret,accountDatabaseUrl},tokens:[a.token,b.token],unconfirmedToken:c.token,
      reauthenticate:async()=>{
        const logout=await cloud.fetch(new Request(origin+'/api/cloud/auth/sign-out',{method:'POST',headers:{Origin:origin,Cookie:a.cookie,'Content-Type':'application/json'},body:'{}'}),'192.0.2.20');assert.equal(logout.status,200);
        const response=await cloud.fetch(new Request(origin+'/api/cloud/auth/sign-in/email',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({email:a.email,password})}),'192.0.2.20');assert.equal(response.status,200);
        a.cookie=response.headers.getSetCookie().map(v=>v.split(';')[0]).join('; ');a.token=(await response.json()).token;assert(a.cookie&&a.token);return a.token;
      },
    });
    assert.deepEqual((await owner.query('select id,revision,flash,sha256 from kanto_preview.adventures where id=any($1::uuid[]) order by id',[snapshots.map(v=>v.id)])).rows,snapshots);
  }finally{
    await sessions?.close();await game.close();await accountPool.end();
    await owner.query('update kanto_auth."user" set "emailVerified"=true where id=$1',[c.id]);
    await owner.query(`alter role "${login}" nologin`);
  }
}
