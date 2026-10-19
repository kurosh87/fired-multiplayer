import {defineConfig} from '@playwright/test';
import application from './playwright.config.ts';
export default defineConfig({...application,testMatch:'battle-screen.browser.spec.ts',timeout:60000,outputDir:'test-output/battle-browser'});
