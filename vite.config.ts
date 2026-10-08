import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The app's CSP lives in tauri.conf.json (a frame-src that allows only srcdoc
// frames, so a sandboxed area app can't navigate itself). Serve the same policy
// from the dev and preview servers so they behave like the packaged app.
const csp = JSON.parse(readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8")).app?.security?.csp as Record<string, string> | string | null | undefined;
const cspHeader = typeof csp === "string" ? csp : csp ? Object.entries(csp).map(([k, v]) => `${k} ${v}`).join("; ") : null;
const headers = cspHeader ? { "Content-Security-Policy": cspHeader } : undefined;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: "127.0.0.1",
    headers,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
  preview: { headers },
}));
