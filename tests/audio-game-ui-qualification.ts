import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium,expect,type Page,type BrowserContext } from '@playwright/test';
import type { Database } from '../apps/server/src/database.ts';
import { createApp } from '../apps/server/src/app.ts';
import { WasmEngine } from '../packages/engine/runtime.ts';
import { originalGameProvider } from './original-game-provider.ts';

/** Real API, original C, WebSocket verifier and PostgreSQL. Account identity
 * comes from an isolated local provider, not hosted signup or email delivery. */
export async function checkAudioGameUi(source:Database,owner:string){
  const tag=process.env.KANTO_AUDIO_GAME_EVIDENCE_TAG??'audio-game-ui';assert(/^[a-z0-9-]{1,40}$/.test(tag));
  const reportPath=`build/${tag}-report.json`;assert(!existsSync(reportPath),'Preserve retained audio-game evidence.');
  let tail:Promise<unknown>=Promise.resolve();
  function serial<T>(body:()=>Promise<T>):Promise<T>{const next=tail.catch(()=>undefined).then(body);tail=next;return next;}
  const database=Object.assign(Object.create(Object.getPrototypeOf(source)),{
    pool:{query:(...args:unknown[])=>serial(()=>Reflect.apply(source.pool.query,source.pool,args))},
    transaction:<T>(body:Parameters<Database['transaction']>[0])=>serial(()=>source.transaction(body)) as Promise<T>,
  }) as Database;
  const registry=await originalGameProvider(false,true),origin='http://127.0.0.1:5173',cases:any[]=[];
  const provider=createServer((request,response)=>{
    response.setHeader('Content-Type','application/json');
    if(request.url!=='/auth/v1/user'||request.headers.authorization!=='Bearer audio-qualification'){
      response.writeHead(401);response.end('{}');return;
    }
    response.end(JSON.stringify({id:owner,aud:'authenticated',email:'audio-fixture@example.invalid',email_confirmed_at:'2026-10-16T00:00:00Z',
      app_metadata:{},user_metadata:{},identities:[],created_at:'2026-10-16T00:00:00Z'}));
  });
  await new Promise<void>(done=>provider.listen(0,'127.0.0.1',done));
  const address=provider.address();assert(address&&typeof address!=='string');
  let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  try{
    browser=await chromium.launch({executablePath:process.env.KANTO_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
    for(const version of ['firered','leafgreen'] as const)for(const viewport of ['desktop','mobile'] as const){
      await database.pool.query('savepoint audio_game_case');
      const app=await createApp({origin,engineDirectory:'unused-isolated-audio-provider',supabaseUrl:`http://127.0.0.1:${address.port}`,
        publishableKey:'audio-qualification-publishable',publicRelease:false,adventureWorkers:1,inspectionWorkers:1,tradeWorkers:1,battleWorkers:1},{database,registry});
      const context:BrowserContext=await browser.newContext(viewport==='desktop'?{viewport:{width:1440,height:1000}}:{viewport:{width:390,height:844},isMobile:true,hasTouch:true});
      const page:Page=await context.newPage();
      let releaseDownloads:()=>void=()=>{};
      const diagnostics:{at:number;event:string;detail:string}[]=[],wireReceived:any[]=[];
      page.on('framenavigated',frame=>{if(frame===page.mainFrame())diagnostics.push({at:Date.now(),event:'navigation',detail:frame.url()});});
      page.on('console',message=>{if(message.text().startsWith('[vite]')||['warning','error'].includes(message.type()))diagnostics.push({at:Date.now(),event:message.type(),detail:message.text()});});
      page.on('websocket',connection=>{
        if(connection.url().includes('/api/play'))connection.on('framereceived',event=>{if(typeof event.payload==='string')wireReceived.push(JSON.parse(event.payload));});
      });
      try{
        const manifest=registry.manifest(version),bytes=registry.artifact(version);
        const qualified=JSON.parse(await readFile(`build/game-source/${version}/audio-16/audio-report.json`,'utf8'));
        assert.equal(manifest.id,qualified.artifactId);
        const replay=JSON.parse(await readFile(`tests/replays/${version}-audio-pc-storage.json`,'utf8'));
        const engine=await WasmEngine.create(bytes,manifest,replay.seed);
        let checkpoint:Buffer,flash:Uint8Array,fieldFrame:number;
        try{
          engine.restore(new Uint8Array(await readFile(`build/game-source/${version}/audio-16/route-audio-pc-desktop.checkpoint`)));
          assert.equal(engine.digest(),qualified.digest);assert.equal(engine.frame,qualified.fullAdventureReplayFrames);
          const bridge=JSON.parse(await readFile(`build/adventure-exploration/${version}/storage-field-return/report.json`,'utf8'));
          for(const run of bridge.runs)engine.advance([run]);
          const before=engine.digest(),c=engine.bindExtension<any>('kanto_lobby_save_abi_version',1,['ArePlayerFieldControlsLocked','ScriptContext_IsEnabled']);
          assert.equal(c.ArePlayerFieldControlsLocked(),0);assert.equal(c.ScriptContext_IsEnabled(),0);assert.equal(engine.digest(),before);
          flash=engine.flash();assert.equal(createHash('sha256').update(flash).digest('hex'),qualified.savedPhases.withdraw.flashSha256);
          fieldFrame=engine.frame;checkpoint=gzipSync(registry.encodeCheckpoint(version,engine.snapshot()),{level:1});
        }finally{engine.close();}
        await database.pool.query("update private.game_sessions set status='closed',superseded_at=clock_timestamp() where owner_id=$1",[owner]);
        const owned=(await database.pool.query(`insert into private.adventures(owner_id,version,flash) values($1,$2,$3)
          on conflict(owner_id,version) do update set flash=excluded.flash returning id,revision`,[owner,version,Buffer.from(flash)])).rows[0];assert(owned);
        const sessionId=randomUUID();
        await database.pool.query(`insert into private.game_sessions(id,owner_id,adventure_id,artifact_id,seed,initial_flash,base_revision,status,frame,next_sequence,checkpoint,checkpoint_frame,checkpoint_sequence,lease_expires_at)
          values($1,$2,$3,$4,$5,$6,$7,'adventure',$8,0,$9,$8,0,clock_timestamp()-interval '1 second')`,
        [sessionId,owner,owned.id,manifest.id,replay.seed,Buffer.from(flash),owned.revision,fieldFrame,checkpoint]);
        const base=await app.listen({host:'127.0.0.1',port:0});
        let claimRequests=0,heldDownloads=0,downloadsReleased=false;
        const downloadGate=new Promise<void>(resolve=>{releaseDownloads=()=>{downloadsReleased=true;resolve();};});
        page.on('request',request=>{if(request.method()==='POST'&&request.url()===`${base}/api/sessions`)claimRequests++;});
        await page.route('**/api/engines/*/*.wasm',async route=>{
          const response=await route.fetch();
          if(!downloadsReleased){heldDownloads++;await downloadGate;}
          try{await route.fulfill({response});}catch(error){if(!page.isClosed()&&!route.request().failure())throw error;}
        });
        await context.grantPermissions(['local-network-access'],{origin});
        const errors:string[]=[],sent:any[]=[],received:any[]=[];
        page.on('pageerror',error=>errors.push(error.message));
        page.on('websocket',socket=>{
          if(!/\/api\/play(?:\?|$)/.test(socket.url()))return;
          socket.on('framesent',event=>{if(typeof event.payload==='string')sent.push(JSON.parse(event.payload));});
          socket.on('framereceived',event=>{if(typeof event.payload==='string')received.push(JSON.parse(event.payload));});
        });
        await installProbe(page);
        await page.route('**/src/api.ts*',route=>route.fulfill({contentType:'text/javascript',body:`
          export const API_URL=${JSON.stringify(base)};
          export class ApiError extends Error {constructor(code,message,status){super(message);this.code=code;this.status=status;}}
          export async function token(){return 'audio-qualification';}
          export async function api(path,body){const response=await fetch(API_URL+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+await token(),...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();if(!response.ok)throw new ApiError(result.error,result.message,response.status);return result;}` }));
        await page.route('**/audio-game-ui-qualification?*',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div>
          <script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
          <script type="module" src="/@fs${fileURLToPath(new URL('./audio-game-ui-entry.tsx',import.meta.url))}"></script></body></html>`}));
        const activate=async(name:string)=>{const button=page.getByRole('button',{name,exact:true});if(viewport==='mobile')await button.tap();else await button.click();};
        const ready=async()=>{await expect(page.getByRole('button',{name:'Pause & checkpoint',exact:true})).toBeEnabled({timeout:15000});await expect(page.getByRole('button',{name:'Enable sound',exact:true})).toBeEnabled();};
        const beforeDownload=(await database.pool.query('select frame,next_sequence,fence from private.game_sessions where id=$1',[sessionId])).rows[0];
        await page.goto(`${origin}/audio-game-ui-qualification?version=${version}`);
        await expect.poll(()=>heldDownloads,{timeout:15000}).toBeGreaterThan(0);
        await expect(page.getByRole('status')).toHaveText('Loading your game…');
        await page.waitForTimeout(200);assert.equal(claimRequests,0,'A worker was reserved before the game file finished downloading.');
        assert.deepEqual((await database.pool.query('select frame,next_sequence,fence from private.game_sessions where id=$1',[sessionId])).rows[0],beforeDownload);
        releaseDownloads();await ready();assert(claimRequests>0);
        await expect.poll(()=>received.filter(item=>item.type==='verified').length).toBeGreaterThan(1);
        const beforeQuickTap=sent.filter(item=>item.type==='input').length;
        if(viewport==='mobile')await page.getByRole('button',{name:'B',exact:true}).tap();
        else {
          // Dispatch both edges in one task so no animation frame can observe
          // the held mask. The production keyboard handler must latch it.
          await page.locator('canvas').evaluate(canvas=>{
            canvas.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyX',bubbles:true}));
            canvas.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyX',bubbles:true}));
          });
        }
        await expect.poll(()=>sent.filter(item=>item.type==='input').slice(beforeQuickTap).some(batch=>batch.runs.some((run:any)=>(run.buttons&2)!==0))).toBe(true);
        if(viewport==='desktop'){await page.getByRole('button',{name:'Enable sound',exact:true}).focus();await page.keyboard.press('Enter');}
        else await activate('Enable sound');
        await expect(page.getByRole('button',{name:'Mute sound',exact:true})).toHaveAttribute('aria-pressed','true');
        await expect.poll(()=>audioPeak(page)).toBeGreaterThan(0.00001);
        await expect(page.getByRole('navigation',{name:'Player tools'})).toBeVisible();
        const overlay=page.locator('.game-performance');
        await expect(page.getByRole('region',{name:'Performance overlay'})).toBeVisible();
        await expect(overlay).toBeVisible();
        await expect.poll(async()=>Number(await overlay.locator('[data-metric="fps"]').textContent())).toBeGreaterThan(0);
        assert(Number(await overlay.locator('[data-metric="interval"]').textContent())>0);
        assert(Number((await overlay.locator('[data-metric="speed"]').textContent())!.replace('%',''))>0);
        const sampledMetrics=await overlay.innerText();
        if(viewport==='desktop'){
          await page.getByRole('button',{name:'Stats',exact:true}).hover();
          await expect(page.getByRole('tooltip')).toContainText('Toggle performance overlay');
          await page.getByRole('button',{name:'Stats',exact:true}).focus();await page.keyboard.press('Space');
        }else await activate('Stats');
        await expect(overlay).toBeHidden();await expect(page.getByRole('button',{name:'Stats',exact:true})).toHaveAttribute('aria-pressed','false');
        await activate('Stats');await expect(overlay).toBeVisible();
        const fullscreenSupported=viewport==='desktop'&&await page.evaluate(()=>document.fullscreenEnabled);
        if(fullscreenSupported){await activate('Enter fullscreen');await expect.poll(()=>page.evaluate(()=>Boolean(document.fullscreenElement))).toBe(true);}
        await activate('Controls');await expect(page.getByRole('dialog')).toBeVisible();
        // Radix correctly hides the background from assistive technology while
        // its modal is open. Inspect the underlying durable-pause status here.
        await expect(page.getByRole('status',{includeHidden:true})).toHaveText('Paused · progress saved');
        await expect.poll(()=>audioPeak(page)).toBe(0);
        await expect(overlay.locator('[data-metric="fps"]')).toHaveText('0');
        const guideFrame=(await database.pool.query('select frame from private.game_sessions where id=$1',[sessionId])).rows[0].frame;
        const inputsBeforeGuide=sent.filter(item=>item.type==='input').length;
        await page.keyboard.press('ArrowDown');await page.keyboard.press('z');await page.waitForTimeout(150);
        assert.equal((await database.pool.query('select frame from private.game_sessions where id=$1',[sessionId])).rows[0].frame,guideFrame);
        assert.equal(sent.filter(item=>item.type==='input').length,inputsBeforeGuide,'Controls guide sent gameplay input.');
        await activate('Close');await expect(page.getByRole('dialog')).toBeHidden();
        await expect(page.getByRole('button',{name:'Resume',exact:true})).toBeEnabled();await page.waitForTimeout(150);
        assert.equal((await database.pool.query('select frame from private.game_sessions where id=$1',[sessionId])).rows[0].frame,guideFrame);
        if(fullscreenSupported){await activate('Exit fullscreen');await expect.poll(()=>page.evaluate(()=>Boolean(document.fullscreenElement))).toBe(false);}
        await activate('Resume');await expect.poll(()=>audioPeak(page)).toBeGreaterThan(0.00001);
        const width=page.viewportSize()!.width;
        assert(await page.evaluate(width=>document.documentElement.scrollWidth<=width,width),'The game exceeds the configured device width.');
        assert(await page.locator('.game-controls button').evaluateAll((buttons,width)=>buttons.every(button=>{
          const rect=button.getBoundingClientRect();return rect.left>=0&&rect.right<=width;
        }),width),'A controller button is outside the device viewport.');
        await mkdir('test-output/screenshots',{recursive:true});await page.screenshot({path:`test-output/screenshots/${tag}-playing-${version}-${viewport}.png`,fullPage:true});
        await expect.poll(()=>received.filter(item=>item.type==='verified').length).toBeGreaterThan(3);
        assert(sent.filter(item=>item.type==='input').every(batch=>batch.runs.every((run:any)=>(run.buttons&8)===0)),'Keyboard activation of Sound leaked a game Start input.');
        await expect(page.getByRole('status')).toHaveText('Online · progress saved');
        assert(Number(await page.locator('[data-verified-frame]').getAttribute('data-verified-frame'))>0);
        if(viewport==='mobile')assert(await page.locator('.game-controls button').evaluateAll(buttons=>buttons.every(button=>{const rect=button.getBoundingClientRect();return rect.width>=44&&rect.height>=44;})));
        await activate('Pause & checkpoint');
        await expect(page.getByRole('status')).toHaveText('Paused · progress saved');await expect(page.locator('.game-progress-badge')).toHaveText('Saved');await expect.poll(()=>audioPeak(page)).toBe(0);
        const stopped=(await database.pool.query('select frame from private.game_sessions where id=$1',[sessionId])).rows[0].frame;
        await page.waitForTimeout(150);assert.equal((await database.pool.query('select frame from private.game_sessions where id=$1',[sessionId])).rows[0].frame,stopped);
        const authState=(await database.pool.query('select frame,next_sequence,fence,checkpoint from private.game_sessions where id=$1',[sessionId])).rows[0];
        const browserConnections=await page.evaluate(()=>(window as any).audioGameSockets.length);
        // Deliver the control event to the native browser listener without a
        // ten-minute wall-clock wait. Its response crosses the real socket and
        // production authorization route; server timing is checked separately.
        await page.evaluate(()=>(window as any).audioGameSockets.at(-1).dispatchEvent(new MessageEvent('message',{
          data:JSON.stringify({type:'auth-required',protocol:1}),
        })));
        await expect.poll(()=>received.filter(item=>item.type==='auth-refreshed').length).toBe(1);
        assert.equal(sent.filter(item=>item.type==='refresh-auth').length,1);
        assert.equal(await page.evaluate(()=>(window as any).audioGameSockets.length),browserConnections);
        assert.deepEqual((await database.pool.query('select frame,next_sequence,fence,checkpoint from private.game_sessions where id=$1',[sessionId])).rows[0],authState);
        await expect(page.getByRole('button',{name:'Resume',exact:true})).toBeEnabled();await expect.poll(()=>audioPeak(page)).toBe(0);
        await activate('Resume');await expect.poll(()=>audioPeak(page)).toBeGreaterThan(0.00001);
        await activate('Enter online lobby');await expect(page.getByRole('heading',{name:'Your party',exact:true})).toBeVisible({timeout:15000});
        await expect.poll(()=>page.evaluate(()=>(window as any).audioContexts.at(-1).state)).toBe('closed');
        const saved=(await database.pool.query('select revision,flash from private.adventures where id=$1',[owned.id])).rows[0];assert.equal(Number(saved.revision),Number(owned.revision)+1);assert.equal(saved.flash.length,131072);
        await activate('Return to adventure');await ready();await activate('Enable sound');await expect.poll(()=>audioPeak(page)).toBeGreaterThan(0.00001);
        await activate('← Save & exit');await expect(page.getByRole('button',{name:'Resume adventure',exact:true})).toBeVisible({timeout:15000});
        await expect.poll(()=>page.evaluate(()=>(window as any).audioContexts.at(-1).state)).toBe('closed');
        await activate('Resume adventure');await ready();await activate('Enable sound');await expect.poll(()=>audioPeak(page)).toBeGreaterThan(0.00001);
        // A real browser socket close exercises the production failure path.
        await page.evaluate(()=>(window as any).audioGameSockets.at(-1).close());
        await expect(page.getByRole('alert')).toContainText('Connection paused.');await expect.poll(()=>audioPeak(page)).toBe(0);
        await expect(page.getByRole('status')).toHaveText('Play paused · return home to restore saved progress');
        await expect(page.locator('.game-progress-badge')).toHaveText('Play paused');
        await page.screenshot({path:`test-output/screenshots/${tag}-offline-${version}-${viewport}.png`,fullPage:true});
        await expect.poll(async()=>{
          const row=(await database.pool.query('select frame,checkpoint_frame from private.game_sessions where id=$1',[sessionId])).rows[0];
          return Number(row.frame)===Number(row.checkpoint_frame);
        }).toBe(true);
        const durable=(await database.pool.query('select frame,checkpoint from private.game_sessions where id=$1',[sessionId])).rows[0];
        await activate('← Back home');
        await expect.poll(()=>page.evaluate(()=>(window as any).audioContexts.at(-1).state)).toBe('closed');
        const response=page.waitForResponse(response=>response.url()===base+'/api/sessions'&&response.request().method()==='POST');
        await activate('Resume adventure');const recovery=await (await response).json();
        assert.equal(recovery.id,sessionId);assert.equal(recovery.frame,Number(durable.frame));
        const recovered=await WasmEngine.create(bytes,manifest,replay.seed);
        try{recovered.restore(registry.decodeCheckpoint(version,new Uint8Array((await import('node:zlib')).gunzipSync(durable.checkpoint))));assert.equal(recovered.digest(),recovery.digest);}
        finally{recovered.close();}
        await ready();await activate('Enable sound');await expect.poll(()=>audioPeak(page)).toBeGreaterThan(0.00001);
        await activate('← Save & exit');await expect(page.getByRole('button',{name:'Resume adventure',exact:true})).toBeVisible({timeout:15000});
        await expect.poll(()=>page.evaluate(()=>(window as any).audioContexts.every((context:AudioContext)=>context.state==='closed'))).toBe(true);
        assert(sent.every(item=>['authenticate','refresh-auth','input','pause','resume','exit'].includes(item.type)),'Audio leaked into the verified input protocol.');
        assert(received.filter(item=>item.type==='verified').length>5);
        assert.deepEqual(errors,[]);assert(await page.evaluate(width=>document.documentElement.scrollWidth<=width,page.viewportSize()!.width));
        await mkdir('test-output/screenshots',{recursive:true});await page.screenshot({path:`test-output/screenshots/${tag}-${version}-${viewport}.png`,fullPage:true});
        cases.push({version,viewport,artifactId:manifest.id,originalC:true,realPostgres:true,httpWebSocket:true,startingFrame:fieldFrame,
          verifiedAcks:received.filter(item=>item.type==='verified').length,nativeAudioGraph:true,keyboardToolDoesNotPressStart:viewport==='desktop',
          pauseStopsAudioAndFrames:true,lobbySaveRevisionAdvanced:true,lobbyReturnAndExitReopen:true,connectionLossStopsAudio:true,
          durableDisconnectRecoveryFrame:Number(durable.frame),recoveredDigestMatchesDurableCheckpoint:true,connectionRecoveryRestoresAudio:true,contextsClosedOnUnmount:true,
          configuredDeviceWidth:page.viewportSize()!.width,controllerButtonsWithinDeviceViewport:true,
          playerTools:true,sampledMetrics,statsToggle:true,controlsGuidePausesAudioAndDurableFrames:true,guideKeysDoNotSendGameplayInput:true,
          closingGuideLeavesPaused:true,fullscreenTested:fullscreenSupported,guideVisibleDuringFullscreen:fullscreenSupported,
          plainSavedAndOfflineStatusChecked:true,mobileTouchTargetsAtLeast44px:viewport==='mobile',
          quickTapReachesVerifiedInput:true,quickTapInput:viewport==='mobile'?'actual touch B':'keyboard down/up in one JavaScript task'});
        Object.assign(cases.at(-1),{authenticationRenewalUsesExistingSocket:true,authenticationRenewalLeavesCheckpointFenceAndSequenceUnchanged:true,
          gameFileDeliveryHeldBeforeSessionClaim:true,downloadHoldMs:200,sessionRowUnchangedDuringGameFileDelivery:true,
          authenticationChallengeDelivery:'native browser MessageEvent; real response over production WebSocket; server deadlines tested with controlled clock'});
      }catch(failure){
        releaseDownloads();
        if(!page.isClosed()){
          await writeFile(`build/${tag}-failure-${version}-${viewport}.json`,JSON.stringify({version,viewport,diagnostics,
            received:wireReceived.slice(-12),socketEvents:await page.evaluate(()=>(window as any).audioGameSocketEvents??[]),
            entryExecutions:await page.evaluate(()=>(window as any).audioGameEntryExecutions),
            text:await page.locator('body').innerText()},null,2)+'\n');
          await page.screenshot({path:`test-output/screenshots/${tag}-failed-${version}-${viewport}.png`,fullPage:true});
        }
        throw failure;
      }finally{releaseDownloads();await context.close();await app.close();await tail;await database.pool.query('rollback to savepoint audio_game_case');await database.pool.query('release savepoint audio_game_case');}
    }
    await writeFile(reportPath,JSON.stringify({cases,authProvider:'isolated local confirmed-email fixture',hostedAccountsQualified:false,physicalDeviceCoverage:false,
      publicReleaseQualified:false,scope:'Authenticated app flow against local original-C verifier and disposable PostgreSQL; not hosted signup/email, battle audio or 1000-player qualification.'},null,2)+'\n');
    console.log(JSON.stringify({audioGameUi:true,cases:cases.length,realPostgres:true}));
  }finally{await browser?.close();await new Promise<void>(done=>provider.close(()=>done()));}
}

async function installProbe(page:Page){
  await page.addInitScript(()=>{
    const NativeAudioContext=window.AudioContext;(window as any).audioContexts=[];
    (window as any).AudioContext=class extends NativeAudioContext{
      constructor(options?:AudioContextOptions){super(options);(window as any).audioContexts.push(this);}
      createGain(){const gain=super.createGain(),analyser=this.createAnalyser();analyser.fftSize=256;gain.connect(analyser);(this as any).analyser=analyser;return gain;}
    };
    (window as any).audioGameSockets=[];(window as any).audioGameSocketEvents=[];
    window.WebSocket=new Proxy(window.WebSocket,{construct(Target,args){const socket=new Target(...args as [string|URL,(string|string[])?]);
      if(/\/api\/play(?:\?|$)/.test(String(args[0]))){(window as any).audioGameSockets.push(socket);
        socket.addEventListener('close',event=>(window as any).audioGameSocketEvents.push({at:Date.now(),code:event.code,reason:event.reason}));}
      return socket;}});
  });
}
async function audioPeak(page:Page){return page.evaluate(()=>{
  const context=(window as any).audioContexts.at(-1),analyser=context?.analyser;if(!analyser||context.state==='closed')return 0;
  const values=new Float32Array(analyser.fftSize);analyser.getFloatTimeDomainData(values);return Math.max(...values.map(Math.abs));
});}
