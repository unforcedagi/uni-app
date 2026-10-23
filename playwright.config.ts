import { defineConfig } from '@playwright/test';
const port = Number(process.env.COMPOSER_TEST_PORT ?? 1420);
/** An Android WebView's user agent (the app tells Android by it). */
const DAYLIGHT_UA = 'Mozilla/5.0 (Linux; Android 13; DC-1 Build/TP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/126.0.0.0 Safari/537.36';
export default defineConfig({
  outputDir: 'test-results/composer',
  testDir: './scripts/browser',
  testIgnore: ['vault-sidebar.spec.ts', 'rail.spec.ts', 'screens.spec.ts', 'areas.spec.ts', 'interface.spec.ts', 'areaRoom.spec.ts', 'lifeos.spec.ts', 'tasks.spec.ts', 'lifeosVault.spec.ts', 'secret.spec.ts', 'chatLive.spec.ts', 'chatCraft.spec.ts', 'sealedCards.spec.ts', 'sealedNeedsYou.spec.ts', 'publishedMedia.spec.ts'], // dedicated sidebar, rail, chat-craft, card and published-media configs
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure', launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } },
  projects: [
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
    // T-200: the Daylight (Android, so the note opens as a sheet at any width), upright and on its side
    ...([['daylight-portrait', 1200, 1600], ['daylight-landscape', 1600, 1200]] as const).map(([name, width, height]) => ({ name, testMatch: /(notePane|videoFullscreen)\.spec\.ts/,
      use: { browserName: 'chromium' as const, viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: DAYLIGHT_UA } })),
  ],
  webServer: { command: `node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
