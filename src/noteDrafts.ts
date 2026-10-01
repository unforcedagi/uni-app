import { draftKey } from "./noteEdit.ts";
// Keep drafts available across pane unmounts even when browser storage is full.
const memory = new Map<string, string | null>();
export function readDraft(vault: string, id: string): string | null {
  const key = draftKey(vault, id);
  if (memory.has(key)) return memory.get(key) ?? null;
  try { return localStorage.getItem(key); } catch { return null; }
}

export function clearDraft(vault: string, id: string) {
  memory.set(draftKey(vault, id), null);
  try { localStorage.removeItem(draftKey(vault, id)); } catch { /* session copy is cleared */ }
}


export function forgetDrafts() { memory.clear(); }

/** A late request may only clear the draft it submitted. */
export function settleDraft(vault: string, id: string, submitted: string | null): boolean {
  if (readDraft(vault, id) === submitted) clearDraft(vault, id);
  return !!readDraft(vault, id);
}

export function draftWriter(key: string, onError: () => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!memory.has(key)) return;
    const raw = memory.get(key) ?? null;
    try { if (raw === null) localStorage.removeItem(key); else localStorage.setItem(key, raw); }
    catch { onError(); }
  };
  return {
    flush,
    write(raw: string | null) {
      memory.set(key, raw);
      clearTimeout(timer);
      timer = setTimeout(flush, 300);
    },
  };
}
