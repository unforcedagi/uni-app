// T-335: the To post queue, with Rust faked (`vault_query` for tag `post`, `post_approve`, `post_drop`, `post_edit`; the
// real ones are proven end to end by toPostLive.spec.ts). The front door shows one quiet count; the queue shows each
// post as it will look with whose voice it is; Approve, Schedule, Edit and Not this each make exactly one call naming
// the post and the revision shown; a post in Uni's words for Aaron's account can't be approved. Synthetic text only.
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const meta = (m: Record<string, unknown>) => ({ state: 'proposed', platform: 'bluesky', piece: '', media: [], ...m });
const POSTS = [
  { id: 'post-uni', path: 'Posts/build log', tags: ['post'], updatedAt: '2026-10-29T10:00:01.000Z',
    metadata: meta({ account: 'uni', provenance: 'uni', body: 'Uni build log, week 44: 12 tests went red before the fix, 0 after. Notes: https://example.com/log/44', why: 'The weekly build log.', crosspost: ['x'] }) },
  { id: 'post-mine', path: 'Posts/excerpt', tags: ['post'], updatedAt: '2026-10-29T10:00:02.000Z',
    metadata: meta({ account: 'aaron', provenance: 'aaron-excerpt', piece: 'https://example.com/pieces/slow-work', body: '“The garden doesn’t hurry.” https://example.com/pieces/slow-work' }) },
  { id: 'post-wrong', path: 'Posts/wrong voice', tags: ['post'], updatedAt: '2026-10-29T10:00:03.000Z',
    metadata: meta({ account: 'aaron', provenance: 'uni', body: 'A sentence Uni wrote, proposed for the wrong account.' }) },
  { id: 'post-done', path: 'Posts/done', tags: ['post'], updatedAt: '2026-10-28T10:00:00.000Z',
    metadata: meta({ account: 'uni', provenance: 'uni', state: 'posted', body: 'An older post.', posted_url: 'https://example.com/p/1', posted_at: '2026-10-28T10:00:00Z', crosspost: ['x'], crosspost_x_failed: 'X 503: Service Unavailable' }) },
];

async function boot(page: Page) {
  await page.addInitScript((posts) => {
    const w = window as any; w.__posts = JSON.parse(JSON.stringify(posts));
    const find = (id: string) => w.__posts.find((p: any) => p.id === id);
    const write = (id: string, at: string, m: Record<string, unknown>) => {
      const p = find(id); if (!p || p.updatedAt !== at) throw 'conflict: the post changed since you read it; look again';
      Object.assign(p.metadata, m); p.updatedAt = new Date().toISOString(); return p;
    };
    w.__extraInvoke = async (cmd: string, args: any) => {
      if (cmd === 'vault_query' && args.tag === 'post') return w.__posts.map((p: any) => ({ ...p, metadata: { ...p.metadata } }));
      // T-335: Rust's unlock grace; an Approve that passed starts one, as the real device unlock would
      if (cmd === 'unlock_grace') return w.__grace ?? null;
      if (cmd === 'post_approve') w.__grace = 300;
      if (cmd === 'post_approve') return write(args.id, args.ifUpdatedAt, { state: 'approved', approved_at: new Date().toISOString(), scheduled_for: args.scheduledFor ? new Date(args.scheduledFor * 1000).toISOString() : null });
      if (cmd === 'post_drop') return write(args.id, args.ifUpdatedAt, { state: 'dropped' });
      if (cmd === 'post_edit') return write(args.id, args.ifUpdatedAt, find(args.id).metadata.account === 'aaron' ? { body: args.text, provenance: 'aaron-typed' } : { feedback: args.text, state: 'dropped' });
      return undefined;
    };
  }, POSTS);
  await bootAreas(page, 'seed', { tree: true, tasks: true, briefs: true });
  await page.locator('[data-place="front-door"]').waitFor();
}
const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.filter((x: any) => x.cmd === c).map((x: any) => x.args), cmd);
const card = (page: Page, text: string) => page.locator('.tp-card').filter({ hasText: text });

test('the front door counts what waits; the queue shows each post as it will look, whose voice it is, and what it may do', async ({ page }) => {
  await boot(page);
  const line = page.getByRole('button', { name: 'To post · 3' });
  await expect(line).toBeVisible();
  if (process.env.T335_SHOTS) await page.screenshot({ path: `${process.env.T335_SHOTS}/${test.info().project.name}-front-door.png` });
  await line.click();
  const q = page.getByRole('region', { name: 'To post' });
  await expect(q.getByRole('heading', { name: 'To review · 3' })).toBeVisible();
  const uni = card(page, 'Uni build log');
  await expect(uni.locator('.tp-badge')).toHaveText('◆ Uni\'s voice');
  // one approval covers Bluesky and its copy on X: the card names both, and counts against the tighter limit
  await expect(uni.locator('.tp-where')).toHaveText('Bluesky + X · Uni\'s account');
  await expect(uni.locator('.tp-count')).toHaveText(/^\d+\/280$/);
  await expect(uni.locator('.tp-body a')).toHaveText('example.com/log/44');
  const mine = card(page, 'The garden doesn’t hurry');
  await expect(mine.locator('.tp-badge')).toHaveText('● Your voice');
  await expect(mine.locator('.tp-piece')).toContainText('example.com/pieces/slow-work');
  // Uni's words proposed for Aaron's account: no Approve, no Schedule
  const wrong = card(page, 'wrong account');
  await expect(wrong.locator('.tp-blocked')).toHaveText('Uni\'s words never go out under your name.');
  await expect(wrong.getByRole('button', { name: 'Approve' })).toBeDisabled();
  await expect(wrong.getByRole('button', { name: 'Schedule' })).toBeDisabled();
  await expect(page.locator('.tp-posted')).toContainText('Posted · open');
  // the X copy failed: said on its own line; the Bluesky post stands (the poster never posts it again)
  await expect(page.locator('.tp-posted .tp-failed')).toHaveText('The X copy didn\'t post: X 503: Service Unavailable');
  if (process.env.T335_SHOTS) await page.locator('.tp-posted').screenshot({ path: `${process.env.T335_SHOTS}/${test.info().project.name}-x-copy-failed.png` });
  if (process.env.T335_SHOTS) await page.screenshot({ path: `${process.env.T335_SHOTS}/${test.info().project.name}-queue.png`, fullPage: true });
});

test('Approve, Schedule, Edit and Not this each make one call naming the post and the revision shown', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'To post · 3' }).click();
  await card(page, 'Uni build log').getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Approved. It goes out within a minute.' })).toBeVisible();
  expect(await calls(page, 'post_approve')).toEqual([{ vault: 'uni', id: 'post-uni', ifUpdatedAt: '2026-10-29T10:00:01.000Z' }]);
  await expect(page.getByRole('heading', { name: 'Going out · 1' })).toBeVisible();
  await expect(card(page, 'Uni build log').locator('.tp-status')).toHaveText('Approved · goes out within a minute');

  // Schedule: a time from a minute ahead, then Approve for then
  const mine = card(page, 'The garden doesn’t hurry');
  await mine.getByRole('button', { name: 'Schedule' }).click();
  const when = new Date(Date.now() + 2 * 86400_000); when.setSeconds(0, 0);
  const local = new Date(when.getTime() - when.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  await mine.locator('input[type="datetime-local"]').fill(local);
  if (process.env.T335_SHOTS) { await mine.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${process.env.T335_SHOTS}/${test.info().project.name}-schedule.png` }); }
  await mine.getByRole('button', { name: 'Approve for then' }).click();
  await expect(page.getByRole('heading', { name: 'Going out · 2' })).toBeVisible();
  const sched = (await calls(page, 'post_approve'))[1];
  expect(sched).toEqual({ vault: 'uni', id: 'post-mine', ifUpdatedAt: '2026-10-29T10:00:02.000Z', scheduledFor: Math.floor(when.getTime() / 1000) });
  await expect(card(page, 'The garden doesn’t hurry').locator('.tp-status')).toHaveText(/^Goes out /);

  // Not this on an approved post
  await card(page, 'Uni build log').getByRole('button', { name: 'Not this' }).click();
  await expect(page.getByRole('heading', { name: 'Going out · 1' })).toBeVisible();
  expect((await calls(page, 'post_drop'))[0]).toMatchObject({ id: 'post-uni' });
  expect(await calls(page, 'post_approve')).toHaveLength(2);
});

test('Edit on Aaron\'s post takes his words; on Uni\'s post it is a note to Uni, never words under Uni\'s name', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'To post · 3' }).click();
  const uni = card(page, 'Uni build log');
  await uni.getByRole('button', { name: 'Edit' }).click();
  await expect(uni.locator('.tp-form label')).toContainText('A note to Uni');
  if (process.env.T335_SHOTS) { await uni.locator('textarea').fill('Shorter, and drop the second number.'); await page.screenshot({ path: `${process.env.T335_SHOTS}/${test.info().project.name}-edit-note.png` }); }
  await uni.locator('textarea').fill('Shorter, and drop the second number.');
  await uni.getByRole('button', { name: 'Send to Uni' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Sent to Uni.' })).toBeVisible();
  expect((await calls(page, 'post_edit'))[0]).toEqual({ vault: 'uni', id: 'post-uni', ifUpdatedAt: '2026-10-29T10:00:01.000Z', text: 'Shorter, and drop the second number.' });
  await expect(card(page, 'Uni build log')).toHaveCount(0); // back to Uni to rewrite
  const mine = card(page, 'wrong account');
  await mine.getByRole('button', { name: 'Edit' }).click();
  await expect(mine.locator('.tp-form label')).toContainText('Your words');
  await mine.locator('textarea').fill('My own sentence, typed by me.');
  await mine.getByRole('button', { name: 'Save' }).click();
  await expect(card(page, 'My own sentence, typed by me.').locator('.tp-badge')).toHaveText('● Your voice');
  await expect(card(page, 'My own sentence, typed by me.').getByRole('button', { name: 'Approve' })).toBeEnabled();
});

test('after an Approve, the other posts it could approve say "Unlocked · 5 min", and only while Rust says so', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'To post · 3' }).click();
  const mine = card(page, 'The garden doesn’t hurry');
  await expect(mine.getByRole('button', { name: 'Approve' })).toBeVisible();
  await expect(page.locator('.cc-grace')).toHaveCount(0);
  await card(page, 'Uni build log').getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Approved. It goes out within a minute.' })).toBeVisible();
  await expect(mine.locator('.cc-grace')).toHaveText('Unlocked · 5 min');
  // a post that can't be approved never says it
  await expect(card(page, 'wrong account').locator('.cc-grace')).toHaveCount(0);
  if (process.env.T335_SHOTS) { await mine.scrollIntoViewIfNeeded(); await page.screenshot({ path: `${process.env.T335_SHOTS}/${test.info().project.name}-post-unlocked.png` }); }
  // the webview only names the post: whether it asks for the unlock is Rust's
  expect(await calls(page, 'post_approve')).toEqual([{ vault: 'uni', id: 'post-uni', ifUpdatedAt: '2026-10-29T10:00:01.000Z' }]);
  await page.evaluate(() => { (window as any).__grace = null; window.dispatchEvent(new Event('focus')); });
  await expect(mine.locator('.cc-grace')).toHaveCount(0);
});
