// The capability router: (namespace, method, params) → the module handler,
// enforcing the user's grant on every call. Modules register
// `{namespace, methods}`; a method names the capability it needs, validates its
// own params, and may carry a `scopeCheck`. Pure: no DOM, no Tauri.

import { ContractError, ERROR_CODES, type Capability } from "./contract.ts";
import type { Resolved } from "./manifest.ts";

export type Validated<T> = { ok: true; value: T } | { ok: false };
export type MethodDef<T = any> = { // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The capability the grant must hold; null for ungated methods (theme). */
  cap: Capability | null;
  validate(params: unknown): Validated<T>;
  /** Called after validation with the granted scopes for `cap`; false → out_of_scope. */
  scopeCheck?(scopes: Resolved, value: T): boolean;
  run(value: T, scopes: Resolved, ctx: CallCtx): Promise<unknown>;
};
/**
 * Per-call host services. `charge(n)` takes n read tokens from the frame's read bucket and throws rate_limited
 * when it is out. `closed()` is true once the session is gone: a module must not leave side effects then.
 */
export type CallCtx = { charge(n: number): void; closed(): boolean };
const FREE: CallCtx = { charge() {}, closed: () => false };
export type UniModule = { namespace: string; methods: Record<string, MethodDef> };

export function createRouter(modules: UniModule[]) {
  const byNs = new Map(modules.map((m) => [m.namespace, m]));
  return {
    async call(ns: string, method: string, params: unknown, grant: Resolved, ctx: CallCtx = FREE): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
      const mod = byNs.get(ns);
      if (!mod) throw new ContractError(ERROR_CODES.unknownNamespace);
      // Own properties only: "constructor", "__proto__" and friends are not methods.
      const def = Object.prototype.hasOwnProperty.call(mod.methods, method) ? mod.methods[method] : null;
      if (!def) throw new ContractError(ERROR_CODES.unknownMethod);
      if (def.cap !== null && !(grant[def.cap]?.length)) throw new ContractError(ERROR_CODES.notGranted);
      const v = def.validate(params);
      if (!v.ok) throw new ContractError(ERROR_CODES.badParams);
      if (def.scopeCheck && !def.scopeCheck(grant, v.value)) throw new ContractError(ERROR_CODES.outOfScope);
      return def.run(v.value, grant, ctx);
    },
  };
}
export type Router = ReturnType<typeof createRouter>;
