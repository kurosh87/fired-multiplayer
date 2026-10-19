import { defineConfig } from '@playwright/test';
import application from './playwright.config.ts';
import { resolve } from 'node:path';
const hosted = process.env.KANTO_PREVIEW_URL;
const tag=process.env.KANTO_UI_EVIDENCE_TAG;
if(tag&&!/^[a-z0-9-]{1,40}$/.test(tag))throw new Error('Use a short evidence tag.');
const output=resolve(process.env.KANTO_PREVIEW_OUTPUT??'build/netlify-preview');
if(!output.startsWith(resolve('build')+'/'))throw new Error('Preview output must stay inside the project build directory.');
const quotedOutput="'"+output.replace(/'/g,"'\\''")+"'";
export default defineConfig({ ...application, testMatch: process.env.KANTO_PREVIEW_RELEASE_AUDIO==='1'?['hosted-preview.spec.ts','audio.browser.spec.ts']:'hosted-preview.spec.ts', timeout: 90_000,
  outputDir: (hosted ? 'test-output/netlify-preview-shadcn' : 'test-output/static-preview-shadcn')+(tag?`-${tag}`:''),
  use: { ...application.use, baseURL: hosted ?? 'http://127.0.0.1:5175' },
  webServer: hosted ? undefined : {
    command: `node node_modules/vite/bin/vite.js preview apps/web --outDir ${quotedOutput} --host 127.0.0.1 --port 5175 --strictPort`,
    url: 'http://127.0.0.1:5175', reuseExistingServer: false } });
