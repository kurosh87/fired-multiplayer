import { test, expect } from '@playwright/test';

// Navigation regression fixtures: no hosted account, game worker or save is created.
test.beforeEach(async ({ page }) => {
  await page.route('**/src/legacy-account-client.ts*',route=>route.fulfill({contentType:'text/javascript',body:"export {supabase} from '/src/api.ts';"}));
  await page.route('**/src/api.ts*', route => route.fulfill({ contentType: 'text/javascript', body: `
    export const API_URL = location.origin + '/__cards';
    let session = { user: { id: 'alice' } };
    export const supabase = { auth: {
      getSession: async () => ({ data: { session } }),
      onAuthStateChange(callback) {
        const listener = event => { session = event.detail; callback(session ? 'SIGNED_IN' : 'SIGNED_OUT', session); };
        window.addEventListener('fixture-account', listener);
        return { data: { subscription: { unsubscribe: () => window.removeEventListener('fixture-account', listener) } } };
      },
      signOut: async () => window.dispatchEvent(new CustomEvent('fixture-account', { detail: null }))
    }};
    export async function token() { return session?.user.id ?? ''; }
    export class ApiError extends Error {}
    export async function api(path, body) {
      const response = await fetch(API_URL + path, { headers: { 'X-Fixture-User': session?.user.id ?? '' },
        method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) throw new Error('Could not refresh adventures.');
      return response.json();
    }
  ` }));
  await page.route('**/src/game.tsx*', route => route.fulfill({ contentType: 'text/javascript', body: `
    import React from '/node_modules/.vite/deps/react.js';
    import { Button } from '/src/components/ui/button.tsx';
    export function Game({ version, onExit }) {
      return React.createElement('main', null,
        React.createElement('h1', null, version + ' navigation fixture'),
        React.createElement(Button, { onClick: async () => {
          await fetch('/__cards/fixture-save/' + version, { method: 'POST' }); onExit();
        } }, 'Save and return home'));
    }
  ` }));
});

test('adventure cards refresh after returning from a saved game', async ({ page }) => {
  let saved = false;
  let refreshes = 0;
  await page.route('**/__cards/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/fixture-save/')) saved = true;
    if (path.endsWith('/api/adventures')) refreshes++;
    await route.fulfill({ json: path.endsWith('/api/status') ? {
      engines: ['firered', 'leafgreen'].map(version => ({ version, available: true })), multiplayer: {}
    } : path.endsWith('/api/profile') ? { profile: { id: 'alice', handle: 'Alice' } }
      : path.endsWith('/api/adventures') ? { adventures: [
        { version: 'firered', hasSave: saved }, { version: 'leafgreen', hasSave: false }
      ] } : {} });
  });
  await page.goto('/');
  const fire = page.locator('.version-card.red');
  const leaf = page.locator('.version-card.green');
  await expect(page.getByText('Alice', { exact: true })).toBeVisible();
  await expect.poll(() => refreshes).toBeGreaterThan(0);
  await fire.getByRole('button', { name: 'Begin adventure' }).click();
  await page.getByRole('button', { name: 'Save and return home' }).click();
  await expect(fire.getByRole('button', { name: 'Continue adventure' })).toBeVisible();
  await expect(fire.getByText('Cloud save', { exact: true })).toBeVisible();
  await expect(leaf.getByRole('button', { name: 'Begin adventure' })).toBeVisible();
  await expect(leaf.getByText('Cloud save', { exact: true })).toHaveCount(0);
});

test('adventure cards ignore a previous account response after switching trainers', async ({ page }) => {
  let release!: () => void;
  let requested!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { requested = resolve; });
  await page.route('**/__cards/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const user = route.request().headers()['x-fixture-user'];
    if (path.endsWith('/api/adventures') && user === 'alice') { requested(); await held; }
    await route.fulfill({ json: path.endsWith('/api/status') ? {
      engines: ['firered', 'leafgreen'].map(version => ({ version, available: true })), multiplayer: {}
    } : path.endsWith('/api/profile') ? { profile: { id: user, handle: user === 'alice' ? 'Alice' : 'Bob' } }
      : { adventures: [{ version: 'firered', hasSave: user === 'alice' }, { version: 'leafgreen', hasSave: false }] } });
  });
  await page.goto('/');
  await started;
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('fixture-account', { detail: { user: { id: 'bob' } } })));
  await expect(page.getByText('Bob', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Begin adventure' })).toHaveCount(2);
  const late = page.waitForResponse(response => response.url().endsWith('/api/adventures') && response.request().headers()['x-fixture-user'] === 'alice');
  release(); await late;
  // Let the response handler and React commit, then inspect the actual cards.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByText('Cloud save', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Begin adventure' })).toHaveCount(2);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByText('Bob', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Cloud save', { exact: true })).toHaveCount(0);
});

test('an active battle is surfaced from the adventure view after a reload', async ({ page }) => {
  await page.route('**/__cards/**', async route => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({ json: path.endsWith('/api/status') ? {
      engines: ['firered', 'leafgreen'].map(version => ({ version, available: true })),
      multiplayer: { lobby: true, battles: true, trading: true }
    } : path.endsWith('/api/profile') ? { profile: { id: 'alice', handle: 'Alice' } }
      : path.endsWith('/api/adventures') ? { adventures: [] }
      : path.endsWith('/api/battles') ? { battles: [{ id: '00000000-0000-4000-8000-000000009999', status: 'active' }] }
      : path.endsWith('/api/trades') ? { trades: [] } : {} });
  });
  await page.goto('/');
  await expect(page.getByText('You have an online battle in progress.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Return to lobby' })).toBeVisible();
});
