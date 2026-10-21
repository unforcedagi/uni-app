import { defineConfig, devices } from '@playwright/test';
// CAL_TEST_PORT: another worktree's preview may hold the default port
const port = Number(process.env.CAL_TEST_PORT || 1436);
// The Daylight is an Android tablet: its WebView's user agent says Android, which is what turns the Calendar's motion off.
const daylight = (width: number, height: number) => ({ browserName: 'chromium' as const, viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: devices['Galaxy Tab S4'].userAgent });
// T-229: the browser runs in Berlin, so a check that sees Denver times proves the Calendar shows the calendar's zone
export default defineConfig({
  outputDir: 'test-results/calendar',
  testDir: './scripts/browser', testMatch: /calendar\.spec\.ts$/, reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', timezoneId: 'Europe/Berlin' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'daylight-portrait', use: daylight(828, 1104) },
    { name: 'daylight-landscape', use: daylight(1104, 828) },
  ],
  webServer: { command: `node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
