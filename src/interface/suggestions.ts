// Pending suggestions: what an interface asked for (a draft, opening a note),
// held until the user taps the host UI (consent.tsx). Nothing here acts by
// itself: `add` only records; only `accept` calls `onAccept`, and only host
// UI calls `accept`.

import { cleanText, ContractError, ERROR_CODES, LIMITS, lineCount } from "./contract.ts";

export type SuggestionInput = { kind: "draft"; room: string; text: string } | { kind: "open"; ref: string };
export type Suggestion = SuggestionInput & { id: string };

export function createSuggestionStore(opts: { onAccept: (s: Suggestion) => void; max?: number }) {
  const max = opts.max ?? 3;
  let items: Suggestion[] = [];
  let n = 0;
  const subs = new Set<() => void>();
  const emit = () => subs.forEach((f) => f());
  const same = (a: SuggestionInput, b: SuggestionInput) => JSON.stringify({ ...a, id: 0 }) === JSON.stringify({ ...b, id: 0 });
  return {
    /** Record a suggestion. Duplicates collapse; more than `max` pending is refused. */
    add(raw: SuggestionInput): Suggestion {
      // The bar shows, and accept inserts, exactly this cleaned text.
      const input: SuggestionInput = raw.kind === "draft" ? { ...raw, text: cleanText(raw.text) } : raw;
      if (input.kind === "draft" && lineCount(input.text) > LIMITS.maxDraftLines) throw new ContractError(ERROR_CODES.badParams, "draft too long");
      const dup = items.find((s) => same(s, input));
      if (dup) return dup;
      if (items.length >= max) throw new ContractError(ERROR_CODES.rateLimited, "too many pending suggestions");
      const s = { ...input, id: `s${++n}` } as Suggestion;
      items = [...items, s]; emit();
      return s;
    },
    dismiss(id: string) { const next = items.filter((s) => s.id !== id); if (next.length !== items.length) { items = next; emit(); } },
    accept(id: string) {
      const s = items.find((x) => x.id === id);
      if (!s) return;
      items = items.filter((x) => x.id !== id); emit();
      opts.onAccept(s);
    },
    clear() { if (items.length) { items = []; emit(); } },
    /** A stable snapshot between changes (for useSyncExternalStore). */
    list(): Suggestion[] { return items; },
    subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  };
}
export type SuggestionStore = ReturnType<typeof createSuggestionStore>;
