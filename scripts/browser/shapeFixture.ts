// T-335 the shape: a made-up world for the new shell (home = rooms, a room with its strip, the journal, the applets drawer, search where you
// are), with the Tauri side faked in the page. It mirrors the approved prototype's data (~/Code/wt/shape-proto/site/data.js): every name,
// line, address and date here is invented (example.com / example.invalid only). Nothing leaves the page: the fake relay and vault record
// every call in `window.__calls`.
// - Rooms: Uni, Riverbend Commons, Garden co-op site, Studio, Teaching: Design 2, To Post, House, Arcade night, plus a private room
//   ("sanctum", the fixtures' private area) with a run and an ask that must never show outside it, and a retired room the registry hides.
// - Two live runs (Uni's and the garden's) whose notes carry their story; asks in Uni, Riverbend, Studio and To Post; one of Uni's approval
//   cards in Riverbend that expires in nine minutes; journal entries; To Post's posts; Calendar through the calendar door double
//   (scripts/calFakeDoor.ts, as scripts/browser/calMock.ts serves it); Mail through scripts/browser/mailMock.ts when asked for.
import { readFileSync } from 'node:fs';
import type { Page } from '@playwright/test';
import { FakeDoor } from '../calFakeDoor';
import { FIXTURE } from './calMock';
import { boot as bootMail } from './mailMock';

export const ME = 'a'.repeat(64);
export const UNI = 'c'.repeat(64);
/** The made-up Claude accounts note (Settings shows it first). */
const USAGE = JSON.parse(readFileSync(new URL('../fixtures/usage-note.json', import.meta.url), 'utf8'));
/** A note cited from an ask's context by its bare id (`uni:<id>`): it opens as a note. */
export const PLOT_NOTE = '01JC0FFEE0PXATMAP000000000';
export const ROOM = {
  uni: 'ch-uni', river: 'ch-river', garden: 'ch-garden', studio: 'ch-studio', teach: 'ch-teach', post: 'ch-post', house: 'ch-house', arcade: 'ch-arcade',
  quiet: 'ch-quiet', barn: 'ch-barn', family: 'ch-family',
} as const;

export type ShapeOpts = {
  /** Start in this room (as if the app was last left there). */ room?: string;
  /** Mail through the mail bridge double (held sends and an unread Inbox): the Mail tile counts them. */ mail?: boolean;
  /** Times the fake relay refuses a post before it takes one. */ postFails?: number;
  /** Times the fake vault refuses an ask's write (a close or a patch) before it takes one. */ writeFails?: number;
  /** A run in a public room (the garden's) that waits on you for the private room's ask T-605: its words must never leave that room. */ leakRun?: boolean;
  /** T-335 cards expand: more cards in Riverbend (a production card an ask points at, a long plain one, an expired one, one the broker ended
   *  with an ask still pointing at it). */ cards?: boolean;
};

/** T-335 cards expand: the extra cards' message ids (card event ids are hex; an ask names one by its first 12 or more). */
export const CARD = { prod: 'ab12cd34ef56' + '1'.repeat(52), long: 'bc23de45fa67' + '2'.repeat(52), old: 'cd34ef56ab78' + '3'.repeat(52), ended: 'de45fa67bc89' + '4'.repeat(52) };

export async function bootShape(page: Page, o: ShapeOpts = {}) {
  // the calendar door double, served to the page as calMock serves it
  const door = new FakeDoor(FIXTURE, {});
  await page.route('**/__door/**', async (route) => {
    const req = route.request(), url = new URL(req.url());
    const r = door.handle(req.method(), url.pathname.replace(/^\/__door/, '') + url.search, req.method() === 'POST' ? req.postDataJSON() : undefined);
    await route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  await page.addInitScript(({ ME, UNI, ROOM, o, USAGE, PLOT_NOTE, CARD }) => {
    const w = window as any;
    const now = Date.now(), nowS = Math.floor(now / 1000), min = 60, H = 3600;
    const iso = (sAgo: number) => new Date((nowS - sAgo) * 1000).toISOString();
    w.__calls = [];
    w.__postFails = o.postFails ?? 0;
    w.__writeFails = o.writeFails ?? 0;
    // the old home's saved places never decide where this world opens (the mail double saves Mail as an old tab)
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (k: string, v: string) { if (k === 'uni.tabs.v1') return; return setItem.call(this, k, v); };
    if (o.room && !localStorage.getItem('uni.tabs.v2')) localStorage.setItem('uni.tabs.v2', JSON.stringify({ v: 1, tabs: [{ id: 'start', kind: 'all', title: 'Uni', channel: o.room }], active: 'start', recent: ['start'] }));

    // ── the relay: rooms and their messages ──
    const msg = (ref: string, channel: string, who: string, sAgo: number, body: string) => ({ ref, channel, author: who === 'me' ? ME : who === 'Uni' ? UNI : 'd'.repeat(63) + who.length, author_name: who === 'me' ? 'Robin' : who, ts: nowS - sAgo, body,
      mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] });
    const fence = (prose: string) => `${prose}\nOpen this in the Uni app to see exactly what it unlocks.\n\n\`\`\`uni-sealed-approval\n{"v": 1}\n\`\`\``;
    const msgs: Record<string, any[]> = {
      [ROOM.uni]: [msg('u1', ROOM.uni, 'Uni', 62 * min, 'The garden site build finished; the plot map is in preview.'), msg('u2', ROOM.uni, 'me', 58 * min, "Nice. Can you tidy this week's notes into a summary?"),
        msg('u3', ROOM.uni, 'Uni', 57 * min, "On it. A worker is tidying the week's notes."), msg('u4', ROOM.uni, 'Uni', 3 * min, 'Two things moved while you were out; one waits on you.')],
      [ROOM.river]: [msg('r1', ROOM.river, 'Mira Okafor', 70 * min, 'Thanks for the draft budget. The board liked the phasing.'),
        msg('rb-card', ROOM.river, 'Uni', 66 * min, fence('🔑 **Uni asks to send the October invoice** (routine)')),
        msg('r3', ROOM.river, 'Mira Okafor', 11 * min, 'Can we move the walkthrough to Thursday?')],
      [ROOM.garden]: [msg('g1', ROOM.garden, 'me', 95 * min, 'The plot labels overlap on a phone. Can a worker fix the map page?'), msg('g2', ROOM.garden, 'Worker', 18 * min, 'Pushed the new plot map to the preview.')],
      [ROOM.studio]: [msg('s1', ROOM.studio, 'Uni', 3 * H, 'Cut 2 had the music too loud under the voice. Lowering it 4 dB.'), msg('s2', ROOM.studio, 'Uni', 52 * min, 'Cut 3 of the river film is up. 64 seconds.')],
      [ROOM.teach]: [msg('t1', ROOM.teach, 'Theo Lindqvist', 150 * min, 'Uploaded the critique rubric for week 9.'), msg('t2', ROOM.teach, 'Uni', 144 * min, "It's in the course folder. I added it to Thursday's class note.")],
      [ROOM.post]: [msg('p1', ROOM.post, 'Uni', 3 * H, 'One post waits for your signature.')],
      [ROOM.house]: [msg('h1', ROOM.house, 'Juno Park', 26 * H, 'Boiler service booked for the 18th.'), msg('h2', ROOM.house, 'me', 25 * H, 'Thank you!')],
      [ROOM.arcade]: [msg('a1', ROOM.arcade, 'Sol Ferreira', 72 * H, 'New high score on Lantern. Beat that.')],
      [ROOM.quiet]: [msg('q1', ROOM.quiet, 'me', 5 * H, 'Sat for twenty minutes.')],
      [ROOM.family]: [msg('f1', ROOM.family, 'me', 8 * H, 'Dinner at six on Sunday.')],
      [ROOM.barn]: [msg('b1', ROOM.barn, 'Uni', 90 * 24 * H, 'This room is closed.')],
    };
    if (o.cards) {
      const river = msgs[ROOM.river];
      river.splice(river.length - 1, 0,
        msg(CARD.ended, ROOM.river, 'Uni', 64 * min, '✓ Approved 13:10 · Open Site (site.example) — PRODUCTION account · loads the history into the archive'),
        msg(CARD.old, ROOM.river, 'Uni', 50 * min, fence('Uni asks to rotate the mailing key.')),
        msg(CARD.long, ROOM.river, 'Uni', 30 * min, fence('Uni asks to send the reminders.')),
        msg(CARD.prod, ROOM.river, 'Uni', 20 * min, fence('Uni asks to deploy the import tool.')));
      river[river.length - 5].edited = true;   // the broker's edit: one line in the card's place, no fence
    }
    const NAMES: Record<string, string> = { [ROOM.uni]: 'Uni', [ROOM.river]: 'Riverbend Commons', [ROOM.garden]: 'Garden co-op site', [ROOM.studio]: 'Studio', [ROOM.teach]: 'Teaching: Design 2',
      [ROOM.post]: 'To Post', [ROOM.house]: 'House', [ROOM.arcade]: 'Arcade night', [ROOM.quiet]: 'sanctum', [ROOM.barn]: 'old-barn', [ROOM.family]: 'Family table' };
    const UNREAD: Record<string, number> = { [ROOM.river]: 2, [ROOM.teach]: 1 };
    const rooms = () => Object.keys(NAMES).map((id) => { const l = msgs[id][msgs[id].length - 1]; return { id, name: NAMES[id], last_message: l ? `**${l.author_name}:** ${l.body}` : null, last_ts: l?.ts ?? null, mentions: false, unread: UNREAD[id] ?? 0, dm: false }; });
    w.__msgs = msgs;

    // ── the vault: asks (tasks that need you), runs, posts, the rooms registry, journal entries, a few notes ──
    const task = (id: string, title: string, sAgo: number, m: Record<string, unknown>, content = '') => ({ id, path: `Tasks/${title}`, tags: ['task'], createdAt: iso(2 * H), updatedAt: iso(sAgo),
      content, metadata: { state: 'open', owner: 'aaron', needs_aaron: true, ...m } });
    // an ask's context as tasks.py writes it at the end of its body (## Why, ## Steps, ## Links, ## Time, ## Already answered)
    const context = (why: string, steps: string[], links: string[], time: string) => `Asked from its room.\n\n## Why\n\n${why}\n\n## Steps\n\n${steps.map((x, i) => `${i + 1}. ${x}`).join('\n')}\n\n## Links\n\n${links.map((l) => `- ${l}`).join('\n')}\n\n## Time\n\n${time}\n\n## Already answered\n\nChecked the rooms and the vault: nothing yet.\n`;
    w.__tasks = [
      task('ask-summary', 'T-601 The weekly summary is ready to read', 3 * min, { kind: 'tell', no_default: true, reply_room: 'Uni', why_now: 'Read it now, or save it for Sunday.', next: 'Read the summary of the week' },
        context("Sunday's review starts from it; three loose ends need a home.", ['Open the summary', 'Say Seen when you have read it'],
          ['The draft: https://example.com/notes/week-45', `The plot map: uni:${PLOT_NOTE}`], 'About five minutes.')),
      task('ask-walk', 'T-602 Offer Mira Thursday at 2 for the walkthrough?', 11 * min, { kind: 'choose', options: ['Yes, Thursday 2pm', 'Friday instead'], no_default: true, reply_room: 'Riverbend Commons', reply_root: 'r3', why_now: 'Your Thursday is free from 1 to 4.' }),
      task('ask-cut', 'T-603 Cut 3 is ready to watch', 52 * min, { kind: 'look', no_default: true, link: 'https://example.com/studio/cut-3', reply_room: 'Studio' }),
      task('ask-sign', 'T-604 Sign What the garden taught us and post it?', 3 * H, { kind: 'choose', options: ['Sign and post', 'Not yet'], no_default: true, reply_room: 'To Post' }),
      task('ask-quiet', 'T-605 A quiet line that stays in its room', 4 * H, { kind: 'tell', no_default: true, reply_room: 'sanctum' }),
      // a room private by the rooms registry only (its name says nothing)
      task('ask-family', 'T-606 A family line that stays at the table', 4 * H, { kind: 'tell', no_default: true, reply_room: 'Family table' }),
      // the same private room by its old name, which no room on this device has (it must not land in Uni's room)
      task('ask-kitchen', 'T-607 A kitchen line that stays private', 4 * H, { kind: 'tell', no_default: true, reply_room: 'kitchen table' }),
      // a private place's ask with no private room of its own on this device: drawn nowhere, only counted on home
      task('ask-away', 'T-608 A line for a place this device lacks', 4 * H, { kind: 'tell', no_default: true, node: '[[Areas/Sanctum/Away]]' }),
      // a do ask (only you can do it), old enough to leave House's place on home as it is; a run in Teaching waits on you for it
      task('ask-key', 'T-609 Paste the boiler portal key', 30 * H, { kind: 'do', no_default: true, reply_room: 'House', why_now: 'The service visit on the 18th needs the portal open.',
        next: 'Paste the portal key into the boiler page' },
        context('Only you can sign in to the boiler portal.', ['Sign in at the portal', 'Copy the key', 'Paste it into the boiler page'], ['The portal: https://example.com/boiler'], 'Two minutes.')),
    ];
    if (o.cards) w.__tasks.push(
      // the ask whose card waits: "Tap the PRODUCTION card" names it (sealed_card: the card's first 12 hex)
      task('ask-deploy', 'T-610 Deploy the import tool to the site', 15 * min, { kind: 'do', no_default: true, reply_room: 'Riverbend Commons', why_now: 'Staging passed; the archive window closes Friday.',
        next: 'Tap the PRODUCTION card in Riverbend that deploys the import tool', sealed_card: CARD.prod.slice(0, 12) }),
      // the ask whose card the broker already ended: it must say so, not send him looking for it
      task('ask-load', 'T-611 Load the history into the archive', 14 * min, { kind: 'do', no_default: true, reply_room: 'Riverbend Commons', why_now: 'The import tool is live.',
        next: 'Tap the second card in Riverbend that loads the history', sealed_card: CARD.ended }));
    const run = (id: string, title: string, channel: string, room: string, sAgo: number, md: Record<string, unknown>, body: string) => ({ id, path: `Runs/2026-11-10 ${title}`, tags: ['run'], createdAt: iso(sAgo), updatedAt: iso(60),
      content: `# ${title}\n\n${body}\n\n---\n\nRun on [[Uni]], worker \`mts-${id}\`.\n`, metadata: { state: 'running', channel, room, attempt: id, worker: `mts-${id}`, started_at: iso(sAgo), doing_at: iso(60), ...md } });
    const notes: any[] = [
      run('run-tidy', "Tidying the week's notes", ROOM.uni, 'Uni', 57 * min, { live_line: 'Reading 14 notes from this week', doing_now: 'Reading notes' },
        "**Working now:** Reading 14 notes from this week\n\nRead the brief: summarise this week's notes, link from Sunday.\n\nGrouped them by place; three loose ends found."),
      run('run-plot', 'Rebuilding the plot map page', ROOM.garden, 'Garden co-op site', 94 * min, { live_line: 'Building the preview', doing_now: 'Building' },
        '**Working now:** Building the preview\n\nReproduced the overlap at 390 px wide. Moved labels outside the small plots.'),
      run('run-family', 'Seating plan', ROOM.family, 'Family table', 30 * min, { live_line: 'Family words about the seating' }, '**Working now:** Family words about the seating'),
      run('run-key', 'Setting up the boiler page', ROOM.teach, 'Teaching: Design 2', 30 * H, { state: 'blocked', waiting_on: 'aaron', waiting_for: 'The boiler portal key', task: 'T-609', ended_at: iso(29 * H) },
        '**Blocked after 40 min. Waiting on Aaron:** the boiler portal key.'),
      ...(o.leakRun ? [run('run-leak', 'Checking the shed lock', ROOM.garden, 'Garden co-op site', 40 * min, { state: 'blocked', waiting_on: 'aaron', waiting_for: 'The shed code', task: 'T-605', ended_at: iso(30 * min) },
        '**Blocked after 10 min. Waiting on Aaron:** the shed code.')] : []),
      run('run-quiet', 'A quiet practice log', ROOM.quiet, 'sanctum', 20 * min, { live_line: 'Private words about the practice', doing_now: 'Writing' }, '**Working now:** Private words about the practice'),
      { id: 'rooms-registry', path: 'System/Rooms', tags: [], createdAt: iso(30 * 24 * H), updatedAt: iso(H), content: '',
        metadata: { registry: { rooms: { uni: { id: ROOM.uni }, sanctum: { id: ROOM.quiet, private: true }, 'family table': { id: ROOM.family, private: true, was: ['kitchen table'] } }, retired: { 'old-barn': { none: true } }, folded_ids: {} } } },
      { id: 'n-rubric', path: 'Teaching/Week 9 critique rubric', tags: [], createdAt: iso(3 * H), updatedAt: iso(3 * H), content: "The rubric for Thursday's critique: clarity, care, and one risk taken." },
      { id: 'n-plot', path: 'Garden/Plot map', tags: [], createdAt: iso(24 * H), updatedAt: iso(24 * H), content: 'Thirty-eight plots, labels outside the small ones.' },
      { id: PLOT_NOTE, path: 'Garden/Plot map, printed', tags: [], createdAt: iso(24 * H), updatedAt: iso(24 * H), content: 'The printed plot map for the shed wall.' },
      USAGE,
    ];
    const post = (id: string, title: string, sAgo: number, m: Record<string, unknown>) => ({ id, path: `Posts/${title}`, tags: ['post'], updatedAt: iso(sAgo), metadata: { platform: 'bluesky', piece: '', media: [], account: 'aaron', provenance: 'uni', ...m } });
    const posts = [
      post('post-garden', 'What the garden taught us', 3 * H, { state: 'proposed', account: 'uni', body: 'This season the co-op grew more than beans. We learned to plan in plots, to share tools, and to let a map be wrong for a week.' }),
      post('post-river', 'Riverbend phasing in plain words', 30 * H, { state: 'posted', account: 'uni', body: 'Phase one starts in spring.', posted_url: 'https://example.com/p/phasing', posted_at: iso(30 * H) }),
    ];
    const journal = [
      { id: 'j1', path: 'Journal/2026/11-10/07-40 Frost', created_at: iso(5 * H), content: 'Slow start. Tea on the step, frost on the bean poles. One window, things moving quietly behind it.', source: 'text', entry_id: 'e1' },
      { id: 'j2', path: 'Journal/2026/11-09/21-10 Board', created_at: iso(22 * H), content: 'The board said yes to the phasing. Mira was glad. Thank Theo for covering class on Thursday.', source: 'text', entry_id: 'e2' },
      { id: 'j3', path: 'Journal/2026/11-09/12-05 Weir', created_at: iso(31 * H), content: 'Walked the river path for the film. The light at the weir is the shot.', source: 'text', entry_id: 'e3' },
    ];
    const vaultNotes = () => [...notes, ...journal.map((j) => ({ id: j.id, path: j.path, tags: ['journal'], content: j.content, createdAt: j.created_at, updatedAt: j.created_at, metadata: {} }))];

    // ── Uni's approval card in Riverbend: it expires nine minutes from now ──
    const expires = nowS + 9 * min;
    const card = { kind: 'single', event_id: 'e'.repeat(64), refused: null, rows: [{ rid: 'r1'.padEnd(32, '0'), action: 'invoice.send', credential: 'billing', class: 'routine', scope: 'Send the October invoice to billing@riverbend.example',
      ttl_s: 600, uses: 1, payload: null, request_digest: '9b13b2ae' + 'f'.repeat(56), expires, answer: null }] };
    // T-335 cards expand: the production card (broker-worded, powerful), a long plain one, an expired one
    const reach = '🔴 Open Site (site.example) — PRODUCTION account · changes what the public reaches · 10 min';
    const cards: Record<string, any> = {
      [CARD.prod]: { kind: 'single', event_id: CARD.prod, refused: null, rows: [{ rid: 'r2'.padEnd(32, '0'), action: 'job.cloudflare', credential: 'cf-site', class: 'powerful',
        scope: `${reach}\nCan: deploy Workers scripts on site.example.\nUni says: Deploy the history import tool`, ttl_s: 600, uses: 1, payload: { purpose: 'Deploy the history import tool', job: 'site-deploy' },
        request_digest: '7c4e19d2' + 'a'.repeat(56), expires: nowS + 40 * min, answer: null, asked: nowS - 20 * min, reach, always_unlock: true }] },
      [CARD.long]: { kind: 'single', event_id: CARD.long, refused: null, rows: [{ rid: 'r3'.padEnd(32, '0'), action: 'mail.send', credential: 'billing', class: 'routine',
        scope: "Send the October invoice and the two overdue reminders to billing@riverbend.example, with the phasing summary attached as a PDF for the board's Thursday meeting",
        ttl_s: 600, uses: 3, payload: null, request_digest: '5d6e7f80' + 'b'.repeat(56), expires: nowS + 50 * min, answer: null, asked: nowS - 30 * min }] },
      [CARD.old]: { kind: 'single', event_id: CARD.old, refused: 'This card has expired.', rows: [] },
    };
    const waiting = () => (w.__cardAnswered ? [] : [{ ref: 'rb-card', channel: ROOM.river, root: null, ts: nowS - 66 * min, kind: 'single', credential: 'billing', action: 'invoice.send', class: 'routine', rows: 1, expires, fingerprint: '9b13b2ae' }]);

    const matches = (m: any, f: any) => Object.entries(f ?? {}).every(([k, c]: [string, any]) => {
      const v = m?.[k];
      if (c && typeof c === 'object') return (c.eq === undefined || v === c.eq) && (!c.in || c.in.includes(v)) && (!c.gte || (typeof v === 'string' && v >= c.gte)) && (!c.lt || (typeof v === 'string' && v < c.lt));
      return v === c;
    });
    const page = (rows: any[], a: any) => JSON.parse(JSON.stringify(rows.slice(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? 200))));
    const bumpRev = (t: any) => { t.updatedAt = new Date(Date.now() + 1).toISOString(); };
    const door = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(`/__door${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      const j = await r.json().catch(() => null);
      if (r.ok) return j;
      throw { kind: 'refused', status: r.status, message: j?.error ?? `error ${r.status}` };
    };
    const SNIP = (s: string, q: string) => { const i = s.toLowerCase().indexOf(q.toLowerCase()); return i < 0 ? s : `${s.slice(0, i)}${s.slice(i, i + q.length)}${s.slice(i + q.length)}`; };

    let mailInvoke: ((cmd: string, args: any) => Promise<any>) | null = null;
    const mine = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: (cb: any) => { (w.__cbs ??= []).push(cb); return w.__cbs.length - 1; },
      invoke: async (cmd: string, args: any) => {
        (w.__calls ??= []).push({ cmd, args });
        if (cmd.startsWith('mail_')) { if (mailInvoke) return mailInvoke(cmd, args); throw { kind: 'unreachable', message: 'no mail bridge in this world' }; }
        switch (cmd) {
          case 'webview_runtime': return 'wry test tauri test';
          case 'plugin:app|version': return 'dev';
          case 'plugin:app|register_listener': w.__backHandler = args.handler; return null;
          case 'plugin:event|listen': (w.__listeners ??= {}); (w.__listeners[args.event] ??= []).push(args.handler); return args.handler;
          case 'identity_status': return { paired: true, pubkey: ME };
          case 'get_identity': return ME;
          case 'get_npub': return 'npub1test';
          case 'relay_origin': return 'wss://relay.example.invalid';
          case 'refresh': return { pubkey: ME, total_items: 0, channel_errors: {}, truncated_channels: [] };
          case 'get_rooms': return rooms();
          case 'get_messages': return JSON.parse(JSON.stringify(args.root ? [] : (msgs[args.channel] ?? []).slice(-(args.limit ?? 300))));
          case 'get_members': return [{ pubkey: ME, name: 'Robin', named: true }, { pubkey: UNI, name: 'Uni', named: true }];
          case 'mark_read': UNREAD[args.channel] = 0; return null;
          case 'approval_messages': return [];
          case 'secret_requesters': return [];
          case 'unlock_grace': return null;
          case 'sealed_waiting': return waiting();
          case 'sealed_card': return args.reference === 'rb-card' ? JSON.parse(JSON.stringify(card)) : o.cards && cards[args.reference] ? JSON.parse(JSON.stringify(cards[args.reference])) : null;
          case 'sealed_answer': {
            const t = Math.floor(Date.now() / 1000);
            card.rows = card.rows.map((r: any) => (args.rids.includes(r.rid) ? { ...r, answer: { decision: args.decision, at: t, until: args.decision === 'approve' ? t + r.ttl_s : null, sent: true } } : r));
            w.__cardAnswered = true;
            return JSON.parse(JSON.stringify(card));
          }
          case 'post_message': {
            if (w.__postFails > 0) { w.__postFails--; throw 'relay unreachable: connection refused'; }
            const ref = 'sent-' + w.__calls.length;
            (msgs[args.channel] ??= []).push({ ...msg(ref, args.channel, 'me', 0, args.body) });
            return { ref, channel: args.channel };
          }
          case 'vault_list': return ['uni', 'field-notes'];
          case 'vault_paths': return [];
          case 'journal_config': return { hub: 'https://example.invalid', vault: 'uni' };
          case 'journal_list': return journal.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 50));
          case 'journal_pending': return [];
          case 'journal_flush': return { sent: [], remaining: 0, error: null };
          case 'vault_note': {
            const n = [...vaultNotes(), ...w.__tasks].find((x) => x.id === args.noteRef || x.path === args.noteRef);
            if (!n) throw 'note not found: ' + args.noteRef;
            return { hub: 'https://example.invalid', vault: args.vault ?? 'uni', note: { createdAt: iso(H), tags: [], metadata: {}, ...JSON.parse(JSON.stringify(n)) } };
          }
          case 'vault_query': {
            if (args.vault && args.vault !== 'uni') return [];
            if (args.tag === 'post') return page(posts, args);
            if (args.tag === 'task') return page(w.__tasks, args);
            return page(notes.filter((n) => (n.tags ?? []).includes(args.tag)), args);
          }
          case 'vault_query_meta': {
            if (args.vault && args.vault !== 'uni') return [];
            if (args.tag === 'task') return page(w.__tasks.filter((t: any) => matches(t.metadata, args.metadata)), args);
            return page(notes.filter((n) => (n.tags ?? []).includes(args.tag) && matches(n.metadata, args.metadata)), args);
          }
          case 'vault_transition': {
            if (w.__writeFails > 0) { w.__writeFails--; throw 'vault unreachable: connection refused'; }
            const t = w.__tasks.find((x: any) => x.id === args.id);
            if (!t) throw 'note not found: ' + args.id;
            if (t.metadata.state !== args.from) throw `[transition_conflict] conflict: state is ${t.metadata.state}, not ${args.from}`;
            if (args.ifUpdatedAt !== t.updatedAt) throw 'conflict: note has been modified';
            Object.assign(t.metadata, args.metadata ?? {}, { state: args.to, needs_aaron: false }); bumpRev(t);
            return JSON.parse(JSON.stringify(t));
          }
          case 'vault_patch_meta': {
            if (w.__writeFails > 0) { w.__writeFails--; throw 'vault unreachable: connection refused'; }
            const t = w.__tasks.find((x: any) => x.id === args.id);
            if (!t) throw 'note not found: ' + args.id;
            if (args.ifUpdatedAt !== t.updatedAt) throw 'conflict: note has been modified';
            Object.assign(t.metadata, args.metadata); bumpRev(t);
            return JSON.parse(JSON.stringify(t));
          }
          case 'search': {
            const q = String(args.query).toLowerCase();
            return Object.values(msgs).flat().filter((m: any) => m.body.toLowerCase().includes(q)).map((m: any) => ({ message: m, channel_name: NAMES[m.channel], snippet: SNIP(m.body, args.query) }));
          }
          case 'vault_search': {
            if (args.vault && args.vault !== 'uni') return [];
            const q = String(args.query).toLowerCase();
            return vaultNotes().filter((n) => String(n.content ?? '').toLowerCase().includes(q) && (!args.pathPrefix || n.path.startsWith(args.pathPrefix)))
              .slice(0, args.limit ?? 20).map((n) => ({ vault: 'uni', id: n.id, path: n.path, snippet: n.content, score: null, mode: 'keyword' }));
          }
          case 'cal_session': return door('GET', '/cal/v1/session');
          case 'cal_events': return door('GET', `/cal/v1/events?from=${args.from}&to=${args.to}`);
          case 'cal_event': return door('GET', `/cal/v1/event/${args.id}`);
          case 'cal_conflicts': return door('GET', '/cal/v1/conflicts');
          case 'messages_status': return { state: 'signed_out' };
          case 'messages_rooms': return [];
          case 'open_link': return null;
          case 'pair_source_available': return true;
          default: return null;
        }
      },
    };
    // the mail double (when booted) installs its own; this world keeps the page's Tauri and hands it only the mail commands
    Object.defineProperty(w, '__TAURI_INTERNALS__', { configurable: true, get: () => mine, set: (v: any) => { mailInvoke = v?.invoke ?? null; } });
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { ME, UNI, ROOM, o, USAGE, PLOT_NOTE, CARD });
  if (o.mail) await bootMail(page, 'ok', { held: true });
  else await page.goto('/');
}

/** A live event from the relay (the rooms list is read again on every one). */
export const live = (page: Page, payload: Record<string, unknown> = { kind: 'rooms', channel: null, status: null, author: null }) =>
  page.evaluate((p) => { const w = window as any; for (const h of w.__listeners?.['uni://live'] ?? []) w.__cbs[h]?.({ event: 'uni://live', id: 1, payload: p }); }, payload);

export const calls = (page: Page, cmd?: string) => page.evaluate((c) => ((window as any).__calls as { cmd: string; args: any }[]).filter((x) => !c || x.cmd === c), cmd ?? null);
