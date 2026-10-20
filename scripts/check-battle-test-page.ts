import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';

const url = process.env.KANTO_BATTLE_TEST_URL;
const accountsPath = process.env.KANTO_BATTLE_TEST_ACCOUNTS;
assert(url && /^https:\/\/[a-f0-9]{24}--kanto-online-preview\.netlify\.app$/.test(url), 'Provide the immutable branch preview URL.');
assert(accountsPath, 'Provide the two preview account credentials.');
const accounts = JSON.parse(await readFile(accountsPath, 'utf8')) as { email: string; password: string; handle: string }[];
assert.equal(accounts.length, 2);
const output = resolve('build/battle-test-page');
await mkdir(output, { recursive: true });
const errors: string[] = [];
const browser = await chromium.launch({ executablePath: process.env.KANTO_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  const contexts = await Promise.all([
    browser.newContext({ viewport: { width: 1280, height: 900 } }),
    browser.newContext({ viewport: { width: 390, height: 844 } })
  ]);
  const pages = await Promise.all(contexts.map(context => context.newPage()));
  for (const page of pages) page.on('pageerror', error => errors.push(error.message));
  async function signIn(page: (typeof pages)[number], account: (typeof accounts)[number]) {
    await page.goto(url + '/battle-test/');
    await page.getByLabel('Email').fill(account.email);
    await page.getByLabel('Password').fill(account.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    // The profile response replaces the name form with the lobby controls.
    await page.waitForTimeout(1500);
    const handle = page.getByPlaceholder('Trainer name');
    if (await handle.isVisible().catch(() => false)) {
      await handle.fill(account.handle);
      const reserve = page.getByRole('button', { name: 'Reserve name', exact: true });
      await expect(reserve).toBeEnabled({ timeout: 10000 });
      await reserve.click();
    }
    const prepare = page.getByRole('button', { name: 'Prepare test lobby', exact: true });
    await expect(prepare).toBeVisible({ timeout: 30000 });
    await prepare.click();
    await expect(page.getByText(`Test lobby ready for @${account.handle}.`, { exact: true })).toBeVisible({ timeout: 30000 });
  }
  await signIn(pages[0]!, accounts[0]!);
  await signIn(pages[1]!, accounts[1]!);
  const aliceRow = pages[0]!.locator('li').filter({ hasText: `@${accounts[1]!.handle}` });
  await expect(aliceRow).toBeVisible({ timeout: 15000 });
  await aliceRow.getByRole('button', { name: 'Challenge', exact: true }).click();
  const accept = pages[1]!.getByRole('button', { name: 'Accept', exact: true });
  const bobContinue = pages[1]!.getByRole('button', { name: 'Continue', exact: true });
  await expect.poll(async () => (await accept.count()) + (await bobContinue.count()), { timeout: 15000 }).toBeGreaterThan(0);
  if (await accept.count()) await accept.click();
  else await bobContinue.click();
  const continueAlice = pages[0]!.getByRole('button', { name: 'Continue', exact: true });
  await expect(continueAlice).toBeVisible({ timeout: 15000 });
  await continueAlice.click();
  for (const [index, page] of pages.entries()) {
    await expect(page.locator('canvas')).toBeVisible({ timeout: 30000 });
    await expect(page.getByText(/Connected · choose your next move\./)).toBeVisible({ timeout: 30000 });
    await page.screenshot({ path: resolve(output, `battle-${index}.png`), fullPage: true });
  }
  await pages[0]!.keyboard.press('KeyZ');
  await pages[0]!.waitForTimeout(1200);
  await pages[0]!.getByRole('button', { name: 'Forfeit battle', exact: true }).click();
  await pages[0]!.getByRole('button', { name: 'Confirm forfeit', exact: true }).click();
  for (const page of pages) await expect(page.getByRole('button', { name: 'Return to lobby', exact: true })).toBeVisible({ timeout: 30000 });
  await pages[0]!.screenshot({ path: resolve(output, 'battle-complete.png'), fullPage: true });
  assert.deepEqual(errors, []);
  await writeFile(resolve(output, 'report.json'), JSON.stringify({
    checkedAt: new Date().toISOString(), url, passed: true, accounts: accounts.map(account => account.handle),
    flow: ['sign-in', 'reserve-name', 'prepare-lobby', 'challenge', 'accept', 'play', 'forfeit'], browserErrors: errors
  }, null, 2) + '\n');
  console.log(JSON.stringify({ output, passed: true }));
} finally {
  await browser.close();
}
