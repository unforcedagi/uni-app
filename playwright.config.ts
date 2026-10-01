import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './scripts/browser', testMatch: 'vault-sidebar.spec.ts', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:1432' },
  projects: [
    { name: 'phone-390', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
  ],
  webServer: { command: 'node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port 1432 --strictPort', url: 'http://127.0.0.1:1432', reuseExistingServer: false },
});
