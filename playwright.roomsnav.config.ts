import { defineConfig } from '@playwright/test';
const port = Number(process.env.ROOMSNAV_TEST_PORT ?? 5632);
export default defineConfig({
  outputDir: 'test-results/roomsnav',
  testDir: './scripts/browser', testMatch: /roomsnav\.spec\.ts/, reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1600, height: 1200 } } },
    { name: 'portrait', use: { browserName: 'chromium', viewport: { width: 1200, height: 1600 } } },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.ROOMSNAV_REUSE },
});
