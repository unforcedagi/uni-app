// T-301: the prototype's stand-in for the native side. In a browser (the web build served for the prototype) there is no Tauri, so this
// answers the app's commands from the made-up world in demoData: seven rooms with their talk, the seven area notes, and nothing else.
// Only installed by the prototype build (VITE_T301_PROTO=1). Writes stay in memory; a reload starts the world again.
import { DEMO_AREAS, demoTalk, type DemoMessage } from "./demoData";
import { loadDemo, onWorkEvent, getWork } from "./store";

const ME = "a".repeat(64);
const UNI = "c".repeat(64);
const T0 = "2026-10-01T08:00:00.000Z";

type Msg = ReturnType<typeof toMsg>;
const toMsg = (m: DemoMessage) => ({ ref: m.ref, channel: m.channel, author: m.mine ? ME : UNI, author_name: m.mine ? "Robin" : "Uni", ts: m.ts, body: m.body, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] });

export function installDemoBackend() {
  const w = window as any;
  if (w.__TAURI_INTERNALS__) return;
  const now = Date.now();
  loadDemo(now);
  const msgs: Record<string, Msg[]> = {};
  for (const m of demoTalk(now)) (msgs[m.channel] ??= []).push(toMsg(m));
  const cbs: ((e: unknown) => void)[] = [];
  const listeners: Record<string, number[]> = {};
  const live = (channel: string, author: string) => { for (const h of listeners["uni://live"] ?? []) cbs[h]?.({ event: "uni://live", id: 1, payload: { kind: "message", channel, status: null, author } }); };
  let n = 0;
  const say = (channel: string, mine: boolean, body: string) => {
    const m = toMsg({ ref: `live-${++n}`, channel, mine, ts: Math.floor(Date.now() / 1000), body });
    (msgs[channel] ??= []).push(m);
    live(channel, m.author);
    return m;
  };
  // A session that finishes says so in its area's room, once: the only time work speaks in the room unasked.
  onWorkEvent((e) => {
    const wk = getWork();
    const p = wk.projects.find((x) => x.id === e.session.project);
    const a = p && wk.areas.find((x) => x.id === p.area);
    if (p && a) say(a.room, false, `${p.name}: a session finished. ${e.session.result ?? ""}`.trim());
  });
  const rooms = () => DEMO_AREAS.map((a) => { const list = msgs[a.room] ?? []; const last = list[list.length - 1]; return { id: a.room, name: a.slug, unread: 0, mentions: false, last_message: last?.body ?? null, last_ts: last?.ts ?? null }; });
  const areaNotes = DEMO_AREAS.map((a) => ({
    id: `area-${a.id}`, path: a.path, extension: "md", tags: ["area"], createdAt: T0, updatedAt: T0,
    metadata: { channel: a.room, room: a.slug, status: "foreground", stands: a.stands, stands_at: new Date(now - 3 * 3600_000).toISOString() },
    content: `# ${a.name}\n\n${a.about}\n`,
  }));
  const nodes = () => [{ id: "uni-root", path: "Uni", extension: "md", tags: ["uni", "node"], createdAt: T0, updatedAt: T0, metadata: {} },
    ...areaNotes.map((n) => ({ ...n, tags: ["node", "area"], content: undefined, metadata: { ...n.metadata, parent: "Uni" } }))];
  const row = (x: { id: string; path: string; extension: string; updatedAt: string }) => ({ id: x.id, path: x.path, extension: x.extension, updatedAt: x.updatedAt });

  w.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
    transformCallback: (cb: (e: unknown) => void) => { cbs.push(cb); return cbs.length - 1; },
    convertFileSrc: (p: string) => p,
    invoke: async (cmd: string, args: any = {}) => {
      switch (cmd) {
        case "webview_runtime": return "prototype browser";
        case "plugin:app|version": return "prototype";
        case "plugin:app|register_listener": return null;
        case "plugin:event|listen": (listeners[args.event] ??= []).push(args.handler); return args.handler;
        case "plugin:event|unlisten": return null;
        case "identity_status": return { paired: true, pubkey: ME };
        case "get_identity": return ME;
        case "get_npub": return "prototype";
        case "get_rooms": return rooms();
        case "get_messages": return args.root ? [] : (msgs[args.channel] ?? []).slice(-(args.limit ?? 300));
        case "approval_messages": return [];
        case "get_members": return [{ pubkey: ME, name: "Robin", named: true }, { pubkey: UNI, name: "Uni", named: true }];
        case "vault_paths": return areaNotes.map(row);
        case "vault_list": return ["uni"];
        case "vault_query": return args.tag === "node" ? nodes() : args.tag === "area" ? areaNotes : [];
        case "vault_query_meta": return [];
        case "vault_subtree_nodes": return nodes();
        case "vault_subtree_tasks": return [];
        case "vault_note": {
          const note = areaNotes.find((x) => x.id === args.noteRef || x.path === args.noteRef);
          if (!note) throw "note not found: " + args.noteRef;
          return { hub: "https://example.invalid", vault: "uni", note };
        }
        case "post_message": {
          const m = say(args.channel, true, String(args.body ?? ""));
          // Uni answers once, so it is plain that nothing left the prototype.
          setTimeout(() => say(args.channel, false, "Noted. (This is a prototype: nothing you write here goes anywhere.)"), 1200);
          return { ref: m.ref, channel: args.channel };
        }
        case "relay_origin": return "wss://relay.example.invalid";
        case "journal_config": return { hub: "https://example.invalid", vault: "uni" };
        case "journal_list": case "journal_pending": case "search_messages": case "search": case "vault_search": return [];
        case "journal_flush": return { sent: [], remaining: 0, error: null };
        case "refresh": return { pubkey: ME, total_items: 0, channel_errors: {}, truncated_channels: [] };
        case "pair_source_available": return false;
        default: return null;
      }
    },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}
