import { defineConfig } from '@playwright/test';
// T-335: a note's content never makes the webview fetch anything (scripts/browser/noRemote.spec.ts). Served by vite preview with the
// app's CSP from tauri.conf.json, as the packaged app is. NOREMOTE_TEST_PORT: another worktree's preview may hold the default.
const port = Number(process.env.NOREMOTE_TEST_PORT || 1449);
export default defineConfig({
  outputDir: 'test-results/noremote',
  testDir: './scripts/browser', testMatch: /noRemote\.spec\.ts$/, reporter: 'list',
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', reducedMotion: 'reduce' },
  projects: [
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1280, height: 900 } } },
  ],
  webServer: { command: `node node_modules/vite/bin/vite.js build --outDir dist-noremote && node node_modules/vite/bin/vite.js preview --outDir dist-noremote --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: !!process.env.NOREMOTE_REUSE, timeout: 300_000 },
});
