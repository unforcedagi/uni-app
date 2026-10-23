import { defineConfig, devices } from '@playwright/test';
// T-260: published media inside a note, a decision card and its sheet, at two phones, the Daylight both ways and the desktop.
// The media is synthetic (made by ffmpeg in the spec) and served on a made-up publish origin by page.route; it plays for real.
const port = Number(process.env.MEDIA_TEST_PORT ?? 5767);
const touch = (width: number, height: number, ua?: string) => ({ browserName: 'chromium' as const, viewport: { width, height }, isMobile: true, hasTouch: true, ...(ua ? { userAgent: ua } : {}) });
export default defineConfig({
  outputDir: 'test-results/media',
  testDir: './scripts/browser', testMatch: /publishedMedia\.spec\.ts/, reporter: 'list', retries: 1,
  // one worker: with more, on a loaded machine short of memory, headless Chromium's renderer crashed mid-playback ("Target
  // crashed"), never an assertion; one worker ran every size clean (about 1.5 minutes)
  workers: 1,
  // a test plays media without a tap (the player itself never autoplays: the spec asserts it)
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce', launchOptions: { args: ['--autoplay-policy=no-user-gesture-required'] } },
  projects: [
    { name: 'phone-390', use: touch(390, 844) },
    { name: 'phone-412', use: touch(412, 915) },
    { name: 'daylight-portrait', use: touch(1200, 1600, devices['Galaxy Tab S4'].userAgent) },
    { name: 'daylight-landscape', use: touch(1600, 1200, devices['Galaxy Tab S4'].userAgent) },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
  ],
  // MEDIA_PREBUILT=1: serve a dist/ that `VITE_AREAS_TESTHOOKS=1 vite build` already made
  webServer: { command: `${process.env.MEDIA_PREBUILT ? '' : 'VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build && '}node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.MEDIA_REUSE, timeout: 300_000 },
});
