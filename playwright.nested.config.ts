import { defineConfig } from '@playwright/test';
const port = Number(process.env.NESTED_TEST_PORT ?? 5681);
export default defineConfig({
  outputDir: 'test-results/nested',
  testDir: './scripts/browser', testMatch: /nested\.spec\.ts/, reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } },
  projects: [
    { name: 'mac', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'mac-small', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.NESTED_REUSE },
});
