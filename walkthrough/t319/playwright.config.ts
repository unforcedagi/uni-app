import { defineConfig, devices } from '@playwright/test';
// T-319 walkthrough: the web build at the Daylight's size with the projects fixture's made-up world, filmed (video + scene marks).
// Run from the repo root: npx playwright test --config walkthrough/t304/playwright.config.ts, then narrate.py (~/studio/.venv/bin/python).
const port = Number(process.env.T319_WALK_PORT ?? 5819);
export default defineConfig({
  outputDir: 'runs', testDir: '.', testMatch: /walk\.spec\.ts/, reporter: 'list', timeout: 240_000,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', viewport: { width: 1104, height: 828 }, isMobile: true, hasTouch: true,
    userAgent: devices['Galaxy Tab S4'].userAgent, video: { mode: 'on', size: { width: 1104, height: 828 } } },
  projects: [{ name: 'daylight', use: { browserName: 'chromium' } }],
  webServer: { command: `node node_modules/vite/bin/vite.js build --outDir dist-walk319 && node node_modules/vite/bin/vite.js preview --outDir dist-walk319 --port ${port} --strictPort`, cwd: '../..', url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
