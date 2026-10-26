import { defineConfig, mergeConfig, type UserConfig } from "vite";
import base from "./vite.config";

// T-301: the prototype's tailnet preview (uni-proto-t301). The server listens on 127.0.0.1 and is reached through `tailscale serve`, which
// forwards the tailnet host name: that one name (UNI_PREVIEW_HOST, set by the unit, never in this public repo) is let through as well.
// Everything else is the app's own config, the CSP included.
const host = process.env.UNI_PREVIEW_HOST?.trim();
export default defineConfig(async (env) => mergeConfig(await (base as (e: typeof env) => Promise<UserConfig>)(env), { preview: { allowedHosts: host ? [host] : [] } }));
