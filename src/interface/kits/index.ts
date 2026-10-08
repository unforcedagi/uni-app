// The kits injected into the frame. `vaultClientSource` is surface-client's
// VaultClient bundled to an IIFE that sets `window.__UniVC` (built by the
// `virtual:uni-vault-client` Vite plugin; tests pass a stub).
import { FRAME_KIT } from "./frameKit.ts";

export function buildKitSource(opts: { vaultClientSource: string }): string {
  return `${opts.vaultClientSource};\n${FRAME_KIT}`;
}
