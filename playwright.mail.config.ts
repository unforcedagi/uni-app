import { defineConfig } from '@playwright/test';
export default defineConfig({
  outputDir: 'test-results/mail',
  testDir: './scripts/browser', testMatch: 'mail.spec.ts', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:1434', colorScheme: 'light' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 860 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: 'node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port 1434 --strictPort', url: 'http://127.0.0.1:1434', reuseExistingServer: false },
});
