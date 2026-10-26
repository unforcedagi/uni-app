import { defineConfig } from '@playwright/test';
// T-301: the area-projects prototype build (VITE_T301_PROTO=1: the made-up world, no native side), at phone and desktop sizes.
const port = Number(process.env.PROJECTS_TEST_PORT ?? 1438);
// PROJECTS_BASE_URL: play the same flows against a running preview (the tailnet one) instead of a fresh local build.
const remote = process.env.PROJECTS_BASE_URL;
export default defineConfig({
  outputDir: 'test-results/projects',
  testDir: './scripts/browser', testMatch: /projects\.spec\.ts/, reporter: 'list',
  use: { baseURL: remote ?? `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1600, height: 1000 } } },
  ],
  webServer: remote ? undefined : { command: `VITE_T301_PROTO=1 node node_modules/vite/bin/vite.js build --outDir dist-t301 && node node_modules/vite/bin/vite.js preview --outDir dist-t301 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
