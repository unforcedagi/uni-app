import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

const seed = (name: string) => readFileSync(new URL(`../../areas-seed/${name}.html`, import.meta.url), 'utf8');
export const LEAK = 'http://127.0.0.1:1436/leak';

// The hostile app runs every attack from inside the frame and writes what it saw into #out.
export const HOSTILE = `<!doctype html><html><body><pre id="out">running</pre><script>
(async () => {
  const R = {}, LEAK = ${JSON.stringify(LEAK)};
  const attempt = async (k, fn) => { try { const v = await fn(); R[k] = 'LEAK:' + String(v).slice(0, 60); } catch (e) { R[k] = 'blocked:' + (e && e.name || 'error'); } };
  const settle = (make) => new Promise((res) => { const t = setTimeout(() => res('blocked:timeout'), 1500); make((v) => { clearTimeout(t); res(v); }); });
  await attempt('fetch', () => fetch(LEAK + '?fetch').then((r) => r.status));
  R.xhr = await settle((done) => { try { const x = new XMLHttpRequest(); x.open('GET', LEAK + '?xhr'); x.onload = () => done('LEAK:xhr'); x.onerror = () => done('blocked:error'); x.send(); } catch (e) { done('blocked:' + e.name); } });
  R.ws = await settle((done) => { try { const w = new WebSocket('ws://127.0.0.1:1436/ws'); w.onopen = () => done('LEAK:ws'); w.onerror = () => done('blocked:error'); w.onclose = () => done('blocked:close'); } catch (e) { done('blocked:' + e.name); } });
  R.img = await settle((done) => { const i = new Image(); i.onload = () => done('LEAK:img'); i.onerror = () => done('blocked:error'); i.src = LEAK + '?img'; });
  await attempt('topRead', () => top.location.href);
  await attempt('topWrite', () => { top.location.href = LEAK + '?nav'; return 'no-throw'; });
  await attempt('parentDoc', () => parent.document.title);
  await attempt('tauri', () => typeof window.__TAURI_INTERNALS__ !== 'undefined' ? 'present' : (() => { throw Object.assign(new Error(), { name: 'absent' }); })());
  await attempt('parentTauri', () => parent.__TAURI_INTERNALS__);
  await attempt('cookie', () => document.cookie);
  await attempt('storage', () => localStorage.length);
  await attempt('eval', () => eval('1+1'));
  await attempt('popup', () => { const w = window.open(LEAK + '?popup'); if (!w) throw Object.assign(new Error(), { name: 'null' }); return 'opened'; });
  const frame = document.createElement('iframe'); frame.src = LEAK + '?frame'; document.body.appendChild(frame);
  R.frame = await settle((done) => { frame.onload = () => done(frame.contentWindow ? 'loaded' : 'blocked:none'); frame.onerror = () => done('blocked:error'); setTimeout(() => done('blocked:not-loaded'), 1200); });

  const replies = {};
  addEventListener('message', (e) => { const m = e.data; if (m && m.bridge === 1 && m.id) (replies[m.id] = replies[m.id] || []).push(m); });
  const send = (m) => parent.postMessage(m, '*');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  send({ bridge: 1, id: 'unk', method: 'fs.read', params: { path: '/etc/passwd' } });
  send({ bridge: 1, id: 'big', method: 'channel.compose', params: { text: 'x'.repeat(9000) } });
  send({ bridge: 1, id: 'out1', method: 'note.get', params: { path: 'Areas/Atlas/Secret' } });
  send({ bridge: 1, id: 'out2', method: 'note.get', params: { path: 'Areas/Hostile/../Atlas/Secret' } });
  send({ bridge: 1, id: 'out3', method: 'note.get', params: { path: '/etc/passwd' } });
  send({ bridge: 1, id: 'extra', method: 'area.get', params: {}, sneaky: true });
  send('garbage'); send(null); send({ bridge: 1 }); send({ bridge: 1, id: 'z'.repeat(100), method: 'area.get' }); send({ bridge: 2, id: 'v2', method: 'area.get' });
  await wait(600);
  const first = (id) => (replies[id] || []).map((m) => m.error || 'result').join(',') || 'none';
  for (const id of ['unk', 'big', 'out1', 'out2', 'out3', 'extra', 'v2']) R['bridge:' + id] = first(id);
  R['bridge:longid'] = Object.keys(replies).some((k) => k.length > 64) ? 'replied' : 'none';
  R.stray = Object.keys(replies).filter((k) => !['unk', 'big', 'out1', 'out2', 'out3', 'extra', 'v2'].includes(k)).join(',') || 'none';
  for (let i = 0; i < 100; i++) send({ bridge: 1, id: 'f' + i, method: 'area.get' });
  await wait(1200);
  let okN = 0, errN = 0, other = 0;
  for (let i = 0; i < 100; i++) { const m = (replies['f' + i] || [])[0]; if (!m) other++; else if ('error' in m) errN++; else okN++; }
  R.flood = JSON.stringify({ ok: okN, err: errN, none: other });
  document.getElementById('out').textContent = JSON.stringify(R);
})();
</script></body></html>`;

export const BENIGN = `<!doctype html><html><body style="font-family:var(--sans)"><h1 id="t">…</h1><p id="n">…</p><p id="th">…</p><script>
const call = (method, params) => new Promise((res, rej) => { const id = 'b' + Math.random(); const on = (e) => { const m = e.data; if (m && m.id === id) { removeEventListener('message', on); 'error' in m ? rej(new Error(m.error)) : res(m.result); } }; addEventListener('message', on); parent.postMessage({ bridge: 1, id, method, params }, '*'); });
addEventListener('message', (e) => { if (e.data && e.data.event === 'theme') { document.getElementById('th').textContent = 'accent=' + e.data.data.accent; } });
call('area.get').then((a) => { document.getElementById('t').textContent = a.title; });
call('notes.list', { limit: 5 }).then((r) => { document.getElementById('n').textContent = r.notes.map((x) => x.title).join('|'); });
</script></body></html>`;

type Variant = 'seed' | 'test';

export async function bootAreas(page: Page, variant: Variant = 'seed') {
  const now = Math.floor(Date.now() / 1000);
  const data = {
    now, variant, hostile: HOSTILE, benign: BENIGN, techne: seed('techne'), unforced: seed('unforced'),
  };
  await page.addInitScript((d) => {
    // Tauri injects its internals into the main frame only (for_main_frame_only: true), so sandboxed frames never get them.
    if (window.top !== window) return;
    const w = window as any;
    w.__calls = [];
    const U = 'a'.repeat(64);
    const area = (id: string, name: string, status: string, ch: string, purpose: string) => ({
      id, path: `Areas/${name}`, extension: 'md', tags: ['area'], updatedAt: '2026-10-07T12:00:00Z', createdAt: '2026-09-01T00:00:00Z',
      metadata: { channel: ch, status, since: '2026-01-15' }, content: `# ${name}\n\n${purpose}\n\n## Notes\n\nSee [[Areas/${name}/Plan|the plan]].`,
    });
    const notes: any[] = [
      area('a-techne', 'Techne', 'foreground', 'ch-techne', 'The craft of building: tools, systems and the small daily practice of making things well.'),
      area('a-unf', 'Unforced Development', 'foreground', 'ch-unf', 'Client practice: facilitation, strategy and the long relationships that pay the bills.'),
      area('a-sad', 'Sanctum', 'background', 'ch-sad', 'Daily practice. Sitting, breath, and a slow return to what matters.'),
      area('a-atlas', 'Atlas', 'background', 'ch-atlas', 'A map of the commons: research, writing and the networks around it.'),
      area('a-rel', 'Relationships', 'background', '', 'The people I love and how I show up for them.'),
      area('a-exp', 'Expression', 'background', 'ch-exp', 'Writing, voice and making things for other people to see.'),
      { id: 'app-techne', path: 'Areas/Techne/app', extension: 'html', content: d.techne, updatedAt: '2026-10-07T00:00:00Z' },
      { id: 'app-unf', path: 'Areas/Unforced Development/app', extension: 'html', content: d.unforced, updatedAt: '2026-10-07T00:00:00Z' },
      { id: 'n-t1', path: 'Areas/Techne/Workbench log', extension: 'md', content: '# Workbench log\n\nTechne log body', updatedAt: new Date((d.now - 7200) * 1000).toISOString() },
      { id: 'n-t2', path: 'Areas/Techne/Plan', extension: 'md', content: '# Plan\n\nTechne plan body', updatedAt: new Date((d.now - 86400 * 3) * 1000).toISOString() },
      { id: 'n-t3', path: 'Areas/Techne/Tooling decisions', extension: 'md', content: '# Tooling\n\nbody', updatedAt: new Date((d.now - 86400) * 1000).toISOString() },
      { id: 'n-u1', path: 'Areas/Unforced Development/Q4 engagements', extension: 'md', content: '# Q4\n\nbody', updatedAt: new Date((d.now - 3600) * 1000).toISOString() },
      { id: 'n-u2', path: 'Areas/Unforced Development/Pricing', extension: 'md', content: '# Pricing\n\nbody', updatedAt: new Date((d.now - 86400 * 5) * 1000).toISOString() },
      { id: 'n-u3', path: 'Areas/Unforced Development/Proposal drafts', extension: 'md', content: '# Proposals\n\nbody', updatedAt: new Date((d.now - 86400 * 2) * 1000).toISOString() },
      { id: 'n-secret', path: 'Areas/Atlas/Secret', extension: 'md', content: '# Secret\n\nATLAS-SECRET-BODY', updatedAt: '2026-10-06T00:00:00Z' },
    ];
    if (d.variant === 'test') {
      notes.push(
        area('a-host', 'Hostile', 'foreground', 'ch-techne', 'An area whose app attacks the host.'),
        { id: 'app-host', path: 'Areas/Hostile/app', extension: 'html', content: d.hostile, updatedAt: '2026-10-07T00:00:00Z' },
        area('a-ben', 'Benign', 'foreground', 'ch-techne', 'An area whose app behaves.'),
        { id: 'app-ben', path: 'Areas/Benign/app', extension: 'html', content: d.benign, updatedAt: '2026-10-07T00:00:00Z' },
        { id: 'n-b1', path: 'Areas/Benign/Alpha', extension: 'md', content: '# Alpha', updatedAt: '2026-10-07T00:00:00Z' },
      );
    }
    const msg = (ref: string, channel: string, name: string, ago: number, body: string) => ({ ref, channel, author: name === 'Aaron' ? U : 'b'.repeat(64), author_name: name, ts: d.now - ago, body, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] });
    const msgs: Record<string, any[]> = {
      'ch-techne': [msg('t1', 'ch-techne', 'Aaron', 86400, 'Scoping the area apps: one HTML note per area, sealed frame, bridge only.'), msg('t2', 'ch-techne', 'Uni', 5400, 'Drafted the bridge reference. Compose never sends, you stay in control.'), msg('t3', 'ch-techne', 'Aaron', 1800, 'Good. Ship Techne first, then the practice dashboard.')],
      'ch-unf': [msg('u1', 'ch-unf', 'Uni', 14000, 'Two proposals are waiting on a decision about scope.'), msg('u2', 'ch-unf', 'Aaron', 600, 'I will call them Thursday.')],
      'ch-sad': [msg('s1', 'ch-sad', 'Aaron', 90000, 'Sat twenty minutes. Restless but stayed.')],
    };
    const lastOf = (c: string) => msgs[c]?.[msgs[c].length - 1];
    const room = (id: string, name: string, unread = 0) => ({ id, name, unread, mentions: false, last_message: lastOf(id)?.body ?? null, last_ts: lastOf(id)?.ts ?? null });
    const rooms = [room('uni-room', 'Uni'), room('ch-techne', 'Techne'), room('ch-unf', 'Unforced Dev'), room('ch-sad', 'Sanctum'), room('ch-atlas', 'Atlas'), room('ch-exp', 'Expression')];
    const rowOf = (n: any) => ({ id: n.id, path: n.path, extension: n.extension, updatedAt: n.updatedAt });
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback: () => 1,
      invoke: async (cmd: string, args: any) => {
        w.__calls.push({ cmd, args });
        switch (cmd) {
          case 'identity_status': return { paired: true, pubkey: U };
          case 'get_identity': return U;
          case 'get_npub': return 'test';
          case 'get_rooms': return rooms;
          case 'get_messages': return args.root ? [] : (msgs[args.channel] ?? []).slice(-(args.limit ?? 300));
          case 'get_members': return [{ pubkey: U, name: 'Aaron', named: true }];
          case 'vault_paths': return notes.map(rowOf);
          case 'vault_list': return ['uni'];
          case 'vault_note': {
            const n = notes.find((x) => x.id === args.noteRef || x.path === args.noteRef);
            if (!n) throw 'note not found: ' + args.noteRef;
            return { hub: 'https://example.invalid', vault: 'uni', note: { createdAt: '2026-09-01T00:00:00Z', tags: [], metadata: {}, ...n } };
          }
          case 'journal_config': return { hub: 'https://example.invalid', vault: 'uni' };
          case 'journal_pending': case 'journal_list': case 'search_messages': case 'vault_search': return [];
          case 'journal_flush': return { sent: [], remaining: 0, error: null };
          case 'refresh': return { pubkey: U, total_items: 0, channel_errors: {}, truncated_channels: [] };
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, data);
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Uni' })).toBeVisible();
}
