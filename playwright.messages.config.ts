import { defineConfig } from '@playwright/test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// T-278 Messages against a live homeserver (scripts/browser/messages.spec.ts says what it needs).
// MESSAGES_TEST_PORT / MESSAGES_BRIDGE_PORT: another worktree's preview may hold the defaults.
const port = Number(process.env.MESSAGES_TEST_PORT || 5788);
const bridgePort = Number(process.env.MESSAGES_BRIDGE_PORT || 5789);
// Set once in the main process; the workers inherit them, so the bridge and the pages share one token and folder.
process.env.MESSAGES_BRIDGE_TOKEN ||= randomBytes(24).toString('hex');
process.env.MESSAGES_BRIDGE_DIR ||= mkdtempSync(join(tmpdir(), 'uni-messages-bridge-'));
process.env.MESSAGES_BRIDGE_URL ||= `http://127.0.0.1:${bridgePort}`;
export default defineConfig({
  outputDir: 'test-results/messages',
  testDir: './scripts/browser', testMatch: /messages\.spec\.ts$/, reporter: 'list',
  timeout: 120_000,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 900 } } },
    { name: 'phone', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
  workers: 1,
  webServer: [
    // the Rust core behind the app's messages_* commands, served on 127.0.0.1 to this preview's origin only
    { command: `cargo run -q -p uni-messages --features dev-bridge --bin uni-messages-dev -- --port ${bridgePort} --dir ${process.env.MESSAGES_BRIDGE_DIR} --origin http://127.0.0.1:${port}`,
      url: `http://127.0.0.1:${bridgePort}/health`, reuseExistingServer: false, timeout: 900_000, env: { UNI_MESSAGES_DEV_TOKEN: process.env.MESSAGES_BRIDGE_TOKEN } },
    { command: `node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
  ],
});
