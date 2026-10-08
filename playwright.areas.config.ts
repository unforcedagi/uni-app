import { defineConfig } from '@playwright/test';
export default defineConfig({
  outputDir: 'test-results/areas',
  testDir: './scripts/browser', testMatch: /(areas|interface)\.spec\.ts/, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:1435', colorScheme: 'light', reducedMotion: 'reduce' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1600, height: 1200 } } },
  ],
  webServer: { command: 'VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port 1435 --strictPort', url: 'http://127.0.0.1:1435', reuseExistingServer: false },
});
