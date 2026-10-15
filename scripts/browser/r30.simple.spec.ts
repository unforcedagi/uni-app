// T-124 r30: the words Aaron reads are the words stored, and every row can be acted on.
// Run: SIMPLE_TEST_PORT=5711 npx playwright test --config playwright.simple.config.ts r30
import { test, expect, type Locator, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';
import { readFileSync } from 'node:fs';

const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900;
const treeBeside = (page: Page) => wide(page) && (page.viewportSize()?.height ?? 0) >= 400;
const base = { briefs: true, tree: true, tasks: true, atlas: true, steer: true, pinned: true } as const;
const boot = (page: Page, extra: Parameters<typeof bootAreas>[2] = {}) => bootAreas(page, 'seed', { ...base, ...extra });
const scope = (page: Page) => (treeBeside(page) ? page.locator('.th-roomnav') : page.locator('.th-phone-tree'));
async function unfoldAll(page: Page) {
  await scope(page).locator('.th-row.d1').first().waitFor();
  for (let i = 0; i < 12; i++) { const f = scope(page).locator('.th-fold[aria-expanded="false"]'); if (!await f.count()) return; await f.first().click(); }
}
async function openRoom(page: Page, name: string) {
  if (!wide(page) && await page.locator('.cp-sheet').count()) { await page.keyboard.press('Escape'); await expect(page.locator('.cp-sheet')).toHaveCount(0); }
  if (!treeBeside(page)) { await page.locator('.sr-drawer, .th-phone-tree').first().waitFor(); if (await page.locator('.sr-drawer').count() && !await page.locator('.th-drawer').count()) await page.locator('.sr-drawer').click(); }
  await unfoldAll(page);
  await scope(page).locator(`.th-go[aria-label^="${name},"]`).click();
  await expect(page.locator('.sr')).toHaveAttribute('data-node', name);
}
async function openCompanion(page: Page) {
  const strip = !wide(page) || await page.locator('.cp.strip').count() > 0;
  if (strip && await page.locator('.cp-line[aria-expanded="false"]').count()) await page.locator('.cp-line').click();
  await expect(page.locator('.cp-body').first()).toBeVisible();
}
async function openWork(page: Page) { await openCompanion(page); await page.getByRole('button', { name: /^All of .*'s work/ }).first().click(); await expect(page.locator('.sr-work')).toBeVisible(); }
const sheetOf = (page: Page) => page.getByRole('dialog').filter({ has: page.locator('.task-kind') });
const NOW = '2026-10-14T09:00:00.000Z';
const refresh = async (page: Page, at: string = NOW) => { await page.clock.setFixedTime(Date.parse(at)); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); };
const RECENT = '2026-10-13T12:00:00.000Z';
/** a task note written straight into the mock vault; `asked_at` is given (null: the record has none) */
const add = (page: Page, n: { id: string; title: string; node: string; tag?: string; asked_at?: string | null; updatedAt?: string; meta?: Record<string, unknown> }) => page.evaluate((x) => {
  (window as any).__tasks.push({ id: x.id, path: `Tasks/${x.title}`, extension: 'md', tags: [x.tag ?? 'task'], createdAt: '2026-10-06T16:00:00.000Z', updatedAt: x.updatedAt ?? '2026-10-13T12:00:00.000Z', lastUpdatedBy: 'u', lastUpdatedVia: 'mcp', content: x.title,
    metadata: { node: x.node, state: 'open', owner: 'aaron', priority: 'now', asked_at: x.asked_at === undefined ? '2026-10-13T12:00:00.000Z' : x.asked_at, ...(x.meta ?? {}) } });
}, n);
const section = (page: Page, label: string) => page.locator('.sr-work').getByRole('region', { name: label });
/** nothing on a row is cut: no element clips its own text, no cut mark */
async function rowsWhole(rows: Locator) {
  const bad = await rows.evaluateAll((lis) => lis.flatMap((li) => [li, ...li.querySelectorAll('*')].filter((el) => {
    const e = el as HTMLElement; const cs = getComputedStyle(e);
    const clips = (cs.overflowY !== 'visible' || cs.overflowX !== 'visible') && cs.display !== 'inline' && !e.matches('.cp-sub-where, .fit-full, .fit-short, .cp-sub') && (e.scrollHeight > e.clientHeight + 1);
    return clips || /…|\.\.\./.test(e.children.length ? '' : e.innerText || '');
  }).map((el) => (el as HTMLElement).className + ': ' + ((el as HTMLElement).innerText || '').slice(0, 60))));
  expect(bad, 'cut text in rows').toEqual([]);
}



const ASKED = '2026-10-14T08:00:00.000Z';
/** a message `secs` after ASKED (the fixture's clock is Oct 9 10:00Z, so `ago` is negative for later times); its ref */
const arriveAt = (page: Page, who: string, body: string, secs: number): Promise<string> => page.evaluate(([w, b, s]) => (window as any).__arrive('ch-techne', w, b, -(424800 + (s as number))), [who, body, secs] as const);
/** T-113's `next` and `detail`, as stored on the scratch hub (hub11, 10-15) */
const NEXT113 = 'Send Eileen the new site labels listed in detail to approve or replace, and ask her for one morning-practice line per day Oct 15-25; then sign in once on cohereboulder.org and open Board, People and Me';
const DETAIL113 = "Labels to approve (en; es written): 'Already registered? Sign in' \u00b7 'Update your registration' \u00b7 'Save changes' \u00b7 'Your registration is updated.' \u00b7 'This email is already registered. Sign in to change your registration.' \u00b7 'Create your account to RSVP to events' \u00b7 'You're signed in' \u00b7 'Sign in to RSVP' \u00b7 'We couldn't load your registration.' \u00b7 'Try again'. Also her call: keep or cut the older registration lines 'You're woven in!', 'choose your own adventure from the community calendar', 'stay up to date with what's unfolding'. Practice lines: her doc has 2 of 11 days (Honoring Water, Noticing Session). Earlier asks from 10-13 (6 groups of short lines, 3 questions) still unanswered in #cohere. Screens: posted in #cohere 10-14 ~22:00 (flows.png).";
const words = (s: string) => s.replace(/\s+/g, ' ').trim();

test.describe('r30', () => {
  for (const size of [{ width: 1280, height: 720 }, { width: 800, height: 600 }, { width: 740, height: 360 }]) {
    test(`1: T-113's real next is word for word in its row and its sheet heading at ${size.width}×${size.height}`, async ({ page }) => {
      test.skip(page.viewportSize()?.width !== 1440, 'one project is enough for the fixed sizes');
      await page.setViewportSize(size);
      await boot(page);
      await add(page, { id: 'c1', title: 'T-113 Look at cohereboulder.org on your phone, then forward Eileen the asks', node: 'Areas/Techne', asked_at: ASKED, meta: { next: NEXT113, detail: DETAIL113, room: 'techne', state: 'waiting', waiting_on: 'aaron' } });
      await refresh(page);
      await openRoom(page, 'Techne');
      await openCompanion(page);
      const row = page.locator('.cp-body li.cp-item').filter({ hasText: 'morning-practice' }).first();
      await expect(row).toBeVisible();
      const lead = words(await row.locator('.cp-lead').innerText());
      expect(lead).toBe(NEXT113);
      await row.locator('.cp-need').click();
      const sheet = sheetOf(page);
      await expect(sheet).toBeVisible();
      expect(words(await sheet.locator('#task-sheet-title').innerText())).toBe(NEXT113);
    });
  }
});

/** the live asks of the scratch hub (hub11), as stored */
const FIXTURE = JSON.parse(readFileSync(new URL('../fixtures/hub11-asks.json', import.meta.url), 'utf8')) as { notes: { id: string; path: string; tags: string[]; metadata: Record<string, any> }[] };

test.describe('r30 words', () => {
  test('1: every live ask of the scratch hub shows its whole stored next in its row, word for word (work view)', async ({ page }) => {
    test.skip(!wide(page), 'work view');
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page);
    // (a step that names a note by id is drawn as that note's title, which the mock vault doesn't hold: the unit test covers those)
    const asks = FIXTURE.notes.filter((n) => !n.tags.includes('decision') && n.metadata.next && !/uni:[0-9A-HJKMNP-TV-Z]{26}/.test(n.metadata.next));
    await page.evaluate((list) => {
      for (const n of list) (window as any).__tasks.push({ id: `fx-${n.id}`, path: n.path, extension: 'md', tags: ['task'], createdAt: '2026-10-06T16:00:00.000Z', updatedAt: '2026-10-13T12:00:00.000Z', lastUpdatedBy: 'u', lastUpdatedVia: 'mcp', content: n.path,
        metadata: { ...n.metadata, node: 'Areas/Techne', state: 'open', owner: 'aaron', waiting_on: null, priority: 'now', asked_at: '2026-10-14T08:00:00.000Z', due: null } });
    }, asks);
    await refresh(page);
    await openRoom(page, 'Techne');
    await openWork(page);
    const rows = section(page, 'Needs you').locator('.cp-list > li.cp-item');
    await expect(rows).toHaveCount(asks.length);
    for (const n of asks) {
      const tid = /T-\d+/.exec(n.path)![0];
      const row = rows.filter({ has: page.locator(`[data-id="${tid}"]`) });
      await expect(row, tid).toHaveCount(1);
      const text = words(await row.innerText());
      // a note's id is drawn as that note's title: what is stored around it is what is checked
      let from = 0;
      for (const seg of String(n.metadata.next).split(/uni:[0-9A-HJKMNP-TV-Z]{26}/).map((s) => words(s)).filter(Boolean)) {
        const at = text.indexOf(seg.replace(/^[;,)\s]+|[\s(]+$/g, '').replace(/\.$/, ''), from); // (a closing "." is no word)
        expect(at, `${tid}: "${seg}" is in its row: ${text}`).toBeGreaterThanOrEqual(0);
        from = at + seg.length;
      }
    }
  });
});

test.describe('r30 sheet', () => {
  for (const size of [{ width: 1280, height: 720 }, { width: 800, height: 600 }, { width: 740, height: 360 }]) {
    test(`3: T-113's sheet is the ask at ${size.width}×${size.height}: the step, its labels straight after it, one closed Background for the rest`, async ({ page }) => {
      test.skip(page.viewportSize()?.width !== 1440, 'one project is enough for the fixed sizes');
      await page.setViewportSize(size);
      await boot(page);
      await add(page, { id: 'c1', title: 'T-113 Look at cohereboulder.org on your phone, then forward Eileen the asks', node: 'Areas/Techne', asked_at: ASKED, meta: { next: NEXT113, detail: DETAIL113, room: 'techne', state: 'waiting', waiting_on: 'aaron' } });
      await refresh(page);
      await openRoom(page, 'Techne');
      await openCompanion(page);
      await page.locator('.cp-body li.cp-item').filter({ hasText: 'morning-practice' }).first().locator('.cp-need').click();
      const sheet = sheetOf(page);
      await expect(sheet.locator('.task-items li')).toHaveCount(10);
      await expect(sheet.locator('.task-items li').first()).toHaveText('Already registered? Sign in');
      // the labels come straight after the heading (only the quiet title line may sit between)
      const order = await sheet.evaluate((d) => { const h = d.querySelector('h2')!; const it = d.querySelector('.task-items')!; let e = h.nextElementSibling; while (e && e !== it && (e.classList.contains('task-sub') || e.classList.contains('task-step-links') || e.classList.contains('task-stepof') || e.classList.contains('task-steps'))) e = e.nextElementSibling; return e === it; });
      expect(order, 'the labels follow the heading').toBe(true);
      const bg = sheet.locator('details.task-background');
      await expect(bg).toHaveCount(1);
      await expect(bg).not.toHaveAttribute('open', '');
      await expect(bg.locator('summary')).toHaveText('Background');
      // closed: none of the older asks or "her call" is on the sheet
      await expect(sheet.locator('.task-body')).not.toContainText(/Earlier asks|her call/i, { useInnerText: true });
      await bg.locator('summary').click();
      await expect(bg).toContainText('Earlier asks from 10-13');
      await expect(bg).toContainText('Also her call');
    });
  }

  test('2: the row carries the labels, whole: two items, then the one total ("10 labels in all"), the same at any width', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await page.setViewportSize({ width: 1280, height: 720 });
    await boot(page);
    await add(page, { id: 'c1', title: 'T-113 Look at cohereboulder.org on your phone, then forward Eileen the asks', node: 'Areas/Techne', asked_at: ASKED, meta: { next: NEXT113, detail: DETAIL113, room: 'techne', state: 'waiting', waiting_on: 'aaron' } });
    await refresh(page);
    await openRoom(page, 'Techne');
    await openCompanion(page);
    const row = page.locator('.cp-body li.cp-item').filter({ hasText: 'morning-practice' }).first();
    await expect(row.locator('.cp-item-line')).toHaveText(['Already registered? Sign in', 'Update your registration']);
    await expect(row.locator('.cp-item-more')).toHaveText(/^10 \w+ in all$/);
    await expect(row.locator('.cp-lead')).not.toContainText('Already registered');
  });
});

test.describe('r30 confirming', () => {
  const NEXT = (w: string) => `Say go on the ${w} ledger from the placeholder books`;
  test('4: the line says requests, and where it counts; each list row its reason; no Answer anyway on a row; the sheet has it after the reason', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await add(page, { id: 'r1', title: 'T-901 Placeholder chat after', node: 'Areas/Techne', asked_at: ASKED, meta: { next: NEXT('amber') } });
    await add(page, { id: 'r2', title: 'T-902 Placeholder old', node: 'Areas/Techne', asked_at: '2026-10-05T08:00:00.000Z', meta: { next: NEXT('cobalt') } });
    await add(page, { id: 'r3', title: 'T-903 Placeholder undated', node: 'Areas/Techne', asked_at: null, meta: { next: NEXT('quartz') } });
    await add(page, { id: 'r4', title: 'T-904 Placeholder waiting', node: 'Areas/Techne', asked_at: null, meta: { next: 'Waiting on the placeholder printer to be repaired by the supplier' } });
    await arriveAt(page, 'Aaron', 'T-901 is off', 120);
    await refresh(page);
    await openRoom(page, 'Techne');
    await openCompanion(page);
    const panel = page.locator('.cp-body').getByRole('region', { name: 'Needs you' });
    await expect(panel.locator('.cp-recheck-line')).toHaveText(/^\d+ requests need confirming in this room\+$/);
    expect(Number((await panel.locator('.cp-recheck-line').innerText()).match(/\d+/)![0])).toBeGreaterThanOrEqual(3);
    await expect(page.locator('.cp-body')).not.toContainText(/\bolder\b/i);
    await panel.locator('.cp-recheck-line').click();
    const items = panel.locator('.cp-recheck-item');
    // r31: chat said "T-901 is off" and changed nothing: the record says it was asked recently, so it is a row, not a recheck
    await expect(items.filter({ hasText: 'amber' })).toHaveCount(0);
    await expect(panel.locator('.cp-list > li.cp-item').filter({ hasText: 'amber' })).toHaveCount(1);
    await expect(items.filter({ hasText: 'cobalt' }).locator('.cp-recheck-asked')).toHaveText(/^asked Oct 5( · in .*)?$/);
    await expect(items.filter({ hasText: 'quartz' }).locator('.cp-recheck-asked')).toHaveText(/^(no date|added \w+ \d+)( · in .*)?$/);
    // a request that leads with its title (its step is a status, no action) still shows its step, whole, under it
    await expect(items.filter({ hasText: 'Placeholder waiting' }).locator('.cp-recheck-next')).toHaveText('Waiting on the placeholder printer to be repaired by the supplier');
    // a list row is its whole step and its reason; there is no "Answer anyway" on any of them
    await expect(panel.locator('.cp-recheck-list').getByRole('button', { name: 'Answer anyway' })).toHaveCount(0);
    await expect(panel.locator('.cp-recheck-list')).not.toContainText('Answer anyway');
    // the sheet: its reason line, then "Answer anyway" straight after it
    await items.filter({ hasText: 'cobalt' }).locator('.cp-rc-open').click();
    const sheet = sheetOf(page);
    await expect(sheet.locator('.task-asked')).toHaveText(/^Asked Oct 5 · not confirmed since$/i);
    const after = await sheet.evaluate((d) => { const r = d.querySelector('.task-asked')!; const a = d.querySelector('.task-anyway')!; return { follows: !!(r.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING), between: [...d.querySelectorAll('.task-body > *')].filter((e) => e.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_PRECEDING && e.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING).length, inFoot: !!d.querySelector('.task-foot .task-anyway') }; });
    expect(after.follows).toBe(true);
    expect(after.inFoot).toBe(false);
    await expect(sheet.getByRole('button', { name: 'Answer anyway' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'I did this' })).toHaveCount(0);
    await sheet.getByRole('button', { name: 'Answer anyway' }).click();
    await expect(sheet.getByRole('button', { name: 'I did this' })).toBeVisible();
  });

  test('4: all of Uni\'s work counts across all rooms', async ({ page }) => {
    test.skip(!wide(page), 'work view');
    await boot(page);
    await add(page, { id: 'r1', title: 'T-911 Placeholder one', node: 'Areas/Techne', asked_at: null, meta: { next: NEXT('jade') } });
    await add(page, { id: 'r2', title: 'T-912 Placeholder two', node: 'Projects/Atlas Institute', asked_at: null, meta: { next: NEXT('onyx') } });
    await refresh(page);
    await page.locator('.th-go[aria-label^="Uni,"]').first().click();
    await openCompanion(page);
    const line = page.locator('.cp-body .cp-recheck-line');
    await expect(line).toHaveText(/^\d+ requests need confirming across all rooms\+$/);
    const all = Number((await line.innerText()).match(/\d+/)![0]);
    expect(all).toBeGreaterThanOrEqual(2);
    await openWork(page);
    await expect(section(page, 'Needs you').locator('.cp-recheck-line')).toHaveText(`${all} requests need confirming across all rooms+`);
    // another room's work counts its own, and says so: fewer than all of them
    await openRoom(page, 'Atlas Institute');
    await openWork(page);
    await expect(section(page, 'Needs you').locator('.cp-recheck-line')).toHaveText(/^1 request needs confirming in this room\+$/);
  });
});
test.describe('r30 waiting runs', () => {
  const composerFocused = (page: Page) => page.evaluate(() => document.activeElement?.tagName === 'TEXTAREA' && !!document.activeElement.closest('.composer'));
  test('6: a waiting run is a row: the whole row opens its room at the run\'s message, the composer focused (the same contract as a request)', async ({ page }) => {
    test.skip(!wide(page), 'work view');
    await boot(page);
    const ref = await arriveAt(page, 'Uni', 'Placeholder release question for 0.1.46', 600);
    await page.evaluate((r) => (window as any).__addRun('wr1', 'Areas/Techne', '', 'Waiting on your answer in #Techne: Ship the placeholder 0.1.46?', 'decision', { room: 'techne', message_ref: r }), ref);
    await refresh(page);
    // from another room: Uni's own
    await page.locator('.th-go[aria-label^="Uni,"]').first().click();
    await openWork(page);
    const run = section(page, 'Needs you').locator('.cp-waiting > li');
    await expect(run).toHaveCount(1);
    await expect(run.getByRole('button')).toHaveCount(1);
    await run.getByRole('button').click();
    await expect(page.locator('.sr')).toHaveAttribute('data-node', 'Techne');
    await expect(page.locator(`.message.search-focus[data-ref="${ref}"]`)).toBeVisible();
    await expect.poll(() => composerFocused(page)).toBe(true);
    expect(await page.locator('.composer textarea').inputValue()).toBe('');
  });

  test('6: with no message ref the row opens the room, the composer focused; the panel\'s row does the same', async ({ page }) => {
    test.skip(!wide(page), 'side panel');
    await boot(page);
    await page.evaluate(() => (window as any).__addRun('wr2', 'Areas/Techne', '', 'Waiting on your answer in #Techne: Say go on the placeholder?', 'decision', { room: 'techne' }));
    await refresh(page);
    await openRoom(page, 'Techne');
    await openCompanion(page);
    const run = page.locator('.cp-body .cp-waiting > li');
    await expect(run).toHaveCount(1);
    await page.locator('.composer textarea').blur().catch(() => {});
    await run.getByRole('button').click();
    await expect.poll(() => composerFocused(page)).toBe(true);
    await expect(page.locator('.message.search-focus')).toHaveCount(0);
  });
});

test.describe('r30 summary', () => {
  const SUMMARY = "Cohort two starts Oct 15 with twelve people; the staging site is live, the sign-in flow was checked on a phone, and prod waits on one go from Aaron for the labels and the three practice lines Eileen still owes us.";
  for (const size of [{ width: 1280, height: 720 }, { width: 1280, height: 600 }, { width: 800, height: 600 }, { width: 740, height: 360 }, { width: 920, height: 360 }]) {
    test(`7: at ${size.width}×${size.height} the summary is never cut by the panel's edge: whole, folded to its one line, or below the footer`, async ({ page }) => {
      test.skip(page.viewportSize()?.width !== 1440, 'one project is enough for the fixed sizes');
      await page.setViewportSize(size);
      await boot(page);
      // tall rows (T-113's whole step and its labels, a long ask, a short one): there is little room left for the summary
      await add(page, { id: 's1', title: 'T-113 Look at cohereboulder.org on your phone, then forward Eileen the asks', node: 'Projects/Learn Vibe Build', asked_at: ASKED, meta: { next: NEXT113, detail: DETAIL113, state: 'waiting', waiting_on: 'aaron' } });
      await add(page, { id: 's2', title: 'T-114 Placeholder second', node: 'Projects/Learn Vibe Build', asked_at: ASKED, meta: { next: 'Tell Uni who pays the amber sponsorship invoice and how, plus the legal name and address for the invoice and the date it is due' } });
      await add(page, { id: 's3', title: 'T-115 Placeholder third', node: 'Projects/Learn Vibe Build', asked_at: ASKED, meta: { next: 'Say go on the placeholder number three release after you look at it on your phone' } });
      await page.evaluate((t) => (window as any).__setStands('p-lvb', t, '2026-10-14T06:00:00.000Z'), SUMMARY);
      await refresh(page);
      await openRoom(page, 'Learn Vibe Build');
      await openCompanion(page);
      const check = () => page.evaluate(() => {
        const n = document.querySelector<HTMLElement>('.cp.side.open .cp-stands-note, .cp-sheet .cp-stands-note'); if (!n) return { present: false };
        const sc = n.closest('.cp-fit, .cp-scroll')!; const own = n.closest('.cp-foot');
        const foot = own ? null : (n.closest('.cp-fit') ?? n.closest('.cp-sheet'))!.querySelector('.cp-foot');
        const s = sc.getBoundingClientRect(); const r = n.getBoundingClientRect();
        const limit = Math.min(s.bottom, foot ? foot.getBoundingClientRect().top : Infinity);
        return { present: true, folded: n.getAttribute('data-folded') === 'true', inFoot: !!own, cut: r.top < limit - 0.5 && r.bottom > limit + 0.5, asof: n.querySelector('.cp-asof')?.textContent };
      });
      // settled: after the panel has been quiet, nothing of the summary is cut by the edge or the footer
      await page.waitForTimeout(900);
      const r = await check();
      expect(r.present).toBe(true);
      expect(r.cut, JSON.stringify(r)).toBe(false);
      // r31: folded, it is one line that opens the summary ("Where this stands · Oct 14, #atlas/teach"): no colon with nothing after it, no second heading
      if (r.folded) { expect(r.asof ?? null).toBeNull(); await expect(page.locator('.cp-stands-note[data-folded] .cp-said summary')).toHaveText('Where this stands · Oct 14, #atlas/teach'); }
      else { expect(r.asof).toBe('Last written Oct 14 by #atlas/teach:'); await expect(page.locator('.cp-stands-note .cp-stands').first()).toHaveText(SUMMARY); }
    });
  }
});
