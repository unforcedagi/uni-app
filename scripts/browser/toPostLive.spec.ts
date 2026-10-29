// T-335 live: one post approved in the To post queue goes out to a real Bluesky server (the loopback test PDS) and is
// then taken down. Nothing is faked on the path that matters: the Approve tap runs the app's own Rust signer
// (VaultClient::post_approve, via scripts/t335/bridge.py) against a scratch Parachute hub, uni-post (uni-ops) checks the
// signature and posts, and the takedown is uni-post's own delete. Only the Tauri shell is replaced by the IPC mock.
// Run by uni-ops post/e2e.py, which starts every server and sets T335_BRIDGE and T335_TEXT. Synthetic text only.
import { test, expect } from '@playwright/test';
import { bootAreas } from './areasFixture';

const BRIDGE = process.env.T335_BRIDGE ?? '';
const TEXT = process.env.T335_TEXT ?? '';
test.skip(!BRIDGE || !TEXT, 'run by uni-ops post/e2e.py (needs T335_BRIDGE and T335_TEXT)');

const bridge = async (path: string, body: unknown) => {
  const r = await fetch(`${BRIDGE}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json();
};

test('Approve in the queue posts it on the Bluesky server; the takedown removes it', async ({ page }) => {
  test.setTimeout(240_000);
  // the page's CSP keeps it from calling other ports, so the bridge is reached from the test process
  await page.exposeFunction('__t335', (cmd: string, args: unknown) => bridge('/invoke', { cmd, args }));
  await page.addInitScript(() => {
    const w = window as any;
    w.__extraInvoke = async (cmd: string, args: any) => {
      if (!(cmd === 'vault_query' && args.tag === 'post') && !cmd.startsWith('post_') && cmd !== 'open_link') return undefined;
      if (cmd === 'open_link') { w.__opened = args.url; return null; }
      const r = await w.__t335(cmd, args);
      if (!r.ok) throw r.error;
      return r.result;
    };
  });
  await bootAreas(page, 'seed', { tree: true, tasks: true, briefs: true });
  await page.locator('[data-place="front-door"]').waitFor();
  await page.getByRole('button', { name: /^To post · \d+$/ }).click();
  const card = page.locator('.tp-card').filter({ hasText: TEXT });
  await expect(card.locator('.tp-badge')).toHaveText('◆ Uni\'s voice');
  const shots = process.env.T335_SHOTS;
  if (shots) await page.screenshot({ path: `${shots}/live-01-queue.png` });
  await card.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Approved. It goes out within a minute.' })).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/live-02-approved.png` });
  // uni-post checks the signature and posts; the queue shows it once the note says so
  await expect(async () => {
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.locator('.tp-card.tp-posted').filter({ hasText: TEXT }).locator('.tp-status')).toHaveText('Posted · open', { timeout: 3000 });
  }).toPass({ timeout: 150_000, intervals: [2000] });
  const id = await page.evaluate((t) => (window as any).__calls.filter((c: any) => c.cmd === 'post_approve').map((c: any) => c.args.id)[0], TEXT);
  const posted = await bridge('/record', { id });
  expect(posted.text).toBe(TEXT);
  expect(posted.uri).toMatch(/^at:\/\/did:plc:[a-z0-9]+\/app\.bsky\.feed\.post\/[a-z0-9]+$/);
  if (shots) await page.screenshot({ path: `${shots}/live-03-posted.png` });
  // the takedown: uni-post delete <note>
  const down = await bridge('/takedown', { id });
  expect(down.ok, down.out).toBe(true);
  expect((await bridge('/record', { id })).text).toBeNull();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.tp-card.tp-taken-down').filter({ hasText: TEXT }).locator('.tp-status')).toHaveText('Taken down');
  if (shots) await page.screenshot({ path: `${shots}/live-04-taken-down.png` });
});
