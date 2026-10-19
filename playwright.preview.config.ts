import { defineConfig } from '@playwright/test';
import application from './playwright.config.ts';
const evidenceTag=process.env.KANTO_ENGINE_EVIDENCE_TAG;
if(evidenceTag&&!/^[a-z0-9-]{1,32}$/.test(evidenceTag))throw new Error('Use a short evidence tag of lowercase letters, numbers and dashes.');

export default defineConfig({ ...application, testMatch: 'engine-preview.spec.ts', timeout: 30_000,
  outputDir: evidenceTag?`test-output/engine-preview-${evidenceTag}`:'test-output/engine-preview',
  use: { ...application.use, baseURL: 'http://127.0.0.1:5174' },
  webServer: { command: 'node --experimental-strip-types scripts/preview-engine.ts',
    url: 'http://127.0.0.1:5174/engine-preview.html', reuseExistingServer: !process.env.CI } });
