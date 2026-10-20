import { defineConfig } from '@playwright/test';
const port = Number(process.env.COMPOSER_TEST_PORT ?? 1420);
export default defineConfig({
  outputDir: 'test-results/composer',
  testDir: './scripts/browser',
  testIgnore: ['vault-sidebar.spec.ts', 'rail.spec.ts', 'screens.spec.ts', 'areas.spec.ts', 'interface.spec.ts', 'areaRoom.spec.ts', 'lifeos.spec.ts', 'tasks.spec.ts', 'lifeosVault.spec.ts', 'secret.spec.ts', 't200.spec.ts'], // dedicated sidebar and rail configs
  reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'retain-on-failure', launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] } },
  projects: [
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
  ],
  webServer: { command: `node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
