import { defineConfig } from '@playwright/test';
const port = Number(process.env.UNREAD_TEST_PORT ?? 5763);
export default defineConfig({
  outputDir: 'test-results/unread',
  testDir: './scripts/browser', testMatch: /unread\.spec\.ts/, reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1600, height: 1200 } } },
    { name: 'portrait', use: { browserName: 'chromium', viewport: { width: 1200, height: 1600 } } },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.UNREAD_REUSE, timeout: 300_000 },
});
