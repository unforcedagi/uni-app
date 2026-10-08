// Host side of the sealed-frame bridge. Pure of React/DOM: it takes decoded
// message data, enforces the limits and routes validated calls to `BridgeApi`.
// AreaFrame owns the iframe and checks `event.source` before calling `handle`.

import { ACTION_COOLDOWN_MS, BRIDGE_VERSION, MAX_PENDING, RateLimiter, validateRequest, type BridgeCall, type ThemeData } from "./areasCore.ts";

export type BridgeMessage =
  | { bridge: 1; id: string; result: unknown }
  | { bridge: 1; id: string; error: string }
  | { bridge: 1; event: "theme"; data: ThemeData };

/** What an area app may do. Each method is already validated and scoped. */
export type BridgeApi = {
  areaGet(): Promise<unknown>;
  notesList(limit: number): Promise<unknown>;
  noteGet(path: string): Promise<unknown>;
  channelRecent(limit: number): Promise<unknown>;
  channelCompose(text: string): Promise<unknown>;
  noteOpen(ref: string): Promise<unknown>;
};

export type BridgeOptions = {
  /** Did the user just act inside the frame? Gates `channel.compose` and `note.open`. Default: never. */
  gesture?: () => boolean;
};

export class AreaBridge {
  private pending = 0;
  private closed = false;
  private lastAction: number | null = null;
  private limiter = new RateLimiter();
  private post: (m: BridgeMessage) => void;
  private api: BridgeApi;
  private now: () => number;
  private gesture: () => boolean;
  constructor(post: (m: BridgeMessage) => void, api: BridgeApi, now: () => number = Date.now, opts: BridgeOptions = {}) {
    this.post = post; this.api = api; this.now = now; this.gesture = opts.gesture ?? (() => false);
  }

  sendTheme(data: ThemeData) { if (!this.closed) this.post({ bridge: BRIDGE_VERSION, event: "theme", data }); }

  /** Stop for good: pending calls get no reply and later messages are ignored. */
  close(): void { this.closed = true; }

  /**
   * Handle one message from the frame. Every message, valid or not, counts
   * against the limiter first; over the limit it is dropped without a reply.
   * Unanswerable junk (no usable id) is dropped.
   */
  handle(data: unknown): void {
    if (this.closed) return;
    const t = this.now();
    if (!this.limiter.take(t)) return;
    const v = validateRequest(data);
    const reply = (id: string, m: { result: unknown } | { error: string }) => { if (!this.closed) this.post({ bridge: BRIDGE_VERSION, id, ...m }); };
    if (!v.ok) { if (v.id) reply(v.id, { error: v.error }); return; }
    const gated = v.call.method === "channel.compose" || v.call.method === "note.open";
    if (gated) {
      if (!this.gesture()) { reply(v.id, { error: "needs_gesture" }); return; }
      if (this.lastAction !== null && t - this.lastAction < ACTION_COOLDOWN_MS) { reply(v.id, { error: "rate_limited" }); return; }
    }
    if (this.pending >= MAX_PENDING) { reply(v.id, { error: "too_many_pending" }); return; }
    if (gated) this.lastAction = t;
    this.pending++;
    this.dispatch(v.call)
      .then((result) => reply(v.id, { result: result ?? null }), (e) => reply(v.id, { error: e instanceof Error ? e.message.slice(0, 200) : "failed" }))
      .finally(() => { this.pending--; });
  }
  private dispatch(call: BridgeCall): Promise<unknown> {
    try {
      switch (call.method) {
        case "area.get": return this.api.areaGet();
        case "notes.list": return this.api.notesList(call.limit);
        case "note.get": return this.api.noteGet(call.path);
        case "channel.recent": return this.api.channelRecent(call.limit);
        case "channel.compose": return this.api.channelCompose(call.text);
        case "note.open": return this.api.noteOpen(call.ref);
      }
    } catch (e) { return Promise.reject(e); }
  }
}
