import { defineConfig } from '@playwright/test';
export default defineConfig({
  outputDir: 'test-results/composer',
  testDir: './scripts/browser',
  testIgnore: ['vault-sidebar.spec.ts', 'rail.spec.ts', 'screens.spec.ts'], // dedicated sidebar and rail configs
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:1420', trace: 'retain-on-failure', launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } },
  projects: [
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
  ],
  webServer: { command: 'node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port 1420 --strictPort', url: 'http://127.0.0.1:1420', reuseExistingServer: false },
});
