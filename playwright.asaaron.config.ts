import { defineConfig } from '@playwright/test';
// T-335 as Aaron: one flow per papercut fixed in the walk through the whole app, at phone and desktop sizes. Made-up data only.
// ASAARON_TEST_PORT: another worktree's preview may hold the default.
const port = Number(process.env.ASAARON_TEST_PORT || 1475);
export default defineConfig({
  outputDir: 'test-results/asaaron',
  testDir: './scripts/browser', testMatch: /asAaron\.spec\.ts$/, reporter: 'list', timeout: 90_000, expect: { timeout: 15_000 },
  workers: 2, fullyParallel: true,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', screenshot: 'only-on-failure' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build --outDir dist-asaaron && node node_modules/vite/bin/vite.js preview --outDir dist-asaaron --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.ASAARON_REUSE, timeout: 300_000 },
});
