import { defineConfig } from '@playwright/test';
import application from './playwright.config.ts';
const hosted=process.env.KANTO_PREVIEW_URL;
export default defineConfig({...application,testMatch:'audio.browser.spec.ts',timeout:60000,
  reporter:[['list'],['json',{outputFile:hosted?'build/netlify-audio-results.json':'build/audio-ui-fixed-results.json'}]],
  outputDir:hosted?'test-output/netlify-audio':'test-output/browser-audio',use:{...application.use,baseURL:hosted??'http://127.0.0.1:5194'},
  webServer:hosted?undefined:{command:'KANTO_AUDIO_PREVIEW=1 node --experimental-strip-types scripts/preview-engine.ts 5194',
    url:'http://127.0.0.1:5194/engine-preview.html',reuseExistingServer:false}});
