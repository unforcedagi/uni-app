import { defineConfig } from '@playwright/test';
// T-335 the Taste Arcade (Rust faked). T335_SHOTS=<dir> writes screenshots.
const port = Number(process.env.ARCADE_TEST_PORT ?? 5843);
export default defineConfig({
  outputDir: 'test-results/arcade',
  testDir: './scripts/browser', testMatch: /arcade\.spec\.ts/, reporter: 'list', workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  // the areas fixture needs the test hooks build; ARCADE_PREBUILT=1 serves a dist/ already built that way
  webServer: { command: `${process.env.ARCADE_PREBUILT ? '' : 'VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build && '}node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 300_000 },
});
