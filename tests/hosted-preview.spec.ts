import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { previewCandidate } from '../scripts/preview-candidate.ts';

for (const version of ['firered', 'leafgreen']) {
  test(`${version} static preview runs without a backend`, async ({ page, request }, info) => {
    const tag=process.env.KANTO_UI_EVIDENCE_TAG;
    if(tag)expect(tag).toMatch(/^[a-z0-9-]{1,40}$/);
    const shot=tag??(process.env.KANTO_PREVIEW_URL?'netlify-shadcn':'static-shadcn');
    const errors: string[] = [], privateRequests: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      if (/\/api\/|\/__engine-preview\//.test(request.url())) privateRequests.push(request.url());
    });
    // Observe real UI inputs sent to the actual worker; do not alter the core.
    await page.addInitScript(`window.previewInputs = []; window.previewWorkers = 0; window.Worker = new Proxy(window.Worker, {
      construct(Target, args) { window.previewWorkers++; const worker = new Target(...args); const send = worker.postMessage.bind(worker);
        worker.postMessage = (message, ...rest) => { if (message.type === 'tick') { window.previewInputs.push(message.buttons); if (window.previewInputs.length > 100) window.previewInputs.shift(); } return send(message, ...rest); }; return worker; }
    });`);
    const metadata = await (await request.get(`/preview-data/${version}/boot.json`)).json();
    const expected = JSON.parse(await readFile(`build/game-source/${version}/${previewCandidate()}/candidate.json`, 'utf8'));
    expect(metadata.manifest.id).toBe(expected.id);
    expect(metadata.manifest.status).toBe('experimental');
    expect(Object.values(metadata.manifest.capabilities)).not.toContain(true);
    await page.goto('/');
    await expect(page.getByText('Browser gameplay preview', {exact: true})).toBeVisible();
    const accounts=process.env.KANTO_NETLIFY_ACCOUNTS==='1';
    await expect(page.getByText(accounts?'Account saves':'Session only', {exact: true})).toBeVisible();
    await expect(page.getByText(accounts?'Use SAVE in the game menu, then Account → Sync current game save. Reloading clears unsynced progress.':'Progress stays in this open page. Reloading or restarting clears it.', {exact: true})).toBeVisible();
    await page.getByRole('combobox', {name:'Game', exact:true}).selectOption(version);
    await expect(page.locator('body')).toHaveAttribute('data-version',version);
    await page.getByRole('button', {name:'Start preview', exact:true}).click();
    // A cold public WASM download is not subject to the default 5-second UI assertion budget.
    await expect(page.getByRole('status')).toHaveText(`${version === 'firered' ? 'FireRed' : 'LeafGreen'} · browser preview`,{timeout:30_000});
    const frame = () => page.locator('canvas').getAttribute('data-frame').then(Number);
    await expect.poll(frame).toBeGreaterThan(120);
    if(previewCandidate().includes('audio')){
      const sound=page.getByRole('button',{name:'Enable sound',exact:true});
      await expect(sound).toBeEnabled();await sound.click();
      const mute=page.getByRole('button',{name:'Mute sound',exact:true});
      await expect(mute).toHaveAttribute('aria-pressed','true');await mute.click();
      await expect(sound).toHaveAttribute('aria-pressed','false');
    }
    const action = page.getByRole('button', {name:'A', exact:true});
    if (info.project.name === 'mobile') await action.tap();
    else { await page.keyboard.press('KeyZ'); }
    await expect.poll(() => page.evaluate('window.previewInputs.some(buttons => (buttons & 1) !== 0)')).toBe(true);
    await page.getByRole('button', {name:'Pause', exact:true}).click();
    await expect.poll(async () => { const before=await frame(); await new Promise(resolve=>setTimeout(resolve,100)); return await frame() === before; }).toBe(true);
    const paused = await frame();
    await page.getByRole('button', {name:'Resume', exact:true}).click();
    await expect.poll(frame).toBeGreaterThan(paused + 15);
    await expect.poll(() => page.locator('canvas').evaluate(canvas => {
      const data=(canvas as HTMLCanvasElement).getContext('2d')!.getImageData(0,0,240,160).data;
      return new Set(new Uint32Array(data.buffer)).size;
    })).toBeGreaterThan(1);
    await expect.poll(() => page.locator('#fps-value').textContent().then(Number)).toBeGreaterThan(0);
    await expect(page.locator('#speed-value')).toHaveText(/\d+\.\d+×/);
    await page.screenshot({path:`test-output/screenshots/${shot}-gameplay-${version}-${info.project.name}.png`,fullPage:true});
    await page.getByRole('button', { name: 'Stats', exact: true }).click();
    await expect(page.getByLabel('Performance overlay')).toBeHidden();
    await page.getByRole('button', { name: 'Stats', exact: true }).click();
    await expect(page.getByLabel('Performance overlay')).toBeVisible();
    await page.getByRole('button', { name: 'Controls', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('heading', {name:'Make yourself at home.'})).toBeVisible();
    await expect(page.locator('#pause')).toHaveText('Resume');
    if (version === 'firered') await page.screenshot({path:`test-output/screenshots/${shot}-controls-${info.project.name}.png`,fullPage:true,animations:'disabled'});
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toBeHidden();
    await page.getByRole('button', {name:'Resume',exact:true}).click();
    if (info.project.name === 'desktop' && await page.getByRole('button', { name: 'Enter fullscreen', exact:true }).isVisible()) {
      await page.getByRole('button', { name: 'Enter fullscreen', exact:true }).click();
      await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
      await page.getByRole('button', {name:'Exit fullscreen',exact:true}).click();
      await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(false);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(errors).toEqual([]); expect(privateRequests.filter(url=>!accounts||!new URL(url).pathname.startsWith('/api/cloud/'))).toEqual([]);
    await expect(page.getByRole('alert')).toBeHidden();
    if (await page.locator('#pause').textContent() === 'Resume') await page.getByRole('button',{name:'Resume',exact:true}).click();
    await expect.poll(frame,{timeout:25_000}).toBeGreaterThan(900);
    await page.locator('canvas').focus(); await page.keyboard.press('Enter');
    await expect.poll(frame,{timeout:10_000}).toBeGreaterThan(1200);
    await page.screenshot({path:`test-output/screenshots/${shot}-preview-${version}-${info.project.name}.png`, fullPage:true});
    const workers = Number(await page.evaluate('window.previewWorkers'));
    await page.getByRole('button', {name:'Restart preview',exact:true}).click();
    const restart = page.getByRole('dialog', {name:'Restart preview?',exact:true});
    await expect(restart).toBeVisible();
    await expect(restart.getByText(`Start ${version === 'firered' ? 'FireRed' : 'LeafGreen'} from the beginning. Your current preview progress will be cleared.`)).toBeVisible();
    await expect(restart.getByRole('button', {name:'Cancel',exact:true})).toBeFocused();
    await expect(page.locator('#pause')).toHaveText('Resume');
    await expect.poll(async()=>{const before=await frame();await page.waitForTimeout(100);return await frame()===before;}).toBe(true);
    const preserved = await frame();
    await page.keyboard.press('KeyZ');await page.keyboard.press('ArrowDown');
    expect(await frame()).toBe(preserved);
    expect(await page.evaluate('window.previewWorkers')).toBe(workers);
    if(version==='firered')await page.screenshot({path:`test-output/screenshots/${shot}-restart-${info.project.name}.png`,fullPage:true,animations:'disabled'});
    await restart.getByRole('button', {name:'Cancel',exact:true}).click();
    await expect(restart).toBeHidden();
    await expect(page.getByRole('button', {name:'Restart preview',exact:true})).toBeFocused();
    expect(await page.evaluate('window.previewWorkers')).toBe(workers);
    await page.getByRole('button', {name:'Resume',exact:true}).click();
    await expect.poll(frame).toBeGreaterThan(preserved+10);
    await page.getByRole('button', {name:'Restart preview',exact:true}).click();
    await expect(restart).toBeVisible();
    await page.keyboard.press('Escape');await expect(restart).toBeHidden();
    expect(await page.evaluate('window.previewWorkers')).toBe(workers);
    await page.getByRole('button', {name:'Restart preview',exact:true}).click();
    await restart.getByRole('button', {name:'Restart adventure',exact:true}).click();
    await expect(restart).toBeHidden();
    await expect.poll(()=>page.evaluate('window.previewWorkers')).toBe(workers+1);
    await expect.poll(frame).toBeLessThan(preserved);
    await expect(page.locator('#play-state')).toHaveAttribute('data-state','playing');
    if(info.project.name==='mobile')expect(await page.locator('.controls button').evaluateAll(buttons=>buttons.every(button=>{const rect=button.getBoundingClientRect();return rect.width>=44&&rect.height>=44;}))).toBe(true);
    expect(errors).toEqual([]);expect(privateRequests.filter(url=>!accounts||!new URL(url).pathname.startsWith('/api/cloud/'))).toEqual([]);
  });
}
