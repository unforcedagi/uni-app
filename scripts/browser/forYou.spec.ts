// 0.3.0 For you, the top of the home: three bands (Yours, Ready to look at, Moving), each item says where it is from, why now, what one tap
// does and when, and where the answer goes. One tap is one compare-and-set on the ask (state -> done, with the answer) and then Aaron's reply in
// the ask's room, under the card's post. The separate Needs-you list is gone, and nothing opens the retired `Aaron/For you` note.
// Phone 360, Daylight 828 (greyscale), desktop 1440. Made-up world only (forYouFixture.ts); the relay is the fixture's fake `post_message`.
// Run: FORYOU_TEST_PORT=17631 npx playwright test --config playwright.foryou.config.ts
import { test, expect, type Page } from '@playwright/test';
import { bootForYou as bootFolded } from './forYouFixture';

/** 0.3.1: For you is folded to its head on the home; these tests start with its bands open. */
const bootForYou = async (page: Page, opts?: Parameters<typeof bootFolded>[1]) => { await bootFolded(page, opts); await openForYou(page); };
import { openForYou, openPlaces } from './areasFixture';

const calls = (page: Page, cmd: string) => page.evaluate((c) => (window as any).__calls.map((x: any, i: number) => ({ ...x, i })).filter((x: any) => x.cmd === c), cmd);
const forYou = (page: Page) => page.getByRole('region', { name: 'For you' });
const band = (page: Page, name: string) => forYou(page).getByRole('region', { name, exact: true });
const item = (page: Page, id: string) => forYou(page).locator(`article.fy-item[data-id="${id}"]`);

test.describe('For you', () => {
  test('is the top of the home: three bands, five of yours in order, the rest behind one line', async ({ page }) => {
    await bootForYou(page);
    // there without pulling anything down (opened from its head: homeLayout.spec.ts has it folded)
    await expect(forYou(page)).toBeVisible();
    await expect(page.locator('[data-place="front-door"] .fd-pull')).toHaveAttribute('aria-expanded', 'false');
    await expect(forYou(page).locator('.fy-band > h2')).toHaveText([/^Yours/, /^Ready to look at/, /^Moving/]);
    // Yours: the earliest default first, then the oldest asked; five shown
    const yours = band(page, 'Yours');
    await expect(yours.locator('article.fy-item')).toHaveCount(5);
    expect(await yours.locator('article.fy-item').evaluateAll((els) => els.map((e) => e.getAttribute('data-id')))).toEqual(['fy-soup', 'fy-glaze', 'fy-jars', 'fy-hall', 'fy-hedge']);
    await yours.getByRole('button', { name: '1 more' }).click();
    await expect(yours.locator('article.fy-item')).toHaveCount(6);
    expect(await yours.locator('article.fy-item').evaluateAll((els) => els.slice(5).map((e) => e.getAttribute('data-id')))).toEqual(['fy-gate']);
    // the item's anatomy: where (card · area), what, why now, the default with its date, the other options, hold to talk, where it goes
    const glaze = item(page, 'fy-glaze');
    await expect(glaze.locator('.fy-where')).toHaveText('Glaze Tests · Kiln Studio');
    await expect(glaze.locator('.fy-what')).toHaveText('Pick the glaze for the test tiles');
    await expect(glaze.locator('.fy-why')).toHaveText('The tiles go in the kiln on Friday.');
    await expect(glaze.locator('.fy-default')).toHaveText(/^Celadon · \w{3} 5pm$/);
    // (T-335 Seen: every item ends with Seen)
    await expect(glaze.locator('.fy-opt')).toHaveText(['Tenmoku', 'Shino', 'Seen']);
    await expect(glaze.getByRole('button', { name: 'Hold to talk' })).toBeVisible();
    await expect(glaze.locator('.fy-goes')).toHaveText("Goes to #kiln-studio, under Glaze Tests's post");
    // no card: the node's area is where; no default: it says so, and it goes to the node's room
    const gate = item(page, 'fy-gate');
    await expect(gate.locator('.fy-where')).toHaveText('North Field');
    await expect(gate.locator('.fy-nodefault')).toHaveText('No default: waits for you');
    await expect(gate.getByRole('button', { name: 'Done' })).toBeVisible();
    await expect(gate.locator('.fy-goes')).toHaveText('Goes to #north-field');
    // 0.3.3: the archived room it names is never named; what its room hasn't asked again in a week is a count, never an item
    await expect(forYou(page)).not.toContainText(/old-barn/i);
    await expect(item(page, 'fy-stale')).toHaveCount(0);
    await expect(forYou(page)).not.toContainText('Mend the old fence');
    await expect(yours.locator('.fy-away')).toHaveText('1 waiting on its room');
    // T-335 one home: an old Decisions/ note is the record, not an ask: never in For you (though the vault returns it for `tag: task` too)
    await expect(forYou(page).locator('article.fy-item[data-id="fy-paint"]')).toHaveCount(0);
    // Ready to look at: the look ask
    await expect(band(page, 'Ready to look at').locator('article.fy-item')).toHaveCount(1);
    await expect(item(page, 'fy-look').locator('.fy-what')).toHaveText('Look at the glaze tile photos');
    // the private area: a count by place, none of its words; a room's own task and an answered ask are not here
    await expect(yours.locator('.fy-private')).toHaveText(/Sanctum: 1 thing for you/);
    await expect(forYou(page)).not.toContainText('Morning practice');
    await expect(forYou(page)).not.toContainText('Private words');
    await expect(forYou(page).locator('[data-id="fy-room"], [data-id="fy-was"]')).toHaveCount(0);
    // Moving: card lines since the last look, newest first; the private card only as its stored topic line; quiet cards counted
    const moving = band(page, 'Moving');
    await expect(moving.locator('.fy-mv .fy-mv-t')).toHaveText(['A session on daily practice: completed.', /Glaze Tests.*The test tiles came out of the kiln\./, /Honey Harvest.*Hive two was weighed/]);
    await expect(moving.locator('.fy-quiet')).toHaveText('2 cards quiet, 1 resting');
    // the head counts what is yours (0.3.1: For you's own head; the places' pull keeps the day's sentence as its label)
    await expect(forYou(page).locator('.fy-toggle')).toHaveText(/^7 for you · 1 to look at · 3 moving$/);
    await expect(page.locator('[data-place="front-door"] .fd-pull')).toHaveAttribute('aria-label', /Eight things need you\./);
  });

  test('T-335: an ask shows its context in place, folded: from its own body, or an older ask\'s context note; read once per revision', async ({ page }) => {
    await bootForYou(page);
    const glaze = item(page, 'fy-glaze');
    const ctx = glaze.locator('details.fy-ctx');
    // folded under its why: what it holds and how long it takes
    await expect(ctx.locator('summary')).toHaveText('Steps and links · About 2 minutes');
    await expect(ctx).not.toHaveAttribute('open', '');
    await expect(ctx.locator('.fy-ctx-steps li').first()).toBeHidden();
    await ctx.locator('summary').click();
    await expect(ctx.locator('.fy-ctx-why')).toHaveText('The test tiles go in the kiln on Friday and need one glaze.');
    await expect(ctx.locator('.fy-ctx-steps li')).toHaveText(['Look at the three test tiles on the shelf', 'Pick the glaze you like best']);
    await expect(ctx.locator('.fy-ctx-links a')).toHaveText('example.com');
    await expect(ctx.locator('.fy-ctx-links a')).toHaveAttribute('href', 'https://example.com/kiln/tiles');
    // an older ask with no context in its body: its context note's
    const hall = item(page, 'fy-hall').locator('details.fy-ctx');
    await expect(hall.locator('summary')).toHaveText('Steps and links · A minute');
    await hall.locator('summary').click();
    await expect(hall.locator('.fy-ctx-steps li')).toHaveText(['Say which night suits the choir']);
    // an ask with neither has nothing to open
    await expect(item(page, 'fy-soup').locator('details.fy-ctx')).toHaveCount(0);
    // each ask's note is read once for its revision: a minute of polling reads none of them again
    const reads = async () => (await calls(page, 'vault_note')).filter((c: any) => /^(fy-|ctx-)/.test(c.args.noteRef)).length;
    const before = await reads();
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(500);
    expect(await reads()).toBe(before);
  });

  test('one tap takes the default: one compare-and-set with the answer, then the reply in its room under the card\'s post', async ({ page }) => {
    await bootForYou(page);
    const glaze = item(page, 'fy-glaze');
    await glaze.locator('.fy-default').click();
    // the item folds into a quiet line
    await expect(forYou(page).getByRole('region', { name: 'Answered today' })).toContainText('Pick the glaze for the test tiles');
    await expect(forYou(page).getByRole('region', { name: 'Answered today' })).toContainText('Celadon');
    await expect(item(page, 'fy-glaze')).toHaveCount(0);
    await expect(forYou(page).getByRole('region', { name: 'Answered today' }).locator('.fy-done[data-post="sent"]')).toHaveCount(1);
    const cas = await calls(page, 'vault_transition');
    expect(cas).toHaveLength(1);
    const a = cas[0].args;
    expect({ id: a.id, from: a.from, to: a.to }).toEqual({ id: 'fy-glaze', from: 'open', to: 'done' });
    expect(a.ifUpdatedAt).toBeTruthy();
    expect(Object.keys(a.metadata).sort()).toEqual(['answer', 'answered_at', 'answered_by', 'decided', 'decided_at', 'decided_by']);
    expect(a.metadata).toMatchObject({ answer: 'Celadon', answered_by: 'aaron', decided: 'Celadon', decided_by: 'aaron' });
    expect(Date.parse(a.metadata.answered_at)).toBeGreaterThan(Date.now() - 60_000);
    // the stored note took it (the fake vault's compare-and-set)
    expect(await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 'fy-glaze').metadata.state)).toBe('done');
    // then, and only then, Aaron's reply in #kiln-studio, threaded under the card's post
    const posts = await calls(page, 'post_message');
    expect(posts).toHaveLength(1);
    expect(posts[0].i).toBeGreaterThan(cas[0].i);
    expect(posts[0].args).toMatchObject({ channel: 'ch-kiln', replyTo: 'k3', body: 'T-501: Celadon' });
    // never the composer's room picker
    await expect(page.getByText(/Choose a room|Pick a room/)).toHaveCount(0);
  });

  test('another option, and Done on an ask with no card: the reply goes to the node\'s room, not threaded', async ({ page }) => {
    await bootForYou(page);
    await item(page, 'fy-glaze').locator('.fy-opt', { hasText: 'Shino' }).click();
    await expect(item(page, 'fy-glaze')).toHaveCount(0);
    // one fewer: all five now show, with no "more" line
    await expect(band(page, 'Yours').getByRole('button', { name: /more/ })).toHaveCount(0);
    await item(page, 'fy-gate').getByRole('button', { name: 'Done' }).click();
    await expect(item(page, 'fy-gate')).toHaveCount(0);
    const cas = (await calls(page, 'vault_transition')).map((c: any) => c.args);
    expect(cas.map((c: any) => [c.id, c.metadata.answer, c.metadata.decided ?? null])).toEqual([['fy-glaze', 'Shino', 'Shino'], ['fy-gate', 'Done', null]]);
    const posts = (await calls(page, 'post_message')).map((c: any) => c.args);
    expect(posts.map((p: any) => [p.channel, p.replyTo ?? null, p.body])).toEqual([['ch-kiln', 'k3', 'T-501: Shino'], ['ch-north', null, 'T-502: Done']]);
  });

  test('a reply the relay refuses says so on the line and keeps a retry; the answer itself is kept', async ({ page }) => {
    await bootForYou(page, { postFails: 1 });
    await item(page, 'fy-soup').locator('.fy-default').click();
    const done = forYou(page).getByRole('region', { name: 'Answered today' }).locator('.fy-done');
    await expect(done).toHaveAttribute('data-post', 'failed');
    await expect(done).toContainText("Couldn't post in #long-table");
    expect((await calls(page, 'vault_transition')).length).toBe(1);
    await done.getByRole('button', { name: 'Retry' }).click();
    await expect(done).toHaveAttribute('data-post', 'sent');
    const posts = (await calls(page, 'post_message')).map((c: any) => c.args);
    expect(posts.map((p: any) => [p.channel, p.body])).toEqual([['ch-table', 'T-504: Uni asks Rowan instead'], ['ch-table', 'T-504: Uni asks Rowan instead']]);
    // the retry posts again; it never writes the ask twice
    expect((await calls(page, 'vault_transition')).length).toBe(1);
  });

  test('hold to talk: the transcript becomes the answer', async ({ page }) => {
    await bootForYou(page, { transcript: 'Leave the far corner wild.' });
    await band(page, 'Yours').getByRole('button', { name: '1 more' }).click();
    const mic = item(page, 'fy-hedge').getByRole('button', { name: 'Hold to talk' });
    await mic.dispatchEvent('pointerdown');
    await expect(item(page, 'fy-hedge').locator('.fy-rec')).toContainText(/Listening/);
    await page.waitForTimeout(900);
    await mic.dispatchEvent('pointerup');
    const said = item(page, 'fy-hedge').locator('.fy-said');
    await expect(said.getByRole('textbox', { name: 'Your answer' })).toHaveValue('Leave the far corner wild.');
    expect(await calls(page, 'vault_transition')).toHaveLength(0);
    await said.getByRole('button', { name: 'Send' }).click();
    await expect(item(page, 'fy-hedge')).toHaveCount(0);
    const cas = (await calls(page, 'vault_transition')).map((c: any) => c.args);
    expect(cas[0]).toMatchObject({ id: 'fy-hedge', to: 'done', metadata: { answer: 'Leave the far corner wild.', answered_by: 'aaron' } });
    const posts = (await calls(page, 'post_message')).map((c: any) => c.args);
    expect(posts.map((p: any) => [p.channel, p.body])).toEqual([['ch-north', 'T-506: Leave the far corner wild.']]);
  });

  // T-335 Seen (11-09): "I should really be able to just mark it as seen... to note that I'm aware of it"
  test('Seen on a look ask closes it, says so in one quiet line in its room, and it leaves For you and the count', async ({ page }) => {
    await bootForYou(page);
    await expect(page.locator('[data-place="front-door"] .fd-pull')).toHaveAttribute('aria-label', /Eight things need you\./);
    // a look ask's one tap is Seen (no second "Seen it")
    await expect(item(page, 'fy-look').locator('.fy-act')).toHaveCount(0);
    await item(page, 'fy-look').getByRole('button', { name: /^Seen: Look at the glaze tile photos \(ends it; its room is told\)$/ }).click();
    await expect(item(page, 'fy-look')).toHaveCount(0);
    const today = forYou(page).getByRole('region', { name: 'Answered today' });
    await expect(today.locator('.fy-done')).toContainText('Look at the glaze tile photos · seen → #kiln-studio');
    await expect(today.locator('.fy-done[data-post="sent"]')).toHaveCount(1);
    // one compare-and-set closes it with who and when, out of For you; never an answer
    const cas = (await calls(page, 'vault_transition')).map((c: any) => c.args);
    expect(cas).toHaveLength(1);
    expect({ id: cas[0].id, from: cas[0].from, to: cas[0].to }).toEqual({ id: 'fy-look', from: 'open', to: 'done' });
    expect(Object.keys(cas[0].metadata).sort()).toEqual(['needs_aaron', 'needs_aaron_why', 'seen_at', 'seen_by']);
    expect(cas[0].metadata).toMatchObject({ seen_by: 'aaron', needs_aaron: false, needs_aaron_why: 'seen' });
    expect(await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 'fy-look').metadata.state)).toBe('done');
    // then the room hears one quiet line: addressed to no one, under no post (it wakes nobody)
    const posts = (await calls(page, 'post_message')).map((c: any) => c.args);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: 'ch-kiln', body: 'T-510: seen.', recipients: [] });
    expect(posts[0].replyTo ?? null).toBeNull();
    await expect(forYou(page).locator('.fy-toggle')).toHaveText(/^7 for you · 3 moving$/);
    await expect(page.locator('[data-place="front-door"] .fd-pull')).toHaveAttribute('aria-label', /Seven things need you\./);
  });

  test('Seen on a do ask keeps it open with its room, out of For you and the count', async ({ page }) => {
    await bootForYou(page);
    await item(page, 'fy-jars').getByRole('button', { name: /^Seen: Find twenty jars for the honey \(out of For you; it stays with its room until it needs you\)$/ }).click();
    await expect(item(page, 'fy-jars')).toHaveCount(0);
    // no close: a metadata patch on the revision shown, and the ask stays open, still his, with its room
    expect(await calls(page, 'vault_transition')).toHaveLength(0);
    const patch = (await calls(page, 'vault_patch_meta')).map((c: any) => c.args);
    expect(patch).toHaveLength(1);
    expect(patch[0].id).toBe('fy-jars');
    expect(patch[0].ifUpdatedAt).toBeTruthy();
    expect(Object.keys(patch[0].metadata).sort()).toEqual(['needs_aaron', 'needs_aaron_why', 'seen_at', 'seen_by']);
    const stored = await page.evaluate(() => (window as any).__tasks.find((t: any) => t.id === 'fy-jars').metadata);
    expect({ state: stored.state, owner: stored.owner, needs_aaron: stored.needs_aaron, why: stored.needs_aaron_why }).toEqual({ state: 'open', owner: 'aaron', needs_aaron: false, why: 'seen' });
    const posts = (await calls(page, 'post_message')).map((c: any) => c.args);
    expect(posts.map((p: any) => [p.body, p.recipients, p.replyTo ?? null])).toEqual([['T-505: seen. It stays open here until it needs my steer; ask again then.', [], null]]);
    await expect(forYou(page).locator('.fy-toggle')).toHaveText(/^6 for you · 1 to look at · 3 moving$/);
    await expect(page.locator('[data-place="front-door"] .fd-pull')).toHaveAttribute('aria-label', /Seven things need you\./);
  });

  test('Seen is on the card too: the ask on it closes there', async ({ page }) => {
    await bootForYou(page);
    await item(page, 'fy-glaze').locator('.fy-where').click();
    const card = page.getByRole('dialog', { name: 'Glaze Tests card' });
    const look = card.locator('article.fy-item[data-id="fy-look"]');
    await look.getByRole('button', { name: /^Seen:/ }).click();
    await expect(look).toHaveCount(0);
    expect((await calls(page, 'vault_transition')).map((c: any) => [c.args.id, c.args.to, c.args.metadata.seen_by])).toEqual([['fy-look', 'done', 'aaron']]);
    // Seen is not his words: no line of his on the card
    await expect(card.locator('.fy-card-lines li')).toHaveText([/The test tiles came out of the kiln\./, /Mixed three glazes/]);
  });

  test('where opens the card: where it stands, the hill, the last lines', async ({ page }) => {
    await bootForYou(page);
    await item(page, 'fy-glaze').locator('.fy-where').click();
    const card = page.getByRole('dialog', { name: 'Glaze Tests card' });
    await expect(card).toBeVisible();
    await expect(card.locator('.fy-card-stands')).toContainText('Twelve test tiles are fired; one glaze crawled.');
    await expect(card.locator('.fy-card-hill')).toContainText('Downhill, 64');
    await expect(card.locator('.fy-card-lines li')).toHaveText([/The test tiles came out of the kiln\./, /Mixed three glazes/]);
    await card.getByRole('button', { name: 'Close' }).click();
    await expect(card).toHaveCount(0);
  });

  test('the old Needs-you list is gone, and nothing opens Aaron/For you', async ({ page }) => {
    await bootForYou(page);
    await expect(forYou(page)).toBeVisible();
    await openPlaces(page);
    const drawer = page.getByRole('region', { name: 'Your places' });
    await expect(drawer).toBeVisible();
    await expect(drawer.locator('.fd-needs-list, .fd-needs')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Needs you' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Needs you' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^For you/ })).toHaveCount(0);
    const reads = (await calls(page, 'vault_note')).map((c: any) => String(c.args.noteRef));
    expect(reads.filter((r) => /For you/i.test(r))).toEqual([]);
  });

  test('reads in greyscale: state by shape, the default by its fill, every word dark enough', async ({ page }) => {
    await bootForYou(page);
    await page.addStyleTag({ content: 'html { filter: grayscale(1) !important; }' });
    await expect(forYou(page)).toBeVisible();
    // a filled dot is yours, a half-filled dot is ready to look at, a ring is moving, a dash is resting
    const shape = (sel: string) => forYou(page).locator(sel).first().evaluate((el) => { const s = getComputedStyle(el); return { bg: s.backgroundImage !== 'none' ? 'half' : s.backgroundColor, border: s.borderTopWidth, w: s.width, h: s.height }; });
    const yours = await shape('.fy-mark[data-mark="yours"]'), look = await shape('.fy-mark[data-mark="look"]'), moving = await shape('.fy-mark[data-mark="moving"]'), rest = await shape('.fy-mark[data-mark="rest"]');
    expect(yours.bg).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(look.bg).toBe('half');
    expect(moving.bg).toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
    expect(moving.border).not.toBe('0px');
    expect(rest.h).not.toBe(rest.w);
    // the default is filled (ink), the other options are outlined: told apart without colour
    const fill = (sel: string) => forYou(page).locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await fill('.fy-default')).not.toBe(await fill('.fy-opt'));
    // every word in For you reads at 4.5:1 once grey
    const faint = await forYou(page).evaluate((root) => {
      const lum = (c: string) => { const m = c.match(/[\d.]+/g)!.map(Number); const [r, g, b] = m.slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); const y = 0.2126 * r + 0.7152 * g + 0.0722 * b; return y; };
      const bgOf = (el: Element | null): string => { for (let e = el; e; e = e.parentElement) { const b = getComputedStyle(e).backgroundColor; if (b && !/rgba\(.*, 0\)$/.test(b) && b !== 'transparent') return b; } return 'rgb(255, 255, 255)'; };
      const out: string[] = [];
      for (const el of Array.from(root.querySelectorAll('*'))) {
        const t = Array.from(el.childNodes).filter((n) => n.nodeType === 3).map((n) => n.textContent ?? '').join('').trim();
        if (!t || (el as HTMLElement).offsetParent === null) continue;
        const s = getComputedStyle(el); const fg = lum(s.color), bg = lum(bgOf(el));
        const ratio = (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05);
        if (ratio * Number(s.opacity || 1) < 4.5) out.push(`${t.slice(0, 30)} ${ratio.toFixed(2)}`);
      }
      return out;
    });
    expect(faint).toEqual([]);
  });

  test('nothing runs past the edge', async ({ page }) => {
    await bootForYou(page);
    await expect(forYou(page)).toBeVisible();
    const over = await page.evaluate(() => { const W = innerWidth; return Array.from(document.querySelectorAll('.fy *')).filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && (r.right > W + 1 || r.left < -1); }).map((e) => (e as HTMLElement).className); });
    expect(over).toEqual([]);
  });
});
