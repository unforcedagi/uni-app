import { readFileSync } from "node:fs";
import { build, defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The app's CSP lives in tauri.conf.json (a frame-src that allows only srcdoc
// frames, so a sandboxed area app can't navigate itself). Serve the same policy
// from the dev and preview servers so they behave like the packaged app.
const csp = JSON.parse(readFileSync(new URL("./src-tauri/tauri.conf.json", import.meta.url), "utf8")).app?.security?.csp as Record<string, string> | string | null | undefined;
const cspHeader = typeof csp === "string" ? csp : csp ? Object.entries(csp).map(([k, v]) => `${k} ${v}`).join("; ") : null;
const headers = cspHeader ? { "Content-Security-Policy": cspHeader } : undefined;

// surface-client's VaultClient, bundled once to an IIFE string that the host
// injects into every sealed frame (src/interface/kits). Pure TS, no deps.
function vaultClientKit(): Plugin {
  const id = "virtual:uni-vault-client";
  return {
    name: "uni-vault-client-kit",
    resolveId: (source) => (source === id ? `\0${id}` : null),
    async load(resolved) {
      if (resolved !== `\0${id}`) return null;
      const out = await build({
        configFile: false, logLevel: "silent",
        build: { write: false, minify: true, lib: { entry: new URL("./src/interface/kits/vaultClientEntry.ts", import.meta.url).pathname, formats: ["iife"], name: "__UniVC" } },
      });
      const result = Array.isArray(out) ? out[0] : out;
      const code = "output" in result ? result.output[0].code : "";
      return `export default ${JSON.stringify(code)};`;
    },
  };
}

// T-76 only (UNI_T76=1): WebKitGTK's Tauri makes `window.__TAURI_INTERNALS__` read-only, so the real-webview harness cannot
// replace it with the Playwright fixture's mock. This build points @tauri-apps/* at `window.__T76_MOCK__` when it is set.
function t76Mock(): Plugin {
  return {
    name: "t76-tauri-mock",
    enforce: "pre",
    transform(code, id) {
      if (!/@tauri-apps[+/](api|plugin-[^/]+)/.test(id) || /mocks\.js/.test(id) || !code.includes("__TAURI")) return null;
      return code.replace(/window\.__TAURI_INTERNALS__/g, "(window.__T76_MOCK__ || window.__TAURI_INTERNALS__)").replace(/window\.__TAURI_EVENT_PLUGIN_INTERNALS__/g, "(window.__T76_MOCK_EVT__ || window.__TAURI_EVENT_PLUGIN_INTERNALS__)");
    },
  };
}

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), vaultClientKit(), ...(process.env.UNI_T76 === "1" ? [t76Mock()] : [])],
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
