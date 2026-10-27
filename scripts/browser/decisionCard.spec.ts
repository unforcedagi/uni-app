// T-212: a decision appears in the chat of the room that asked it, as a card with one button per option. A tap is the vault's
// compare-and-set and, only when it won, "Picked: …" posted in the room as you; a tap that lost shows the stored answer and posts nothing.
// Run: DECISIONS_TEST_PORT=5731 npx playwright test --config playwright.decisions.config.ts
import { mkdir } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, leaveFrontDoor } from './areasFixture';

const BUILD = '7dcea809-25cd-4160-ba99-f0a56386adcb';
const D1 = '01M5D0000000000000000000A1';
const SHOTS = 'scripts/browser/__shots__/decisions';
const wide = (page: Page) => (page.viewportSize()?.width ?? 0) >= 900 && (page.viewportSize()?.height ?? 0) >= 400;

/** A decision note as `tasks.py decide new` writes it (made-up question), on the ATLAS project, whose room is #atlas/build. */
const seed = (page: Page, extra: Record<string, unknown> = {}) => page.addInitScript(([d1, more]) => {
  const at = '2026-10-09T09:00:00.000Z';
  (window as any).__seedTasks = [{ id: d1, path: 'Decisions/2026-10-09 Which layout for the garden page?', extension: 'md', tags: ['decision'], createdAt: at, updatedAt: at,
    lastUpdatedVia: 'api', content: '# Which layout for the garden page?\n\n- A\n- B (default)\n- C\n',
    metadata: { node: 'Projects/ATLAS', state: 'open', options: ['A', 'B', 'C'], default: 'B', owner: 'aaron', asked: '2026-10-09', task: 'T-07', ...more } }];
}, [D1, extra] as const);

async function openAtlas(page: Page) {
  await bootAreas(page, 'seed', { briefs: true, tree: true, tasks: true, atlas: true, steer: true, pinned: true });
  const nav = wide(page) ? page.locator('.th-roomnav') : page.locator('.th-phone-tree');
  await leaveFrontDoor(page); // T-302: the tree is in a room
  if (!wide(page)) { await page.locator('.sr-drawer, .th-phone-tree').first().waitFor(); if (await page.locator('.sr-drawer').count() && !await page.locator('.th-drawer').count()) await page.locator('.sr-drawer').click(); }
  await nav.locator('.th-row.d1').first().waitFor();
  for (let i = 0; i < 12; i++) { const f = nav.locator('.th-fold[aria-expanded="false"]'); if (!await f.count()) break; await f.first().click(); }
  await nav.locator('.th-go[aria-label^="ATLAS,"]').click();
  await expect(page.locator('.sr')).toHaveAttribute('data-node', 'ATLAS');
}
const arrive = (page: Page, body: string, who = 'Uni') => page.evaluate(([b, n, t]) => (window as any).__arrive(b, n, t), [BUILD, who, body] as const);
const posts = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: any) => c.cmd === 'post_message').map((c: any) => c.args));
const stored = (page: Page) => page.evaluate((d) => (window as any).__tasks.find((t: any) => t.id === d).metadata, D1);
const shot = async (page: Page, name: string) => {
  await mkdir(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}-${page.viewportSize()!.width}x${page.viewportSize()!.height}.png` });
};
const ASK = `Your call on the garden page layout. Tap your pick: uni:${D1}`;

test.describe('decision cards in the chat', () => {
  test('1. a room\'s message with uni:<id> of a decision note renders a card: the question, a button per option, the default marked', async ({ page }) => {
    // a decision in a private area: the shell never lists it, so only the message's ref can bring its card (the T-70 case)
    await seed(page, { node: 'Areas/Sanctum' });
    await openAtlas(page);
    await arrive(page, ASK);
    const msg = page.locator('.sr-chat .message').filter({ hasText: 'Your call on the garden page layout' });
    const card = msg.getByRole('region', { name: 'Decision: Which layout for the garden page?' });
    await expect(card).toBeVisible();
    await expect(card.locator('.decision-kind')).toHaveText('Decision · T-07');
    const pick = card.getByRole('group', { name: /^Pick one:/ });
    await expect(pick.getByRole('button')).toHaveText(['A', 'Bdefault', 'C']);
    await expect(pick.getByRole('button', { name: 'B (default)' })).toHaveClass(/dflt/);
    // big enough to tap on every screen, and the card never makes the page scroll sideways
    for (const b of await pick.getByRole('button').all()) { const box = (await b.boundingBox())!; expect(box.height).toBeGreaterThanOrEqual(44); expect(box.width).toBeGreaterThanOrEqual(44); }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    // no motion for the e-ink screen
    expect(await pick.getByRole('button').first().evaluate((b) => getComputedStyle(b).transitionDuration)).toBe('0s');
    await shot(page, '01-card');
    // its context: the decision's own note opens beside (or over) the chat
    await card.getByRole('button', { name: 'Context ›' }).click();
    await expect(page.locator('.note-pane, .note-view').first()).toBeVisible();
  });

  test('2. a tap sets the state (open -> decided, by you) and tells the room as you: "Picked: B …"; 3. a second card for it shows Decided', async ({ page }) => {
    await seed(page);
    await openAtlas(page);
    await arrive(page, ASK);
    await arrive(page, `Reminder: the garden page layout is still open, uni:${D1}`);
    const cards = page.locator('.sr-chat .message .decision-card');
    await expect(cards).toHaveCount(2);
    await expect(cards.nth(1).getByRole('button', { name: 'C', exact: true })).toBeVisible();
    const before = (await posts(page)).length;
    await cards.first().getByRole('button', { name: 'B (default)' }).click();
    await expect(cards.first().locator('.decision-result')).toHaveText('Decided: B · by you');
    const m = await stored(page);
    expect([m.state, m.decided, m.decided_by, m.decided_at]).toEqual(['decided', 'B', 'aaron', '2026-10-09T10:00:00.000Z']);
    const sent = (await posts(page)).slice(before);
    expect(sent).toHaveLength(1);
    expect(sent[0].channel).toBe(BUILD);
    expect(sent[0].body).toBe(`Picked: B (decision: Which layout for the garden page?) uni:${D1}`);
    expect(sent[0].recipients).toEqual(['b'.repeat(64)]); // the room's Uni hears it
    await expect(page.locator('.sr-chat').getByText('Sent to the room.')).toBeVisible();
    // 3: the other card of the same decision, and the card under your own "Picked" message, show the answer, with no buttons
    await expect(cards.nth(1).locator('.decision-result')).toHaveText('Decided: B · by you');
    await expect(cards.nth(1).getByRole('group', { name: /^Pick one:/ })).toHaveCount(0);
    const own = page.locator('.sr-chat .message').filter({ hasText: 'Picked: B' });
    await expect(own.locator('.decision-card .decision-result')).toHaveText('Decided: B · by you');
    await shot(page, '02-decided');
  });

  test('4. a lost race: the room decided first; the tap shows the stored pick and posts nothing', async ({ page }) => {
    await seed(page);
    await openAtlas(page);
    await arrive(page, ASK);
    await arrive(page, `Reminder: uni:${D1}`);
    const card = page.locator('.sr-chat .message .decision-card').first();
    await expect(card.getByRole('button', { name: 'C', exact: true })).toBeVisible();
    // the room picks A in the vault after the card was read and before the tap
    await page.evaluate((d) => { const t = (window as any).__tasks.find((x: any) => x.id === d); Object.assign(t.metadata, { state: 'decided', decided: 'A', decided_by: 'room' }); t.updatedAt = '2026-10-09T09:30:00.000Z'; }, D1);
    const before = (await posts(page)).length;
    await card.getByRole('button', { name: 'C', exact: true }).click();
    await expect(card.locator('.decision-result')).toHaveText('Decided: A · by room');
    await expect(card.getByText('Already decided before your tap; nothing was sent.')).toBeVisible();
    expect((await stored(page)).decided).toBe('A');
    // 3: the decision's other card shows the stored answer too, with nothing posted to refresh it
    await expect(page.locator('.sr-chat .message .decision-card').nth(1).locator('.decision-result')).toHaveText('Decided: A · by room');
    await page.waitForTimeout(500);
    expect((await posts(page)).length).toBe(before);
    await shot(page, '04-lost');
  });

  test('a question that changed after the card showed it is not answered: the card shows the new one, nothing is written or posted', async ({ page }) => {
    await seed(page);
    await openAtlas(page);
    await arrive(page, ASK);
    const card = page.locator('.sr-chat .message .decision-card').first();
    await expect(card.getByRole('button', { name: 'A', exact: true })).toBeVisible();
    await page.evaluate((d) => { const t = (window as any).__tasks.find((x: any) => x.id === d); t.content = '# Which layout for the garden page, and its menu?\n'; t.updatedAt = '2026-10-09T09:40:00.000Z'; }, D1);
    const before = (await posts(page)).length;
    await card.getByRole('button', { name: 'A', exact: true }).click();
    await expect(card.getByRole('alert')).toHaveText('The question changed since you saw it. Here it is again; nothing was saved.');
    await expect(card.locator('.decision-q')).toHaveText('Which layout for the garden page, and its menu?');
    expect((await stored(page)).state).toBe('open');
    expect((await posts(page)).length).toBe(before);
    // tapped again, now on the question shown
    await card.getByRole('button', { name: 'A', exact: true }).click();
    await expect(card.locator('.decision-result')).toHaveText('Decided: A · by you');
  });

  test('a decision that could not be read (offline) is read again when the app comes back, and has Try again', async ({ page }) => {
    await seed(page);
    await page.addInitScript((d) => { (window as any).__noteFails = { [d]: true }; }, D1);
    await openAtlas(page);
    await arrive(page, ASK);
    const msg = page.locator('.sr-chat .message').filter({ hasText: 'Your call on the garden page layout' });
    await expect(msg.locator('.decision-loading')).toContainText("Couldn't read this note to show its decision");
    await page.evaluate(() => { (window as any).__noteFails = {}; });
    await msg.getByRole('button', { name: 'Try again' }).click();
    await expect(msg.getByRole('group', { name: /^Pick one:/ })).toBeVisible();
  });

  test('a room\'s [decision T-NN] marker gets the card too; an open decision of this room no message names is listed under the chat', async ({ page }) => {
    await seed(page);
    await openAtlas(page);
    // dq2 (the fixture's ATLAS hosting decision, no message names it) belongs to this room
    const list = page.locator('.sr-chat .room-decisions');
    await expect(list.locator('summary')).toHaveText(/^\d+ open decisions? for this room$/);
    await list.locator('summary').click();
    await expect(list.getByRole('region', { name: /Decide the ATLAS hosting/ }).getByRole('group', { name: /^Pick one:/ }).getByRole('button')).toHaveText(['Self-host', 'Managed']);
    await arrive(page, 'The garden page layout is yours. [decision T-07]');
    const msg = page.locator('.sr-chat .message').filter({ hasText: 'The garden page layout is yours' });
    await expect(msg).not.toContainText('T-07]');
    await expect(msg.getByRole('region', { name: 'Decision: Which layout for the garden page?' })).toBeVisible();
    // named by a message now, so it is not listed twice
    await expect(list.getByRole('region', { name: /garden page/ })).toHaveCount(0);
  });

  test('the existing Areas rendering stays in step: a card\'s pick leaves Needs you; a pick in the decision\'s sheet turns its card to Decided', async ({ page }) => {
    await seed(page);
    await openAtlas(page);
    await arrive(page, ASK);
    const card = page.locator('.sr-chat .message .decision-card').first();
    await expect(card.getByRole('button', { name: 'A', exact: true })).toBeVisible();
    // the sheet (Needs you) answers the fixture's other decision; the garden one is answered from the card
    const companionText = () => page.locator('.cp').first().innerText();
    if (wide(page)) await expect.poll(companionText).toContain('Which layout for the garden page?');
    await card.getByRole('button', { name: 'A', exact: true }).click();
    await expect(card.locator('.decision-result')).toHaveText('Decided: A · by you');
    if (wide(page)) await expect.poll(companionText).not.toContain('Which layout for the garden page?');
    // the other way round: a room's message names the hosting decision by its marker; it is answered in its sheet (or by the room)
    await page.evaluate(() => (window as any).__setTask('dq2', { task: 'T-140' }));
    await page.clock.setFixedTime(Date.parse('2026-10-09T10:01:00.000Z'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await arrive(page, 'The hosting call is yours: self-host or managed. [decision T-140]');
    const hosting = page.locator('.sr-chat .message').filter({ hasText: 'The hosting call is yours' }).locator('.decision-card');
    await expect(hosting.getByRole('button', { name: 'Managed' })).toBeVisible();
    await page.evaluate(() => { const t = (window as any).__tasks.find((x: any) => x.id === 'dq2'); Object.assign(t.metadata, { state: 'decided', decided: 'Managed', decided_by: 'aaron' }); t.updatedAt = new Date(Date.now() + 9000).toISOString(); });
    await page.clock.setFixedTime(Date.parse('2026-10-09T10:05:00.000Z'));
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(hosting.locator('.decision-result')).toHaveText('Decided: Managed · by you');
  });

  test('a Forget while a won tap is still telling the room: nothing is posted', async ({ page }) => {
    await seed(page);
    await openAtlas(page);
    await arrive(page, ASK);
    const card = page.locator('.sr-chat .message .decision-card').first();
    await expect(card.getByRole('button', { name: 'A', exact: true })).toBeVisible();
    const before = (await posts(page)).length;
    await page.evaluate(() => { (window as any).__membersDelay = 2500; });
    await card.getByRole('button', { name: 'A', exact: true }).click();
    await expect(card.getByText('Telling the room…')).toBeVisible();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Forget this device key' }).click();
    await page.getByRole('button', { name: /^Tap again to forget/ }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__calls.some((c: any) => c.cmd === 'identity_forget'))).toBe(true);
    await page.waitForTimeout(3500);
    expect((await posts(page)).length).toBe(before);
  });

  test('a decision listed under the chat (no message names it) is answered there: its card stays, says Decided and tells the room', async ({ page }) => {
    await seed(page);
    await openAtlas(page);
    const list = page.locator('.sr-chat .room-decisions');
    await list.locator('summary').click();
    const hosting = list.getByRole('region', { name: /Decide the ATLAS hosting/ });
    const before = (await posts(page)).length;
    await hosting.getByRole('button', { name: 'Managed' }).click();
    await expect(hosting.locator('.decision-result')).toHaveText('Decided: Managed · by you');
    await expect(hosting.getByText('Sent to the room.')).toBeVisible();
    const sent = (await posts(page)).slice(before);
    expect(sent.map((p: any) => p.body)).toEqual([expect.stringMatching(/^Picked: Managed \(decision: .*ATLAS hosting\) uni:dq2$/)]);
  });

  test('a ref to a note that is not a decision is only its chip', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__seedTasks = [{ id: '01M5D0000000000000000000B1', path: 'Projects/Atlas/Plain note', extension: 'md', tags: [], createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', content: '# Plain', metadata: {} }]; });
    await openAtlas(page);
    await arrive(page, 'See uni:01M5D0000000000000000000B1 for the notes.');
    const msg = page.locator('.sr-chat .message').filter({ hasText: 'for the notes' });
    await expect(msg.locator('a.note-chip')).toBeVisible();
    await expect(msg.locator('.decision-card')).toHaveCount(0);
  });
});

// T-226: a card takes your words too. With a tap they go with the pick (`decided_note`, same compare-and-set) and the room hears
// "Picked: X — …"; alone ("Send note", Shift/Ctrl/Cmd+Enter) they are appended to the decision's `notes`, which stays open. Enter is a
// new line, never a send. A tap that lost writes and posts nothing and keeps the words. Run as above.
test.describe('your words on a decision card', () => {
  const field = (card: ReturnType<Page['locator']>) => card.getByRole('textbox', { name: 'Add a note to this decision' });
  const firstCard = async (page: Page) => {
    await seed(page);
    await openAtlas(page);
    await arrive(page, ASK);
    const card = page.locator('.sr-chat .message .decision-card').first();
    await expect(card.getByRole('button', { name: 'C', exact: true })).toBeVisible();
    return card;
  };

  test('a pick with words: both in one write; the room hears "Picked: B — <words>" as you, to Uni', async ({ page }) => {
    const card = await firstCard(page);
    const box = field(card);
    await expect(box).toHaveAttribute('placeholder', 'Add a note…');
    // big enough to tap on the Daylight, and nothing moves
    expect((await box.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await box.evaluate((b) => getComputedStyle(b).transitionDuration)).toBe('0s');
    await box.fill('B, but keep the menu on the left.');
    const send = card.getByRole('button', { name: 'Send note' });
    const sb = (await send.boundingBox())!; expect(sb.height).toBeGreaterThanOrEqual(44); expect(sb.width).toBeGreaterThanOrEqual(44);
    expect(await send.evaluate((b) => getComputedStyle(b).transitionDuration)).toBe('0s');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await shot(page, '11-words');
    const before = (await posts(page)).length;
    await card.getByRole('button', { name: 'B (default)' }).click();
    await expect(card.locator('.decision-result')).toHaveText('Decided: B · by you');
    await expect(card.locator('.decision-said')).toHaveText('B, but keep the menu on the left.');
    const m = await stored(page);
    expect([m.state, m.decided, m.decided_by, m.decided_note]).toEqual(['decided', 'B', 'aaron', 'B, but keep the menu on the left.']);
    const sent = (await posts(page)).slice(before);
    expect(sent.map((p: any) => [p.body, p.recipients])).toEqual([[`Picked: B — B, but keep the menu on the left. (decision: Which layout for the garden page?) uni:${D1}`, ['b'.repeat(64)]]]);
    // the words went: no field is left on the decided card
    await expect(field(card)).toHaveCount(0);
    await shot(page, '12-picked-with-words');
  });

  test('words alone: Send note appends them, the decision stays open, the room hears "Note on decision (no pick yet): …"', async ({ page }) => {
    const card = await firstCard(page);
    const before = (await posts(page)).length;
    await field(card).fill('None of these fit: ask the gardeners first.');
    await card.getByRole('button', { name: 'Send note' }).click();
    await expect(card.getByText('Note sent to the room.')).toBeVisible();
    const m = await stored(page);
    expect(m.state).toBe('open');
    expect(m.decided ?? null).toBe(null);
    expect(m.notes.map((n: any) => [n.text, n.by])).toEqual([['None of these fit: ask the gardeners first.', 'aaron']]);
    const sent = (await posts(page)).slice(before);
    expect(sent.map((p: any) => [p.channel, p.body, p.recipients])).toEqual([[BUILD, `Note on decision (no pick yet): None of these fit: ask the gardeners first. uni:${D1}`, ['b'.repeat(64)]]]);
    // still open and tappable; the field is empty again and the note shows on the card
    await expect(field(card)).toHaveValue('');
    await expect(card.locator('.decision-notes')).toHaveText('You: None of these fit: ask the gardeners first.');
    await shot(page, '13-note-alone');
    // and a pick after it is written against the revision the note made (no "the question changed")
    await card.getByRole('button', { name: 'A', exact: true }).click();
    await expect(card.locator('.decision-result')).toHaveText('Decided: A · by you');
  });

  test('Enter is a new line and never sends; Shift+Enter and Ctrl+Enter send the words alone', async ({ page }) => {
    const card = await firstCard(page);
    const before = (await posts(page)).length;
    const box = field(card);
    await box.click();
    await box.pressSequentially('line one');
    await box.press('Enter');
    await box.pressSequentially('line two');
    await expect(box).toHaveValue('line one\nline two');
    // it grew to fit the second line
    expect((await box.boundingBox())!.height).toBeGreaterThan(50);
    await page.waitForTimeout(300);
    expect((await posts(page)).length).toBe(before);
    expect((await stored(page)).notes).toBeUndefined();
    await box.press('Shift+Enter');
    await expect(card.getByText('Note sent to the room.')).toBeVisible();
    expect((await stored(page)).notes.map((n: any) => n.text)).toEqual(['line one\nline two']);
    await box.pressSequentially('and one more');
    await box.press('Control+Enter');
    await expect.poll(async () => (await stored(page)).notes.length).toBe(2);
    const sent = (await posts(page)).slice(before).map((p: any) => p.body);
    expect(sent).toEqual([`Note on decision (no pick yet): line one\nline two uni:${D1}`, `Note on decision (no pick yet): and one more uni:${D1}`]);
    expect((await stored(page)).state).toBe('open');
  });

  test('a tap that lost the race writes and posts nothing and keeps the words; they survive a redraw and can go as a note', async ({ page }) => {
    const card = await firstCard(page);
    await arrive(page, `Reminder: uni:${D1}`);
    await field(card).fill('C, so the path stays lit.');
    // the same decision's other card shows the same unsent words (they live with the decision, not the card), and a redraw keeps them
    const other = page.locator('.sr-chat .message .decision-card').nth(1);
    await expect(field(other)).toHaveValue('C, so the path stays lit.');
    await arrive(page, 'Something else entirely.');
    await expect(field(card)).toHaveValue('C, so the path stays lit.');
    await page.evaluate((d) => { const t = (window as any).__tasks.find((x: any) => x.id === d); Object.assign(t.metadata, { state: 'decided', decided: 'A', decided_by: 'room' }); t.updatedAt = '2026-10-09T09:30:00.000Z'; }, D1);
    const before = (await posts(page)).length;
    await card.getByRole('button', { name: 'C', exact: true }).click();
    await expect(card.locator('.decision-result')).toHaveText('Decided: A · by room');
    await expect(card.getByText(/Already decided before your tap; nothing was sent\. Your note is still here/)).toBeVisible();
    await expect(field(card)).toHaveValue('C, so the path stays lit.');
    const m = await stored(page);
    expect([m.decided, m.decided_note, m.notes]).toEqual(['A', undefined, undefined]);
    await page.waitForTimeout(500);
    expect((await posts(page)).length).toBe(before);
    await shot(page, '14-lost-keeps-words');
    // cleared to be retyped, the field stays
    await field(card).fill('');
    await expect(field(card)).toBeVisible();
    await field(card).fill('C, so the path stays lit.');
    // sent on its own now: the room hears it, saying what it was decided as
    await card.getByRole('button', { name: 'Send note' }).click();
    await expect(card.getByText('Note sent to the room.')).toBeVisible();
    expect((await posts(page)).slice(before).map((p: any) => p.body)).toEqual([`Note on decision (decided already: A): C, so the path stays lit. uni:${D1}`]);
    expect((await stored(page)).notes.map((n: any) => n.text)).toEqual(['C, so the path stays lit.']);
  });

  test('a note that could not be saved stays in the field and nothing is posted', async ({ page }) => {
    const card = await firstCard(page);
    const before = (await posts(page)).length;
    await field(card).fill('Ask again on Friday.');
    await page.evaluate(() => { (window as any).__noteSaveFails = true; });
    await card.getByRole('button', { name: 'Send note' }).click();
    await expect(card.getByRole('alert')).toHaveText(/^Couldn't save your note: hub unreachable/);
    await expect(field(card)).toHaveValue('Ask again on Friday.');
    expect((await posts(page)).length).toBe(before);
    await card.getByRole('button', { name: 'Send note' }).click();
    await expect(card.getByText('Note sent to the room.')).toBeVisible();
  });

  test('the length cap: the field stops at 1000 characters and counts down from 900', async ({ page }) => {
    const card = await firstCard(page);
    const box = field(card);
    await box.fill('x'.repeat(899));
    await expect(card.locator('.decision-count')).toHaveCount(0);
    await box.fill('x'.repeat(950));
    await expect(card.locator('.decision-count')).toHaveText('50 characters left');
    await box.fill('y'.repeat(1200));
    await expect(box).toHaveValue('y'.repeat(1000));
    await expect(card.locator('.decision-count')).toHaveText('1000 characters: the most a note takes');
    await shot(page, '15-cap');
    await card.getByRole('button', { name: 'A', exact: true }).click();
    await expect(card.locator('.decision-result')).toHaveText('Decided: A · by you');
    expect((await stored(page)).decided_note).toBe('y'.repeat(1000));
  });

  test('words that look like markup stay words: stored as typed, escaped in the room, shown as text', async ({ page }) => {
    const card = await firstCard(page);
    const words = '<b>bold</b> and [x](javascript:alert(1)) **loud**\n# not a heading';
    await field(card).fill(words);
    await card.getByRole('button', { name: 'Send note' }).click();
    await expect(card.getByText('Note sent to the room.')).toBeVisible();
    expect((await stored(page)).notes[0].text).toBe(words);
    const body = (await posts(page)).at(-1).body;
    expect(body).toBe(`Note on decision (no pick yet): <b>bold</b> and \\[x\\](javascript:alert(1)) \\*\\*loud\\*\\*\n\\# not a heading uni:${D1}`);
    // in the chat: the words as typed, no link, no bold, no heading, no element from the text
    const own = page.locator('.sr-chat .message').filter({ hasText: 'Note on decision (no pick yet)' });
    const md = own.locator('.message-content > .md');
    await expect(md).toContainText('<b>bold</b> and [x](javascript:alert(1)) **loud**');
    await expect(md.locator('a[href^="javascript"], b, strong, em, .md-h')).toHaveCount(0);
    await expect(md).toContainText('# not a heading');
    // on the card too
    await expect(card.locator('.decision-notes li')).toContainText('<b>bold</b> and [x](javascript:alert(1))');
    await expect(card.locator('.decision-notes b')).toHaveCount(0);
    await shot(page, '16-markup-as-text');
  });
});
