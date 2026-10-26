import { defineConfig, devices } from '@playwright/test';
// T-295: the Claude accounts card in Settings. USAGE_TEST_PORT: another worktree's preview may hold the default port.
const port = Number(process.env.USAGE_TEST_PORT || 1437);
const daylight = { browserName: 'chromium' as const, viewport: { width: 828, height: 1104 }, isMobile: true, hasTouch: true, userAgent: devices['Galaxy Tab S4'].userAgent };
export default defineConfig({
  outputDir: 'test-results/usage',
  testDir: './scripts/browser', testMatch: /usage\.spec\.ts$/, reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', timezoneId: 'America/Denver' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'daylight', use: daylight },
  ],
  webServer: { command: `node node_modules/vite/bin/vite.js build --outDir dist-usage && node node_modules/vite/bin/vite.js preview --outDir dist-usage --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
