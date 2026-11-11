import { defineConfig } from '@playwright/test';
// T-335 the shape: home = rooms, a room with its strip, the journal, the applets drawer, search where you are, on the real build with
// Tauri faked (scripts/browser/shapeFixture.ts: made-up world only). Screenshots go to test-results/shape-shots (never committed).
// SHAPE_TEST_PORT: another worktree's preview may hold the default.
const port = Number(process.env.SHAPE_TEST_PORT || 1495);
export default defineConfig({
  outputDir: 'test-results/shape',
  testDir: './scripts/browser', testMatch: /shape\.spec\.ts$/, reporter: 'list', workers: 1, timeout: 90_000, expect: { timeout: 15_000 },
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', screenshot: 'only-on-failure' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build --outDir dist-shape && node node_modules/vite/bin/vite.js preview --outDir dist-shape --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.SHAPE_REUSE, timeout: 300_000 },
});
