import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
const [origin,tag]=process.argv.slice(2);
assert(origin&&tag&&/^[a-z0-9-]{1,50}$/.test(tag));
const url=new URL(origin);assert(url.protocol==='https:'&&(url.hostname==='kanto-online-preview.netlify.app'||/^[a-f0-9]{24}--kanto-online-preview\.netlify\.app$/.test(url.hostname)));
const output=`build/${tag}-http.json`;assert(!existsSync(output));
const results:unknown[]=[];
async function check(path:string,status:number,body?:unknown,requestOrigin:string=origin!){
  const response=await fetch(origin+path,{signal:AbortSignal.timeout(30000),...(body?{method:'POST',headers:{Origin:requestOrigin,'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
  const data=await response.json();assert.equal(response.status,status,JSON.stringify({path,status:response.status,data}));
  assert.equal(response.headers.get('cache-control'),'no-store');results.push({path,status:response.status,noStore:true});return data;
}
assert.equal(await check('/api/cloud/auth/get-session',200),null);
await check('/api/cloud/profile',401);await check('/api/cloud/saves/firered',401);await check('/api/cloud/saves/leafgreen',401);
await check('/api/cloud/adventures',401,{version:'firered'});
await check('/api/cloud/adventures/00000000-0000-4000-8000-000000000000/save',401);
await check('/api/cloud/profile',403,{handle:'NoWrite'},'https://foreign.invalid');
await check('/api/cloud/auth/sign-in/email',401,{email:'hosting-smoke@example.invalid',password:'No account fixture 2026!'});
const page=await fetch(origin+'/account/recovery');assert.equal(page.status,200);assert((await page.text()).includes('<div id="root">'));
await writeFile(output,JSON.stringify({checkedAt:new Date().toISOString(),origin,results,recoveryRoute:true,
  actualHostedAuthDatabaseQuery:true,externalEmailsSent:0,scope:'Public HTTP configuration and unauthenticated access checks. No hosted account or cloud save was created.'},null,2)+'\n');
console.log(JSON.stringify({output,origin,checks:results.length,recoveryRoute:true,actualHostedAuthDatabaseQuery:true}));
