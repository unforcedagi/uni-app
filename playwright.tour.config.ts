import { defineConfig, devices } from '@playwright/test';
// The screen tour: every screen, sheet and panel on made-up data, screenshotted, with a computed-style audit beside each shot.
// Built to its own outDir. TOUR_TEST_PORT: another worktree's preview may hold the default. TOUR_REUSE=1 reuses a running server.
// Run: TOUR_TEST_PORT=17491 TOUR_SHOTS=/some/dir npx playwright test --config playwright.tour.config.ts
const port = Number(process.env.TOUR_TEST_PORT || 1471);
const daylight = { browserName: 'chromium' as const, viewport: { width: 828, height: 1104 }, isMobile: true, hasTouch: true, userAgent: devices['Galaxy Tab S4'].userAgent };
export default defineConfig({
  outputDir: 'test-results/tour-runs',
  testDir: './scripts/browser', testMatch: /tour\.spec\.ts$/, reporter: 'list', timeout: 60_000, expect: { timeout: 10_000 },
  workers: 3, retries: 0, fullyParallel: true,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', screenshot: 'off' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'daylight', use: daylight },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'night', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 }, colorScheme: 'dark' } },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build --outDir dist-tour && node node_modules/vite/bin/vite.js preview --outDir dist-tour --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.TOUR_REUSE, timeout: 300_000 },
});
