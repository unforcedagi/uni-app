import { defineConfig, devices } from '@playwright/test';
// T-161: a Hermes approval prompt in Needs you and its room, at the desktop, a phone and the Daylight both ways (an Android tablet: its user agent says Android).
const port = Number(process.env.PROMPTS_TEST_PORT ?? 5741);
const daylight = (width: number, height: number) => ({ browserName: 'chromium' as const, viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: devices['Galaxy Tab S4'].userAgent });
export default defineConfig({
  outputDir: 'test-results/prompts',
  testDir: './scripts/browser', testMatch: /approvalPrompts\.spec\.ts/, reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'daylight-portrait', use: daylight(828, 1104) },
    { name: 'daylight-landscape', use: daylight(1104, 828) },
  ],
  // PROMPTS_PREBUILT=1: serve the dist/ a `VITE_AREAS_TESTHOOKS=1 vite build` already made (a busy machine builds slowly)
  webServer: { command: `${process.env.PROMPTS_PREBUILT ? '' : 'VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build && '}node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.PROMPTS_REUSE, timeout: 300_000 },
});
