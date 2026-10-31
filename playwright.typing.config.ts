import { defineConfig, devices } from '@playwright/test';
// T-335: keystroke-to-paint in the composer with a long history, at phone and Daylight sizes, the CPU slowed 4x. Built unminified (still
// React's production build) into its own folder, so the spec can name the components a key redraws.
const port = Number(process.env.TYPING_TEST_PORT ?? 5771);
const daylight = (width: number, height: number) => ({ browserName: 'chromium' as const, viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: devices['Galaxy Tab S4'].userAgent });
export default defineConfig({
  outputDir: 'test-results/typing',
  testDir: './scripts/browser', testMatch: /typing\.spec\.ts/, reporter: 'list', timeout: 300_000, workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'daylight-portrait', use: daylight(828, 1104) },
  ],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build --minify false --outDir dist-typing && node node_modules/vite/bin/vite.js preview --outDir dist-typing --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.TYPING_REUSE, timeout: 300_000 },
});
