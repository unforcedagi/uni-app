import { defineConfig, devices } from '@playwright/test';
// T-234: Settings → Approvals (enable sealed-credential approvals for Uni) at the desktop, a phone and the Daylight both ways.
const port = Number(process.env.APPROVALS_TEST_PORT ?? 5734);
const daylight = (width: number, height: number) => ({ browserName: 'chromium' as const, viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: devices['Galaxy Tab S4'].userAgent });
export default defineConfig({
  outputDir: 'test-results/approvals',
  testDir: './scripts/browser', testMatch: /approvals\.spec\.ts/, reporter: 'list', workers: 2,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'daylight-portrait', use: daylight(828, 1104) },
    { name: 'daylight-landscape', use: daylight(1104, 828) },
  ],
  webServer: { command: `node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.APPROVALS_REUSE },
});
