import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const chrome = process.env.KANTO_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export default defineConfig({
  testDir: './tests', testMatch: ['web.spec.ts', 'adventure-cards.spec.ts'], workers: 1, retries: 0,
  outputDir: 'test-output/browser', reporter: 'list',
  use: { baseURL: process.env.KANTO_WEB_URL ?? 'http://127.0.0.1:5173',
    launchOptions: existsSync(chrome) ? { executablePath: chrome } : {},
    screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: process.env.KANTO_WEB_URL ? undefined : [
    { command: 'node --experimental-strip-types apps/server/src/main.ts',
      url: 'http://127.0.0.1:8787/healthz', reuseExistingServer: !process.env.CI },
    { command: 'node node_modules/vite/bin/vite.js apps/web --host 127.0.0.1',
      url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI },
  ],
});
