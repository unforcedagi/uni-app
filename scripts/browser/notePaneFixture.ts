// T-200: a made-up backend for the note-beside-chat tests, installed with page.addInitScript (so nothing of it is in the app's build).
// Every name, note and message here is invented. What the app sends is recorded in window.__notePane.sent.

export const PLAN = `01JT2${'0'.repeat(20)}1`;

/** Runs in the page before the app: self-contained, it closes over nothing. */
export function installNotePaneFixture() {
  const ME = 'a'.repeat(64), UNI = 'c'.repeat(64), ROBIN = 'b'.repeat(64);
  const HUB = 'https://hub.example.invalid';
  const id = (n: number) => `01JT2${String(n).padStart(21, '0')}`;
  const ids = { plan: id(1), beds: id(2), tools: id(3) };
  const notes: Record<string, { path: string; content: string }> = {
    [ids.plan]: { path: 'Projects/Orchard/Spring planting plan', content: `# Spring planting plan

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
    [ids.beds]: { path: 'Projects/Orchard/Bed layout', content: `# Bed layout

Three beds, north to south. The middle bed gets the most sun after noon.

- North bed: herbs and comfrey.
- Middle bed: currants.
- South bed: the two apples, two metres apart.
` },
    [ids.tools]: { path: 'Projects/Workshop/Tool library', content: `# Tool library

A shelf in the shed where anyone can borrow a tool and write their name on the card.

Rules: bring it back clean, say if it broke, and nobody takes the good saw home overnight.
` },
  };
  type Msg = { ref: string; channel: string; author: string; author_name: string; ts: number; body: string; mentions_me: boolean; root: null; parent: null; mentions: []; reply_count: number; last_reply_ts: null; edited: boolean; reactions: [] };
  const t0 = Math.floor(Date.UTC(2026, 2, 14, 9, 0) / 1000);
  const msg = (channel: string, n: number, author: string, author_name: string, body: string): Msg =>
    ({ ref: `${channel}-${n}`, channel, author, author_name, ts: t0 + n * 900, body, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] });
  const chatter = [
    'Morning all. The compost is turned.', 'Did anyone see where the twine went?', 'Twine is on the second shelf now.',
    'I can do the Saturday shift.', 'The rhubarb is coming up already.', 'Who has the key to the shed this week?',
    "Me, I'll leave it under the pot.", 'The water butt is full after last night.', 'Pictures of the frost damage later.',
    'Seed swap is on the 20th.', 'Can someone check the netting on the brassicas?', 'Done, two holes patched.',
    'The robin is back on the fork handle.', 'Reminder: no bonfire until the wind drops.', 'Lunch rota is on the board.',
    'Thanks for the leeks, they were great.', 'I moved the trays into the cold frame.', 'Slugs got the lettuce again.',
  ];
  const orchard: Msg[] = chatter.map((b, i) => msg('orchard', i, i % 3 ? ROBIN : ME, i % 3 ? 'Robin Vale' : 'You', b));
  orchard.push(msg('orchard', 18, UNI, 'Uni', `I drafted the plan for the work day: uni:${ids.plan}. Can you read it and tell me what to change?`));
  for (let i = 19; i < 60; i++) orchard.push(msg('orchard', i, i % 2 ? ROBIN : ME, i % 2 ? 'Robin Vale' : 'You', chatter[(i * 7) % chatter.length]));
  orchard.push(msg('orchard', 60, UNI, 'Uni', `The bed layout is here too: ${HUB}/surface/parachute/v/uni/n/${ids.beds}`));
  // a long room: the link is among its oldest messages, past the 300 a room first loads
  const archive: Msg[] = Array.from({ length: 420 }, (_, i) => i === 20
    ? msg('archive', i, UNI, 'Uni', `Last year's plan, for comparison: uni:${ids.plan}.`)
    : msg('archive', i, i % 2 ? ROBIN : ME, i % 2 ? 'Robin Vale' : 'You', `${chatter[i % chatter.length]} (${i})`)).map((m) => ({ ...m, ts: m.ts - 1_000_000 }));
  let olderLoaded = false;
  const msgs: Record<string, Msg[]> = {
    orchard, archive,
    workshop: [msg('workshop', 0, UNI, 'Uni', `Rules for the shed are in uni:${ids.tools}.`), msg('workshop', 1, ROBIN, 'Robin Vale', 'Looks right to me.')],
  };
  let sent = 0;
  const w = window as any;
  w.__notePane = { sent: [] as { channel: string; body: string }[] };
  const answer = async (cmd: string, args: any): Promise<unknown> => {
    switch (cmd) {
      case 'identity_status': return { paired: true, pubkey: ME };
      case 'get_identity': return ME;
      case 'get_npub': return 'npub1fixture';
      case 'relay_origin': return 'https://relay.example.invalid';
      case 'app_version': return '0.0.0-test';
      case 'journal_config': return { hub: HUB, hub_origins: [] };
      case 'get_rooms': { const last = (l: Msg[]) => l[l.length - 1]; return [
        { id: 'orchard', name: 'Orchard', last_message: last(msgs.orchard).body, last_ts: last(msgs.orchard).ts, mentions: false, unread: 0 },
        { id: 'archive', name: 'Archive', last_message: last(msgs.archive).body, last_ts: last(msgs.archive).ts, mentions: false, unread: 0 },
        { id: 'workshop', name: 'Workshop', last_message: last(msgs.workshop).body, last_ts: last(msgs.workshop).ts, mentions: false, unread: 0 },
      ]; }
      case 'get_members': return [{ pubkey: UNI, name: 'Uni' }, { pubkey: ROBIN, name: 'Robin Vale' }, { pubkey: ME, name: 'You' }];
      case 'get_messages': {
        // __notePane.slowBig: a window bigger than a room's first 300 answers late, so the smaller one lands first
        if (w.__notePane.slowBig && (args?.limit ?? 300) > 300) await new Promise((r) => setTimeout(r, 800));
        return args?.root ? [] : (msgs[args?.channel] ?? []).slice(-(args?.limit ?? 300));
      }
      case 'load_older': if (args?.channel === 'archive' && !olderLoaded) { olderLoaded = true; return 120; } return 0;
      case 'refresh': return { pubkey: ME, total_items: 0, channel_errors: {}, truncated_channels: [] };
      case 'post_message': {
        const list = msgs[args.channel] ??= [];
        const m = msg(args.channel, 1000 + sent++, ME, 'You', args.body);
        list.push(m);
        w.__notePane.sent.push({ channel: args.channel, body: args.body });
        return m;
      }
      case 'vault_list': return ['uni'];
      case 'journal_list': case 'journal_pending': return [];
      case 'journal_flush': return { sent: [], failed: [] };
      case 'vault_note': {
        const key = Object.keys(notes).find((k) => k === args.noteRef || notes[k].path === args.noteRef);
        if (args.vault !== 'uni' || !key) throw `vault: note not found: ${args.noteRef}`;
        const n = notes[key];
        const links = Object.keys(notes).filter((k) => n.content.includes(`[[${notes[k].path}]]`)).map((k) => ({ sourceId: key, targetId: k, targetNote: { id: k, path: notes[k].path } }));
        return { hub: HUB, vault: 'uni', note: { id: key, path: n.path, content: n.content, extension: 'md', createdAt: '2026-03-10T09:00:00Z', updatedAt: '2026-03-14T09:00:00Z', tags: [], links } };
      }
      // T-204: what the Save dialog or Android's Downloads would get, as a real browser download of these bytes under this name.
      case 'note_download': {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([new TextEncoder().encode(args.text)], { type: 'text/markdown' }));
        a.download = args.name;
        document.body.append(a); a.click(); a.remove();
        return `~/Downloads/${args.name}`;
      }
      default: return null;
    }
  };
  // Android's Back button: the app listens through the app plugin; __notePane.back() presses it.
  const callbacks = new Map<number, (m: unknown) => void>();
  const backListeners = new Map<number, { n: number }>();
  let nextCallback = 1;
  w.__notePane.back = () => { for (const [cid, l] of backListeners) callbacks.get(cid)?.({ index: l.n++, message: {} }); return backListeners.size; };
  w.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback: (cb: (m: unknown) => void) => { const cid = nextCallback++; callbacks.set(cid, cb); return cid; },
    unregisterCallback: (cid: number) => { callbacks.delete(cid); },
    invoke: async (cmd: string, args: any) => {
      if (cmd === 'plugin:app|register_listener' && args?.event === 'back-button') { backListeners.set(args.handler.id, { n: 0 }); return null; }
      if (cmd === 'plugin:app|remove_listener' && args?.event === 'back-button') { backListeners.delete(args.channelId); return null; }
      return cmd.startsWith('plugin:') ? null : answer(cmd, args);
    },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
}
