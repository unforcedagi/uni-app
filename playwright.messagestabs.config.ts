import { defineConfig, devices } from '@playwright/test';
// T-310: Messages' tabs (All, then one per network) at a phone, the Daylight both ways and a desktop
// (scripts/browser/messagesTabs.spec.ts), and T-313's links, voice messages, pictures, files, replies and reactions
// (messagesRich.spec.ts). Messages' door is faked with made-up people; no homeserver.
const port = Number(process.env.MESSAGESTABS_TEST_PORT ?? 5797);
// the Daylight's WebView says Android, so Messages keeps still there, as on the device
const daylight = (width: number, height: number) => ({ browserName: 'chromium' as const, viewport: { width, height }, isMobile: true, hasTouch: true, userAgent: devices['Galaxy Tab S4'].userAgent });
export default defineConfig({
  outputDir: 'test-results/messagestabs',
  testDir: './scripts/browser', testMatch: /messages(Tabs|Rich)\.spec\.ts/, reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'daylight-landscape', use: daylight(1104, 828) },
    { name: 'daylight-portrait', use: daylight(828, 1104) },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
  ],
  webServer: { command: `node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.MESSAGESTABS_REUSE },
});
