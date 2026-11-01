import { defineConfig, devices } from '@playwright/test';
// T-335 motion: the Mac, the Pixel (an Android phone that keeps its motion) and the Daylight (an Android tablet, calm by its switch).
// MOTION_TEST_PORT: another worktree's preview may hold the default.
const port = Number(process.env.MOTION_TEST_PORT || 1447);
export default defineConfig({
  outputDir: 'test-results/motion',
  testDir: './scripts/browser', testMatch: /motion\.spec\.ts$/, reporter: 'list', timeout: 90_000, expect: { timeout: 15_000 },
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'pixel', use: { browserName: 'chromium', viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, userAgent: devices['Pixel 7'].userAgent } },
    { name: 'daylight', use: { browserName: 'chromium', viewport: { width: 828, height: 1104 }, isMobile: true, hasTouch: true, userAgent: devices['Galaxy Tab S4'].userAgent } },
  ],
  webServer: { command: `node node_modules/vite/bin/vite.js build --outDir dist-motion && node node_modules/vite/bin/vite.js preview --outDir dist-motion --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.MOTION_REUSE, timeout: 300_000 },
});
