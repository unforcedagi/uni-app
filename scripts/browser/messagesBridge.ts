// T-278: the app's Tauri IPC, pointed at the Messages dev bridge (crates/uni-messages, bin uni-messages-dev). The
// `messages_*` commands go to the same Rust core the app's Tauri commands call, signed into a real homeserver; the
// `messages://update` event comes from the bridge's event stream. Only the shell's own startup commands are answered
// here, as mailMock.ts answers them, so the app boots without a hub. A page is one profile: one person.
import type { Page } from '@playwright/test';

export type Bridge = { url: string; token: string };

export async function boot(page: Page, profile: string, bridge: Bridge) {
  await page.addInitScript(([profile, url, token]) => {
    const w = window as any;
    localStorage.setItem('uni.tabs.v1', JSON.stringify({ v: 1, tabs: [{ id: 'messages', kind: 'messages', title: 'Messages' }], active: 'messages', recent: ['messages'] }));
    localStorage.setItem('uni.messages.seen.v1', '1');
    w.__calls = [] as string[];
    const callbacks = new Map<number, (e: unknown) => void>();
    const listeners = new Map<number, { event: string; handler: number }>();
    let nextId = 1;
    let stream: EventSource | null = null;
    const base = `${url}/p/${profile}`;
    // the bridge's stream is open before `listen` resolves, as Tauri's listener is registered before it resolves
    const openStream = () => new Promise<void>((resolve) => {
      if (stream) { resolve(); return; }
      stream = new EventSource(`${base}/events?token=${encodeURIComponent(token)}`);
      stream.onopen = () => resolve();
      stream.onmessage = (m) => {
        const payload = JSON.parse(m.data);
        for (const [id, l] of listeners) if (l.event === 'messages://update') callbacks.get(l.handler)?.({ event: l.event, id, payload });
      };
    });
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: (cb: (e: unknown) => void) => { const id = nextId++; callbacks.set(id, cb); return id; },
      invoke: async (cmd: string, args: any) => {
        w.__calls.push(cmd);
        // opening a file is the system's: a browser has nothing to hand it to (T-313)
        if (cmd === 'messages_open_file') return null;
        if (cmd.startsWith('messages_')) {
          const r = await fetch(`${base}/invoke/${cmd}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(args ?? {}) });
          // T-313: an attachment's bytes come back raw, as the app's command answers them (an ArrayBuffer)
          if (r.ok && cmd === 'messages_media') return await r.arrayBuffer();
          const body = await r.json().catch(() => null);
          if (!r.ok) throw body ?? { kind: 'server', message: `bridge answered ${r.status}` };
          return body;
        }
        switch (cmd) {
          case 'plugin:event|listen': {
            const id = nextId++;
            listeners.set(id, { event: args.event, handler: args.handler });
            if (args.event === 'messages://update') await openStream();
            return id;
          }
          case 'plugin:event|unlisten': listeners.delete(args.eventId); return null;
          case 'identity_status': return { paired: true, pubkey: 'a'.repeat(64) };
          case 'get_identity': return 'a'.repeat(64);
          case 'get_rooms': case 'get_messages': case 'get_members': case 'vault_paths': case 'journal_pending': case 'journal_list': case 'vault_list': return [];
          case 'journal_flush': return { sent: [], remaining: 0, error: null };
          case 'journal_config': return { hub: 'https://example.invalid', vault: 'uni' };
          case 'refresh': return { pubkey: 'a'.repeat(64), total_items: 0, channel_errors: {}, truncated_channels: [] };
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: (_event: string, id: number) => listeners.delete(id) };
  }, [profile, bridge.url, bridge.token] as const);
  await page.goto('/');
}
