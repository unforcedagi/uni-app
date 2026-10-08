// The host side of one frame: takes decoded message data, enforces the limits
// and routes validated calls through the router under this frame's grant.
// The frame component owns the iframe and checks `event.source` before `handle`.

import { ContractError, ERROR_CODES, LIMITS, parseEnvelope, RateLimiter, type ErrorCode, type HostMessage } from "./contract.ts";
import { errorToFrameFetchReply, toFrameFetchReply, type FetchResult } from "./modules/frameFetch.ts";
import type { Resolved } from "./manifest.ts";
import type { Router } from "./router.ts";

export type SessionOptions = { post: (m: HostMessage) => void; router: Router; grant: Resolved; now?: () => number };

const codeOf = (e: unknown): ErrorCode => (e instanceof ContractError ? e.code : ERROR_CODES.failed);

export function createSession(opts: SessionOptions) {
  const now = opts.now ?? Date.now;
  const limiter = new RateLimiter();
  let pending = 0;
  let closed = false;
  const post = (m: HostMessage) => { if (!closed) opts.post(m); };
  return {
    /** Stop for good: in-flight calls get no reply and later messages are ignored. */
    close() { closed = true; },
    sendEvent(event: string, data: unknown) { post({ uni: 1, event, data }); },
    /**
     * Handle one message from the frame. Every message, valid or not, counts
     * against the limiter first; over the limit it is dropped without a reply.
     * Unanswerable junk (no usable id) is dropped.
     */
    handle(data: unknown): void {
      if (closed || !limiter.take(now())) return;
      const env = parseEnvelope(data);
      const isPfr = !!data && typeof data === "object" && "pfr" in (data as object);
      const errorReply = (id: string, code: ErrorCode) => post(isPfr || env.kind === "pfr"
        ? errorToFrameFetchReply({ id, channel: "vault" }, code)
        : { uni: 1, id, error: { code, message: code } });
      if (env.kind === "bad") { if (env.id) errorReply(env.id, env.error); return; }
      if (pending >= LIMITS.maxPending) { errorReply(env.id, ERROR_CODES.tooManyPending); return; }
      pending++;
      const call = env.kind === "pfr"
        ? opts.router.call("vault", "fetch", { method: env.method, path: env.path, headers: env.headers, body: env.body }, opts.grant)
          .then((r: FetchResult) => post(toFrameFetchReply(env, r)))
        : opts.router.call(env.ns, env.method, env.params, opts.grant).then((result) => post({ uni: 1, id: env.id, result: result ?? null }));
      call.catch((e) => errorReply(env.id, codeOf(e))).finally(() => { pending--; });
    },
  };
}
export type Session = ReturnType<typeof createSession>;
