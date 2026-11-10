import { defineConfig } from '@playwright/test';
// T-335 runs visible: a room at work and a room waiting on you, in the room list and the room's head, and the run's note opened from each.
// Synthetic data only (areasFixture's `runs`). RUNSVISIBLE_TEST_PORT: another worktree's preview may hold the default.
const port = Number(process.env.RUNSVISIBLE_TEST_PORT || 1471);
export default defineConfig({
  outputDir: 'test-results/runsvisible',
  testDir: './scripts/browser', testMatch: /runsVisible\.spec\.ts$/, reporter: 'list', timeout: 90_000, expect: { timeout: 15_000 },
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', screenshot: 'only-on-failure' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build --outDir dist-runsvisible && node node_modules/vite/bin/vite.js preview --outDir dist-runsvisible --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.RUNSVISIBLE_REUSE, timeout: 300_000 },
});
