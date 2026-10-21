// T-229: the Calendar place against a fake calendar door. The app's `cal_*` commands are Rust commands that sign and
// send each request (crates/uni-core/src/cal.rs, its tests in crates/uni-core/tests/cal_door.rs); here the command layer
// forwards each one as the HTTP request the Rust client makes, and the test process answers it from a FakeDoor built
// from the shared fixture (scripts/calFakeDoor.ts), one per test. Errors come back in the Rust client's shapes: 401/403
// not_allowed, 409 stale with current_rev, 502-504 server, anything else refused; a door that can't be reached is
// `unreachable`. Every command is kept in window.__calls.
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { FakeDoor, type Fixture, type Role } from '../calFakeDoor.ts';

export const FIXTURE: Fixture = JSON.parse(readFileSync(new URL('../fixtures/cal-sample-events.json', import.meta.url), 'utf8'));
/** Wed 2026-10-21, 10:00 in Denver: inside the fixture's week (Mon 19 – Sun 25). */
export const NOW = new Date('2026-10-21T16:00:00Z');

export type Door = { door: FakeDoor; down: boolean; refuse: boolean };

export async function boot(page: Page, opts: { role?: Role; conflict?: boolean; noSession?: boolean; open?: boolean } = {}): Promise<Door> {
  const d: Door = { door: new FakeDoor(FIXTURE, { role: opts.role, conflict: opts.conflict }), down: false, refuse: false };
  d.door.noSession = !!opts.noSession;
  await page.clock.setFixedTime(NOW);
  await page.route('**/__door/**', async (route) => {
    if (d.down) return route.abort('connectionrefused');
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/__door/, '') + url.search;
    if (d.refuse) return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'pubkey not allowed' }) });
    const r = d.door.handle(req.method(), path, req.method() === 'POST' ? req.postDataJSON() : undefined);
    await route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body) });
  });
  await page.addInitScript(([open]) => {
    const w = window as any;
    if (open) localStorage.setItem('uni.tabs.v1', JSON.stringify({ v: 1, tabs: [{ id: 'cal', kind: 'calendar', title: 'Calendar' }], active: 'cal', recent: ['cal'] }));
    w.__calls = [] as { cmd: string; args: any }[];
    const door = async (method: string, path: string, body?: unknown) => {
      let r: Response;
      try { r = await fetch(`/__door${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
      catch { throw { kind: 'unreachable', message: 'https://uni-1.example.ts.net:8490 is not answering (tailnet only)' }; }
      const j = await r.json().catch(() => null);
      if (r.ok) return j;
      const message = j?.error ?? `error ${r.status}`;
      if (r.status === 401 || r.status === 403) throw { kind: 'not_allowed', message, pubkey: 'a'.repeat(64) };
      if (r.status === 409) throw { kind: 'stale', message, current_rev: j?.current_rev ?? null };
      if (r.status >= 502 && r.status <= 504) throw { kind: 'server', message };
      throw { kind: 'refused', status: r.status, message };
    };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } }, transformCallback: () => 1,
      invoke: async (cmd: string, args: any) => {
        w.__calls.push({ cmd, args });
        switch (cmd) {
          case 'cal_session': return door('GET', '/cal/v1/session');
          case 'cal_events': return door('GET', `/cal/v1/events?from=${args.from}&to=${args.to}`);
          case 'cal_event': return door('GET', `/cal/v1/event/${args.id}`);
          case 'cal_conflicts': return door('GET', '/cal/v1/conflicts');
          case 'cal_op': return door('POST', '/cal/v1/op', args.op);
          case 'identity_status': return { paired: true, pubkey: 'a'.repeat(64) };
          case 'get_identity': return 'a'.repeat(64);
          case 'get_rooms': case 'get_messages': case 'get_members': case 'vault_paths': case 'journal_pending': case 'journal_list': case 'vault_list': return [];
          case 'journal_flush': return { sent: [], remaining: 0, error: null };
          case 'journal_config': return { hub: 'https://example.invalid', vault: 'uni' };
          case 'refresh': return { pubkey: 'a'.repeat(64), total_items: 0, channel_errors: {}, truncated_channels: [] };
          case 'mail_parked': throw { kind: 'unreachable', message: 'no mail here' };
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, [opts.open !== false] as const);
  await page.goto('/');
  return d;
}

export const width = (page: Page) => page.viewportSize()?.width ?? 1440;
export const isPhone = (page: Page) => width(page) < 600;
/** The event panel sits beside the grid (else it covers it). */
export const beside = (page: Page) => width(page) >= 1000;
export const cal = (page: Page) => page.getByRole('region', { name: 'Calendar' }).last();
export const ops = (d: Door) => d.door.log.filter((l) => l.method === 'POST').map((l) => l.body);

export async function pickView(page: Page, v: 'Day' | 'Week' | 'Agenda') {
  const name = v === 'Week' && isPhone(page) ? '3 days' : v;
  await cal(page).getByRole('tab', { name, exact: true }).click();
  await expect(cal(page).getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
}

/** An event's button by its title, in whichever view is showing. */
export const ev = (page: Page, title: string | RegExp) => cal(page).locator('.cal-main').getByRole('button', { name: typeof title === 'string' ? new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')},`) : title });

export const detail = (page: Page) => page.getByRole('dialog', { name: /^Event: / });

/** CAL_SHOTS=<dir>: keep a screenshot of each step, for looking at (never committed). */
export async function shot(page: Page, name: string) {
  const dir = process.env.CAL_SHOTS;
  if (dir) await page.screenshot({ path: `${dir}/${test.info().project.name}-${name}.png` });
}

/** No sideways scroll anywhere in the place. */
export async function noSidewaysScroll(page: Page) {
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(over).toBeLessThanOrEqual(0);
}
