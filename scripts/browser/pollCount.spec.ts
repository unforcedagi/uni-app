// T-335 one reader: how many times the home reads the vault while it sits open. The made-up For you world (forYouFixture.ts) boots on a
// fake clock; after the first load settles, ten minutes pass with the window visible, and every vault call the page makes is counted by
// command and tag. The reads go through one module (src/vault/reader.ts) with one poller, so each kind is read once a minute, not once per
// screen part that wants it. Run: FORYOU_TEST_PORT=17631 npx playwright test --config playwright.foryou.config.ts pollCount --project desktop
import { test, expect, type Page } from '@playwright/test';
import { bootForYou } from './forYouFixture';

type Call = { cmd: string; args: Record<string, any> };
const vaultCalls = (page: Page) => page.evaluate(() => ((window as any).__calls as Call[]).filter((c) => c.cmd.startsWith('vault_')).map((c) => ({ cmd: c.cmd, args: c.args })));
/** A call by its command, tag and the shape of its filter (a run read's date window counts as one query whatever its dates). */
const key = (c: Call) => `${c.cmd}${c.args?.tag ? ` ${c.args.tag}` : ''}${c.args?.metadata ? ` ${JSON.stringify(c.args.metadata).replace(/"\d{4}-[^"]*"/g, '"<t>"')}` : ''}`;
const tally = (calls: Call[]) => { const m: Record<string, number> = {}; for (const c of calls) m[key(c)] = (m[key(c)] ?? 0) + 1; return m; };

test('the open home reads each kind once a minute, through one poller', async ({ page }) => {
  await page.clock.install();
  await bootForYou(page);
  await expect(page.getByRole('region', { name: 'For you' })).toBeVisible();
  await page.clock.runFor(5_000);
  const atBoot = await vaultCalls(page);
  await page.evaluate(() => { (window as any).__calls.length = 0; });
  await page.clock.runFor(10 * 60_000);
  const after = await vaultCalls(page);
  const t = tally(after);
  console.log(`poll count: boot ${atBoot.length} calls ${JSON.stringify(tally(atBoot))}; ten open minutes ${after.length} calls ${JSON.stringify(t)}`);
  // the bound: one poller, a minute apart, reading node, the live tasks, the open decisions, the cards, the runs and the drafts at most
  // once per tick (a tick that falls on the edge may add one); a second engine or a second timer would double some of them
  for (const [k, n] of Object.entries(t)) expect(n, k).toBeLessThanOrEqual(11);
  // main before the one reader (f73d4697): 182 calls in these ten minutes (two timers, the nodes read three times a minute, five run windows
  // every 30 s); through the one reader: 78
  expect(after.length).toBeLessThanOrEqual(85);
});
