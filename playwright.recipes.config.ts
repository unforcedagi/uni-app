import { defineConfig } from '@playwright/test';
// T-335 the Recipes applet end to end: the real applet folder (RECIPES_APPLET_DIR, default ../uni-ops/applets/recipes beside this
// checkout) in a made-up `recipes` vault, through the drawer, the grant card and the frame's writes (scripts/browser/recipesApplet.spec.ts).
const port = Number(process.env.RECIPES_TEST_PORT || 1437);
export default defineConfig({
  outputDir: 'test-results/recipes',
  testDir: './scripts/browser', testMatch: /recipesApplet\.spec\.ts$/, reporter: 'list', timeout: 90_000, expect: { timeout: 15_000 },
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', screenshot: 'only-on-failure' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1600, height: 1200 } } },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build --outDir dist-recipes && node node_modules/vite/bin/vite.js preview --outDir dist-recipes --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.RECIPES_REUSE, timeout: 300_000 },
});
