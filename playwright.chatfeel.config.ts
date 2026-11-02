import { defineConfig, devices } from '@playwright/test';
// T-335 chat feel: the send moment, the answer under its question, message actions, reading, the New line, chips under a question and the
// All view's routed composer, at phone, Daylight and desktop sizes. Synthetic data only. Motion is on (it is part of what is checked);
// the Daylight is set to Calm screen, as the device is.
// CHATFEEL_TEST_PORT: another worktree's preview may hold the default.
const port = Number(process.env.CHATFEEL_TEST_PORT || 1471);
const daylight = { browserName: 'chromium' as const, viewport: { width: 828, height: 1104 }, isMobile: true, hasTouch: true, userAgent: devices['Galaxy Tab S4'].userAgent };
export default defineConfig({
  outputDir: 'test-results/chatfeel',
  testDir: './scripts/browser', testMatch: /chatfeel\.spec\.ts$/, reporter: 'list', timeout: 90_000, expect: { timeout: 10_000 },
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'no-preference', screenshot: 'only-on-failure' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'daylight', use: daylight },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build --outDir dist-chatfeel && node node_modules/vite/bin/vite.js preview --outDir dist-chatfeel --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.CHATFEEL_REUSE, timeout: 300_000 },
});
