// Host side of the sealed-frame bridge. Pure of React/DOM: it takes decoded
// message data, enforces the limits and routes validated calls to `BridgeApi`.
// AreaFrame owns the iframe and checks `event.source` before calling `handle`.

import { BRIDGE_VERSION, MAX_PENDING, RateLimiter, validateRequest, type BridgeCall, type ThemeData } from "./areasCore.ts";

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

export class AreaBridge {
  private pending = 0;
  private limiter = new RateLimiter();
  private post: (m: BridgeMessage) => void;
  private api: BridgeApi;
  private now: () => number;
  constructor(post: (m: BridgeMessage) => void, api: BridgeApi, now: () => number = Date.now) { this.post = post; this.api = api; this.now = now; }

  sendTheme(data: ThemeData) { this.post({ bridge: BRIDGE_VERSION, event: "theme", data }); }

  /** Handle one message from the frame. Unanswerable junk (no usable id) is dropped. */
  handle(data: unknown): void {
    const v = validateRequest(data);
    const reply = (id: string, m: { result: unknown } | { error: string }) => this.post({ bridge: BRIDGE_VERSION, id, ...m });
    if (!v.ok) { if (v.id) reply(v.id, { error: v.error }); return; }
    if (!this.limiter.take(this.now())) { reply(v.id, { error: "rate_limited" }); return; }
    if (this.pending >= MAX_PENDING) { reply(v.id, { error: "too_many_pending" }); return; }
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
