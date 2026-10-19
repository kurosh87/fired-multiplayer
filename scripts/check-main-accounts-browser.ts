import assert from 'node:assert/strict';
import {createServer as reservePort} from 'node:http';
import {resolve} from 'node:path';
import {writeFile} from 'node:fs/promises';
import {createServer as createViteServer} from 'vite';
import {chromium,expect} from '@playwright/test';
import pg from 'pg';
import {createPreviewCloud,type CloudEmail} from '../apps/server/src/preview-cloud.ts';
import {createApp} from '../apps/server/src/app.ts';
import type {Database} from '../apps/server/src/database.ts';
import {originalGameProvider} from '../tests/original-game-provider.ts';

/** Actual main UI and SDK, API, workers and Postgres. Only the experimental
 * client status admission is a fixture; public manifest flags stay false. */
export async function checkMainAccountsBrowser(game:Database,accountDatabaseUrl:string,secret:string,
  accounts:[{email:string},{email:string}],password:string,output:string){
  const reservation=reservePort();await new Promise<void>(done=>reservation.listen(0,'127.0.0.1',done));
  const address=reservation.address();assert(address&&typeof address!=='string');
  const port=address.port,origin=`http://127.0.0.1:${port}`;await new Promise<void>(done=>reservation.close(()=>done()));
  const registry=await originalGameProvider(),battleRegistry=await originalGameProvider(true);
  const app=await createApp({origin,engineDirectory:'unused-native-check',publicRelease:false,
    accountOrigin:origin,accountSecret:secret,accountDatabaseUrl,adventureWorkers:1,battleWorkers:1},{database:game,registry,battleRegistry});
  const pool=new pg.Pool({connectionString:accountDatabaseUrl,max:2}),emails:CloudEmail[]=[];
  const cloud=createPreviewCloud(pool,origin,secret,async value=>{emails.push(value);});
  let web:Awaited<ReturnType<typeof createViteServer>>|undefined,browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
  const results:unknown[]=[];
  try{
    const base=await app.listen({host:'127.0.0.1',port:0});
    web=await createViteServer({root:resolve('apps/web'),configFile:resolve('apps/web/vite.config.ts'),cacheDir:resolve('build/main-accounts-vite-cache'),logLevel:'warn',
      define:{'import.meta.env.VITE_ACCOUNT_PROVIDER':JSON.stringify('better-auth'),'import.meta.env.VITE_API_URL':JSON.stringify(base)},
      server:{host:'127.0.0.1',port,strictPort:true,fs:{allow:[resolve('.')]}} ,plugins:[{name:'kanto-native-accounts',configureServer(server){server.middlewares.use((request,response,next)=>{
      if(!request.url?.startsWith('/api/cloud/'))return next();
      void(async()=>{
        const headers=new Headers();for(const [key,value] of Object.entries(request.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
        const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
        const result=await cloud.fetch(new Request(origin+request.url,{method:request.method,headers,...(['GET','HEAD'].includes(request.method!)?{}:{body:new Uint8Array(Buffer.concat(chunks))})}),
          String(request.headers['user-agent']).includes('Kanto-Local-Qualification-Mobile')?'192.0.2.121':'192.0.2.120');
        response.statusCode=result.status;for(const [key,value] of result.headers)if(key!=='set-cookie')response.setHeader(key,value);
        if(result.headers.getSetCookie().length)response.setHeader('Set-Cookie',result.headers.getSetCookie());response.end(Buffer.from(await result.arrayBuffer()));
      })().catch(()=>{response.statusCode=500;response.end('{}');});
    });}}]});
    await web.listen();
    browser=await chromium.launch({executablePath:process.env.KANTO_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
    const pages=[],pageErrors:string[][]=[];
    for(const [side,label] of (['desktop','mobile'] as const).entries()){
      const context=await browser.newContext({viewport:side?{width:390,height:844}:{width:1440,height:1000},isMobile:Boolean(side),hasTouch:Boolean(side),...(side?{userAgent:'Kanto-Local-Qualification-Mobile'}:{})});
      await context.grantPermissions(['local-network-access'],{origin});const page=await context.newPage();pages.push(page);
      page.setDefaultTimeout(10000);const errors:string[]=[];let sessionRequests=0;
      pageErrors.push(errors);
      page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(new URL(request.url()).pathname==='/api/cloud/auth/get-session')sessionRequests++;});
      await page.route(base+'/api/status',route=>route.fulfill({headers:{'Access-Control-Allow-Origin':origin},json:{protocol:1,accountsConfigured:true,publicReleaseReady:false,
        engines:(['firered','leafgreen'] as const).map(version=>({version,available:true,reason:'Explicit local experimental UI qualification',manifest:registry.manifest(version)})),
        multiplayer:{lobby:true,battles:true,trading:false},capacity:{target:1000,qualified:false}}}));
      try{
        await page.goto(origin);await page.getByRole('button',{name:/Create account/}).first().click();
        const dialog=page.getByRole('dialog'),email=`main-${label}@example.invalid`,localPassword='Main browser fixture 123!';
        await dialog.getByLabel('Email address').fill(email);await dialog.getByLabel('Password',{exact:true}).fill(localPassword);
        await dialog.getByRole('button',{name:/Create account/}).click();
        await expect(page.getByText('Check your email to confirm your account, then choose your trainer name.')).toBeVisible();
        const verification=emails.find(v=>v.to===email)?.text.match(/https?:\/\/\S+/)?.[0];assert(verification);await page.goto(verification);
        await expect(page.getByRole('heading',{name:'What should we call you?'})).toBeVisible();
        await page.getByLabel('Trainer name').fill('cLoUdAlIcE');await page.getByRole('button',{name:'Reserve name',exact:true}).click();
        await expect(page.getByText('That name is already reserved, or you already have a trainer.')).toBeVisible();
        await page.getByLabel('Trainer name').fill('Main'+label);await page.getByRole('button',{name:'Reserve name',exact:true}).click();
        await expect(page.getByText('Main'+label,{exact:true})).toBeVisible();await expect(page.locator('.version-card')).toHaveCount(2);
        await page.getByRole('button',{name:'New FireRed adventure',exact:true}).click();await expect(page.getByRole('heading',{name:'FireRed 2',exact:true})).toBeVisible();
        const second=page.locator('.version-card').filter({has:page.getByRole('heading',{name:'FireRed 2',exact:true})});
        await second.getByRole('button',{name:'Begin adventure',exact:true}).click();
        await expect(page.getByRole('button',{name:'Pause & checkpoint',exact:true})).toBeEnabled({timeout:30000});
        await expect.poll(()=>page.locator('[data-verified-frame]').getAttribute('data-verified-frame').then(Number),{timeout:15000}).toBeGreaterThan(0);
        await page.getByRole('button',{name:'← Save & exit',exact:true}).click();
        await expect(second.getByRole('button',{name:'Continue adventure',exact:true})).toBeVisible();
        const first=page.locator('.version-card').filter({has:page.getByRole('heading',{name:'FireRed',exact:true})});await expect(first.getByText('A new beginning',{exact:true})).toBeVisible();
        await page.screenshot({path:output+`/main-${label}-adventures.png`,fullPage:true});
        await page.getByRole('button',{name:'Sign out',exact:true}).click();await page.locator('.account-actions').getByRole('button',{name:'Log in',exact:true}).click();await page.getByRole('button',{name:'Forgot password?'}).click();
        await page.getByLabel('Email address').fill(email);await page.getByRole('button',{name:'Send reset link',exact:true}).click();
        await expect(page.getByText('If an account uses that address, a password reset email is on its way.',{exact:true})).toBeVisible();
        const link=emails.findLast(v=>v.to===email&&v.subject.includes('Reset'))?.text.match(/https?:\/\/\S+/)?.[0];assert(link);await page.goto(link);
        await expect(page.getByRole('heading',{name:'Choose a new password.'})).toBeVisible();await page.getByLabel('New password',{exact:true}).fill(localPassword+' new');await page.getByRole('button',{name:'Update password',exact:true}).click();
        await expect(page.getByText('Your password has been updated.',{exact:true})).toBeVisible();
        await page.locator('.account-actions').getByRole('button',{name:'Log in',exact:true}).click();await page.getByLabel('Email address').fill(email);await page.getByLabel('Password',{exact:true}).fill(localPassword+' new');await page.getByRole('dialog').getByRole('button',{name:'Log in',exact:true}).click();await expect(page.getByText('Main'+label,{exact:true})).toBeVisible();await page.getByRole('button',{name:'Sign out',exact:true}).click();
        await page.locator('.account-actions').getByRole('button',{name:'Log in',exact:true}).click();await page.getByLabel('Email address').fill(accounts[side]!.email);await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('dialog').getByRole('button',{name:'Log in',exact:true}).click();
        await expect(page.getByText(side?'CloudBob':'CloudAlice',{exact:true})).toBeVisible();await expect(page.getByText('Main'+label,{exact:true})).toHaveCount(0);
        await page.waitForTimeout(250);const before=sessionRequests;
        await page.evaluate(async()=>{const path='/src/api.ts';const {api}=await import(path);await Promise.all([api('/api/profile'),api('/api/profile'),api('/api/profile')]);});assert.equal(sessionRequests,before);
        const cookie=(await context.cookies()).find(v=>v.name.endsWith('.session_token'));assert(cookie?.httpOnly);
        const token=decodeURIComponent(cookie.value).split('.')[0]!;
        assert.equal(await page.evaluate(value=>[...Object.values(localStorage),...Object.values(sessionStorage)].some(v=>v.includes(value)),token),false);
        await page.getByRole('button',{name:'Online lobby',exact:true}).click();await expect(page.getByRole('heading',{name:'Your party',exact:true})).toBeVisible();
        assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),side?390:1440);
        results.push({viewport:label,actualMainUi:true,actualSdkAccounts:true,caseInsensitiveNameCollision:true,newAdventureAndExactSaveSelection:true,
          originalCWorkerAndVerifiedApi:true,otherAdventureUnchanged:true,passwordRecovery:true,accountSwitchCleanup:true,
          repeatedApiRequestsUseMemoryCredentials:true,noPersistentTokenStorage:true,noBrowserErrors:true});
      }catch(error){await page.screenshot({path:output+`/main-${label}-failure.png`,fullPage:true});await writeFile(output+`/main-${label}-failure.json`,JSON.stringify({error:String(error),errors,text:await page.locator('body').innerText()},null,2)+'\n');throw error;}
    }
    const canonical=(await game.pool.query('select id,revision,flash from private.adventures order by id')).rows;
    const [alice,bob]=pages;assert(alice&&bob);await alice.getByRole('button',{name:'Challenge to battle',exact:true}).click();
    await bob.getByRole('button',{name:'Accept battle',exact:true}).click();await alice.getByRole('button',{name:'Continue battle',exact:true}).click();
    for(const page of pages)await expect(page.getByRole('status')).toContainText('Connected',{timeout:15000});
    await alice.getByRole('button',{name:'Forfeit battle',exact:true}).click();await alice.getByRole('button',{name:'Confirm forfeit',exact:true}).click();
    for(const page of pages){await page.getByRole('button',{name:'Return to lobby',exact:true}).click();await expect(page.getByRole('heading',{name:'Your party',exact:true})).toBeVisible();}
    assert.deepEqual((await game.pool.query('select id,revision,flash from private.adventures order by id')).rows,canonical);
    const expectedAdventure=(await game.pool.query("select s.adventure_id from private.game_sessions s join public.profiles p on p.id=s.owner_id where p.handle='CloudAlice' and s.status='lobby'")).rows[0].adventure_id;
    const returning=alice.waitForResponse(response=>new URL(response.url()).pathname==='/api/lobby/leave');
    await alice.getByRole('button',{name:'Return to adventure',exact:true}).click();
    const resumed=await (await returning).json();assert.equal(resumed.adventureId,expectedAdventure);
    await expect(alice.getByRole('button',{name:'Pause & checkpoint',exact:true})).toBeEnabled({timeout:30000});
    await alice.getByRole('button',{name:'← Save & exit',exact:true}).click();await expect(alice.getByRole('heading',{name:'Choose your adventure',exact:true})).toBeVisible();
    assert.deepEqual((await game.pool.query('select flash from private.adventures where id=$1',[resumed.adventureId])).rows[0].flash,canonical.find(row=>row.id===resumed.adventureId).flash);
    assert(pageErrors.every(errors=>errors.length===0));
    await writeFile(output+'/main-browser-report.json',JSON.stringify({checkedAt:new Date().toISOString(),results,actualMainAccountsAndBattle:true,
      battleForfeitAndReturn:true,exactAdventureReturnAndCartridgePreserved:true,experimentalStatusAdmissionFixture:true,publicReleaseQualified:false,externalEmailsSent:0},null,2)+'\n');
  }finally{await browser?.close();await web?.close();await app.close();await pool.end();}
}
