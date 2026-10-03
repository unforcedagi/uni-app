import { defineConfig } from '@playwright/test';

// Run on a Mac/WebKit host; Chromium on Linux cannot reproduce WebKit's null-relatedTarget blur.
export default defineConfig({
  outputDir: 'test-results/webkit',
  testDir: './scripts/browser',
  testMatch: 'composer.spec.ts',
  grep: /Mention touch|Attach opens|Keyboard menu|Edge press/,
  reporter: 'list',
  use: { baseURL: 'http://127.0.0.1:1431', trace: 'retain-on-failure' },
  projects: [{ name: 'webkit-desktop', use: { browserName: 'webkit', viewport: { width: 1280, height: 900 } } }],
  webServer: {
    command: 'node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port 1431 --strictPort',
    url: 'http://127.0.0.1:1431',
    reuseExistingServer: false,
  },
});
