import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { configuredAccountAuthenticator, createBetterAuthAuthenticator } from '../apps/server/src/account-auth.ts';

test('account configuration rejects partial and mixed identity providers',()=>{
  assert.equal(configuredAccountAuthenticator({}),undefined);
  assert.throws(()=>configuredAccountAuthenticator({supabaseUrl:'https://fixture.invalid'}),/both Supabase/);
  assert.throws(()=>configuredAccountAuthenticator({accountOrigin:'https://kanto-fixture.invalid'}),/together/);
  assert.throws(()=>configuredAccountAuthenticator({accountOrigin:'https://kanto-fixture.invalid',publishableKey:'fixture'}),/cannot be mixed/);
});

test('Better Auth adapter refuses insecure origins and malformed credentials before querying',async()=>{
  const pool=new pg.Pool({connectionString:'postgresql://unused@localhost/unused'});
  let connections=0;
  Object.defineProperty(pool,'connect',{value:()=>{connections++;throw new Error('Malformed credentials must not open the database.');}});
  try{
    for(const origin of ['http://foreign.invalid','https://kanto-fixture.invalid/path','https://user:pass@kanto-fixture.invalid'])
      assert.throws(()=>createBetterAuthAuthenticator(pool,origin,'x'.repeat(48)),/origin/);
    assert.throws(()=>createBetterAuthAuthenticator(pool,'https://kanto-fixture.invalid','short'),/BETTER_AUTH_SECRET/);
    const authenticate=createBetterAuthAuthenticator(pool,'https://kanto-fixture.invalid','x'.repeat(48));
    for(const authorization of [undefined,'','Cookie abc','Bearer ','Bearer '+'x'.repeat(8192)])
      await assert.rejects(authenticate(authorization),{code:'UNAUTHENTICATED'});
    await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(connections,0);
    assert.equal(pool.totalCount,0);
  }finally{await pool.end();}
});
