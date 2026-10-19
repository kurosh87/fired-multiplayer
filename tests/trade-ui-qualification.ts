import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { writeFile,mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium,expect,type Page } from '@playwright/test';
import type { Database } from '../apps/server/src/database.ts';
import type { EngineRegistry } from '../packages/engine/registry.ts';
import { createApp } from '../apps/server/src/app.ts';

type SavedRow={id:string;revision:string;flash:Buffer};
type TradeUiOptions={earnedJourney?:boolean;expectedOffer?:string;inspectCommitted?:(saves:SavedRow[])=>Promise<void>};
/** Full local HTTP/WS + real UI/worker qualification using an isolated auth
 * provider. This does not prove hosted signup, email delivery or deployment. */
export async function checkTradeUi(database:Database,registry:EngineRegistry,owners:[string,string],saves:[string,string],options:TradeUiOptions={}):Promise<void> {
  const evidenceTag=process.env.KANTO_UI_EVIDENCE_TAG;
  if(evidenceTag)assert(/^[a-z0-9-]{1,32}$/.test(evidenceTag));
  const prefix=evidenceTag?`${evidenceTag}-`:'';
  const audio=process.env.KANTO_CHECK_TRADE_AUDIO==='1'||Boolean(options.earnedJourney);
  assert(!(audio&&process.env.KANTO_CHECK_AUDIO_LEGACY==='1'),'Choose positive trade audio or legacy no-audio coverage.');
  // The surrounding contract holds one rollback transaction on one client.
  // Serialize entire savepoint transactions, including direct reads, so two
  // real browser clients cannot interleave that test-only connection's SQL.
  const source=database;
  let sqlTail:Promise<unknown>=Promise.resolve();
  function serial<T>(body:()=>Promise<T>):Promise<T> {
    const task=sqlTail.catch(()=>undefined).then(body);sqlTail=task;return task;
  }
  database=Object.assign(Object.create(Object.getPrototypeOf(source)),{
    pool:{query:(...args:unknown[])=>serial(()=>Reflect.apply(source.pool.query,source.pool,args))},
    transaction:<T>(body:Parameters<Database['transaction']>[0])=>serial(()=>source.transaction(body)) as Promise<T>,
  }) as Database;
  const origin='http://127.0.0.1:5173';
  const provider=createServer((request,response)=> {
    const owner=request.headers.authorization==='Bearer qualification-alice'?owners[0]
      :request.headers.authorization==='Bearer qualification-bob'?owners[1]:undefined;
    response.setHeader('Content-Type','application/json');
    if (request.url!=='/auth/v1/user'||!owner) {response.writeHead(401);response.end('{}');return;}
    response.end(JSON.stringify({id:owner,aud:'authenticated',email_confirmed_at:'2026-10-16T00:00:00Z',
      app_metadata:{},user_metadata:{},identities:[],created_at:'2026-10-16T00:00:00Z'}));
  });
  await new Promise<void>(resolve=>provider.listen(0,'127.0.0.1',resolve));
  const address=provider.address();assert(address&&typeof address!=='string');
  const app=await createApp({origin,engineDirectory:'unused-qualification-provider',
    supabaseUrl:`http://127.0.0.1:${address.port}`,publishableKey:'local-qualification',publicRelease:false},{database,registry});
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try {
    const base=await app.listen({host:'127.0.0.1',port:0});
    browser=await chromium.launch({executablePath:process.env.KANTO_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
    const errors:string[]=[];
    const contexts=await Promise.all([browser.newContext({viewport:{width:1440,height:1000}}),browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true})]);
    // Permission belongs only to these fresh qualification contexts.
    for(const context of contexts) await context.grantPermissions(['local-network-access'],{origin});
    const pages=await Promise.all(contexts.map(context=>context.newPage()));
    const sent:any[][]=[[],[]],authRenewals=[0,0];
    await mkdir('test-output/screenshots',{recursive:true});
    for(let side=0;side<2;side++) {
      const page=pages[side]!;
      await page.addInitScript(()=>{
        (window as any).tradeAuthSockets=[];
        window.WebSocket=new Proxy(window.WebSocket,{construct(Target,args){const socket=new Target(...args as [string|URL,(string|string[])?]);
          if(String(args[0]).includes('/api/play'))(window as any).tradeAuthSockets.push(socket);return socket;}});
      });
      page.on('websocket',socket=>{
        if(!/\/api\/play(?:\?|$)/.test(socket.url()))return;
        socket.on('framereceived',event=>{if(typeof event.payload==='string'&&JSON.parse(event.payload).type==='auth-refreshed')authRenewals[side]!++;});
      });
      if(audio){
        await installAudioProbe(page);
        page.on('websocket',socket=>{
          if(!/\/api\/play(?:\?|$)/.test(socket.url()))return;
          socket.on('framesent',event=>{if(typeof event.payload==='string')sent[side]!.push(JSON.parse(event.payload));});
        });
      }
      page.on('pageerror',error=>errors.push(error.message));
      page.on('requestfailed',request=>console.log(JSON.stringify({tradeUiRequestFailed:request.url(),reason:request.failure()?.errorText})));
      page.on('console',message=>{if(message.type()==='error')console.log(JSON.stringify({tradeUiConsoleError:message.text()}));});
      await page.route('**/src/api.ts*',route=>route.fulfill({contentType:'text/javascript',body:`
        export const API_URL=${JSON.stringify(base)};
        export class ApiError extends Error {constructor(code,message,status){super(message);this.code=code;this.status=status;}}
        export async function token(){return ${JSON.stringify(side===0?'qualification-alice':'qualification-bob')};}
        export async function api(path,body){const response=await fetch(API_URL+path,{method:body===undefined?'GET':'POST',
          headers:{Authorization:'Bearer '+await token(),...(body===undefined?{}:{'Content-Type':'application/json'})},
          ...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();
          if(!response.ok)throw new ApiError(result.error,result.message,response.status);return result;}
      `}));
      await page.route('**/trade-ui-qualification*',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head>
        <meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div>
        <script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
        <script type="module" src="/@fs${fileURLToPath(new URL('./trade-ui-entry.tsx',import.meta.url))}"></script></body></html>`}));
      await page.goto(`${origin}/trade-ui-qualification${options.earnedJourney?`?journey=1&version=${side===0?'firered':'leafgreen'}`:''}`);
      if(options.earnedJourney){
        const prior=(await database.pool.query('select revision from private.adventures where id=$1',[saves[side]])).rows[0];
        await expect(page.getByRole('button',{name:'Pause & checkpoint',exact:true})).toBeEnabled({timeout:15000});
        const gesture=async(name:string)=>{const button=page.getByRole('button',{name,exact:true});if(side===1)await button.tap();else await button.click();};
        await gesture('Enable sound');await expect.poll(()=>audioPeak(page)).toBeGreaterThan(0.00001);
        await gesture('Enter online lobby');
        await expect(page.getByRole('heading',{name:'Your party',exact:true})).toBeVisible({timeout:15000});
        await expect.poll(()=>page.evaluate(()=>(window as any).tradeAudioContexts.at(-1).state)).toBe('closed');
        const saved=(await database.pool.query('select revision from private.adventures where id=$1',[saves[side]])).rows[0];assert.equal(Number(saved.revision),Number(prior.revision)+1);
        await page.evaluate(version=>history.replaceState({},'',`${location.pathname}?version=${version}`),side===0?'firered':'leafgreen');
      }
      await expect(page.getByRole('heading',{name:'Your party',exact:true})).toBeVisible();
    }
    const [alice,bob]=pages as [typeof pages[number],typeof pages[number]];
    await alice.getByRole('button',{name:'Invite to trade'}).click();
    await expect(bob.getByRole('heading',{name:'Trade invitations',exact:true})).toBeVisible({timeout:10000});
    await alice.getByLabel('Pokémon to offer').selectOption('1');
    await expect(bob.locator('.trade-card').getByText(options.expectedOffer??'PIDGEY',{exact:true})).toBeVisible({timeout:10000});
    await bob.getByLabel('Pokémon to offer').selectOption('1');
    await expect(alice.getByRole('button',{name:'Confirm both offers'})).toBeEnabled({timeout:10000});
    await alice.getByRole('button',{name:'Confirm both offers'}).click();
    await bob.getByRole('button',{name:'Confirm both offers'}).click();
    await expect(alice.getByRole('button',{name:'Play trade scene'})).toBeVisible({timeout:10000});
    await alice.screenshot({path:`test-output/screenshots/${prefix}trade-offers-desktop.png`,fullPage:true});
    await bob.screenshot({path:`test-output/screenshots/${prefix}trade-offers-mobile.png`,fullPage:true});
    await alice.getByRole('button',{name:'Play trade scene'}).click();
    await expect(bob.getByRole('button',{name:/Play trade scene|Continue trade/})).toBeVisible();
    await bob.getByRole('button',{name:/Play trade scene|Continue trade/}).click();
    for(const page of pages) await expect(page.locator('.game-page')).toBeVisible({timeout:10000});
    if(process.env.KANTO_CHECK_AUDIO_LEGACY==='1')for(const page of pages)await expect(page.getByRole('button',{name:'Enable sound',exact:true})).toBeDisabled();
    for(const page of pages)assert(await page.evaluate(width=>document.documentElement.scrollWidth<=width,page.viewportSize()!.width),'The trade player exceeds its device viewport.');
    const activeTrade=(await database.pool.query("select id from private.trades where player_a=$1 and player_b=$2 and status='committing'",[...owners])).rows[0];
    assert(activeTrade,'The UI did not reserve its trade.');
    const before=(await database.pool.query('select id,revision,flash from private.adventures where id=any($1::uuid[]) order by id',[saves])).rows;
    const activate=async(page:Page,name:string)=>{
      const button=page.getByRole('button',{name,exact:true});
      if(page===bob)await button.tap();else await button.click();
    };
    const frame=async(side:number)=>Number((await database.pool.query('select frame from private.trade_scenes where trade_id=$1 and owner_id=$2',[activeTrade.id,owners[side]])).rows[0].frame);
    if(audio){
      for(let side=0;side<2;side++){
        const page=pages[side]!;
        await expect(page.getByRole('button',{name:'Pause & checkpoint',exact:true})).toBeEnabled();
        await expect(page.getByRole('button',{name:'Enable sound',exact:true})).toHaveAttribute('aria-pressed','false');
        await activate(page,'Enable sound');await expect.poll(()=>audioPeak(page)).toBeGreaterThan(0.00001);
        await activate(page,'Pause & checkpoint');
        await expect(page.getByRole('status')).toHaveText('Paused · progress saved');
        await expect.poll(()=>audioPeak(page)).toBe(0);
        const pausedFrame=await frame(side);await page.waitForTimeout(150);assert.equal(await frame(side),pausedFrame);
        const beforeAuth=(await database.pool.query('select frame,next_sequence,fence,checkpoint from private.trade_scenes where trade_id=$1 and owner_id=$2',[activeTrade.id,owners[side]])).rows[0];
        const socketCount=await page.evaluate(()=>(window as any).tradeAuthSockets.length);
        await page.evaluate(()=>(window as any).tradeAuthSockets.at(-1).dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'auth-required',protocol:1})})));
        await expect.poll(()=>authRenewals[side]).toBe(1);
        assert.equal(await page.evaluate(()=>(window as any).tradeAuthSockets.length),socketCount);
        assert.deepEqual((await database.pool.query('select frame,next_sequence,fence,checkpoint from private.trade_scenes where trade_id=$1 and owner_id=$2',[activeTrade.id,owners[side]])).rows[0],beforeAuth);
        await expect(page.getByRole('button',{name:'Resume',exact:true})).toBeEnabled();assert.equal(await audioPeak(page),0);
        await activate(page,'Mute sound');await activate(page,'Resume');
        await expect.poll(()=>frame(side)).toBeGreaterThan(pausedFrame);assert.equal(await audioPeak(page),0);
        await activate(page,'Enable sound');await expect.poll(()=>audioPeak(page)).toBeGreaterThan(0.00001);
      }
      // Hold Bob so Alice's completed scene can prove that one-sided progress
      // neither commits canonical saves nor leaves queued sound playing.
      await activate(bob,'Pause & checkpoint');await expect(bob.getByRole('status')).toHaveText('Paused · progress saved');
      await expect.poll(()=>audioPeak(bob)).toBe(0);
      for(let side=0;side<2;side++)await pages[side]!.screenshot({path:`test-output/screenshots/${prefix}trade-playing-${side===0?'desktop':'mobile'}.png`,fullPage:true});
    }
    let reloaded=false;
    let partnerReleased=!audio,oneSidedAudioStopped=false,reloadSoundRestored=false;
    const deadline=Date.now()+100000;
    while(Date.now()<deadline) {
      for(const [side,page] of pages.entries()) {
        const errorText=(await page.locator('.game-error').allTextContents()).join('; ');
        assert.equal(await page.locator('.game-error').count(),0,errorText);
        if((side===0||partnerReleased)&&await page.locator('.game-page').count()) await page.keyboard.press('z');
      }
      if(!reloaded && Number(await alice.locator('[data-verified-frame]').getAttribute('data-verified-frame'))>=300) {
        await alice.reload();
        await expect(alice.getByRole('button',{name:'Continue trade'})).toBeVisible({timeout:10000});
        await alice.getByRole('button',{name:'Continue trade'}).click();
        if(audio){
          await expect(alice.getByRole('button',{name:'Enable sound',exact:true})).toBeEnabled();
          await expect(alice.getByRole('button',{name:'Enable sound',exact:true})).toHaveAttribute('aria-pressed','false');
          await activate(alice,'Enable sound');await expect.poll(()=>audioPeak(alice)).toBeGreaterThan(0.00001);reloadSoundRestored=true;
        }
        reloaded=true;
      }
      if(audio&&!partnerReleased){
        const done=await database.pool.query("select id from private.trade_scenes where trade_id=$1 and owner_id=$2 and status='done'",[activeTrade.id,owners[0]]);
        if(done.rowCount){
          await expect.poll(()=>audioPeak(alice)).toBe(0);
          const unchanged=(await database.pool.query('select id,revision,flash from private.adventures where id=any($1::uuid[]) order by id',[saves])).rows;
          for(let side=0;side<2;side++){assert.equal(Number(unchanged[side].revision),Number(before[side].revision));assert.deepEqual(unchanged[side].flash,before[side].flash);}
          await expect(alice.getByRole('status')).toContainText('Waiting for your partner');
          await activate(bob,'Resume');await expect.poll(()=>audioPeak(bob)).toBeGreaterThan(0.00001);
          oneSidedAudioStopped=true;partnerReleased=true;
        }
      }
      const committed=await database.pool.query("select id from private.trades where id=$1 and status='committed'",[activeTrade.id]);
      if(committed.rowCount) break;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    assert(reloaded,'The browser reconnect branch did not run.');
    for(const page of pages) await expect(page.locator('.game-page')).toHaveCount(0,{timeout:10000});
    if(audio){
      assert(oneSidedAudioStopped&&reloadSoundRestored);
      for(const [side,page] of pages.entries()){
        await expect.poll(()=>page.evaluate(()=>(window as any).tradeAudioContexts.every((context:AudioContext)=>context.state==='closed'))).toBe(true);
        assert(sent[side]!.some(item=>item.type==='authenticate')&&sent[side]!.some(item=>item.type==='input'),'Trade WebSocket capture missed the actual verification protocol.');
        assert(sent[side]!.every(item=>['authenticate','refresh-auth','input','pause','resume','exit'].includes(item.type)),'Trade audio entered the verified input protocol.');
      }
    }
    const after=(await database.pool.query('select id,revision,flash from private.adventures where id=any($1::uuid[]) order by id',[saves])).rows;
    for(let side=0;side<2;side++) {assert.equal(Number(after[side].revision),Number(before[side].revision)+1);assert(!after[side].flash.equals(before[side].flash));}
    await options.inspectCommitted?.(after);
    for(let side=0;side<2;side++) {
      assert(await pages[side]!.evaluate(width=>document.documentElement.scrollWidth<=width,pages[side]!.viewportSize()!.width),'The trade layout overflows its device viewport.');
      await pages[side]!.screenshot({path:`test-output/screenshots/${prefix}trade-complete-${side===0?'desktop':'mobile'}.png`,fullPage:true});
    }
    if(options.earnedJourney){
      // The committed cartridge must become the input to a fresh adventure,
      // rather than resurrecting the pre-trade RAM checkpoint.
      for(const page of pages){await activate(page,'Back to adventures');await activate(page,'Resume adventure');await expect(page.getByRole('button',{name:'Pause & checkpoint',exact:true})).toBeEnabled({timeout:15000});await activate(page,'Enable sound');await expect.poll(()=>audioPeak(page)).toBeGreaterThan(0.00001);}
      const returned=async(side:number)=>{
        const result=await database.pool.query("select id,frame,initial_flash,base_revision from private.game_sessions where owner_id=$1 and status='adventure'",[owners[side]]);assert.equal(result.rows.length,1);return result.rows[0];
      };
      for(let side=0;side<2;side++){
        const row=await returned(side),canonical=after.find(save=>save.id===saves[side]);assert(canonical);
        assert.deepEqual(row.initial_flash,canonical.flash);assert.equal(Number(row.base_revision),Number(canonical.revision));
      }
      await Promise.all(pages.map(async(page,side)=>{
        await expect.poll(async()=>Number((await returned(side)).frame),{timeout:25000}).toBeGreaterThan(900);
        await page.locator('canvas').focus();await page.keyboard.press('Enter');
        await page.waitForTimeout(5500);
        // Explicit real controller presses dismiss Continue and the original
        // recap. No game memory or save data is edited by this driver.
        for(let i=0;i<8;i++){if(side===1)await page.getByRole('button',{name:'A',exact:true}).tap();else await page.keyboard.press('z');await page.waitForTimeout(1500);}
        for(let i=0;i<6;i++){if(side===1)await page.getByRole('button',{name:'B',exact:true}).tap();else await page.keyboard.press('x');await page.waitForTimeout(250);}
        await activate(page,'Pause & checkpoint');await expect(page.getByRole('status')).toHaveText('Paused · progress saved');
        await page.screenshot({path:`test-output/screenshots/${prefix}returned-adventure-${side===0?'desktop':'mobile'}.png`,fullPage:true});
        await activate(page,'← Save & exit');await expect(page.getByRole('button',{name:'Resume adventure',exact:true})).toBeVisible({timeout:15000});
        await expect.poll(()=>page.evaluate(()=>(window as any).tradeAudioContexts.every((context:AudioContext)=>context.state==='closed'))).toBe(true);
      }));
    }
    assert.deepEqual(errors,[]);
    await writeFile(`build/${prefix}trade-ui-report.json`,JSON.stringify({realUi:true,originalC:true,httpWebSocket:true,
      desktopAndMobile:true,mobileDevice:'Chrome emulation; physical-device QA pending',reloadRecovery:true,atomicCommit:true,
      artifacts:['firered','leafgreen'].map(version=>registry.manifest(version as 'firered'|'leafgreen').id),
      legacySoundDisabledChecked:process.env.KANTO_CHECK_AUDIO_LEGACY==='1',nativeAudioGraph:audio,pauseAndMuteChecked:audio,
      soundRestoredAfterSceneReload:reloadSoundRestored,oneSidedCompletionStopsAudioWithoutCanonicalSave:oneSidedAudioStopped,
      audioContextsClosedAfterCommit:audio,audioExcludedFromInputProtocol:audio,sharedThemeLoaded:true,
      capturedInputBatches:audio?sent.map(messages=>messages.filter(item=>item.type==='input').length):undefined,
      authenticationRenewals:audio?authRenewals:undefined,authenticationRenewalKeepsPausedSceneAndSocket:audio,
      authenticationChallengeDelivery:audio?'native browser MessageEvent; real response over production WebSocket; server deadlines tested with controlled clock':undefined,
      earnedAdventureLobbyEntry:options.earnedJourney===true,committedCartridgeBootstrapsReturn:options.earnedJourney===true,
      originalContinueAndExitAfterTrade:options.earnedJourney===true,
      authProvider:'isolated local fixture',hostedAccountsQualified:false,publicReleaseQualified:false},null,2)+'\n');
    console.log(JSON.stringify({tradeUi:true,reloadRecovery:true,atomicCommit:true}));
  } finally {
    await browser?.close();await app.close();await new Promise<void>(resolve=>provider.close(()=>resolve()));
  }
}

async function installAudioProbe(page:Page){
  await page.addInitScript(()=>{
    const NativeAudioContext=window.AudioContext;(window as any).tradeAudioContexts=[];
    (window as any).AudioContext=class extends NativeAudioContext{
      constructor(options?:AudioContextOptions){super(options);(window as any).tradeAudioContexts.push(this);}
      createGain(){const gain=super.createGain(),analyser=this.createAnalyser();analyser.fftSize=256;gain.connect(analyser);(this as any).analyser=analyser;return gain;}
    };
  });
}
async function audioPeak(page:Page){return page.evaluate(()=>{
  const context=(window as any).tradeAudioContexts.at(-1),analyser=context?.analyser;
  if(!analyser||context.state==='closed')return 0;
  const values=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(values);return Math.max(...values.map(Math.abs));
});}
