// note module: ask the host to open a note. Scoped to the granted `vault.read`
// prefixes, judged on the note the ref RESOLVES to (not on the ref string), and
// only a pending suggestion: the user taps the host UI to open it. The
// suggestion carries the resolved path, the thing that was checked and shown.

import { ContractError, ERROR_CODES, hasHidden, hasOnly, inScope, plain } from "../contract.ts";
import type { UniModule } from "../router.ts";
import type { SuggestionInput } from "../suggestions.ts";

export type NoteDeps = {
  suggest(s: SuggestionInput): unknown;
  /** The note a ref (id or path) names; rejects when there is none. */
  resolve(ref: string): Promise<{ id: string; path?: string | null }>;
};

export function createNoteModule(deps: NoteDeps): UniModule {
  return {
    namespace: "note",
    methods: {
      open: {
        cap: "vault.read",
        validate: (p: unknown) => {
          if (!plain(p) || !hasOnly(p, ["ref"]) || typeof p.ref !== "string") return { ok: false };
          const ref = p.ref.trim();
          return ref && ref.length <= 300 && !/[\u0000-\u001f]/.test(ref) && !hasHidden(ref) ? { ok: true, value: { ref } } : { ok: false };
        },
        async run(v: { ref: string }, scopes, ctx) {
          // Obvious traversal never reaches the vault; the resolved note is what is judged.
          if (/[%\\]/.test(v.ref) || v.ref.startsWith("/") || v.ref.split("/").some((seg) => seg === ".." || seg === ".")) throw new ContractError(ERROR_CODES.outOfScope);
          ctx.charge(1);
          let note: { id: string; path?: string | null };
          try { note = await deps.resolve(v.ref); } catch { throw new ContractError(ERROR_CODES.outOfScope); }
          if (!inScope(scopes["vault.read"] ?? [], note.path)) throw new ContractError(ERROR_CODES.outOfScope);
          deps.suggest({ kind: "open", ref: note.path as string });
          return { pending: true };
        },
      },
    },
  };
}
