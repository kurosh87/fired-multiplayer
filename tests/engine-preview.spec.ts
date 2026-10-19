import { test, expect } from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {originalGameDirectory} from './original-game-provider.ts';

for (const version of ['firered', 'leafgreen'] as const) {
  test(`${version} local preview boots the actual worker and pauses/resumes`, async ({ page, request }, info) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('/engine-preview.html');
    await page.getByRole('combobox', { name: 'Game', exact: true }).selectOption(version);
    const bootResponse=page.waitForResponse(response=>new URL(response.url()).pathname===`/__engine-preview/${version}/boot`);
    await page.getByRole('button', { name: 'Start preview', exact: true }).click();
    const boot=await (await bootResponse).json();
    const expected=JSON.parse(await readFile(resolve(originalGameDirectory(version),'candidate.json'),'utf8'));
    expect(boot.manifest.id).toBe(expected.id);
    await expect(page.getByRole('status')).toHaveText(`${version === 'firered' ? 'FireRed' : 'LeafGreen'} · local preview`);
    const frame = () => page.locator('canvas').getAttribute('data-frame').then(Number);
    await expect.poll(frame).toBeGreaterThan(120);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
    // Let the single in-flight worker tick finish before checking a pause.
    await expect.poll(async () => {
      const before = await frame();
      await new Promise(resolve => setTimeout(resolve, 100));
      return await frame() === before;
    }).toBe(true);
    const paused = await frame();
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect.poll(frame).toBeGreaterThan(paused + 15);
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const colors = await page.locator('canvas').evaluate(canvas => {
      const pixels = (canvas as HTMLCanvasElement).getContext('2d')!.getImageData(0, 0, 240, 160).data;
      return new Set(new Uint32Array(pixels.buffer)).size;
    });
    expect(colors).toBeGreaterThan(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
    await expect(page.getByRole('alert')).toBeHidden();
    const tag=process.env.KANTO_ENGINE_EVIDENCE_TAG;
    if(tag)expect(tag).toMatch(/^[a-z0-9-]{1,32}$/);
    await page.screenshot({ path: `test-output/screenshots/preview-${version}${tag?'-'+tag:''}-${info.project.name}.png`, fullPage: true });
    expect((await request.get('/__engine-preview/unknown/boot')).status()).toBe(404);
    expect((await request.get(`/__engine-preview/${version}/boot`, { headers: { Origin: 'https://unrelated.example' } })).status()).toBe(403);
  });
}
