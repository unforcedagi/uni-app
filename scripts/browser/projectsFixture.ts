// T-302: the native side, played for the projects flows. The real web build of the app runs against a vault held in the page (node, run
// and task notes, the Claude accounts note), seven rooms with their talk, and a room "Uni" that does what an action message asks the way
// the real one does with mts: a Stop closes the run note as stopped, an Archive sets the project's status. Nothing leaves the page.
//
// `bootProjects(page)` plays the made-up world (projectsWorld.ts). `bootProjects(page, { live })` plays a read of the real vault taken
// moments before (scripts/browser/projectsLive.py writes it outside the repo): the same notes, read-only, and nothing can be posted.
import type { Page } from '@playwright/test';
import { demoTalk, demoVault, DEMO_AREAS, slugOf } from './projectsWorld.ts';
import { workFrom } from '../../src/projects/live.ts';

export type LiveRead = { nodes: any[]; runs: any[]; tasks: any[]; usage: any | null; rooms: { id: string; name: string }[]; feeds?: any[] };
/** `bigRuns`: this many more finished runs, a month old, listed before every other run (a ledger longer than the pages the app reads). */
export type Boot = { live?: LiveRead; bigRuns?: number;
  /** this many more tasks, listed before every other task (a task list longer than the pages the app reads) */ bigTasks?: number;
  /** T-304: more run notes, made from the clock at boot */ moreRuns?: (now: number) => any[] };

export async function bootProjects(page: Page, opts: Boot = {}) {
  const now = Date.now();
  // the account has its (archived) Uni room, as the real one does: the app opens on the front door, not on that room
  const world = opts.live ?? { ...demoVault(now), rooms: [{ id: 'demo-uni', name: 'uni' }, ...DEMO_AREAS.map((a) => ({ id: a.room, name: slugOf(a.name) }))] };
  // what the room's Uni needs to find a session from the message's words: its one line, as the app shows it
  const asks = Object.fromEntries(workFrom({ nodes: world.nodes, runs: world.runs, tasks: world.tasks }).sessions.map((s) => [s.id, s.ask]));
  if (opts.bigRuns) {
    const old = new Date(now - 30 * 86_400_000).toISOString(), done = new Date(now - 30 * 86_400_000 + 600_000).toISOString();
    world.runs = [...Array.from({ length: opts.bigRuns }, (_, i) => ({ id: `run-old-${i}`, path: `Runs/2026-09-20 Old tidy ${i}`, tags: ['run'], metadata: { node: 'p-seeds', state: 'done', started_at: old, ended_at: done, summary: 'mts aaaabbbb: completed' }, createdAt: old, updatedAt: done })), ...world.runs];
  }
  if (opts.moreRuns) world.runs = [...world.runs, ...opts.moreRuns(now)];
  if (opts.bigTasks) world.tasks = [...Array.from({ length: opts.bigTasks }, (_, i) => ({ id: `t-old-${i}`, path: `Tasks/T-${5000 + i} Old placeholder ${i}`, tags: ['task'], metadata: { node: 'p-seeds', state: 'done', owner: 'uni' }, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' })), ...world.tasks];
  const data = { now, world, asks, talk: opts.live ? [] : demoTalk(now), readOnly: !!opts.live };
  await page.addInitScript((d: any) => {
    const w = window as any;
    // round 3 test seams: sessionStorage 't.identity' signs in as another key; 't.offline' fails the work's reads (node, run, task), 't.hang'
    // never answers them;
    // window.__holdRuns holds run reads until __releaseRuns(); __world is the vault, to change a note mid-test
    const ME = sessionStorage.getItem('t.identity') ?? 'a'.repeat(64), UNI = 'c'.repeat(64);
    const notes = d.world;
    w.__world = notes;
    w.__posted = [];
    w.__held = [];
    w.__releaseRuns = () => { w.__holdRuns = false; for (const r of w.__held.splice(0)) r(); };
    const offline = (tag: string) => (sessionStorage.getItem('t.offline') === '1' && ['node', 'run', 'task'].includes(tag)) || (sessionStorage.getItem('t.tasksfail') === '1' && tag === 'task');
    const hold = async (tag: string) => {
      // 't.hang': the work's reads never answer (a network that hangs rather than fails)
      if (sessionStorage.getItem('t.hang') === '1' && ['node', 'run', 'task'].includes(tag)) await new Promise(() => {});
      if (tag === 'run' && w.__holdRuns) await new Promise((r) => w.__held.push(r));
    };
    const msgs: Record<string, any[]> = {};
    const toMsg = (m: any) => ({ ref: m.ref, channel: m.channel, author: m.mine ? ME : UNI, author_name: m.mine ? 'Robin' : 'Uni', ts: m.ts, body: m.body, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] });
    for (const m of d.talk) (msgs[m.channel] ??= []).push(toMsg(m));
    const cbs: any[] = []; const listeners: Record<string, number[]> = {};
    const live = (channel: string, author: string) => { for (const h of listeners['uni://live'] ?? []) cbs[h]?.({ event: 'uni://live', id: 1, payload: { kind: 'message', channel, status: null, author } }); };
    let n = 0;
    const say = (channel: string, mine: boolean, body: string) => { const m = toMsg({ ref: `live-${++n}`, channel, mine, ts: Math.floor(Date.now() / 1000), body }); (msgs[channel] ??= []).push(m); live(channel, m.author); return m; };
    // T-304: you ask in a room and its Uni takes it (👀 on your message): a turn under way, until __reply
    w.__turn = (channel: string, body: string) => { const m = say(channel, true, body); m.reactions = [{ emoji: '👀', count: 1, mine: null, by: [{ pubkey: UNI, ts: m.ts + 1 }] }]; return m.ref; };
    w.__reply = (channel: string, body: string) => say(channel, false, body).ref;
    const iso = () => new Date().toISOString();
    /** The room's Uni, doing what the message asks (as it would with mts and the vault). */
    const act = (channel: string, body: string) => {
      const stop = /^Stop the session on “(.+?)” \(started [^)]+\) on (.+)\.$/.exec(body);
      const fresh = /^Fresh start on (.+?): end the session on “(.+?)”/.exec(body);
      const archive = /^Archive the project (.+?)\./.exec(body);
      const restore = /^Bring back the project (.+?) from the archive\.$/.exec(body);
      const runFor = (ask: string) => notes.runs.find((r: any) => r.metadata.state === 'running' && d.asks[r.id] === ask);
      const nodeNamed = (name: string) => notes.nodes.find((x: any) => x.path === `Projects/${name}`);
      setTimeout(() => {
        if (stop || fresh) {
          const r = runFor(stop ? stop[1] : fresh![2]);
          if (!r) return void say(channel, false, "I couldn't find that session.");
          Object.assign(r.metadata, { state: 'failed', ended_at: iso(), summary: 'mts zzzzzzzz: stopped' }); r.updatedAt = iso();
          if (fresh) notes.runs.push({ ...r, id: r.id + '-fresh', path: r.path + ' (fresh)', metadata: { ...r.metadata, state: 'running', started_at: iso(), ended_at: undefined, summary: undefined, steps: 0, doing_now: 'Reading the handoff' } });
          say(channel, false, fresh ? 'Stopped it and started a fresh one with a handoff.' : 'Stopped it.');
        } else if (archive || restore) {
          const p = nodeNamed((archive ?? restore)![1]);
          if (!p) return;
          if (archive) for (const r of notes.runs) if (r.metadata.node === p.id && r.metadata.state === 'running') Object.assign(r.metadata, { state: 'failed', ended_at: iso(), summary: 'mts zzzzzzzz: stopped' });
          p.metadata.status = archive ? 'archived' : 'active'; p.updatedAt = iso();
          say(channel, false, archive ? 'Archived it.' : 'It is back.');
        } else say(channel, false, 'Starting it.');
      }, 600);
    };
    const rooms = () => notes.rooms.map((r: any) => { const list = msgs[r.id] ?? []; const last = list[list.length - 1]; return { id: r.id, name: r.name, unread: 0, mentions: false, last_message: last?.body ?? null, last_ts: last?.ts ?? null }; });
    const byTag = (tag: string) => tag === 'node' ? notes.nodes : tag === 'area' ? notes.nodes.filter((x: any) => x.tags.includes('area')) : tag === 'project' ? notes.nodes.filter((x: any) => x.tags.includes('project'))
      : tag === 'run' ? notes.runs : tag === 'task' ? notes.tasks : [];
    const page = (rows: any[], a: any) => JSON.parse(JSON.stringify(rows.slice(a.offset ?? 0, (a.offset ?? 0) + (a.limit ?? 100))));
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: (cb: any) => { cbs.push(cb); return cbs.length - 1; },
      convertFileSrc: (p: string) => p,
      invoke: async (cmd: string, args: any = {}) => {
        switch (cmd) {
          case 'webview_runtime': return 'test browser';
          case 'plugin:app|version': return 'dev';
          case 'plugin:app|register_listener': return null;
          case 'plugin:event|listen': (listeners[args.event] ??= []).push(args.handler); return args.handler;
          case 'plugin:event|unlisten': return null;
          case 'identity_status': return { paired: true, pubkey: ME };
          case 'get_identity': return ME;
          case 'get_npub': return 'test';
          case 'get_rooms': return rooms();
          case 'get_messages': return args.root ? [] : (msgs[args.channel] ?? []).slice(-(args.limit ?? 300));
          case 'approval_messages': return [];
          case 'get_members': return [{ pubkey: ME, name: 'Robin', named: true }, { pubkey: UNI, name: 'Uni', named: true }];
          case 'vault_paths': if (sessionStorage.getItem('t.nopaths') === '1') throw 'offline'; return [...notes.nodes, ...notes.tasks].map((x: any) => ({ id: x.id, path: x.path, extension: 'md', updatedAt: x.updatedAt }));
          case 'vault_list': return ['uni'];
          case 'vault_query': if (offline(args.tag)) throw 'offline'; await hold(args.tag); return page(byTag(args.tag), args);
          case 'vault_query_meta': {
            if (offline(args.tag)) throw 'offline';
            await hold(args.tag);
            // the indexed operators the app uses on run and task notes: eq, gte, lt and in (several on one field: all of them)
            const op: Record<string, (v: any, x: any) => boolean> = { eq: (v, x) => v === x, gte: (v, x) => v != null && v >= x, lt: (v, x) => v != null && v < x, in: (v, x) => x.includes(v) };
            const ok = (n: any) => Object.entries(args.metadata ?? {}).every(([k, c]: [string, any]) => Object.entries(c).every(([o, x]) => op[o]?.(n.metadata?.[k], x) ?? false));
            return page(byTag(args.tag).filter(ok), args);
          }
          case 'vault_subtree_nodes': return JSON.parse(JSON.stringify(notes.nodes));
          case 'vault_subtree_tasks': return [];
          case 'vault_note': {
            if (args.noteRef === 'System/Claude accounts') { if (!notes.usage) throw 'note not found'; return { hub: 'https://example.invalid', vault: 'uni', note: JSON.parse(JSON.stringify(notes.usage)) }; }
            // T-304: a session's steps note (window.__feedReads counts the reads; 't.feedfail' fails them)
            const f = (notes.feeds ?? []).find((y: any) => y.id === args.noteRef);
            if (f) { w.__feedReads = (w.__feedReads ?? 0) + 1; if (sessionStorage.getItem('t.feedfail') === '1') throw 'offline'; return { hub: 'https://example.invalid', vault: args.vault, note: JSON.parse(JSON.stringify({ ...f, extension: 'md' })) }; }
            const x = [...notes.nodes, ...notes.tasks].find((y: any) => y.id === args.noteRef || y.path === args.noteRef);
            if (!x) throw 'note not found: ' + args.noteRef;
            return { hub: 'https://example.invalid', vault: 'uni', note: { ...x, extension: 'md', content: `# ${x.path.split('/').pop()}\n` } };
          }
          case 'post_message': {
            if (d.readOnly) throw 'read-only run: nothing is posted';
            w.__posted.push({ channel: args.channel, body: args.body, recipients: args.recipients });
            const m = say(args.channel, true, String(args.body ?? ''));
            act(args.channel, String(args.body ?? ''));
            return { ref: m.ref, channel: args.channel };
          }
          case 'relay_origin': return 'wss://relay.example.invalid';
          case 'journal_config': return { hub: 'https://example.invalid', vault: 'uni' };
          case 'journal_list': case 'journal_pending': case 'search_messages': case 'search': case 'vault_search': return [];
          case 'journal_flush': return { sent: [], remaining: 0, error: null };
          case 'refresh': return { pubkey: ME, total_items: 0, channel_errors: {}, truncated_channels: [] };
          case 'pair_source_available': return false;
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, data);
}
