// Opens a scratch Life OS vault in the browser build (SV_ENV = the scratch server's env.json). See scripts/browser/lifeosAnyVault.ts.
import { defineConfig } from '@playwright/test';
const port = Number(process.env.LIFEOS_VAULT_TEST_PORT ?? 1465);
export default defineConfig({
  outputDir: 'test-results/lifeos-vault',
  testDir: './scripts/browser', testMatch: /lifeosVault\.spec\.ts/, reporter: 'list', workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1600, height: 1200 } } },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build --outDir dist-lifeos-vault && node node_modules/vite/bin/vite.js preview --outDir dist-lifeos-vault --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
