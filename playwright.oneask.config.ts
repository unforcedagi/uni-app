import { defineConfig } from '@playwright/test';
// T-335 one ask, step 2: one card per ask across a room, home and the bar; a "tap the card" task shows once; a reply posts flat and ends
// its ask; Seen ends it for good; a lapsed ask leaves at its time with no sweep. On the real build with Tauri faked (scripts/browser/
// shapeFixture.ts with real signed room asks: a made-up world only). ONEASK_TEST_PORT: another worktree's preview may hold the default.
// Screenshots go to test-results/oneask-shots (never committed).
const port = Number(process.env.ONEASK_TEST_PORT || 1499);
export default defineConfig({
  outputDir: 'test-results/oneask',
  testDir: './scripts/browser', testMatch: /oneAsk\.spec\.ts$/, reporter: 'list', workers: 1, timeout: 90_000, expect: { timeout: 15_000 },
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', screenshot: 'only-on-failure' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
  webServer: { command: `${process.env.ONEASK_PREBUILT ? '' : 'VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build --outDir dist-oneask && '}node node_modules/vite/bin/vite.js preview --outDir dist-oneask --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.ONEASK_REUSE, timeout: 300_000 },
});
