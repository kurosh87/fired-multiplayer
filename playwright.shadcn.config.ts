import { defineConfig } from '@playwright/test';
import application from './playwright.config.ts';
export default defineConfig({ ...application, outputDir: 'test-output/shadcn-application' });
