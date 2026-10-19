import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium, expect } from '@playwright/test';
import type { createPreviewCloud, CloudEmail } from '../apps/server/src/preview-cloud.ts';
import { checkPreviewPerformance } from './check-preview-performance.ts';

export async function checkPreviewBrowser(service: ReturnType<typeof createPreviewCloud>, emails: CloudEmail[], origin: string,
  output: string, account: {id:string;email:string}, password:string) {
  const publicDir=resolve(process.env.KANTO_PREVIEW_OUTPUT??'build/netlify-accounts-v1');
  const server=createServer((incoming,outgoing)=>{void(async()=>{
    const url=new URL(incoming.url!,origin);
    if(url.pathname.startsWith('/api/cloud/')){
      const chunks:Buffer[]=[];for await(const chunk of incoming)chunks.push(Buffer.from(chunk));
      const headers=new Headers();for(const [key,value] of Object.entries(incoming.headers))if(value)headers.set(key,Array.isArray(value)?value.join(','):value);
      const response=await service.fetch(new Request(url,{method:incoming.method,headers,
        ...(['GET','HEAD'].includes(incoming.method!)?{}:{body:new Uint8Array(Buffer.concat(chunks))})}),'192.0.2.99');
      outgoing.statusCode=response.status;for(const [key,value] of response.headers)if(key!=='set-cookie')outgoing.setHeader(key,value);
      if(response.headers.getSetCookie().length)outgoing.setHeader('Set-Cookie',response.headers.getSetCookie());
      outgoing.end(Buffer.from(await response.arrayBuffer()));return;
    }
    const path=resolve(publicDir,'.'+(url.pathname==='/'||url.pathname==='/account/recovery'?'/index.html':url.pathname));
    if(!path.startsWith(publicDir+'/')){outgoing.writeHead(403).end();return;}
    try{const bytes=await readFile(path);outgoing.setHeader('Content-Type',({'.html':'text/html','.js':'text/javascript','.css':'text/css','.wasm':'application/wasm','.json':'application/json'} as Record<string,string>)[extname(path)]??'application/octet-stream');outgoing.end(bytes);}
    catch{outgoing.writeHead(404).end();}
  })().catch(()=>outgoing.writeHead(500).end());});
  await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(Number(new URL(origin).port),'127.0.0.1',resolve);});
  const browser=await chromium.launch({executablePath:process.env.KANTO_CHROME_PATH??'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const results:unknown[]=[];
  try{
    for(const mobile of [false,true]){
      const label=mobile?'mobile':'desktop';
      const context=await browser.newContext({viewport:mobile?{width:390,height:844}:{width:1440,height:1000},isMobile:mobile,hasTouch:mobile});
      const page=await context.newPage(),errors:string[]=[],wasmRequests:string[]=[];page.on('pageerror',error=>errors.push(error.message));
      page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('.wasm'))wasmRequests.push(request.url());});
      page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(20000);
      console.log('Checking browser accounts: '+label);
      try {
      await page.goto(origin);await expect(page.getByText('Account saves',{exact:true})).toBeVisible();
      await page.getByRole('button',{name:'Account and saves',exact:true}).click();
      // Better Auth marks anonymous background refreshes as pending. Hold an
      // actual SDK refresh while credentials are being edited: neither field
      // may be detached or lose its value. This uses the SDK's storage listener,
      // not a mocked session/client or a production-only test hook.
      await page.getByLabel('Email',{exact:true}).fill('typing@example.invalid');await page.getByLabel('Password',{exact:true}).fill(password);
      const emailField=await page.getByLabel('Email',{exact:true}).elementHandle(),passwordField=await page.getByLabel('Password',{exact:true}).elementHandle();assert(emailField&&passwordField);
      let releaseRefresh:()=>void=()=>{},refreshStarted:()=>void=()=>{};
      const heldRefresh=new Promise<void>(done=>{releaseRefresh=done;}),refreshSeen=new Promise<void>(done=>{refreshStarted=done;});
      const refreshRoute='**/api/cloud/auth/get-session';
      // The SDK can cancel a superseded session fetch while it is held. Drain
      // its route without turning expected cancellation into an unhandled
      // Playwright rejection during failure/screenshot cleanup.
      await page.route(refreshRoute,async route=>{refreshStarted();await heldRefresh;await route.continue().catch(()=>{});});
      try{
        await page.evaluate(()=>window.dispatchEvent(new StorageEvent('storage',{key:'better-auth.message',newValue:JSON.stringify({event:'session',data:{trigger:'signout'}})})));
        await Promise.race([refreshSeen,new Promise((_,reject)=>setTimeout(()=>reject(new Error('SDK refresh did not start.')),5000))]);
        assert.equal(await emailField.evaluate(node=>node.isConnected),true,'Anonymous refresh must keep the email field mounted');
        assert.equal(await passwordField.evaluate(node=>node.isConnected),true,'Anonymous refresh must keep the password field mounted');
        await expect(page.getByLabel('Email',{exact:true})).toHaveValue('typing@example.invalid');await expect(page.getByLabel('Password',{exact:true})).toHaveValue(password);
      }finally{releaseRefresh();await page.unrouteAll({behavior:'wait'});await emailField.dispose();await passwordField.dispose();}
      await page.getByRole('button',{name:'Create account',exact:true}).click();
      const signupEmail=`browser-${label}@example.invalid`;
      await page.getByLabel('Email',{exact:true}).fill(signupEmail);await page.getByLabel('Password',{exact:true}).fill(password);
      await page.getByRole('button',{name:'Create account',exact:true}).first().click();
      await expect(page.getByText('Check your email to confirm your account, then log in and choose your trainer name.',{exact:true})).toBeVisible();
      const link=emails.find(email=>email.to===signupEmail)?.text.match(/https?:\/\/\S+/)?.[0];assert(link);
      await page.goto(link);await page.getByRole('button',{name:'Account and saves',exact:true}).click();
      await page.getByLabel('Trainer name',{exact:true}).fill('Browser'+label);
      await page.getByRole('button',{name:'Reserve trainer name',exact:true}).click();
      await expect(page.getByRole('heading',{name:'@Browser'+label,exact:true})).toBeVisible();
      await expect(page.getByText('No cloud save yet',{exact:true})).toHaveCount(2);
      await page.getByRole('button',{name:'New FireRed adventure',exact:true}).click();
      await expect(page.getByRole('button',{name:'Start FireRed 2',exact:true})).toBeVisible();
      await page.getByRole('button',{name:'Start FireRed 2',exact:true}).click();
      await page.getByRole('button',{name:'Start adventure',exact:true}).click();
      await expect(page.locator('#status')).toHaveText('FireRed · browser preview',{timeout:30000});
      await expect.poll(()=>page.locator('canvas').getAttribute('data-frame').then(Number)).toBeGreaterThan(30);
      await page.getByRole('button',{name:'Account and saves',exact:true}).click();
      await page.getByRole('button',{name:'Sync current game save',exact:true}).click();
      await expect(page.getByText('Use SAVE in the game menu before syncing your adventure.',{exact:true})).toBeVisible();
      await page.getByRole('button',{name:'Sign out',exact:true}).click();
      await expect(page.getByRole('heading',{name:'Welcome back, trainer',exact:true})).toBeVisible();
      await expect(page.getByRole('button',{name:'Log in',exact:true})).toBeEnabled();
      await page.getByLabel('Email',{exact:true}).fill(account.email);await page.getByLabel('Password',{exact:true}).fill(password);
      await expect(page.getByLabel('Email',{exact:true})).toHaveValue(account.email);
      await page.getByRole('button',{name:'Log in',exact:true}).click();
      await expect(page.getByRole('heading',{name:'@CloudAlice',exact:true})).toBeVisible();
      for(const version of ['firered','leafgreen'] as const){
        const title=version==='firered'?'FireRed':'LeafGreen';
        await page.getByRole('button',{name:'Continue '+title,exact:true}).click();
        await page.getByRole('button',{name:'Load cloud save',exact:true}).click();
        await expect(page.getByRole('dialog')).toBeHidden();
        await expect.poll(async()=>{const message=await page.locator('#error').textContent();if(message)throw new Error('Game worker: '+message);return page.locator('#status').textContent();},{timeout:30000}).toBe(title+' · browser preview');
        await expect.poll(()=>page.locator('canvas').getAttribute('data-frame').then(Number)).toBeGreaterThan(120);
        await expect.poll(()=>page.locator('#fps-value').textContent().then(Number)).toBeGreaterThan(0);
        if(version==='firered'){
          await page.getByRole('button',{name:'Enable sound',exact:true}).click();
          await expect(page.getByRole('button',{name:'Mute sound',exact:true})).toHaveAttribute('aria-pressed','true');
          await page.getByRole('button',{name:'Mute sound',exact:true}).click();
        }
        await page.getByRole('button',{name:'Account and saves',exact:true}).click();
        await page.getByRole('button',{name:'Sync current game save',exact:true}).click();
        await expect(page.getByText('Game save synced. Your adventure stays paused; choose Resume when ready.',{exact:true})).toBeVisible();
        const saved=await service.store.read(account.id,version),expected=await readFile(`build/adventure-qualification/${version}-misty-v1/adventure.sav`);
        assert.deepEqual(saved.bytes,expected,'Actual browser worker exported the same original-game save loaded from the account');
        await page.screenshot({path:output+`/${label}-${version}-account.png`,fullPage:true});
        if(version==='firered'){await page.keyboard.press('Escape');await page.getByRole('button',{name:'Resume',exact:true}).click();
          await page.getByRole('button',{name:'Controls',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();
          await page.keyboard.press('Escape');await page.getByRole('button',{name:'Account and saves',exact:true}).click();}
      }
      assert.equal(wasmRequests.filter(url=>url.includes('/firered/')).length,1,'Starting and loading FireRed share one verified cached artifact');
      assert.equal(wasmRequests.filter(url=>url.includes('/leafgreen/')).length,1);
      const reset=await page.request.post(origin+'/api/cloud/auth/request-password-reset',{headers:{Origin:origin},data:{email:account.email,redirectTo:origin+'/account/recovery'}});
      assert.equal(reset.status(),200);
      const resetLink=emails.findLast(email=>email.to===account.email&&email.subject.includes('Reset'))?.text.match(/https?:\/\/\S+/)?.[0];assert(resetLink);
      await page.goto(resetLink);await expect(page.getByRole('heading',{name:'Choose a new password',exact:true})).toBeVisible();
      await page.getByLabel('Password',{exact:true}).fill(password);await page.getByRole('button',{name:'Update password',exact:true}).click();
      await expect(page.getByRole('heading',{name:'Welcome back, trainer',exact:true})).toBeVisible();
      assert.equal(await (await page.request.get(origin+'/api/cloud/auth/get-session')).json(),null);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth),mobile?390:1440);
      assert.deepEqual(errors,[]);results.push({viewport:label,realSignupConfirmationAndName:true,realLogin:true,bothEditionCloudLoadsAndSync:true,
        originalEarnedFlashUnchanged:true,multipleAdventures:true,emptySaveRejected:true,verifiedWasmCacheReuse:true,
        fpsAndAudioControls:true,passwordRecoveryWhileSignedIn:true,anonymousRefreshKeepsCredentialFieldsMounted:true,noHorizontalOverflow:true,noBrowserErrors:true});
      await context.close();
      } catch(error) {
        await writeFile(output+`/${label}-failure.json`,JSON.stringify({error:String(error),gameError:await page.locator('#error').textContent(),errors},null,2));
        await page.screenshot({path:output+`/${label}-failure.png`,fullPage:true});throw error;
      }
    }
    await checkPreviewPerformance(origin,publicDir,output);
  }finally{await browser.close();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));}
  await writeFile(output+'/browser-report.json',JSON.stringify({checkedAt:new Date().toISOString(),results,
    scope:'Native PostgreSQL + actual Better Auth + built web UI and real source-built game worker. Reuses retained input-earned saves; no new story automation or external email.'},null,2)+'\n');
  return results;
}
