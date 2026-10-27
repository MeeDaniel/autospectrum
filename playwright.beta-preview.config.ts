import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/production',
  testMatch: 'beta-booking.spec.ts',
  workers: 1,
  outputDir: join(tmpdir(), 'autospectrum-beta-preview-results'),
  use: {
    baseURL: 'http://127.0.0.1:4187',
    browserName: 'chromium',
    channel: 'chrome',
    headless: true,
  },
  webServer: {
    command: 'npm run build && node node_modules/vite/bin/vite.js preview --configLoader runner --host 127.0.0.1 --port 4187 --strictPort',
    url: 'http://127.0.0.1:4187',
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
