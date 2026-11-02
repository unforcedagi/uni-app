import { defineConfig, devices } from '@playwright/test';
// T-335 glow-up: the new look on home, a room and find, and the All view, at phone, Daylight and desktop sizes. Synthetic data only.
// GLOWUP_TEST_PORT: another worktree's preview may hold the default.
const port = Number(process.env.GLOWUP_TEST_PORT || 1461);
const daylight = { browserName: 'chromium' as const, viewport: { width: 828, height: 1104 }, isMobile: true, hasTouch: true, userAgent: devices['Galaxy Tab S4'].userAgent };
export default defineConfig({
  outputDir: 'test-results/glowup',
  testDir: './scripts/browser', testMatch: /glowup\.spec\.ts$/, reporter: 'list', timeout: 90_000, expect: { timeout: 15_000 },
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', screenshot: 'only-on-failure' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'daylight', use: daylight },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build --outDir dist-glowup && node node_modules/vite/bin/vite.js preview --outDir dist-glowup --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.GLOWUP_REUSE, timeout: 300_000 },
});
