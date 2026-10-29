import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'dirty-navigation.spec.ts',
  use: {
    baseURL: 'http://127.0.0.1:4185',
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
  },
});
