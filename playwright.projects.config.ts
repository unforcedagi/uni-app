import { defineConfig } from '@playwright/test';
// T-301/T-302: the areas, projects and sessions flows on the real web build, with the native side played by projectsFixture.ts,
// at phone and desktop sizes. PROJECTS_LIVE=<json> plays projectsLive.spec.ts on a read of the real vault instead (outside the repo).
const port = Number(process.env.PROJECTS_TEST_PORT ?? 1438);
export default defineConfig({
  outputDir: 'test-results/projects',
  testDir: './scripts/browser', testMatch: process.env.PROJECTS_LIVE ? /projectsLive\.spec\.ts/ : /projects(Review)?\.spec\.ts/, reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1600, height: 1000 } } },
  ],
  webServer: { command: `node node_modules/vite/bin/vite.js build --outDir dist-projects && node node_modules/vite/bin/vite.js preview --outDir dist-projects --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
