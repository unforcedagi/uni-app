// T-200 prototypes only: a made-up backend so a plain browser runs the app with no relay and no vault.
// Built in only when VITE_T200_FIXTURE=1 (the previews and the T-200 browser tests). Every name, note and message here is invented.

const ME = "a".repeat(64), UNI = "c".repeat(64), ROBIN = "b".repeat(64);
const HUB = "https://hub.example.invalid";
const id = (n: number) => `01JT2${String(n).padStart(21, "0")}`;
export const FIXTURE_NOTES = { plan: id(1), beds: id(2), tools: id(3) };

const notes: Record<string, { path: string; content: string }> = {
  [FIXTURE_NOTES.plan]: { path: "Projects/Orchard/Spring planting plan", content: `# Spring planting plan

Draft for the orchard group. Comments welcome before the work day.

## What we plant

- Two dwarf apple trees by the south fence.
- A row of currants along the path.
- Comfrey under the trees as a living mulch.

## When

The work day is the first Saturday of April. We start at nine and stop when the light goes.
If it rains we move to the Sunday after.

## Who brings what

Robin brings the spades and the wheelbarrow. Uni keeps the list of seedlings.
Everyone else brings gloves, water and something to share at lunch.

## Open questions

1. Do we net the currants this year, or leave some for the birds?
2. Is the south fence strong enough to train the apples along it?
3. Who waters in May, while Robin is away?

## Budget

| Item | Count | Cost |
| --- | --- | --- |
| Apple trees | 2 | 60 |
| Currant bushes | 6 | 42 |
| Comfrey roots | 12 | 18 |

The bed layout is in [[Projects/Orchard/Bed layout]].
` },
  [FIXTURE_NOTES.beds]: { path: "Projects/Orchard/Bed layout", content: `# Bed layout

Three beds, north to south. The middle bed gets the most sun after noon.

- North bed: herbs and comfrey.
- Middle bed: currants.
- South bed: the two apples, two metres apart.
` },
  [FIXTURE_NOTES.tools]: { path: "Projects/Workshop/Tool library", content: `# Tool library

A shelf in the shed where anyone can borrow a tool and write their name on the card.

Rules: bring it back clean, say if it broke, and nobody takes the good saw home overnight.
` },
};

type Msg = { ref: string; channel: string; author: string; author_name: string; ts: number; body: string; mentions_me: boolean; root: null; parent: null; mentions: []; reply_count: number; last_reply_ts: null; edited: boolean; reactions: [] };
const t0 = Math.floor(Date.UTC(2026, 2, 14, 9, 0) / 1000);
const chatter = [
  "Morning all. The compost is turned.", "Did anyone see where the twine went?", "Twine is on the second shelf now.",
  "I can do the Saturday shift.", "The rhubarb is coming up already.", "Who has the key to the shed this week?",
  "Me, I'll leave it under the pot.", "The water butt is full after last night.", "Pictures of the frost damage later.",
  "Seed swap is on the 20th.", "Can someone check the netting on the brassicas?", "Done, two holes patched.",
  "The robin is back on the fork handle.", "Reminder: no bonfire until the wind drops.", "Lunch rota is on the board.",
  "Thanks for the leeks, they were great.", "I moved the trays into the cold frame.", "Slugs got the lettuce again.",
];
function seed(): Record<string, Msg[]> {
  const m = (channel: string, n: number, author: string, author_name: string, body: string): Msg =>
    ({ ref: `${channel}-${n}`, channel, author, author_name, ts: t0 + n * 900, body, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] });
  const orchard: Msg[] = [];
  chatter.forEach((b, i) => orchard.push(m("orchard", i, i % 3 ? ROBIN : ME, i % 3 ? "Robin Vale" : "You", b)));
  orchard.push(m("orchard", 18, UNI, "Uni", `I drafted the plan for the work day: uni:${FIXTURE_NOTES.plan}. Can you read it and tell me what to change?`));
  for (let i = 19; i < 30; i++) orchard.push(m("orchard", i, i % 2 ? ROBIN : ME, i % 2 ? "Robin Vale" : "You", chatter[(i * 7) % chatter.length]));
  orchard.push(m("orchard", 30, UNI, "Uni", `The bed layout is here too: ${HUB}/surface/parachute/v/uni/n/${FIXTURE_NOTES.beds}`));
  const workshop = [m("workshop", 0, UNI, "Uni", `Rules for the shed are in uni:${FIXTURE_NOTES.tools}.`), m("workshop", 1, ROBIN, "Robin Vale", "Looks right to me.")];
  return { orchard, workshop };
}

export function installFixture(mode: string | null) {
  const w = window as any;
  const real = w.__TAURI_INTERNALS__;
  const msgs = seed();
  let sent = 0;
  // Tests read what was sent from here; `browser`: no Tauri behind this page (C then opens a popup, not a native window).
  w.__t200 = { sent: [] as { channel: string; body: string }[], browser: !real?.invoke };
  const answer = async (cmd: string, args: any): Promise<unknown> => {
    switch (cmd) {
      case "identity_status": return { paired: true, pubkey: ME };
      case "get_identity": return ME;
      case "get_npub": return "npub1fixture";
      case "relay_origin": return "https://relay.example.invalid";
      case "app_version": return "t200-prototype";
      case "journal_config": return { hub: HUB, hub_origins: [] };
      case "get_rooms": { const last = (l: Msg[]) => l[l.length - 1]; return [
        { id: "orchard", name: "Orchard", last_message: last(msgs.orchard).body, last_ts: last(msgs.orchard).ts, mentions: false, unread: 0 },
        { id: "workshop", name: "Workshop", last_message: last(msgs.workshop).body, last_ts: last(msgs.workshop).ts, mentions: false, unread: 0 },
      ]; }
      case "get_members": return [{ pubkey: UNI, name: "Uni" }, { pubkey: ROBIN, name: "Robin Vale" }, { pubkey: ME, name: "You" }];
      case "get_messages": return args?.root ? [] : (msgs[args?.channel] ?? []).slice(-(args?.limit ?? 300));
      case "refresh": return { pubkey: ME, total_items: 0, channel_errors: {}, truncated_channels: [] };
      case "post_message": {
        const list = msgs[args.channel] ??= [];
        const n = 1000 + sent++;
        const m: Msg = { ref: `${args.channel}-${n}`, channel: args.channel, author: ME, author_name: "You", ts: t0 + n * 900, body: args.body, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] };
        list.push(m);
        w.__t200.sent.push({ channel: args.channel, body: args.body });
        return m;
      }
      case "vault_list": return ["uni"];
      case "vault_note": {
        const key = Object.keys(notes).find((k) => k === args.noteRef || notes[k].path === args.noteRef);
        if (args.vault !== "uni" || !key) throw `vault: note not found: ${args.noteRef}`;
        const n = notes[key];
        const links = Object.keys(notes).filter((k) => n.content.includes(`[[${notes[k].path}]]`)).map((k) => ({ sourceId: key, targetId: k, targetNote: { id: k, path: notes[k].path } }));
        return { hub: HUB, vault: "uni", note: { id: key, path: n.path, content: n.content, createdAt: "2026-03-10T09:00:00Z", updatedAt: "2026-03-14T09:00:00Z", tags: [], links } };
      }
      case "vault_search": case "search": case "vault_query": case "vault_query_meta": case "vault_paths": return [];
      case "open_link": return null;
      default: return null;
    }
  };
  // Say plainly that this is a prototype on invented data.
  const label = mode === "split" ? "A · split view" : mode === "sheet" ? "B · note sheet" : mode === "window" ? "C · separate window" : "today's behaviour";
  const banner = document.createElement("div");
  banner.className = "t200-banner";
  banner.setAttribute("role", "note");
  banner.textContent = `Prototype T-200 · ${label} · made-up data, nothing is sent anywhere`;
  document.documentElement.classList.add("t200-preview");
  document.addEventListener("DOMContentLoaded", () => document.body.appendChild(banner));
  if (document.readyState !== "loading") document.body.appendChild(banner);
  if (import.meta.env.VITE_T200_DRIVE === "1") void drive((m) => { banner.textContent = `T-200 C desktop run · ${m}`; });
  // A real Tauri window (the desktop run of C, built with UNI_T76=1 because WebKitGTK keeps the internals read-only): the app's own
  // commands are answered here, Tauri's (windows, events) still go to Tauri.
  if (real?.invoke) {
    const invoke = (cmd: string, args: any, opts: unknown) => (cmd.startsWith("plugin:") ? real.invoke(cmd, args, opts) : answer(cmd, args));
    // inherits from Tauri's own: `metadata` (which window this is) is not a field a copy would carry, and `invoke` there is read-only
    w.__T76_MOCK__ = Object.create(real, { invoke: { value: invoke } });
    return;
  }
  w.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: new URLSearchParams(location.search).get("label") ?? "main" }, currentWebview: { label: "main" } },
    transformCallback: () => Math.floor(Math.random() * 1e9),
    unregisterCallback: () => {},
    invoke: async (cmd: string, args: any) => (cmd.startsWith("plugin:") ? null : answer(cmd, args)),
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}

/** The headless desktop run of C (VITE_T200_DRIVE=1 only): the main window opens the plan; the note window quotes a line and closes;
 *  the main window adds a sentence and sends. Screenshots of the run show each step. */
async function drive(report: (m: string) => void) {
  addEventListener("unhandledrejection", (e) => report(`error: ${String(e.reason)}`));
  addEventListener("error", (e) => report(`error: ${e.message}`));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const wait = async <T extends Element>(sel: string): Promise<T> => { for (;;) { const el = document.querySelector<T>(sel); if (el) return el; await sleep(200); } };
  const type = (el: HTMLTextAreaElement, text: string) => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, text); el.dispatchEvent(new Event("input", { bubbles: true })); };
  if (new URLSearchParams(location.search).get("noteWindow") === "1") {
    const li = await wait(".note-body li");
    await sleep(2500);
    const r = document.createRange(); r.selectNodeContents(li); const sel = getSelection()!; sel.removeAllRanges(); sel.addRange(r);
    await sleep(1500);
    (await wait<HTMLButtonElement>(".t200-quote:not(:disabled)")).click();
    report("note window: quoted a line");
    await sleep(2500);
    (await wait<HTMLButtonElement>('[aria-label="Close note"]')).click();
    await sleep(2000);
    report("note window: still open 2 s after Close note");
    return;
  }
  // The app may open on Uni's home: go to the Orchard room through the room tree, as a person would.
  for (let i = 0; i < 50 && !document.querySelector("textarea"); i++) {
    const fold = document.querySelector<HTMLButtonElement>(".th-others .th-fold");
    if (fold && fold.getAttribute("aria-expanded") !== "true") fold.click();
    [...document.querySelectorAll<HTMLElement>(".th-other .th-go")].find((b) => b.textContent?.includes("#Orchard"))?.click();
    await sleep(300);
  }
  const box = await wait<HTMLTextAreaElement>("textarea");
  await sleep(2500);
  const chip = [...document.querySelectorAll<HTMLAnchorElement>(".message-list .note-chip")].find((a) => a.textContent?.includes("Spring planting plan"));
  chip?.scrollIntoView({ block: "center" });
  type(box, "Half-written reply.");
  await sleep(1500);
  chip?.click();
  report("main window: plan link clicked");
  for (;;) { if (box.value.includes("> ")) break; await sleep(200); }
  report("main window: the quote arrived in the draft");
  await sleep(3000);
  type(box, `${box.value}Yes to both.`);
  await sleep(1000);
  (await wait<HTMLButtonElement>('button[aria-label="Send message"]:not(:disabled)')).click();
  await sleep(1500);
  report(`main window: sent ${JSON.stringify((window as any).__t200.sent.map((x: { body: string }) => x.body.length))} chars`);
}
