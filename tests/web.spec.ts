import { test, expect, type WebSocketRoute } from '@playwright/test';
import {fileURLToPath} from 'node:url';
import type {LobbyTrainer} from '../packages/protocol/index.ts';
import type {LiveBattle} from '../packages/battles/protocol.ts';
import {BattleScreenEncoder} from '../packages/battles/screen.ts';

test('adventure selection, account forms and navigation work before game integration', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const serviceResponse = page.waitForResponse(response => response.url().endsWith('/api/status'));
  await page.goto('/');
  expect((await serviceResponse).ok()).toBe(true);
  await expect(page.getByRole('heading', { level: 1 })).toContainText('A whole world.');
  const navigation = page.getByRole('navigation', { name: 'Main navigation' });
  await expect(navigation.getByRole('button', { name: 'Adventures' })).toHaveAttribute('aria-current', 'page');
  if (info.project.name === 'desktop')
    await expect(page.getByText('Service connected', { exact: true })).toBeVisible();
  const play = page.getByRole('button', { name: 'Game port in development' });
  await expect(play).toHaveCount(2);
  await expect(play.nth(0)).toBeDisabled();
  await expect(play.nth(1)).toBeDisabled();
  await expect(page.getByRole('heading', { name: 'FireRed', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'LeafGreen', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({ path: `test-output/screenshots/${process.env.KANTO_UI_EVIDENCE_TAG ?? ''}${info.project.name}.png`, fullPage: true });

  await page.getByRole('button', { name: /Create account/ }).first().click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await expect(dialog.getByRole('heading')).toHaveText('A new adventure starts here.');
  await expect(dialog.getByLabel('Email address')).toBeVisible();
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveAttribute('minlength', '12');
  if (process.env.KANTO_UI_EVIDENCE_TAG) await page.screenshot({path:`test-output/screenshots/${process.env.KANTO_UI_EVIDENCE_TAG}account-${info.project.name}.png`,fullPage:true,animations:'disabled'});
  // No test credentials or pretend account service is injected into the UI.
  if (await dialog.getByText('Account services need configuration before sign-in is available.').count())
    await expect(dialog.getByRole('button', { name: /Create account/ })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('button', { name: /Create account/ }).first()).toBeFocused();

  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await expect(dialog.getByRole('heading')).toHaveText('Get back on your journey.');
  await expect(dialog.getByLabel('Email address')).toBeVisible();
  await expect(dialog.getByLabel('Password', { exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Online lobby' }).click();
  await expect(navigation.getByRole('button', { name: 'Online lobby' })).toHaveAttribute('aria-current', 'page');
  await expect(navigation.getByRole('button', { name: 'Adventures' })).not.toHaveAttribute('aria-current');
  await expect(page.getByRole('heading', { name: 'The online lobby is being built' })).toBeVisible();
  await page.getByRole('button', { name: 'Trainer profile' }).click();
  await expect(page.getByRole('heading', { name: 'A name of your own' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('lobby search, pages and trainer actions work beyond the first 100 names',async({page},info)=>{
  const errors:string[]=[],actions:{kind:string;trainerId:string;watchable?:boolean}[]=[],offeredTrades:unknown[]=[],offeredBattles:unknown[]=[],quickActions:string[]=[];
  page.on('pageerror',error=>errors.push(error.message));
  const trainers:LobbyTrainer[]=Array.from({length:150},(_,index)=>({
    id:`00000000-0000-4000-8000-${String(index+1000).padStart(12,'0')}`,
    handle:`Scout${String(index).padStart(3,'0')}`,version:index%2?'leafgreen':'firered',
    party:index%10?[]:[{species:1,name:'BULBASAUR',level:5}],maxLevel:index%10?null:5}));
  const alice={id:'00000000-0000-4000-8000-000000000001',handle:'Alice'};
  const liveBattles:LiveBattle[]=[{id:'00000000-0000-4000-8000-000000009998',
    playerA:{handle:'Live Alice',version:'firered'},playerB:{handle:'Live Bob',version:'leafgreen'},frame:12,startedAt:Date.now()}];
  let releaseOld:(()=>void)|undefined,oldSearchStarted:(()=>void)|undefined;
  const oldStarted=new Promise<void>(resolve=>{oldSearchStarted=resolve;});
  const oldReleased=new Promise<void>(resolve=>{releaseOld=resolve;});
  let delayOld=true;
  await page.route('**/src/api.ts*',route=>route.fulfill({contentType:'text/javascript',body:`
    export const API_URL = 'http://127.0.0.1:8787';
    export class ApiError extends Error{constructor(code,message,status){super(message);this.code=code;this.status=status;}}
    export async function token(){return 'lobby-fixture-token';}
    export async function api(path,body){const response=await fetch('/__lobby-fixture'+path,{method:body===undefined?'GET':'POST',
      headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
      const result=await response.json();if(!response.ok)throw new ApiError(result.error,result.message,response.status);return result;}
  `}));
  await page.route('**/__lobby-fixture/**',async route=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.replace('/__lobby-fixture','');
    const search=(url.searchParams.get('search')??'').toLowerCase(),after=url.searchParams.get('after')??'';
    const matches=trainers.filter(trainer=>trainer.handle.toLowerCase().startsWith(search)&&trainer.handle.toLowerCase()>after);
    const results={trainers:matches.slice(0,50),nextCursor:matches.length>50?matches[49]!.handle.toLowerCase():null};
    if(path==='/api/lobby/trainers'&&search==='scout0'&&delayOld){delayOld=false;oldSearchStarted?.();await oldReleased;}
    let response:unknown;
    if(path==='/api/lobby')response={lobby:{sessionId:'lobby-discovery-fixture',version:'firered',saveRevision:1,party:[]},...results};
    else if(path==='/api/lobby/trainers')response=results;
    else if(path==='/api/trades'&&request.method()==='GET')response={trades:offeredTrades};
    else if(path==='/api/battles'&&request.method()==='GET')response={battles:offeredBattles};
    else if(path==='/api/battles/live'&&request.method()==='GET')response={battles:liveBattles};
    else if(path==='/api/battles/quick'&&request.method()==='POST'){quickActions.push('queue');response={status:'waiting',maxLevel:0};}
    else if(path==='/api/battles/quick/cancel'&&request.method()==='POST'){quickActions.push('cancel');response={status:'idle'};}
    else if(request.method()==='POST'&&(path==='/api/trades'||path==='/api/battles/challenge')){
      const {trainerId,watchable}=request.postDataJSON(),target=trainers.find(trainer=>trainer.id===trainerId)!;
      actions.push(watchable===undefined?{kind:path,trainerId}:{kind:path,trainerId,watchable});expect(target).toBeTruthy();
      const common={id:'00000000-0000-4000-8000-000000009999',side:'a',status:'offered',expiresAt:Date.now()+60000,playerA:alice,playerB:target};
      response=path==='/api/trades'?{...common,offerRevision:0,offerA:null,offerB:null,confirmedA:false,confirmedB:false}
        :{...common,playerA:{...alice,version:'firered'},rules:{format:'singles',levels:'earned',ranked:false},result:null,watchable:watchable===true};
      (path==='/api/trades'?offeredTrades:offeredBattles).push(response);
    }else throw new Error(`Unexpected lobby fixture request: ${request.method()} ${path}`);
    await route.fulfill({contentType:'application/json',body:JSON.stringify(response)});
  });
  await page.route('**/lobby-discovery-qualification',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head>
    <meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div>
    <script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    <script type="module" src="/@fs${fileURLToPath(new URL('./lobby-discovery-ui-entry.tsx',import.meta.url))}"></script></body></html>`}));
  // The presence stream stays silent until the test drives it, so every page
  // assertion below is a pure poll result first and a merge result later.
  const presenceStreams:WebSocketRoute[]=[];
  await page.routeWebSocket('**/api/lobby-play',socket=>{presenceStreams.push(socket);});
  await page.goto('/lobby-discovery-qualification');
  const directory=page.locator('.trainer-directory'),status=directory.getByRole('status'),rows=directory.locator('li');
  await expect(status).toHaveText('Page 1 · 50 trainers');await expect(rows).toHaveCount(50);
  await expect(rows.first().locator('.party-preview-chip')).toHaveCount(1);
  // The Quick Match card round-trips queue then cancel without leaving the lobby.
  const quickPanel=page.locator('.quick-match');
  await expect(quickPanel.getByText('Ready',{exact:true})).toBeVisible();
  await quickPanel.getByRole('button',{name:'Find a battle'}).click();
  await expect(quickPanel.getByText('Searching',{exact:true})).toBeVisible();
  await expect(quickPanel.getByRole('status')).toHaveText('Looking for a trainer…');
  await quickPanel.getByRole('button',{name:'Stop searching'}).click();
  await expect(quickPanel.getByText('Ready',{exact:true})).toBeVisible();
  // The live list is the server's public projection and hands off to watch mode.
  await expect(page.getByRole('heading',{name:'@Live Alice vs @Live Bob'})).toBeVisible();
  await page.getByRole('button',{name:'Watch battle'}).click();
  expect(await page.evaluate(()=>document.body.dataset.watch)).toBe('00000000-0000-4000-8000-000000009998:a');
  await directory.getByRole('button',{name:'Next trainers',exact:true}).click();
  await expect(status).toHaveText('Page 2 · 50 trainers');await expect(rows.first()).toContainText('@Scout050');
  await directory.getByRole('button',{name:'Next trainers',exact:true}).click();
  await expect(status).toHaveText('Page 3 · 50 trainers');await expect(rows.first()).toContainText('@Scout100');
  await expect(directory.getByRole('button',{name:'Next trainers',exact:true})).toBeDisabled();
  await directory.getByRole('button',{name:'Previous trainers',exact:true}).click();
  await expect(status).toHaveText('Page 2 · 50 trainers');await expect(rows.first()).toContainText('@Scout050');
  const field=directory.getByRole('searchbox',{name:'Find a trainer'});
  await field.fill('Scout0');await directory.getByRole('button',{name:'Search trainers',exact:true}).click();await oldStarted;
  await field.fill('sCoUt129');await directory.getByRole('button',{name:'Search trainers',exact:true}).click();
  await expect(status).toHaveText('Page 1 · 1 trainer');await expect(rows).toHaveCount(1);await expect(rows.first()).toContainText('@Scout129');
  const oldResponse=page.waitForResponse(response=>response.url().includes('search=Scout0'));
  releaseOld?.();await oldResponse;
  await expect(rows).toHaveCount(1);await expect(rows.first()).toContainText('@Scout129');
  await rows.first().getByRole('button',{name:'Invite to trade',exact:true}).click();
  await expect(page.locator('.trade-card')).toContainText('@Alice ↔ @Scout129');
  await directory.getByRole('checkbox',{name:'Allow spectators for new challenges'}).check();
  await rows.first().getByRole('button',{name:'Challenge to battle',exact:true}).click();
  await expect(page.getByRole('heading',{name:'@Alice vs @Scout129'})).toBeVisible();
  await expect(page.locator('.trade-invitations').filter({hasText:'@Alice vs @Scout129'})).toContainText('spectators allowed');
  expect(actions).toEqual([{kind:'/api/trades',trainerId:trainers[129]!.id},
    {kind:'/api/battles/challenge',trainerId:trainers[129]!.id,watchable:true}]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.screenshot({path:`test-output/screenshots/${process.env.KANTO_UI_EVIDENCE_TAG ?? ''}lobby-discovery-${info.project.name}.png`,fullPage:true});
  await field.fill('NoSuchTrainer');await directory.getByRole('button',{name:'Search trainers',exact:true}).click();
  await expect(status).toHaveText('Page 1 · 0 trainers');await expect(directory.getByText('No trainers on this page match that name.')).toBeVisible();
  await directory.getByRole('button',{name:'Clear search',exact:true}).click();await expect(status).toHaveText('Page 1 · 50 trainers');
  // The next battles poll turns the offered challenge into a ready quick match.
  (offeredBattles[0] as {status:string}).status='active';
  await expect(quickPanel.getByText('Match ready',{exact:true})).toBeVisible({timeout:8000});
  await expect(quickPanel.getByRole('button',{name:'Open match'})).toBeVisible();
  expect(quickActions).toEqual(['queue','cancel']);
  // Live presence: the mocked stream marks the directory live and merges its
  // events into the visible page without another fetch.
  await expect.poll(()=>presenceStreams.length).toBe(1);
  const stream=presenceStreams[0]!;
  stream.send(JSON.stringify({protocol:1,type:'ready'}));
  await expect(status).toHaveText('Page 1 · 50 trainers · live updates');
  stream.send(JSON.stringify({protocol:1,type:'put',trainer:{id:'00000000-0000-4000-8000-0000000000aa',handle:'Aardvark',version:'firered',party:[],maxLevel:9}}));
  await expect(rows.first()).toContainText('@Aardvark');await expect(rows).toHaveCount(50);
  await expect(directory.getByText('@Scout049')).toHaveCount(0);
  stream.send(JSON.stringify({protocol:1,type:'del',ownerId:'00000000-0000-4000-8000-0000000000aa'}));
  await expect(rows.first()).toContainText('@Scout000');await expect(rows).toHaveCount(49);
  // The live battle list rides the same stream; the next poll agrees with it.
  liveBattles.splice(0,liveBattles.length,{id:'00000000-0000-4000-8000-000000009997',
    playerA:{handle:'Push Alice',version:'firered'},playerB:{handle:'Push Bob',version:'leafgreen'},frame:30,startedAt:Date.now()});
  stream.send(JSON.stringify({protocol:1,type:'live',battles:liveBattles}));
  await expect(page.getByRole('heading',{name:'@Push Alice vs @Push Bob'})).toBeVisible();
  await expect(page.getByRole('heading',{name:'@Live Alice vs @Live Bob'})).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('watch mode streams a read-only screen and follows the side toggle',async({page},info)=>{
  const errors:string[]=[];page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/src/api.ts*',route=>route.fulfill({contentType:'text/javascript',body:`
    export const API_URL = 'http://127.0.0.1:8787';
    export class ApiError extends Error{constructor(code,message,status){super(message);this.code=code;this.status=status;}}
    export async function token(){return 'watch-fixture-token';}
    export async function api(){throw new Error('Watching must not fetch private battle state.');}
  `}));
  await page.route('**/watch-qualification',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head>
    <meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div>
    <script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    <script type="module" src="/@fs${fileURLToPath(new URL('./watch-ui-entry.tsx',import.meta.url))}"></script></body></html>`}));
  const streams:WebSocketRoute[]=[],auths:any[]=[];
  await page.routeWebSocket('**/api/battle-play',socket=>{
    streams.push(socket);
    socket.onMessage(message=>{auths.push(JSON.parse(message.toString()));});
  });
  await page.goto('/watch-qualification');
  await expect.poll(()=>streams.length).toBe(1);
  const battleId='00000000-0000-4000-8000-000000009999';
  await expect.poll(()=>auths.length).toBe(1);
  expect(auths[0]).toEqual({type:'authenticate',protocol:1,token:'watch-fixture-token',battleId,watch:{side:'a'}});
  const view=(side:'a'|'b')=>({id:battleId,side,status:'active',
    playerA:{id:'00000000-0000-4000-8000-000000000001',handle:'Scout001',version:'firered'},
    playerB:{id:'00000000-0000-4000-8000-000000000002',handle:'Scout002',version:'leafgreen'},
    rules:{format:'singles',levels:'earned',ranked:false},expiresAt:Date.now()+3_600_000,result:null,watchable:true});
  const screen=(value:number)=>{const pixels=new Uint8Array(240*160*4);pixels[0]=value;pixels[3]=255;return pixels;};
  const pixel=()=>page.evaluate(()=>{
    const canvas=document.querySelector('canvas');if(!canvas)return [];
    const context=canvas.getContext('2d');return context?Array.from(context.getImageData(0,0,1,1).data):[];
  });
  const first=new BattleScreenEncoder();
  streams[0]!.send(JSON.stringify({type:'ready',protocol:1,frame:4,battle:view('a')}));
  streams[0]!.send(Buffer.from(first.encode(screen(10),4)!));
  await expect(page.getByRole('heading',{name:'Watching @Scout001'})).toBeVisible();
  await expect(page.getByRole('status')).toHaveText('Watching live · read-only.');
  await expect.poll(pixel).toEqual([10,0,0,255]);
  await page.screenshot({path:`test-output/screenshots/${process.env.KANTO_UI_EVIDENCE_TAG ?? ''}watch-${info.project.name}.png`,fullPage:true});
  await page.getByRole('button',{name:'Watch side B · @Scout002'}).click();
  await expect.poll(()=>streams.length).toBe(2);
  await expect.poll(()=>auths.length).toBe(2);
  expect(auths[1]).toMatchObject({type:'authenticate',battleId,watch:{side:'b'}});
  const second=new BattleScreenEncoder();
  streams[1]!.send(JSON.stringify({type:'ready',protocol:1,frame:4,battle:view('b')}));
  streams[1]!.send(Buffer.from(second.encode(screen(20),4)!));
  await expect(page.getByRole('heading',{name:'Watching @Scout002'})).toBeVisible();
  await expect.poll(pixel).toEqual([20,0,0,255]);
  streams[1]!.send(Buffer.from(second.encode(screen(30),8)!));
  await expect.poll(pixel).toEqual([30,0,0,255]);
  streams[1]!.send(JSON.stringify({type:'finished',protocol:1,result:{winner:'b',reason:'finished'}}));
  await expect(page.getByRole('status')).toHaveText('@Scout002 won the battle!');
  await page.getByRole('button',{name:'Back to lobby'}).click();
  await expect.poll(()=>page.evaluate(()=>document.body.dataset.exited)).toBe('yes');
  expect(errors).toEqual([]);
});

test('player surface fills the viewport and follows the local trainer edition', async ({ page }, info) => {
  await page.route('**/player-layout-qualification*', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head>
    <meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div>
    <script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script>
    <script type="module" src="/@fs${fileURLToPath(new URL('./player-layout-ui-entry.tsx', import.meta.url))}"></script></body></html>` }));
  for (const version of ['firered', 'leafgreen']) {
    await page.goto(`/player-layout-qualification?version=${version}`);
    const player = page.getByRole('main');
    await expect(player).toHaveAttribute('data-version', version);
    await expect(page.getByRole('status')).toHaveText('The battle ended in a draw.');
    const bounds = await player.boundingBox();
    expect(bounds?.x).toBe(0);
    expect(bounds?.width).toBe(page.viewportSize()!.width);
    expect(bounds!.height).toBeGreaterThanOrEqual(page.viewportSize()!.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    await page.screenshot({ path: `test-output/screenshots/${process.env.KANTO_UI_EVIDENCE_TAG ?? ''}player-layout-${version}-${info.project.name}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Return to lobby', exact: true }).click();
    await expect(page).toHaveURL(/#lobby$/);
  }
});
