import { defineConfig } from '@playwright/test';
// T-200: the note-beside-chat prototypes, on the fixture build (invented rooms and notes, no relay, no vault).
const port = Number(process.env.T200_TEST_PORT ?? 5720);
export default defineConfig({
  outputDir: 'test-results/t200',
  testDir: './scripts/browser', testMatch: /t200\.spec\.ts/, reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 860 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  webServer: { command: `VITE_T200_FIXTURE=1 node node_modules/vite/bin/vite.js build --outDir dist-t200 && node node_modules/vite/bin/vite.js preview --outDir dist-t200 --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.T200_REUSE },
});
