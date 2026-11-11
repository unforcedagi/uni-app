import { defineConfig } from '@playwright/test';
// T-335 cards expand: a card opens to its whole text and says what it asks; an ask's card that no longer waits says so and offers a repost.
// On the real build with Tauri faked (scripts/browser/shapeFixture.ts, `cards`: a made-up world only). CARDS_EXPAND_PORT: another worktree's
// preview may hold the default. Screenshots go to test-results/cards-expand-shots (never committed).
const port = Number(process.env.CARDS_EXPAND_PORT || 1497);
export default defineConfig({
  outputDir: 'test-results/cards-expand',
  testDir: './scripts/browser', testMatch: /cardsExpand\.spec\.ts$/, reporter: 'list', workers: 1, timeout: 90_000, expect: { timeout: 15_000 },
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', screenshot: 'only-on-failure' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 860 } } },
  ],
  webServer: { command: `${process.env.CARDS_EXPAND_PREBUILT ? '' : 'VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build --outDir dist-cards && '}node node_modules/vite/bin/vite.js preview --outDir dist-cards --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.CARDS_EXPAND_REUSE, timeout: 300_000 },
});
