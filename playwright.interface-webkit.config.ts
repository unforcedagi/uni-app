import { defineConfig } from '@playwright/test';
export default defineConfig({
  outputDir: 'test-results/interface-webkit',
  testDir: './scripts/browser', testMatch: /(areas|interface|areaRoom)\.spec\.ts/, reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:1437', colorScheme: 'light', reducedMotion: 'reduce' },
  projects: [{ name: 'desktop-webkit', use: { browserName: 'webkit', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', viewport: { width: 1600, height: 1200 } } }],
  webServer: { command: 'VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port 1437 --strictPort', url: 'http://127.0.0.1:1437', reuseExistingServer: false },
});
