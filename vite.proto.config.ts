import { defineConfig, mergeConfig, type UserConfig } from "vite";
import base from "./vite.config";

// T-301: the prototype's tailnet preview (uni-proto-t301). The server listens on 127.0.0.1 only and is reached through `tailscale serve`,
// which forwards the tailnet host name, so any Host is let through; everything else is the app's own config (the CSP included).
export default defineConfig(async (env) => mergeConfig(await (base as (e: typeof env) => Promise<UserConfig>)(env), { preview: { allowedHosts: true } }));
