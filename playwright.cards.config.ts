import { defineConfig, devices } from '@playwright/test';
// T-234 milestone 2: Uni's approval card and morning card at the desktop, a phone and the Daylight landscape. One worker, one
// retry: the machine is busy (the brief's rule for suites).
const port = Number(process.env.CARDS_TEST_PORT ?? 5744);
export default defineConfig({
  outputDir: 'test-results/cards',
  testDir: './scripts/browser', testMatch: /sealed(Cards|NeedsYou)\.spec\.ts/, reporter: 'list', workers: 1, retries: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'daylight-landscape', use: { browserName: 'chromium', viewport: { width: 1104, height: 828 }, isMobile: true, hasTouch: true, userAgent: devices['Galaxy Tab S4'].userAgent } },
  ],
  // CARDS_PREBUILT=1: serve the dist/ a `VITE_AREAS_TESTHOOKS=1 vite build` already made (Needs you uses the areas fixture's hooks)
  webServer: { command: `${process.env.CARDS_PREBUILT ? '' : 'VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build && '}node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.CARDS_REUSE, timeout: 300_000 },
});
