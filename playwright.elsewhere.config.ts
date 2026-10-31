import { defineConfig, devices } from '@playwright/test';
// T-335: an approval waiting in another room is said at the top of the room you are in and on that room in the rooms list; the update
// line sits at the top, never over the composer. A phone and the Daylight both ways (Android, like the real devices) and the desktop.
const port = Number(process.env.ELSEWHERE_TEST_PORT ?? 5781);
const android = devices['Galaxy Tab S4'].userAgent;
const phoneUa = devices['Pixel 7'].userAgent;
export default defineConfig({
  outputDir: 'test-results/elsewhere',
  testDir: './scripts/browser', testMatch: /(approvalElsewhere|updateNotice)\.spec\.ts/, reporter: 'list', workers: 1, retries: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, userAgent: phoneUa } },
    { name: 'daylight-landscape', use: { browserName: 'chromium', viewport: { width: 1104, height: 828 }, isMobile: true, hasTouch: true, userAgent: android } },
    { name: 'daylight-portrait', use: { browserName: 'chromium', viewport: { width: 828, height: 1104 }, isMobile: true, hasTouch: true, userAgent: android } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
  ],
  // ELSEWHERE_PREBUILT=1: serve the dist/ a `VITE_AREAS_TESTHOOKS=1 vite build` already made
  webServer: { command: `${process.env.ELSEWHERE_PREBUILT ? '' : 'VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build && '}node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.ELSEWHERE_REUSE, timeout: 300_000 },
});
