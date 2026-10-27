import { defineConfig } from '@playwright/test';
import { randomBytes } from 'node:crypto';
// T-313 walkthrough: the web build at a phone's size, its Messages door the dev bridge (the real Rust core) signed in to the
// throwaway homeserver walk.sh started, voice messages transcribed by its local whisper stand-in. Filmed to the narration's
// timing (runs/vo/timeline.json). Run through walk.sh film.
const port = Number(process.env.T313_WALK_PORT ?? 5821);
const bridgePort = Number(process.env.T313_BRIDGE_PORT ?? 5822);
process.env.MESSAGES_BRIDGE_TOKEN ||= randomBytes(24).toString('hex');
process.env.MESSAGES_BRIDGE_URL ||= `http://127.0.0.1:${bridgePort}`;
const dir = `${process.env.T313_DIR}/bridge-${Date.now()}`;
export default defineConfig({
  outputDir: 'runs/film', testDir: '.', testMatch: /walk\.spec\.ts/, reporter: 'list', timeout: 300_000, workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}`, colorScheme: 'light', viewport: { width: 412, height: 892 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    video: { mode: 'on', size: { width: 824, height: 1784 } } },
  projects: [{ name: 'phone', use: { browserName: 'chromium' } }],
  webServer: [
    { command: `cargo run -q -p uni-messages --features dev-bridge --bin uni-messages-dev -- --port ${bridgePort} --dir ${dir} --origin http://127.0.0.1:${port} --transcribe-url ${process.env.T313_WHISPER}`,
      cwd: '../..', url: `http://127.0.0.1:${bridgePort}/health`, reuseExistingServer: false, timeout: 900_000, env: { UNI_MESSAGES_DEV_TOKEN: process.env.MESSAGES_BRIDGE_TOKEN! } },
    { command: `node node_modules/vite/bin/vite.js build && node node_modules/vite/bin/vite.js preview --port ${port} --strictPort`, cwd: '../..', url: `http://127.0.0.1:${port}`, reuseExistingServer: false },
  ],
});
