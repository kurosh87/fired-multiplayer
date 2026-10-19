import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {existsSync} from 'node:fs';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium,expect} from '@playwright/test';
import type {Database} from '../apps/server/src/database.ts';
import {createApp} from '../apps/server/src/app.ts';
import {originalGameProvider,originalGameDirectory} from './original-game-provider.ts';
import WebSocket from 'ws';
import type { AccountAuthConfig } from '../apps/server/src/account-auth.ts';
import { createServer as createViteServer } from 'vite';
import { resolve } from 'node:path';
import type {EngineRegistry} from '../packages/engine/registry.ts';

/** Explicit input-earned cartridge fixtures, not an upload admission path. */
export async function seedBattleLobby(database:Database,owners:[string,string],saves:[string,string],registry:EngineRegistry){
  await database.pool.query("update private.game_sessions set status='closed' where owner_id=any($1::uuid[])",[owners]);
  for(const [side,version] of (['firered','leafgreen'] as const).entries()){
    await database.pool.query('update private.adventures set flash=$2 where id=$1',[saves[side],await readFile(`${originalGameDirectory(version)}/gameplay.sav`)]);
    await database.pool.query(`insert into private.game_sessions(id,owner_id,adventure_id,artifact_id,seed,initial_flash,base_revision,status,lease_expires_at)
      select gen_random_uuid(),owner_id,id,$2,0,flash,revision,'lobby',clock_timestamp()+interval '60 seconds' from private.adventures where id=$1`,[saves[side],registry.manifest(version).id]);
  }
}

/** Real C, auth validation, HTTP/WS and UI on a wall clock. The isolated Auth
 * fixture does not qualify hosted signup/email or a public deployment. */
export async function checkBattleUi(source:Database,owners:[string,string],saves:[string,string],
  accounts?:{config:AccountAuthConfig;tokens:[string,string];unconfirmedToken:string;reauthenticate?:()=>Promise<string>;ownedDatabase?:boolean}):Promise<void>{
  const tag=process.env.KANTO_BATTLE_UI_EVIDENCE_TAG;
  if(tag)assert(/^[a-z0-9-]{1,32}$/.test(tag));
  const prefix=tag?`${tag}-`:'';
  const reportPath=`build/${prefix}battle-ui-report.json`;
  assert(!existsSync(reportPath),'Preserve retained battle UI evidence; choose a fresh tag.');
  let tail:Promise<unknown>=Promise.resolve();
  const serial=<T>(body:()=>Promise<T>):Promise<T>=>{const task=tail.catch(()=>undefined).then(body);tail=task;return task;};
  const database=accounts?.ownedDatabase?source:Object.assign(Object.create(Object.getPrototypeOf(source)),{
    pool:{query:(...args:unknown[])=>serial(()=>Reflect.apply(source.pool.query,source.pool,args))},
    transaction:<T>(body:Parameters<Database['transaction']>[0])=>serial(()=>source.transaction(body)) as Promise<T>,
  }) as Database;
  const registry=await originalGameProvider(),battleRegistry=await originalGameProvider(true);
  if(!accounts?.ownedDatabase)await database.pool.query('savepoint battle_ui');
  const web=await createViteServer({root:resolve('apps/web'),configFile:resolve('apps/web/vite.config.ts'),
    cacheDir:resolve('build/battle-ui-vite-cache'),logLevel:'warn',
    server:{host:'127.0.0.1',port:0,strictPort:true,fs:{allow:[resolve('.')]}}});
  try {
  await web.listen();const webAddress=web.httpServer?.address();assert(webAddress&&typeof webAddress!=='string');
  const origin=`http://127.0.0.1:${webAddress.port}`;
  const provider=accounts?undefined:createServer((request,response)=>{
    const unconfirmed=request.headers.authorization==='Bearer battle-unconfirmed';
    const owner=request.headers.authorization==='Bearer battle-alice'||unconfirmed?owners[0]:request.headers.authorization==='Bearer battle-bob'?owners[1]:undefined;
    response.setHeader('Content-Type','application/json');
    if(request.url!=='/auth/v1/user'||!owner){response.writeHead(401);response.end('{}');return;}
    response.end(JSON.stringify({id:owner,aud:'authenticated',email_confirmed_at:unconfirmed?null:'2026-10-16T00:00:00Z',
      app_metadata:{},user_metadata:{},identities:[],created_at:'2026-10-16T00:00:00Z'}));
  });
  if(provider)await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const address=provider?.address();
  if(provider)assert(address&&typeof address!=='string');
  const tokens=accounts?.tokens??['battle-alice','battle-bob'];
  const accountConfig=accounts?.config??{supabaseUrl:`http://127.0.0.1:${(address as {port:number}).port}`,publishableKey:'isolated-local-qualification'};
  const app=await createApp({origin,engineDirectory:'unused-qualification',...accountConfig,
    publicRelease:false},{database,registry,battleRegistry});
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    await seedBattleLobby(database,owners,saves,registry);
    const before=(await database.pool.query('select id,revision,flash from private.adventures order by id')).rows;
    const base=await app.listen({host:'127.0.0.1',port:0});
    assert.equal((await app.inject({method:'GET',url:'/api/battles'})).statusCode,401);
    assert.equal((await app.inject({method:'GET',url:'/api/battles',headers:{authorization:'Bearer '+(accounts?.unconfirmedToken??'battle-unconfirmed')}})).statusCode,403);
    const rejected=new WebSocket(base.replace('http:','ws:')+'/api/battle-play',{origin:'https://unrelated.invalid'});
    const rejectedCode=await new Promise<number>((resolve,reject)=>{rejected.once('close',resolve);rejected.once('error',reject);});assert.equal(rejectedCode,1008);
    browser=await chromium.launch({executablePath:process.env.KANTO_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
    const contexts=await Promise.all([browser.newContext({viewport:{width:1440,height:1000}}),browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true})]);
    const pages=await Promise.all(contexts.map(context=>context.newPage())),errors:string[]=[],downloads:string[]=[],commands:number[]=[0,0],pixels:number[]=[0,0],authRenewals:number[]=[0,0];
    const lifecycle:{side:number;at:number;event:string;detail:string}[]=[];
    await mkdir('test-output/screenshots',{recursive:true});
    for(let side=0;side<2;side++){
      const page=pages[side]!;await contexts[side]!.grantPermissions(['local-network-access'],{origin});
      page.on('framenavigated',frame=>{if(frame===page.mainFrame())lifecycle.push({side,at:Date.now(),event:'navigation',detail:frame.url()});});
      page.on('console',message=>{if(message.text().startsWith('[vite]'))lifecycle.push({side,at:Date.now(),event:'vite',detail:message.text()});});
      await page.addInitScript(()=>{
        (window as any).battleAuthSockets=[];
        (window as any).battleAuthErrors=[];
        window.WebSocket=new Proxy(window.WebSocket,{construct(Target,args){const socket=new Target(...args as [string|URL,(string|string[])?]);
          if(String(args[0]).includes('/api/battle-play')){
            (window as any).battleAuthSockets.push(socket);
            socket.addEventListener('message',event=>{if(typeof event.data==='string'){const body=JSON.parse(event.data);if(body.type==='error')(window as any).battleAuthErrors.push(body.error);}});
          }return socket;}});
      });
      page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>downloads.push(request.url()));
      page.on('websocket',socket=>{
        if(socket.url().includes('/api/battle-play')){
          lifecycle.push({side,at:Date.now(),event:'socket-open',detail:socket.url()});
          socket.on('close',()=>lifecycle.push({side,at:Date.now(),event:'socket-close',detail:socket.url()}));
        }
        socket.on('framesent',event=>{if(typeof event.payload==='string'&&JSON.parse(event.payload).type==='buttons')commands[side]!++;});
        socket.on('framereceived',event=>{if(typeof event.payload!=='string')pixels[side]!++;else if(JSON.parse(event.payload).type==='auth-refreshed')authRenewals[side]!++;});
      });
      await page.route('**/src/api.ts*',route=>route.fulfill({contentType:'text/javascript',body:`
        export const API_URL=${JSON.stringify(base)};
        export class ApiError extends Error{constructor(code,message,status){super(message);this.code=code;this.status=status;}}
        export async function token(){return ${JSON.stringify(tokens[side])};}
        export async function api(path,body){const response=await fetch(API_URL+path,{method:body===undefined?'GET':'POST',
          headers:{Authorization:'Bearer '+await token(),...(body===undefined?{}:{'Content-Type':'application/json'})},
          ...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();
          if(!response.ok)throw new ApiError(result.error,result.message,response.status);return result;}` }));
      await page.route('**/battle-ui-qualification',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div>
        <script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
        <script type="module" src="/@fs${fileURLToPath(new URL('./battle-ui-entry.tsx',import.meta.url))}"></script></body></html>`}));
      await page.goto(`${origin}/battle-ui-qualification`);
      try{await expect(page.getByRole('heading',{name:'Your party',exact:true})).toBeVisible();}
      catch(failure){await page.screenshot({path:`test-output/screenshots/${prefix}battle-ui-setup-failed-${side}.png`,fullPage:true});
        await writeFile(`build/${prefix}battle-ui-setup-failure.json`,JSON.stringify({side,errors,lifecycle,url:page.url(),text:await page.locator('body').innerText()},null,2)+'\n');throw failure;}
    }
    const [alice,bob]=pages as [typeof pages[number],typeof pages[number]];
    await alice.getByRole('button',{name:'Challenge to battle'}).click();
    await expect(bob.getByRole('button',{name:'Accept battle'})).toBeVisible({timeout:10000});
    const offered=(await database.pool.query("select id from private.battles where player_a=$1 and player_b=$2 and status='offered'",owners)).rows[0];assert(offered);
    assert.equal((await app.inject({method:'POST',url:`/api/battles/${offered.id}/accept`,headers:{authorization:'Bearer '+tokens[0]},payload:{}})).statusCode,403);
    assert.equal((await app.inject({method:'POST',url:`/api/battles/${offered.id}/accept`,headers:{authorization:'Bearer '+tokens[1]},payload:{winner:'b'}})).statusCode,400);
    await bob.getByRole('button',{name:'Accept battle'}).click();
    await expect(alice.getByRole('button',{name:'Continue battle'})).toBeVisible({timeout:10000});
    await alice.getByRole('button',{name:'Continue battle'}).click();
    for(const page of pages)await expect(page.getByRole('status')).toContainText('Connected',{timeout:15000});
    for(const [side,page] of pages.entries()) {
      const beforeCommands=commands[side];
      await page.getByRole('button',{name:'Forfeit battle',exact:true}).click();
      await expect(page.getByRole('button',{name:'Battle A',exact:true})).toBeDisabled();
      await page.keyboard.press('z',{delay:80});await page.keyboard.press('ArrowDown');await page.waitForTimeout(140);
      assert.equal(commands[side],beforeCommands,'Forfeit confirmation leaked keyboard input into the battle.');
      await page.getByRole('button',{name:'Keep playing',exact:true}).click();
      await expect(page.getByRole('button',{name:'Battle A',exact:true})).toBeEnabled();
    }
    for(const [side,page] of pages.entries()){
      await page.evaluate(()=>(window as any).battleAuthSockets.at(-1).dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'auth-required',protocol:1})})));
      await expect.poll(()=>authRenewals[side]).toBe(1);
      assert.equal(await page.evaluate(()=>(window as any).battleAuthSockets.length),1,'Authentication renewal replaced the battle socket.');
      await expect(page.getByRole('status')).toContainText('Connected');
    }
    const battle=(await database.pool.query("select id from private.battles where player_a=$1 and player_b=$2 and status='active'",owners)).rows[0];assert(battle);
    let reloaded=false,finished=false,captured=false;const deadline=Date.now()+180000;
    while(Date.now()<deadline){
      for(const [side,page] of pages.entries()){
        assert.equal(await page.locator('.game-error').count(),0,(await page.locator('.game-error').allTextContents()).join('; '));
        // Explicit browser input driver. No production auto-choice logic.
        if(side===0)await page.keyboard.press('z',{delay:65});
        else try{await page.getByRole('button',{name:'Battle A',exact:true}).tap({timeout:1000});}
        catch(failure){if(!await page.getByRole('button',{name:'Return to lobby'}).isVisible()){
          await page.screenshot({path:`test-output/screenshots/${prefix}battle-ui-failed-${side}.png`,fullPage:true});
          await writeFile(`build/${prefix}battle-ui-failure.json`,JSON.stringify({side,errors,lifecycle,authRenewals,url:page.url(),text:await page.locator('body').innerText(),
            state:(await database.pool.query('select status,result from private.battles where id=$1',[battle.id])).rows},null,2)+'\n');
          throw failure;
        }}
      }
      const state=(await database.pool.query('select b.status,b.result,r.frame from private.battles b join private.battle_runs r on r.battle_id=b.id where b.id=$1',[battle.id])).rows[0];
      if(!captured&&Number(state.frame)>1100){
        for(const page of pages)assert(await page.evaluate(()=>document.documentElement.scrollWidth)<=page.viewportSize()!.width,'The battle controls overflow the configured viewport.');
        await alice.screenshot({path:`test-output/screenshots/${prefix}battle-ui-desktop.png`,fullPage:true});
        await bob.screenshot({path:`test-output/screenshots/${prefix}battle-ui-mobile.png`,fullPage:true});captured=true;
      }
      if(!reloaded&&Number(state.frame)>2000){
        if(accounts?.reauthenticate){
          // A fresh connection avoids the one-minute duplicate-refresh throttle;
          // this assertion must exercise session revocation, not rate limiting.
          await alice.reload();await expect(alice.getByRole('button',{name:'Continue battle'})).toBeVisible({timeout:10000});
          await alice.getByRole('button',{name:'Continue battle'}).click();await expect(alice.getByRole('status')).toContainText('Connected',{timeout:10000});
          const old=tokens[0];tokens[0]=await accounts.reauthenticate();
          assert.notEqual(tokens[0],old);
          assert.equal((await app.inject({method:'GET',url:'/api/profile',headers:{authorization:'Bearer '+old}})).statusCode,401);
          // The loaded module still holds the revoked token. Exercise the real
          // refresh response before a reload obtains the new login token.
          await alice.evaluate(()=>(window as any).battleAuthSockets.at(-1).dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'auth-required',protocol:1})})));
          await expect.poll(()=>alice.evaluate(()=>(window as any).battleAuthErrors.includes('UNAUTHENTICATED'))).toBe(true);
          await expect.poll(()=>alice.evaluate(()=>(window as any).battleAuthSockets.at(-1).readyState)).toBeGreaterThanOrEqual(2);
        }
        await alice.reload();await expect(alice.getByRole('button',{name:'Continue battle'})).toBeVisible({timeout:10000});
        await alice.getByRole('button',{name:'Continue battle'}).click();await expect(alice.getByRole('status')).toContainText('Connected',{timeout:10000});reloaded=true;
      }
      if(state.status==='finished'){assert.equal(state.result.reason,'finished');finished=true;break;}
      await new Promise(resolve=>setTimeout(resolve,180));
    }
    assert(finished,'Original browser battle did not finish on the server clock.');assert(reloaded);assert(captured);
    for(const page of pages){await expect(page.getByRole('button',{name:'Return to lobby'})).toBeVisible();await page.getByRole('button',{name:'Return to lobby'}).click();await expect(page.getByRole('heading',{name:'Your party',exact:true})).toBeVisible();}
    assert.deepEqual(errors,[]);assert(commands.every(count=>count>20));assert(pixels.every(count=>count>20));
    assert.deepEqual(downloads.filter(url=>/\.wasm(?:\?|$)|checkpoint|snapshot/.test(url)),[]);
    assert.deepEqual((await database.pool.query('select id,revision,flash from private.adventures order by id')).rows,before);
    await writeFile(reportPath,JSON.stringify({artifacts:[battleRegistry.manifest('firered').id,battleRegistry.manifest('leafgreen').id],
      realOriginalC:true,realPostgres:true,realWallClock:true,ownedFrontendServer:true,authGetUserFixture:!accounts,realBetterAuthAccounts:Boolean(accounts),desktopAndMobileEmulation:true,
      isolatedConsoleWorkers:true,independentDatabaseTransactions:Boolean(accounts?.ownedDatabase),
      mobileTouchControls:true,forfeitConfirmationBlocksBattleInputs:true,viewportOverflowChecked:true,unconfirmedAccountRejected:true,wrongOriginRejected:true,
      lobbyChallenge:true,buttonsAcknowledged:true,personalScreensOnly:true,reloadRecovery:true,originalResult:true,
      canonicalAdventuresUnchanged:true,commands,pixels,authenticationRenewals:authRenewals,authenticationRenewalKeepsExistingSockets:true,
      authenticationChallengeDelivery:'native browser MessageEvent; real response over production WebSocket; server deadlines tested with controlled clock',
      logoutRevocationDuringBattle:Boolean(accounts?.reauthenticate),reauthenticatedRecovery:Boolean(accounts?.reauthenticate),
      browserTokenSource:accounts?'Actual Better Auth session through a fixture API module':'Isolated Supabase getUser fixture',
      hostedAccountsQualified:false,publicReleaseQualified:false},null,2)+'\n');
  }finally{await browser?.close();await app.close();if(provider)await new Promise<void>(resolve=>provider.close(()=>resolve()));if(!accounts?.ownedDatabase)await database.pool.query('rollback to savepoint battle_ui');}
  }finally{await web.close();}
}
