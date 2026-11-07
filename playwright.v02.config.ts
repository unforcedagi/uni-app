import { defineConfig, devices } from '@playwright/test';
// T-335 Uni 0.2: one home, fewer controls, nothing cramped at 360 px, every word readable in greyscale. Synthetic data only.
// V02_TEST_PORT: another worktree's preview may hold the default. V02_REUSE=1 reuses a running preview (V02_DIST: which build it serves).
const port = Number(process.env.V02_TEST_PORT || 17611);
const daylight = { browserName: 'chromium' as const, viewport: { width: 828, height: 1104 }, isMobile: true, hasTouch: true, userAgent: devices['Galaxy Tab S4'].userAgent };
const dist = process.env.V02_DIST || 'dist-v02';
export default defineConfig({
  outputDir: 'test-results/v02',
  testDir: './scripts/browser', testMatch: /v02\.spec\.ts$/, reporter: 'list', timeout: 60_000, expect: { timeout: 10_000 }, workers: 3, fullyParallel: true,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', screenshot: 'only-on-failure' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'daylight', use: daylight },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build --outDir ${dist} && node node_modules/vite/bin/vite.js preview --outDir ${dist} --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.V02_REUSE, timeout: 300_000 },
});
