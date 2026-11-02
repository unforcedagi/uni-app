// T-305 interface platform spike: the Garden interface builds on its own, into dist-garden/, as a separate bundle.
import { defineConfig } from "vite";

export default defineConfig({
  root: __dirname,
  base: "./",
  build: { outDir: "../../dist-garden", emptyOutDir: true, assetsInlineLimit: 0 },
  server: { port: 1455, strictPort: true, host: "127.0.0.1" },
  preview: { port: Number(process.env.GARDEN_TEST_PORT || 1455), strictPort: true, host: "127.0.0.1" },
});
