import { defineConfig, devices } from '@playwright/test';
// T-335 one fluid surface: long messages read in place in All; a room in focus inside All, the rest receded, and one tap back. Synthetic data only.
// Motion is on (it is part of what is checked); the Daylight is set to Calm screen, as the device is.
// FLUID_TEST_PORT: another worktree's preview may hold the default.
const port = Number(process.env.FLUID_TEST_PORT || 1491);
const daylight = { browserName: 'chromium' as const, viewport: { width: 828, height: 1104 }, isMobile: true, hasTouch: true, userAgent: devices['Galaxy Tab S4'].userAgent };
export default defineConfig({
  outputDir: 'test-results/fluid',
  testDir: './scripts/browser', testMatch: /fluid\.spec\.ts$/, reporter: 'list', timeout: 60_000, expect: { timeout: 10_000 }, workers: 3,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'no-preference', screenshot: 'only-on-failure' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'daylight', use: daylight },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build --outDir dist-fluid && node node_modules/vite/bin/vite.js preview --outDir dist-fluid --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.FLUID_REUSE, timeout: 300_000 },
});
