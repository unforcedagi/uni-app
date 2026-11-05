import { defineConfig, devices } from '@playwright/test';
// T-335 All v2: inline reply from All, All reachable from everywhere and back, Haiku's route with the word-match fallback. Synthetic data only.
// ALLV2_TEST_PORT: another worktree's preview may hold the default.
const port = Number(process.env.ALLV2_TEST_PORT || 1481);
const daylight = { browserName: 'chromium' as const, viewport: { width: 828, height: 1104 }, isMobile: true, hasTouch: true, userAgent: devices['Galaxy Tab S4'].userAgent };
export default defineConfig({
  outputDir: 'test-results/allv2',
  testDir: './scripts/browser', testMatch: /allv2\.spec\.ts$/, reporter: 'list', timeout: 60_000, expect: { timeout: 10_000 }, workers: 3,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', screenshot: 'only-on-failure' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'daylight', use: daylight },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build --outDir dist-allv2 && node node_modules/vite/bin/vite.js preview --outDir dist-allv2 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.ALLV2_REUSE, timeout: 300_000 },
});
