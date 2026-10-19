import assert from 'node:assert/strict';
import {writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {createServer as createViteServer} from 'vite';
import {chromium,expect} from '@playwright/test';
import type {Database} from '../apps/server/src/database.ts';
import type {RequestBattles} from '../apps/server/src/request-battles.ts';
import {requestBattleHttp} from '../apps/server/src/request-battle-http.ts';

/** Real same-origin browser fetch, source C consoles and SDK-created identities.
 * Token seeding is explicit; the service still verifies every actual session. */
export async function checkRequestBattleBrowser(database:Database,service:RequestBattles,authenticate:(authorization:string|undefined)=>Promise<string>,
  accounts:[{id:string;token:string},{id:string;token:string}],output:string){
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  let releaseBusy:(()=>void)|undefined;
  const active=new Set<Promise<unknown>>(),errors:string[]=[],steps:{side:number;body:any}[]=[],screenshots:string[]=[];
  const network:{side:number;path:string;status?:number;contentType?:string;failure?:string}[]=[];
  let origin='',handler:ReturnType<typeof requestBattleHttp>;
  const middleware=(incoming:IncomingMessage,outgoing:ServerResponse,next:()=>void)=>{
    if(!incoming.url?.startsWith('/api/online/battles')){next();return;}
    const work=(async()=>{
      const chunks:Buffer[]=[];let size=0;
      for await(const chunk of incoming){size+=chunk.length;if(size>8192)throw new Error('Oversized browser fixture request');chunks.push(Buffer.from(chunk));}
      const response=await handler(new Request(origin+incoming.url,{method:incoming.method,headers:incoming.headers as Record<string,string>,
        ...(incoming.method==='GET'?{}:{body:new Uint8Array(Buffer.concat(chunks))})}));
      outgoing.writeHead(response.status,Object.fromEntries(response.headers));outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch(()=>{if(!outgoing.headersSent)outgoing.writeHead(500);outgoing.end('{}');});
    active.add(work);void work.finally(()=>active.delete(work));
  };
  const web=await createViteServer({root:resolve('apps/web'),configFile:resolve('apps/web/vite.config.ts'),logLevel:'warn',
    cacheDir:resolve('build/request-battle-vite-cache'),define:{'import.meta.env.VITE_ACCOUNT_PROVIDER':JSON.stringify('better-auth'),'import.meta.env.VITE_BATTLE_TRANSPORT':JSON.stringify('http')},
    plugins:[{name:'kanto-native-battle-api',configureServer(server){server.middlewares.use(middleware);}}],
    server:{host:'127.0.0.1',port:0,strictPort:true,fs:{allow:[resolve('.')]}}});
  try{
    await web.listen();const address=web.httpServer?.address();assert(address&&typeof address!=='string');origin=`http://127.0.0.1:${address.port}`;
    handler=requestBattleHttp(service,authenticate,origin);
    const offered=await service.repository.challenge(accounts[0].id,accounts[1].id);await service.accept(accounts[1].id,offered.id);
    const views=await Promise.all(accounts.map(account=>service.repository.get(account.id,offered.id)));
    browser=await chromium.launch({executablePath:process.env.KANTO_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
    const contexts=await Promise.all([browser.newContext({viewport:{width:1440,height:1000}}),browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true})]);
    await mkdir('test-output/screenshots',{recursive:true});
    const pages=await Promise.all(contexts.map(context=>context.newPage()));
    const setup=async(page:typeof pages[number],side:number)=>{
      page.on('pageerror',error=>errors.push(error.message));
      page.on('response',response=>{const path=new URL(response.url()).pathname;if(path.startsWith('/api/online/battles'))network.push({side,path,status:response.status(),contentType:response.headers()['content-type']});});
      page.on('requestfailed',request=>{const path=new URL(request.url()).pathname;if(path.startsWith('/api/online/battles'))network.push({side,path,failure:request.failure()?.errorText});});
      page.on('request',request=>{if(request.url().endsWith('/step'))steps.push({side,body:request.postDataJSON()});});
      await page.addInitScript(value=>{(window as any).requestBattleFixture=value;},{battle:views[side],owner:accounts[side]!.id,token:accounts[side]!.token});
      await page.route('**/request-battle-ui',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div>
        <script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
        <script type="module" src="/@fs${fileURLToPath(new URL('../tests/request-battle-ui-entry.tsx',import.meta.url))}"></script></body></html>`}));
    };
    for(const [side,page] of pages.entries())await setup(page,side);
    let lostOperation='',forceBusy=false,busyOperation='';
    let sawBusy:()=>void=()=>{};
    const busyReached=new Promise<void>(resolve=>{sawBusy=resolve;}),busyRelease=new Promise<void>(resolve=>{releaseBusy=resolve;});
    await pages[0]!.route('**/step',async route=>{
      const body=route.request().postDataJSON();
      if(!lostOperation){
        const upstream=await route.fetch();if(!upstream.ok()){await route.fulfill({response:upstream});return;}
        lostOperation=body.operationId;await route.abort('failed');return;
      }
      if(forceBusy){
        forceBusy=false;busyOperation=body.operationId;assert(body.runs.every((run:any)=>run.buttons===0));sawBusy();await busyRelease;
        await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:'BATTLE_REQUEST_BUSY',message:'Another request is committing this battle. Retry shortly.'})});return;
      }
      await route.continue();
    });
    await Promise.all(pages.map(page=>page.goto(origin+'/request-battle-ui')));
    for(const page of pages)await expect(page.getByRole('status')).toContainText('Connected',{timeout:30_000});
    assert(steps.filter(value=>value.body.operationId===lostOperation).length>=2);
    assert.equal(Number((await database.pool.query('select count(*) from private.battle_request_receipts where battle_id=$1 and operation_id=$2',[offered.id,lostOperation])).rows[0].count),1);
    await pages[0]!.locator('canvas').click();forceBusy=true;
    await Promise.race([busyReached,new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('No HTTP request reached the contention fixture.')),10_000))]);
    const beforeBufferedTap=steps.length;await pages[0]!.keyboard.press('KeyZ');await pages[0]!.waitForTimeout(50);releaseBusy!();
    await expect.poll(()=>steps.slice(beforeBufferedTap).some(value=>value.side===0&&value.body.operationId!==busyOperation&&value.body.runs.some((run:any)=>run.buttons&1)),{timeout:15_000}).toBe(true);
    assert(steps.filter(value=>value.body.operationId===busyOperation).length>=2,'A busy response must retry the same operation.');
    for(const [side,page] of pages.entries()){
      await expect.poll(async()=>Number(await page.locator('canvas').getAttribute('data-frame')),{timeout:20_000}).toBeGreaterThan(60);
      await page.locator('canvas').click();
      const beforeTap=steps.length;if(side)await page.getByRole('button',{name:'Battle A',exact:true}).tap();else await page.keyboard.press('KeyZ');
      await expect.poll(()=>steps.slice(beforeTap).some(value=>value.side===side&&value.body.runs.some((run:any)=>run.buttons&1)),{timeout:10_000}).toBe(true);
      await page.getByRole('button',{name:'Forfeit battle',exact:true}).click();
      await expect(page.getByRole('button',{name:'Battle A',exact:true})).toBeDisabled();
      const before=steps.length,priorOperations=new Set(steps.map(value=>value.body.operationId));await page.keyboard.press('KeyZ');await page.keyboard.press('ArrowDown');await page.waitForTimeout(700);
      assert(steps.slice(before).filter(value=>value.side===side&&!priorOperations.has(value.body.operationId)).every(value=>value.body.runs.every((run:any)=>run.buttons===0)),'Confirmation leaked new controls');
      await page.getByRole('button',{name:'Keep playing',exact:true}).click();
      await expect(page.getByRole('button',{name:'Battle A',exact:true})).toBeEnabled();
      const path=output+`/http-battle-${side?'mobile':'desktop'}.png`;await page.screenshot({path,fullPage:true});screenshots.push(path);
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    }
    const previous=(await database.pool.query('select control_epoch_b from private.battle_request_runs where battle_id=$1',[offered.id])).rows[0].control_epoch_b;
    await pages[1]!.reload();await expect(pages[1]!.getByRole('status')).toContainText('Connected',{timeout:20_000});
    assert.equal(Number((await database.pool.query('select control_epoch_b from private.battle_request_runs where battle_id=$1',[offered.id])).rows[0].control_epoch_b),Number(previous)+1);
    const replacement=await contexts[0]!.newPage();await setup(replacement,0);await replacement.goto(origin+'/request-battle-ui');
    await expect(replacement.getByRole('status')).toContainText('Connected',{timeout:20_000});
    await expect(pages[0]!.getByText('This battle is open in another tab. Reconnect here to take control.',{exact:false})).toBeVisible({timeout:20_000});
    await expect(pages[0]!.getByRole('button',{name:'Battle A',exact:true})).toBeDisabled();
    const state=(await database.pool.query('select control_id_a,control_epoch_a from private.battle_request_runs where battle_id=$1',[offered.id])).rows[0];
    await pages[0]!.waitForTimeout(1200);assert.deepEqual((await database.pool.query('select control_id_a,control_epoch_a from private.battle_request_runs where battle_id=$1',[offered.id])).rows[0],state);
    await replacement.getByRole('button',{name:'Forfeit battle',exact:true}).click();await replacement.getByRole('button',{name:'Confirm forfeit',exact:true}).click();
    for(const page of [replacement,pages[1]!])await expect(page.getByRole('button',{name:'Return to lobby',exact:true})).toBeVisible({timeout:20_000});
    await replacement.getByRole('button',{name:'Return to lobby',exact:true}).click();await expect(replacement.locator('body')).toHaveAttribute('data-exited','true');
    assert.deepEqual(errors,[]);
    assert.deepEqual(network.filter(item=>item.status!==undefined&&item.status>=500),[],'Unexpected server failures occurred during the browser journey.');
    const report={checkedAt:new Date().toISOString(),actualSameOriginHttp:true,actualSdkCreatedAccounts:true,actualOriginalC:true,restrictedPostgres:true,
      desktopAndMobile:true,shortKeyboardAndTouchTaps:true,forfeitConfirmationBlocksControls:true,exactLostReplyRetry:true,busyRetryRetainsBufferedTap:true,singleBusyResponseFixture:true,reloadPreservesSequence:true,
      replacedTabStopsWithoutReclaiming:true,atomicForfeitAndLobbyReturn:true,noBrowserErrors:true,noUnexpectedServerFailures:true,noViewportOverflow:true,steps:steps.length,screenshots,hosted:false,publicReleaseQualified:false};
    await writeFile(output+'/request-battle-browser-report.json',JSON.stringify(report,null,2)+'\n');return report;
  }catch(error){
    const views=[];
    for(const [index,page] of (browser?.contexts().flatMap(context=>context.pages())??[]).entries()){
      const path=output+`/http-battle-failure-${index}.png`;await page.screenshot({path,fullPage:true}).catch(()=>{});
      views.push({path,text:await page.locator('body').innerText().catch(()=>'Unavailable')});
    }
    await writeFile(output+'/request-battle-browser-failure.json',JSON.stringify({error:String(error),errors,steps:steps.length,origin,network:network.slice(-100),views},null,2)+'\n');throw error;
  }
  finally{releaseBusy?.();await browser?.close();await Promise.allSettled([...active]);await web.close();}
}
