import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createAuthenticator} from '../apps/server/src/auth.ts';

test('bounded Auth validation aborts a hung provider without cancelling another player request',async()=>{
  let hungClosed=false;
  const provider=createServer((request,response)=>{
    if(request.headers.authorization==='Bearer hung'){
      response.on('close',()=>{hungClosed=true;});return;
    }
    response.setHeader('Content-Type','application/json');response.end(JSON.stringify({id:'00000000-0000-4000-8000-000000000001',
      aud:'authenticated',email_confirmed_at:'2026-10-16T00:00:00Z',app_metadata:{},user_metadata:{},identities:[],created_at:'2026-10-16T00:00:00Z'}));
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));const address=provider.address();assert(address&&typeof address!=='string');
  try{
    const authenticate=createAuthenticator(`http://127.0.0.1:${address.port}`,'fixture-public-key',100);
    const failed=assert.rejects(authenticate('Bearer hung'),{code:'AUTH_UNAVAILABLE',status:503});
    assert.equal(await authenticate('Bearer healthy'),'00000000-0000-4000-8000-000000000001');await failed;
    const end=Date.now()+1000;while(!hungClosed){assert(Date.now()<end,'The provider connection was not aborted.');await new Promise(resolve=>setTimeout(resolve,5));}
  }finally{provider.closeAllConnections();await new Promise<void>(resolve=>provider.close(()=>resolve()));}
});
