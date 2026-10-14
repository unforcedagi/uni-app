// Harness for opening ANY Parachute vault in the browser build: the Tauri IPC is mocked in the page (as in areasFixture.ts),
// but every `vault_*` command is forwarded to a real Parachute server's REST API (a scratch vault; see SV_ENV), so the tree, the
// task lists and the `state_transition` check-off run against real vault data and schema. The Buzz side (rooms, messages) is empty.
import { readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

export type ScratchEnv = { port: number; tokens: Record<string, string>; ids: Record<string, string> };
export const scratchEnv = (): ScratchEnv => JSON.parse(readFileSync(process.env.SV_ENV ?? '/nonexistent', 'utf8'));

const enc = encodeURIComponent;
/** Maps the app's vault commands to the vault's REST API (the same queries the Rust door sends over MCP). */
export function vaultBridge(env: ScratchEnv, log: { cmd: string; args: any }[]) {
  const api = async (vault: string, path: string, init: { method?: string; body?: unknown } = {}) => {
    const r = await fetch(`http://127.0.0.1:${env.port}/vault/${vault}/api${path}`, { method: init.method ?? 'GET', headers: { Authorization: `Bearer ${env.tokens[vault]}`, 'Content-Type': 'application/json' }, body: init.body ? JSON.stringify(init.body) : undefined });
    const text = await r.text();
    if (!r.ok) throw `${r.status} ${text}`.replace(/"error_type":"(\w+)"/, '[$1]');
    return text ? JSON.parse(text) : null;
  };
  const list = async (vault: string, qs: string) => { const b = await api(vault, `/notes?${qs}`); return Array.isArray(b) ? b : b.notes; };
  const near = (root: string, tasks: boolean) => `near[note_id]=${enc(root)}&near[relationship]=parent&near[direction]=inbound&near[depth]=5${tasks ? '&near[then][relationship]=node&near[then][direction]=inbound' : ''}`;
  return async (cmd: string, args: any): Promise<unknown> => {
    log.push({ cmd, args });
    const v = args?.vault as string;
    switch (cmd) {
      case 'vault_list': return Object.keys(env.tokens);
      case 'vault_paths': return (await list(v, 'limit=500')).map((n: any) => ({ id: n.id, path: n.path, extension: n.extension, updatedAt: n.updatedAt }));
      case 'vault_query': return list(v, `tag=${enc(args.tag)}&include_content=${args.includeContent !== false}&limit=${args.limit ?? 100}&sort=asc`);
      case 'vault_query_meta': {
        const m = args.metadata ?? {}; const parts = Object.entries(m).map(([k, c]: [string, any]) => `meta[${k}][in]=${enc(c.in.join(','))}`);
        return list(v, `tag=${enc(args.tag)}&${parts.join('&')}&limit=${args.limit ?? 100}`);
      }
      case 'vault_subtree_nodes': return list(v, `tag=node&limit=200&${near(args.root, false)}`);
      case 'vault_subtree_tasks': return list(v, `tag=${enc(args.tag)}&meta[state][in]=${enc(args.states.join(','))}&limit=${args.limit ?? 200}&${near(args.root, true)}`);
      case 'vault_transition': return api(v, `/notes/${enc(args.id)}`, { method: 'PATCH', body: { state_transition: { field: 'state', from: args.from, to: args.to }, if_updated_at: args.ifUpdatedAt } });
      case 'vault_patch_meta': return api(v, `/notes/${enc(args.id)}`, { method: 'PATCH', body: { metadata: args.metadata, if_updated_at: args.ifUpdatedAt } });
      case 'vault_note': { const n = await api(v, `/notes/${enc(args.noteRef)}`); return { hub: 'http://scratch.invalid', vault: v, note: n.note ?? n }; }
      case 'vault_search': return [];
      default: return undefined; // handled by the page-side mock
    }
  };
}

/** Put the seeded tasks back to their seed states, so a run is repeatable (scratch vault only). */
export async function resetSeed(env: ScratchEnv) {
  const seed: Record<string, string> = { 'Book a dentist visit': 'open', 'Walk every morning': 'doing', 'Review the contract': 'waiting', 'Write release notes': 'open', 'Tag the build': 'open' };
  const h = { Authorization: `Bearer ${env.tokens.lifeos}`, 'Content-Type': 'application/json' };
  const rows = await (await fetch(`http://127.0.0.1:${env.port}/vault/lifeos/api/notes?tag=task&limit=50`, { headers: h })).json();
  for (const n of rows) {
    const want = seed[n.path.replace('Tasks/', '')];
    if (want && n.metadata.state !== want) await fetch(`http://127.0.0.1:${env.port}/vault/lifeos/api/notes/${n.id}`, { method: 'PATCH', headers: h, body: JSON.stringify({ state_transition: { field: 'state', from: n.metadata.state, to: want } }) });
  }
}

export async function bootAnyVault(page: Page, opts: { savedVault?: string } = {}) {
  const env = scratchEnv();
  const log: { cmd: string; args: any }[] = [];
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.exposeFunction('__vaultCall', async (cmd: string, args: any) => {
    try { return { ok: await vaultBridge(env, log)(cmd, args) ?? null }; } catch (e) { return { err: String(e) }; }
  });
  await page.addInitScript((d) => {
    const w = window as any;
    w.__calls = []; w.__cbs = []; w.__listeners = {};
    if (d.savedVault) localStorage.setItem('uni.lifeos.vault', d.savedVault);
    const U = 'a'.repeat(64);
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback: (cb: any) => { w.__cbs.push(cb); return w.__cbs.length - 1; },
      invoke: async (cmd: string, args: any) => {
        w.__calls.push({ cmd, args });
        if (cmd.startsWith('vault_')) { const r = await w.__vaultCall(cmd, args); if ('err' in r) throw r.err; return r.ok; }
        switch (cmd) {
          case 'webview_runtime': return 'wry test tauri test';
          case 'plugin:app|version': return 'dev';
          case 'plugin:app|register_listener': w.__backHandler = args.handler; return null;
          case 'plugin:event|listen': (w.__listeners[args.event] ??= []).push(args.handler); return args.handler;
          case 'identity_status': return { paired: true, pubkey: U };
          case 'get_identity': return U;
          case 'get_npub': return 'test';
          case 'get_rooms': return [];
          case 'get_messages': case 'journal_pending': case 'journal_list': case 'search_messages': return [];
          case 'get_members': return [{ pubkey: U, name: 'Me', named: true }];
          case 'journal_config': return { hub: 'http://scratch.invalid', vault: 'uni' };
          case 'journal_flush': return { sent: [], remaining: 0, error: null };
          case 'relay_origin': return 'wss://relay.test';
          case 'refresh': return { pubkey: U, total_items: 0, channel_errors: {}, truncated_channels: [] };
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { savedVault: opts.savedVault ?? null });
  await page.goto('/');
  return { log, errors, env };
}
export { expect };
