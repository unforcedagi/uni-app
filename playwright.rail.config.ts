import { defineConfig } from '@playwright/test';
export default defineConfig({
  outputDir: 'test-results/rail',
  testDir: './scripts/browser', testMatch: 'rail.spec.ts', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:1433', colorScheme: 'light' },
  projects: [
    { name: 'portrait', use: { browserName: 'chromium', viewport: { width: 816, height: 1092 } } },
    { name: 'landscape', use: { browserName: 'chromium', viewport: { width: 1092, height: 816 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: 'node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port 1433 --strictPort', url: 'http://127.0.0.1:1433', reuseExistingServer: false },
});
