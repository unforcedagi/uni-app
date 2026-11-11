import { defineConfig } from '@playwright/test';
// The sealed applet specs on WebKit (the engine of the Linux and macOS webviews): the sandbox, CSP and frame checks must hold there too.
const port = Number(process.env.APPLETS_WEBKIT_PORT || 1437);
export default defineConfig({
  outputDir: 'test-results/applets-webkit',
  testDir: './scripts/browser', testMatch: /sealedApplet\.spec\.ts$/, reporter: 'list', timeout: 90_000, expect: { timeout: 15_000 },
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce' },
  projects: [{ name: 'desktop-webkit', use: { browserName: 'webkit', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', viewport: { width: 1600, height: 1200 } } }],
  webServer: { command: `VITE_AREAS_TESTHOOKS=1 node node_modules/vite/bin/vite.js build --outDir dist-applets-webkit && node node_modules/vite/bin/vite.js preview --outDir dist-applets-webkit --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.APPLETS_REUSE, timeout: 300_000 },
});
