import { defineConfig } from '@playwright/test';
// T-335 sealed applets in the drawer (once the area apps): the interface contract end to end on the new shell, Tauri faked
// (scripts/browser/sealedAppletFixture.ts on shapeFixture.ts: made-up world only). APPLETS_TEST_PORT: another worktree's preview may hold the default.
const port = Number(process.env.APPLETS_TEST_PORT || 1435);
export default defineConfig({
  outputDir: 'test-results/applets',
  testDir: './scripts/browser', testMatch: /sealedApplet\.spec\.ts$/, reporter: 'list', timeout: 90_000, expect: { timeout: 15_000 },
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', screenshot: 'only-on-failure' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1600, height: 1200 } } },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build --outDir dist-applets && node node_modules/vite/bin/vite.js preview --outDir dist-applets --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.APPLETS_REUSE, timeout: 300_000 },
});
