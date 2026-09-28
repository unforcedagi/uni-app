// Copy text to the system clipboard. The Tauri clipboard plugin goes through
// the native ClipboardManager, which works in the Android WebView where
// navigator.clipboard needs a secure context + user-activation and can fail
// silently. Browser APIs are the fallback (vite dev in a browser).

import { writeText } from "@tauri-apps/plugin-clipboard-manager";

type Listener = (message: string) => void;
const listeners = new Set<Listener>();

/** Subscribe to "Copied" confirmations (the app shows a small toast). */
export function onCopied(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function execCopy(text: string): boolean {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  try { return document.execCommand("copy"); } catch { return false; } finally { ta.remove(); }
}

/** Copies `text`; announces `message` on success. Returns whether it worked. */
export async function copyText(text: string, message = "Copied"): Promise<boolean> {
  let ok = false;
  try { await writeText(text); ok = true; } catch { /* not in Tauri, or plugin refused */ }
  if (!ok) { try { await navigator.clipboard.writeText(text); ok = true; } catch { /* insecure context */ } }
  if (!ok) ok = execCopy(text);
  listeners.forEach((fn) => fn(ok ? message : "Couldn't copy"));
  return ok;
}
