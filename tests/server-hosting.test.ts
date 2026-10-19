import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../apps/server/src/app.ts';
import type { Database } from '../apps/server/src/database.ts';
import { EngineRegistry } from '../packages/engine/registry.ts';
import { hostingFixtureRegistry } from './hosting-readiness.integration.ts';
import { parseTrustedProxyCidrs } from '../apps/server/src/runtime-config.ts';

const config={origin:'http://127.0.0.1:5173',engineDirectory:'unused-hosting-fixture',publicRelease:false};

test('proxy configuration accepts explicit IPs and CIDRs, never boolean or hop trust',()=>{
  assert.equal(parseTrustedProxyCidrs(undefined),undefined);assert.equal(parseTrustedProxyCidrs('  '),undefined);
  assert.deepEqual(parseTrustedProxyCidrs('127.0.0.1, ::1/128,10.20.3.0/24,127.0.0.1'),['127.0.0.1','::1/128','10.20.3.0/24']);
  for(const value of ['true','false','1','loopback','127.0.0.1,','127.0.0.1/33','::1/129','127.0.0.1/','127.0.0.1/1/2','0.0.0.0/0','::/0'])assert.throws(()=>parseTrustedProxyCidrs(value),/TRUST_PROXY_CIDRS/);
});

test('direct server configuration cannot bypass proxy validation',async()=>{
  await assert.rejects(createApp({...config,trustedProxyCidrs:['0.0.0.0/0']}),/TRUST_PROXY_CIDRS/);
  await assert.rejects(createApp({...config,trustedProxyCidrs:['true']}),/TRUST_PROXY_CIDRS/);
});

for(const trusted of [false,true])test(`${trusted?'untrusted sender with configured proxy':'default direct sender'} cannot rotate forwarded IPs to evade rate limits`,async()=>{
  const app=await createApp({...config,...(trusted?{trustedProxyCidrs:['127.0.0.1/32']}: {})});
  try{
    for(let i=0;i<121;i++){
      const response=await app.inject({url:'/healthz',remoteAddress:'198.51.100.20',headers:{'x-forwarded-for':`203.0.113.${i%250+1}`}});
      assert.equal(response.statusCode,i<120?200:429);
    }
    assert.equal((await app.inject({url:'/healthz',remoteAddress:'198.51.100.21'})).statusCode,200);
  }finally{await app.close();}
});

test('trusted ingress separates actual clients and stops at the nearest untrusted hop',async()=>{
  const app=await createApp({...config,trustedProxyCidrs:['127.0.0.1/32']});
  try{
    for(let i=0;i<121;i++){
      const response=await app.inject({url:'/healthz',remoteAddress:'127.0.0.1',headers:{'x-forwarded-for':`203.0.113.${i%250+1}, 198.51.100.40`}});
      assert.equal(response.statusCode,i<120?200:429);
    }
    assert.equal((await app.inject({url:'/healthz',remoteAddress:'127.0.0.1',headers:{'x-forwarded-for':'198.51.100.41'}})).statusCode,200);
  }finally{await app.close();}
});

test('readiness requires both artifact statuses, configured accounts and a successful database ping',async()=>{
  let available=true,queries=0;
  const database={pool:{async query(){queries++;if(!available)throw new Error('private database detail');return {rows:[{value:1}]};}}} as unknown as Database;
  for(const registry of [new EngineRegistry(),hostingFixtureRegistry()]){
    if(registry.status().length)registry.status=()=>[{version:'firered',available:true,reason:'fixture'}];
    const app=await createApp({...config,supabaseUrl:'https://fixture.invalid',publishableKey:'fixture-only'},{database,registry});
    try{assert.equal((await app.inject('/readyz')).statusCode,503);}finally{await app.close();}
  }
  assert.equal(queries,0,'Missing artifacts must not probe the database.');
  const missingAuth=await createApp(config,{database,registry:hostingFixtureRegistry()});
  try{assert.equal((await missingAuth.inject('/readyz')).statusCode,503);}finally{await missingAuth.close();}
  assert.equal(queries,0);
  const app=await createApp({...config,supabaseUrl:'https://fixture.invalid',publishableKey:'fixture-only'},{database,registry:hostingFixtureRegistry()});
  try{
    assert.equal((await app.inject('/readyz')).statusCode,200);assert.equal(queries,1);
    available=false;const failed=await app.inject('/readyz');assert.equal(failed.statusCode,503);assert.deepEqual(failed.json(),{ready:false});assert(!failed.body.includes('private database detail'));
    assert.equal((await app.inject('/healthz')).statusCode,200);
    available=true;assert.equal((await app.inject('/readyz')).statusCode,200);
  }finally{await app.close();}
});
