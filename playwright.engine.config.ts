import { defineConfig } from '@playwright/test';
import application from './playwright.config.ts';

export default defineConfig({ ...application, testMatch: 'engine.browser.spec.ts',
  timeout: 120_000, outputDir: 'test-output/engine-browser' });
