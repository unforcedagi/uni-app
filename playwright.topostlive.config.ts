import { defineConfig } from '@playwright/test';
// T-335 live: the To post queue against a scratch hub, the loopback Bluesky server and uni-post. Run by uni-ops
// post/e2e.py (it builds with the test hooks, starts the servers and sets T335_BRIDGE); skipped without it.
const port = Number(process.env.TOPOST_TEST_PORT ?? 5836);
export default defineConfig({
  outputDir: 'test-results/topostlive',
  testDir: './scripts/browser', testMatch: /toPostLive\.spec\.ts/, reporter: 'list', workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', viewport: { width: 1280, height: 800 }, browserName: 'chromium' },
  webServer: { command: `${process.env.TOPOST_PREBUILT ? '' : 'VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build && '}node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 300_000 },
});
