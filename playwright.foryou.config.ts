import { defineConfig, devices } from '@playwright/test';
// 0.3.0 For you: the top of the home (Yours, Ready to look at, Moving), one tap applies an ask's default, the answer posts in its room under
// the card's post. Synthetic data only. FORYOU_TEST_PORT: another worktree's preview may hold the default. FORYOU_REUSE=1 reuses a running preview.
const port = Number(process.env.FORYOU_TEST_PORT || 17631);
const daylight = { browserName: 'chromium' as const, viewport: { width: 828, height: 1104 }, isMobile: true, hasTouch: true, userAgent: devices['Galaxy Tab S4'].userAgent };
const dist = process.env.FORYOU_DIST || 'dist-foryou';
export default defineConfig({
  outputDir: 'test-results/foryou',
  testDir: './scripts/browser', testMatch: /forYou\.spec\.ts$/, reporter: 'list', timeout: 60_000, expect: { timeout: 10_000 }, workers: 3, fullyParallel: true,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', screenshot: 'only-on-failure',
    launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'daylight', use: daylight },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build --outDir ${dist} && node node_modules/vite/bin/vite.js preview --outDir ${dist} --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.FORYOU_REUSE, timeout: 300_000 },
});
