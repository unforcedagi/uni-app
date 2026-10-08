// note module: ask the host to open a note. Scoped to the granted `vault.read`
// prefixes, and only a pending suggestion: the user taps the host UI to open it.

import { hasOnly, inScope, plain } from "../contract.ts";
import type { UniModule } from "../router.ts";
import type { SuggestionInput } from "../suggestions.ts";

export function createNoteModule(deps: { suggest(s: SuggestionInput): unknown }): UniModule {
  return {
    namespace: "note",
    methods: {
      open: {
        cap: "vault.read",
        validate: (p: unknown) => {
          if (!plain(p) || !hasOnly(p, ["ref"]) || typeof p.ref !== "string") return { ok: false };
          const ref = p.ref.trim();
          return ref && ref.length <= 300 && !/[\u0000-\u001f]/.test(ref) ? { ok: true, value: { ref } } : { ok: false };
        },
        scopeCheck: (scopes, v: { ref: string }) => !/[%\\]/.test(v.ref) && inScope(scopes["vault.read"] ?? [], v.ref),
        async run(v: { ref: string }) {
          deps.suggest({ kind: "open", ref: v.ref });
          return { pending: true };
        },
      },
    },
  };
}
