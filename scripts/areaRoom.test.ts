// T-75: an area includes its room. Red tests written before the code.
// Run: node --experimental-strip-types scripts/areaRoom.test.ts
import assert from "node:assert/strict";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const opt = async (p: string): Promise<Any> => import(p).catch(() => ({}));
const manifest: Any = await opt("../src/interface/manifest.ts");
const session: Any = await opt("../src/interface/session.ts");
const push: Any = await opt("../src/interface/modules/chatPush.ts");
const kits: Any = await opt("../src/interface/kits/index.ts");
const layout: Any = await opt("../src/areas/areaLayout.ts");
const tabs: Any = await opt("../src/tabs.ts");
const routerMod: Any = await opt("../src/interface/router.ts");
const chatMod: Any = await opt("../src/interface/modules/chat.ts");
const themeMod: Any = await opt("../src/interface/modules/theme.ts");

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}
const ctx = { areaPath: "Areas/Techne", channels: ["ch-techne"] };
const withLayout = (chat: unknown) => ({ interface: { contract: 1, needs: [{ "chat.read": "area" }], layout: { chat } } });

// ------------------------------------------------------------ manifest layout hint
await check("layout: side, sheet and hidden are read from interface.layout.chat", () => {
  for (const v of ["side", "sheet", "hidden"]) {
    const m = manifest.parseManifest(withLayout(v), ctx);
    assert.equal(m.ok, true); assert.equal(m.manifest.layout.chat, v);
  }
});
await check("layout: unknown, wrong-typed or missing hints fall back to the default (null), the manifest still runs", () => {
  for (const v of ["left", "", "SIDE", 3, null, ["side"], { a: 1 }, true, "side "]) {
    const m = manifest.parseManifest(withLayout(v), ctx);
    assert.equal(m.ok, true, String(v)); assert.equal(m.manifest.layout.chat, null, String(v));
  }
  const noLayout = manifest.parseManifest({ interface: { contract: 1, needs: [] } }, ctx);
  assert.equal(noLayout.manifest.layout.chat, null);
  const badLayout = manifest.parseManifest({ interface: { contract: 1, needs: [], layout: "sheet" } }, ctx);
  assert.equal(badLayout.ok, true); assert.equal(badLayout.manifest.layout.chat, null);
  assert.equal(manifest.parseManifest({}, ctx).manifest.layout.chat, null, "default manifest");
});
await check("layout: the hint is not a need, so it never changes the grant key", async () => {
  const a = manifest.parseManifest(withLayout("side"), ctx), b = manifest.parseManifest(withLayout("sheet"), ctx);
  const ka = await manifest.grantKey(manifest.resolveNeeds(a.manifest.needs, ctx), ctx.areaPath);
  const kb = await manifest.grantKey(manifest.resolveNeeds(b.manifest.needs, ctx), ctx.areaPath);
  assert.equal(ka, kb);
});
await check("layout: a prototype-polluting layout object is harmless", () => {
  const m = manifest.parseManifest(JSON.parse('{"interface":{"contract":1,"needs":[],"layout":{"__proto__":{"chat":"hidden"}}}}'), ctx);
  assert.equal(m.ok, true); assert.equal(m.manifest.layout.chat, null);
});

// ------------------------------------------------------------ layout decision (pure)
await check("new messages: the first list is only recorded; later refs come out oldest first; refs are never pushed twice", () => {
  const seen = layout.createSeen();
  const m = (ref: string, ts: number) => ({ ref, ts });
  assert.deepEqual(seen.fresh([m("a", 1), m("b", 2)]), [], "the room as it was when the area opened");
  assert.deepEqual(seen.fresh([m("a", 1), m("b", 2)]), []);
  assert.deepEqual(seen.fresh([m("a", 1), m("b", 2), m("d", 4), m("c", 3)]).map((x: Any) => x.ref), ["c", "d"]);
  assert.deepEqual(seen.fresh([m("a", 1), m("b", 2), m("d", 4), m("c", 3)]), []);
  assert.deepEqual(seen.fresh([m("old", 0), m("a", 1), m("b", 2), m("d", 4), m("c", 3)]), [], "an older page loaded later is not news");
  seen.reset(); assert.deepEqual(seen.fresh([m("z", 9)]), [], "after reset the next list is a baseline again");
});
await check("new messages: judged by position, not by timestamp (a slow clock or a far-future ts neither drops nor mutes live pushes)", () => {
  const m = (ref: string, ts: number) => ({ ref, ts });
  const a = layout.createSeen();
  a.fresh([m("a", 1000)]);
  assert.deepEqual(a.fresh([m("a", 1000), m("late", 990)]).map((x: Any) => x.ref), ["late"], "a sender whose clock is behind");
  const b = layout.createSeen();
  b.fresh([m("a", 1000), m("future", 9999999999)]);
  assert.deepEqual(b.fresh([m("a", 1000), m("future", 9999999999), m("real", 2000)]).map((x: Any) => x.ref), ["real"], "a baseline message with a far-future ts");
  assert.deepEqual(b.fresh([m("older", 5), m("a", 1000), m("future", 9999999999), m("real", 2000)]), [], "an older page prepended later is still not news");
  const c = layout.createSeen();
  assert.deepEqual(c.fresh([]), []);
  assert.deepEqual(c.fresh([m("first", 1)]).map((x: Any) => x.ref), ["first"], "an empty room's first message is news");
});
// ------------------------------------------------------------ push into the frame
const msg = (over: Any = {}) => ({ ref: "m1", author: "b".repeat(64), author_name: "Uni", ts: 1_700_000_000, body: "hello", ...over });
const harness = (grant: Any, now = { v: 0 }) => {
  const out: Any[] = [];
  const router = routerMod.createRouter([themeMod.createThemeModule({ theme: () => ({}) })]);
  const s = session.createSession({ post: (m: Any) => out.push(m), router, grant, now: () => now.v });
  return { s, out, now };
};
await check("push: with chat.read for the room a chat.message event reaches the frame", () => {
  const { s, out } = harness({ "chat.read": ["ch-techne"] });
  assert.equal(push.pushChatMessage(s, { "chat.read": ["ch-techne"] }, "ch-techne", msg()), true);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { uni: 1, event: "chat.message", data: { id: "m1", author: "Uni", content: "hello", created_at: new Date(1_700_000_000_000).toISOString(), room: "ch-techne" } });
});
await check("push: nothing without chat.read, and nothing for a room outside the grant", () => {
  const g = { "vault.read": ["Areas/Techne/"], "chat.draft": ["ch-techne"] };
  const h = harness(g);
  assert.equal(push.pushChatMessage(h.s, g, "ch-techne", msg()), false);
  assert.equal(h.out.length, 0, "chat.draft alone grants no reading");
  const h2 = harness({ "chat.read": ["ch-other"] });
  assert.equal(push.pushChatMessage(h2.s, { "chat.read": ["ch-other"] }, "ch-techne", msg()), false);
  assert.equal(push.pushChatMessage(h2.s, {}, "ch-techne", msg()), false);
  assert.equal(h2.out.length, 0);
});
await check("push: content and author are cleaned with stripHidden and capped like chat.recent", () => {
  const g = { "chat.read": ["ch-techne"] };
  const h = harness(g);
  const tag = String.fromCodePoint(0xe0041, 0xe0042);
  push.pushChatMessage(h.s, g, "ch-techne", msg({ body: `a‮b​c${tag}d\n\te` + "x".repeat(5000), author_name: "Un‮i​" }));
  const d = h.out[0].data;
  assert.equal(d.author, "Uni");
  assert.ok(d.content.startsWith("abcd\n\te"), JSON.stringify(d.content.slice(0, 12)));
  assert.equal(d.content.length, 4000);
  assert.equal(push.pushChatMessage(h.s, g, "ch-techne", msg({ author_name: null, author: "c".repeat(64) })), true);
  assert.equal(h.out[1].data.author, "cccccccc", "falls back to the short key, like chat.recent");
});
await check("chat.recent cleans content and author with stripHidden, like the pushed event", async () => {
  const tag = String.fromCodePoint(0xe0041, 0xe0042);
  const mod = chatMod.createChatModule({ getMessages: async () => [{ ref: "r1", author: "c".repeat(64), author_name: "Un‮i​", ts: 5, body: `a‮b​c${tag}d\n\te` + "x".repeat(5000) }], suggest: () => ({}), roomName: (id: string) => id });
  const r = routerMod.createRouter([mod]);
  const { messages } = await r.call("chat", "recent", { limit: 5 }, { "chat.read": ["ch-techne"] });
  assert.equal(messages[0].author, "Uni");
  assert.ok(messages[0].content.startsWith("abcd\n\te"), JSON.stringify(messages[0].content.slice(0, 12)));
  assert.equal(messages[0].content.length, 4000);
});
await check("push: events count against the request bucket (60 per 10 s); over it nothing is posted", () => {
  const g = { "chat.read": ["ch-techne"] };
  const h = harness(g);
  let sent = 0;
  for (let i = 0; i < 100; i++) if (push.pushChatMessage(h.s, g, "ch-techne", msg({ ref: "m" + i }))) sent++;
  assert.equal(sent, 60); assert.equal(h.out.length, 60);
  h.now.v = 10_001;
  assert.equal(push.pushChatMessage(h.s, g, "ch-techne", msg({ ref: "late" })), true, "the window rolled");
});
await check("push: the same bucket is shared with requests, so a flood of pushes rate-limits requests and vice versa", () => {
  const g = { "chat.read": ["ch-techne"] };
  const h = harness(g);
  for (let i = 0; i < 60; i++) push.pushChatMessage(h.s, g, "ch-techne", msg({ ref: "m" + i }));
  h.s.handle({ uni: 1, id: "q", ns: "theme", method: "get", params: {} });
  const reply = h.out.find((m: Any) => m.id === "q");
  assert.equal(reply.error.code, "rate_limited");
});
await check("push: a closed session posts nothing", () => {
  const g = { "chat.read": ["ch-techne"] };
  const h = harness(g);
  h.s.close();
  assert.equal(push.pushChatMessage(h.s, g, "ch-techne", msg()), false);
  assert.equal(h.out.length, 0);
});
await check("push: bad shapes (no ref, non-string body) are dropped without throwing", () => {
  const g = { "chat.read": ["ch-techne"] };
  const h = harness(g);
  for (const bad of [null, {}, { ref: 1, body: "x" }, { ref: "a", body: 5, ts: 1, author: "x" }, { ref: "a", body: "x", ts: "now", author: "x" }, { ref: "a", body: "x", ts: Number.NaN, author: "x" }]) {
    assert.equal(push.pushChatMessage(h.s, g, "ch-techne", bad), false, JSON.stringify(bad));
  }
  assert.equal(h.out.length, 0);
});

// ------------------------------------------------------------ the kit
await check("kit: uni.chat.onMessage subscribes to chat.message events and returns an unsubscribe", () => {
  const src = kits.buildKitSource({ vaultClientSource: "" });
  assert.match(src, /onMessage/); assert.match(src, /chat\.message/);
  assert.doesNotMatch(src, /`/, "kit stays free of backticks");
  // Run the kit against a fake window and drive it with host events.
  const listeners: Any = {}; const posts: Any[] = [];
  const parent = { postMessage: (m: Any) => posts.push(m) };
  const doc: Any = { documentElement: { style: { setProperty() {} } }, addEventListener() {}, getElementById: () => null, getElementsByName: () => [] };
  const win: Any = { addEventListener: (t: string, f: Any) => { listeners[t] = f; }, parent, document: doc };
  const run = new Function("window", "parent", "document", "addEventListener", "Promise", "Object", "Response", "URL", "setTimeout", src);
  run(win, parent, doc, win.addEventListener, Promise, Object, class {}, URL, () => 0);
  const uni = win.uni;
  assert.equal(typeof uni.chat.onMessage, "function");
  const got: Any[] = [];
  const off = uni.chat.onMessage((m: Any) => got.push(m));
  const deliver = (data: Any, source: Any = parent) => listeners.message({ source, data });
  deliver({ uni: 1, event: "chat.message", data: { id: "1", content: "hi" } });
  deliver({ uni: 1, event: "chat.message", data: { id: "2", content: "x" } }, {});
  assert.deepEqual(got.map((m) => m.id), ["1"], "only the host window is believed");
  assert.equal(typeof off, "function"); off();
  deliver({ uni: 1, event: "chat.message", data: { id: "3" } });
  assert.equal(got.length, 1, "unsubscribed");
  uni.chat.onMessage(() => { throw new Error("app bug"); });
  uni.chat.onMessage((m: Any) => got.push(m));
  deliver({ uni: 1, event: "chat.message", data: { id: "4" } });
  assert.equal(got.length, 2, "a throwing callback does not stop the others");
  assert.throws(() => uni.chat.onMessage("nope"), /function/i);
});

// ------------------------------------------------------------ tabs
await check("tabs: an area tab keeps its room channel across save and restore; a vanished room drops only the channel", () => {
  const s = { tabs: [{ id: "t1", kind: "area", path: "Areas/Techne", title: "Techne", channel: "ch-techne" }], active: "t1", recent: ["t1"] };
  const back = tabs.restoreTabs(tabs.serializeTabs(s), ["ch-techne"]);
  assert.equal(back.tabs[0].channel, "ch-techne"); assert.equal(back.tabs[0].path, "Areas/Techne");
  const gone = tabs.restoreTabs(tabs.serializeTabs(s), ["other"]);
  assert.equal(gone.tabs.length, 1); assert.equal(gone.tabs[0].channel, undefined);
  assert.equal(tabs.sameTarget({ kind: "area", path: "Areas/Techne", title: "a", channel: "x" }, { kind: "area", path: "Areas/Techne", title: "b" }), true);
  const upd = tabs.updateTab(s, "t1", { channel: "ch-new" });
  assert.equal(upd.tabs[0].channel, "ch-new");
});

if (failed) { console.log(`\nareaRoom: ${failed} failed`); process.exit(1); }
console.log("\nareaRoom: ok");
