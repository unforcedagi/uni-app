import { defineConfig } from '@playwright/test';
// T-335 live proof: the Mail view against a real mail bridge through scripts/browser/mail-live.spec.ts (skipped unless
// MAIL_LIVE_PROXY is set; the recipe is at the top of that spec). Never part of `pnpm test`.
const port = Number(process.env.MAIL_LIVE_PORT || 1436);
export default defineConfig({
  outputDir: 'test-results/maillive',
  testDir: './scripts/browser', testMatch: /mail-live\.spec\.ts$/, reporter: 'list', workers: 1, timeout: 120_000,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light' },
  projects: [{ name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } }],
  webServer: { command: `node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
