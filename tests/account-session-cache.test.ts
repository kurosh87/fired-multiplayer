import {test} from 'node:test';
import assert from 'node:assert/strict';
import {AccountSessionCache,type AccountCredential} from '../apps/web/src/lib/account-session-cache.ts';
const a:AccountCredential={owner:'alice',token:'local-test-alice',expiresAt:10000,emailVerified:true};
const b:AccountCredential={...a,owner:'bob',token:'local-test-bob'};

test('active credentials avoid repeated account HTTP queries and cold requests share one fetch',async()=>{
  const cache=new AccountSessionCache();let calls=0,finish!:(value:AccountCredential)=>void;
  const pending=new Promise<AccountCredential>(resolve=>{finish=resolve;});
  const load=()=>{calls++;return pending;};
  const first=cache.token(load,()=>1000),second=cache.token(load,()=>1000);assert.equal(calls,1);
  finish(a);assert.deepEqual(await Promise.all([first,second]),[a.token,a.token]);
  assert.equal(await cache.token(load,()=>1000),a.token);assert.equal(calls,1);
});
test('logout and account switching invalidate outstanding credential requests',async()=>{
  const cache=new AccountSessionCache();let finish!:(value:AccountCredential)=>void;
  const old=cache.token(()=>new Promise(resolve=>{finish=resolve;}),()=>1000);
  cache.clear();cache.observe(b);finish(a);
  await assert.rejects(old,/account changed/);
  assert.equal(await cache.token(async()=>{throw new Error('Unexpected account query.');},()=>1000),b.token);
});
test('expired, unconfirmed and absent sessions never supply a game token',async()=>{
  const cache=new AccountSessionCache();cache.observe({...a,expiresAt:500});
  assert.equal(await cache.token(async()=>b,()=>1000),b.token);
  cache.clear();await assert.rejects(cache.token(async()=>({...a,emailVerified:false}),()=>1000),/Confirm your email/);
  await assert.rejects(cache.token(async()=>({...a,expiresAt:500}),()=>1000),/sign in/);
  await assert.rejects(cache.token(async()=>null,()=>1000),/sign in/);
});
