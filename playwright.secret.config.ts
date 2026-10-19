import { defineConfig } from '@playwright/test';
// T-176 secret-request card. T176_SHOTS=1 writes the walkthrough screenshots (desktop project).
const port = Number(process.env.SECRET_TEST_PORT ?? 5776);
export default defineConfig({
  outputDir: 'test-results/secret',
  testDir: './scripts/browser', testMatch: /secret\.spec\.ts/, reporter: 'list', workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 800 } } },
    ...(process.env.T176_SHOTS ? [] : [{ name: 'phone', use: { browserName: 'chromium' as const, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } }]),
  ],
  webServer: { command: `node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
});
