import { defineConfig } from '@playwright/test';
const sizes = [
  ['phone-390', 390, 844], ['pixel-7', 412, 915], ['phone-landscape', 844, 390],
  ['daylight-portrait', 828, 1104], ['daylight-landscape', 1104, 828],
  ['laptop', 1280, 800], ['desktop', 1920, 1080],
] as const;
export default defineConfig({
  testDir: './scripts/browser', testMatch: 'screens.spec.ts', outputDir: 'test-results/screens', reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:1434', colorScheme: 'light', reducedMotion: 'reduce' },
  projects: sizes.map(([name, width, height]) => ({ name, use: { browserName: 'chromium', viewport: { width, height }, hasTouch: width < 1200, isMobile: width < 600 } })),
  webServer: { command: 'node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port 1434 --strictPort', url: 'http://127.0.0.1:1434', reuseExistingServer: false },
});
