import { defineConfig } from '@playwright/test';
// T-294: Uni's rooms and Messages each keep their last place (scripts/browser/roomRestore.spec.ts).
const port = Number(process.env.ROOMRESTORE_TEST_PORT ?? 5794);
export default defineConfig({
  outputDir: 'test-results/roomrestore',
  testDir: './scripts/browser', testMatch: /roomRestore\.spec\.ts/, reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce' },
  projects: [
    { name: 'daylight', use: { browserName: 'chromium', viewport: { width: 1600, height: 1200 }, isMobile: true, hasTouch: true } },
    { name: 'mac', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.ROOMRESTORE_REUSE },
});
