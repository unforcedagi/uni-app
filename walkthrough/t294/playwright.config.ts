import { defineConfig } from '@playwright/test';
// T-294 walkthrough: the web build at the Daylight's size with the areas fixture's made-up rooms, filmed (video + scene marks).
// Run from the repo root: npx playwright test --config walkthrough/t294/playwright.config.ts, then narrate.py.
const port = Number(process.env.T294_WALK_PORT ?? 5795);
export default defineConfig({
  outputDir: 'runs', testDir: '.', testMatch: /walk\.spec\.ts/, reporter: 'list', timeout: 180_000,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', viewport: { width: 1600, height: 1200 }, video: { mode: 'on', size: { width: 1600, height: 1200 } } },
  projects: [{ name: 'daylight', use: { browserName: 'chromium' } }],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, cwd: '../..', url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
