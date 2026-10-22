import { defineConfig, devices } from '@playwright/test';
// T-132: the chat's live feel (Uni is working, jump to latest) and its craft (code blocks, saved drafts) at the three sizes. CHAT_TEST_PORT: another worktree's preview may hold the default
const port = Number(process.env.CHAT_TEST_PORT || 1437);
export default defineConfig({
  outputDir: 'test-results/chat',
  testDir: './scripts/browser', testMatch: /(chatLive|chatCraft)\.spec\.ts$/, reporter: 'list', timeout: 90_000, expect: { timeout: 15_000 },
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', screenshot: 'only-on-failure' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    // the Daylight is an Android tablet, on its side
    { name: 'daylight', use: { browserName: 'chromium', viewport: { width: 1104, height: 828 }, isMobile: true, hasTouch: true, userAgent: devices['Galaxy Tab S4'].userAgent } },
  ],
  webServer: { command: `node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 300_000 },
});
