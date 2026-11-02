import { defineConfig, devices } from '@playwright/test';
// T-305 interface platform spike: the Garden interface bundle against a mocked shell. GARDEN_TEST_PORT: another worktree may hold the default
const port = Number(process.env.GARDEN_TEST_PORT || 1455);
export default defineConfig({
  outputDir: 'test-results/garden',
  testDir: './scripts/browser', testMatch: /garden\.spec\.ts$/, reporter: 'list', timeout: 60_000, expect: { timeout: 10_000 },
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'dark', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'daylight', use: { browserName: 'chromium', viewport: { width: 1104, height: 828 }, isMobile: true, hasTouch: true, userAgent: devices['Galaxy Tab S4'].userAgent } },
  ],
  webServer: { command: `node node_modules/vite/bin/vite.js build --config interfaces/garden/vite.config.ts && GARDEN_TEST_PORT=${port} node node_modules/vite/bin/vite.js preview --config interfaces/garden/vite.config.ts`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 120_000 },
});
