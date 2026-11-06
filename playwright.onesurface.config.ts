import { defineConfig, devices } from '@playwright/test';
// T-335 one surface: every way into a room opens it in focus over All, and the old room view (its tree of rooms beside the conversation) is gone.
// Phone, desktop and the Daylight in Calm screen (greyscale). Synthetic data only.
// ONE_TEST_PORT: another worktree's preview may hold the default.
const port = Number(process.env.ONE_TEST_PORT || 1493);
const daylight = { browserName: 'chromium' as const, viewport: { width: 828, height: 1104 }, isMobile: true, hasTouch: true, userAgent: devices['Galaxy Tab S4'].userAgent };
export default defineConfig({
  outputDir: 'test-results/onesurface',
  testDir: './scripts/browser', testMatch: /oneSurface\.spec\.ts$/, reporter: 'list', timeout: 60_000, expect: { timeout: 10_000 }, workers: 3,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'no-preference', screenshot: 'only-on-failure' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'daylight', use: daylight },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build --outDir dist-onesurface && node node_modules/vite/bin/vite.js preview --outDir dist-onesurface --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.ONE_REUSE, timeout: 300_000 },
});
