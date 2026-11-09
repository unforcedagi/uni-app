import { defineConfig } from '@playwright/test';
const port = Number(process.env.COMPOSER_TEST_PORT ?? 1420);
/** An Android WebView's user agent (the app tells Android by it). */
const DAYLIGHT_UA = 'Mozilla/5.0 (Linux; Android 13; DC-1 Build/TP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Safari/537.36';
export default defineConfig({
  outputDir: 'test-results/composer',
  testDir: './scripts/browser',
  // Composer's suite (webkit greps four of its tests) and the specs no dedicated config runs; every other spec has its
  // own playwright.<name>.config.ts. A list, not an ignore list: a new spec joins here or gets its own config, and an
  // env-only spec (projectsLive, with PROJECTS_LIVE) can't break the listing.
  testMatch: /\/(attachments|composer|journalAreas|note-download|noteFormat|notePane|recPause|splitSheet|vault-links|videoFullscreen)\.spec\.ts$/,
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure', launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } },
  projects: [
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
    // T-200: the Daylight (Android, so the note opens as a sheet at any width), upright and on its side
    ...([['daylight-portrait', 1200, 1600], ['daylight-landscape', 1600, 1200]] as const).map(([name, width, height]) => ({ name, testMatch: /(notePane|videoFullscreen|splitSheet)\.spec\.ts/,
      use: { browserName: 'chromium' as const, viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: DAYLIGHT_UA } })),
  ],
  webServer: { command: `node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
