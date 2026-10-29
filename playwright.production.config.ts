import { defineConfig } from '@playwright/test';

if (!process.env.SMOKE_BASE_URL) throw new Error('SMOKE_BASE_URL is required; use npm run test:production');

export default defineConfig({
  testDir: './tests/production',
  testMatch: ['smoke.spec.ts', 'real-api.spec.ts'],
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.SMOKE_BASE_URL,
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
    ignoreHTTPSErrors: true,
  },
});
