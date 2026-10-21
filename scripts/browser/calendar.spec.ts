// T-229: the Calendar place, driven as a person would, against a fake calendar door made from the shared fixture
// (made-up events). Desktop 1440×900, phone 390×844, the Daylight upright and on its side; the browser is in Berlin and
// the times read are Denver's. Run: pnpm test:calendar (CAL_SHOTS=<dir> keeps a screenshot of each step).
import { expect, test } from '@playwright/test';
import { beside, boot, cal, detail, ev, isPhone, noSidewaysScroll, ops, pickView, shot } from './calMock';

test.describe('T-229 Calendar', () => {
  test('every view shows the door\'s events in the calendar\'s zone', async ({ page }) => {
    await boot(page);
    const c = cal(page);
    await pickView(page, 'Week');
    // Thursday's lunch is noon in Denver (18:00Z), shown as noon though the browser is in Berlin
    await expect(ev(page, 'Lunch with Kai')).toHaveAccessibleName(/Thursday, Oct 22 · 12 PM – 1 PM/);
    await expect(ev(page, 'Call with Ines?')).toHaveAccessibleName(/tentative/);
    await expect(ev(page, 'Board call')).toHaveAccessibleName(/cancelled/);
    await expect(ev(page, /^Studio hours, Thursday, Oct 22 · 9 AM – 11 AM, repeats/)).toBeVisible();
    if (!isPhone(page)) {
      await expect(c.getByRole('heading', { name: 'Oct 19 – Sun, Oct 25' })).toBeVisible();
      await expect(c.getByRole('group', { name: 'All-day events' }).getByRole('button', { name: /^Seed swap week,/ })).toBeVisible();
    } else {
      // three days from today on a phone
      await expect(c.locator('.cal-col')).toHaveCount(3);
      await expect(c.getByRole('heading', { name: 'Oct 21 – Oct 23' })).toBeVisible();
    }
    await expect(c.getByText('Times in America/Denver')).toBeAttached();
    await shot(page, 'week');
    await noSidewaysScroll(page);

    await pickView(page, 'Day');
    await expect(c.locator('.cal-col')).toHaveCount(1);
    await expect(ev(page, 'Soil workshop')).toHaveAccessibleName(/Wednesday, Oct 21 · 6 PM – 8 PM/);
    await expect(ev(page, 'Lunch with Kai')).toHaveCount(0);
    await c.getByRole('button', { name: 'Later' }).click();
    await expect(ev(page, 'Lunch with Kai')).toBeVisible();
    await c.getByRole('button', { name: 'Today' }).click();
    await shot(page, 'day');
    await noSidewaysScroll(page);

    await pickView(page, 'Agenda');
    const wed = c.getByRole('region', { name: 'Wednesday, Oct 21' });
    await expect(wed.getByRole('heading')).toContainText('today');
    await expect(wed.getByRole('button', { name: /^Soil workshop,.*public/ })).toBeVisible();
    // the weekly reading group keeps 7 PM after the clocks change on Nov 1
    await expect(c.getByRole('region', { name: 'Monday, Nov 2' }).getByRole('button', { name: /^Reading group, Monday, Nov 2 · 7 PM – 8:30 PM/ })).toBeVisible();
    await shot(page, 'agenda');
    await noSidewaysScroll(page);
  });

  test('create, then edit, by form', async ({ page }) => {
    const d = await boot(page);
    const c = cal(page);
    await pickView(page, 'Week');
    await c.getByRole('button', { name: 'New event', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New event' });
    await form.getByLabel('Title').fill('Pottery wheel session');
    await form.getByLabel('Start').fill('14:00');
    await form.getByLabel('End').fill('15:30');
    await form.getByLabel('Where').fill('Clay barn');
    await shot(page, 'new-form');
    await form.getByRole('button', { name: 'Add event' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Added “Pottery wheel session”.' })).toBeVisible();
    const made = ops(d).find((o) => o.op === 'create');
    expect(made.fields).toEqual({ title: 'Pottery wheel session', location: 'Clay barn', start: '2026-10-21T20:00:00Z', end: '2026-10-21T21:30:00Z', all_day: false, tz: 'America/Denver', visibility: 'private' });
    expect(made.opId).toMatch(/^app-[0-9a-f]{24}$/);
    // the new event opens, read back from the door
    await expect(detail(page)).toHaveAccessibleName('Event: Pottery wheel session');
    await expect(detail(page).getByText('Wednesday, Oct 21 · 2 PM – 3:30 PM')).toBeVisible();

    await detail(page).getByRole('button', { name: 'Edit…' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit event' });
    await expect(edit.getByLabel('Title')).toHaveValue('Pottery wheel session');
    await edit.getByLabel('Title').fill('Pottery wheel, second go');
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(detail(page)).toHaveAccessibleName('Event: Pottery wheel, second go');
    const upd = ops(d).find((o) => o.op === 'update');
    // only what changed, with the revision it was read at
    expect(upd).toMatchObject({ op: 'update', base_rev: 1, scope: 'all', fields: { title: 'Pottery wheel, second go' } });
    expect(Object.keys(upd.fields)).toEqual(['title']);
    if (!beside(page)) await detail(page).getByRole('button', { name: 'Close event' }).click();
    await expect(ev(page, 'Pottery wheel, second go')).toBeVisible();
    await noSidewaysScroll(page);
  });

  test('move by form, and by drag on a desktop', async ({ page }) => {
    const d = await boot(page);
    await pickView(page, 'Week');
    await ev(page, 'Lunch with Kai').click();
    await detail(page).getByRole('button', { name: 'Move…' }).click();
    const form = detail(page).getByRole('form', { name: 'Move event' });
    await form.getByLabel('Start').fill('13:30');
    await form.getByRole('button', { name: 'Move' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Moved “Lunch with Kai” to Thu, Oct 22, 1:30 PM.' })).toBeVisible();
    expect(ops(d).filter((o) => o.op === 'move')).toMatchObject([{ id: 'fx-lunch', base_rev: 1, start: '2026-10-22T19:30:00Z', end: '2026-10-22T20:30:00Z', scope: 'all' }]);
    await expect(detail(page).getByText('Thursday, Oct 22 · 1:30 PM – 2:30 PM')).toBeVisible();
    await detail(page).getByRole('button', { name: 'Close event' }).click();
    if (test.info().project.name !== 'desktop') {
      // no drag on a touch screen: a touch opens the event
      return;
    }
    // drag the dentist down an hour and over a day: Fri 10 AM → Sat 11 AM
    const box = (await ev(page, 'Dentist (private canary)').boundingBox())!;
    const colW = (await cal(page).locator('.cal-col').first().boundingBox())!.width;
    await page.mouse.move(box.x + box.width / 2, box.y + 10);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + box.width / 2 + (colW * i) / 6, box.y + 10 + (48 * i) / 6);
    await page.mouse.up();
    await expect(ev(page, 'Dentist (private canary)')).toHaveAccessibleName(/Saturday, Oct 24 · 11 AM – 12 PM/);
    expect(ops(d).filter((o) => o.op === 'move')[1]).toMatchObject({ id: 'fx-dentist', base_rev: 1, start: '2026-10-24T17:00:00Z', end: '2026-10-24T18:00:00Z', scope: 'all' });
    await shot(page, 'dragged');
  });

  test('a repeating event asks which events: this, following or all', async ({ page }) => {
    const d = await boot(page);
    await pickView(page, 'Week');
    const thu = ev(page, /^Studio hours, Thursday, Oct 22/);
    if (test.info().project.name === 'desktop') {
      // a drag on one of them asks first
      const box = (await thu.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + 10);
      await page.mouse.down();
      for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + box.width / 2, box.y + 10 + (48 * i) / 6);
      await page.mouse.up();
      const ask = page.getByRole('dialog', { name: 'Move a repeating event' });
      await expect(ask.getByRole('button')).toHaveText(['This event', 'This and following', 'All events', "Don't move"]);
      await shot(page, 'scope-ask');
      await ask.getByRole('button', { name: 'This event' }).click();
      await expect(ev(page, /^Studio hours, Thursday, Oct 22 · 10 AM – 12 PM/)).toBeVisible();
      expect(ops(d).at(-1)).toMatchObject({ op: 'move', id: 'fx-studio', base_rev: 1, scope: 'this', recurrence_id: '2026-10-22T15:00:00Z', start: '2026-10-22T16:00:00Z', end: '2026-10-22T18:00:00Z' });
      // Tuesday's didn't move
      await expect(ev(page, /^Studio hours, Tuesday, Oct 20 · 9 AM – 11 AM/)).toBeVisible();
    }
    // cancelling one asks too, and "Keep them" sends nothing
    await ev(page, /^Studio hours, Thursday, Oct 22/).click();
    await detail(page).getByRole('button', { name: 'Cancel…' }).click();
    const ask = page.getByRole('dialog', { name: 'Cancel a repeating event' });
    const before = ops(d).length;
    await ask.getByRole('button', { name: 'Keep them' }).click();
    expect(ops(d).length).toBe(before);
    await detail(page).getByRole('button', { name: 'Cancel…' }).click();
    await page.getByRole('dialog', { name: 'Cancel a repeating event' }).getByRole('button', { name: 'This and following' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Cancelled “Studio hours”.' })).toBeVisible();
    expect(ops(d).at(-1)).toMatchObject({ op: 'cancel', id: 'fx-studio', scope: 'following', recurrence_id: '2026-10-22T15:00:00Z' });
    // an edit to the series' people can't be for one event alone
    if (!beside(page) && await detail(page).isVisible()) await detail(page).getByRole('button', { name: 'Close event' }).click();
    await pickView(page, 'Agenda');
    await ev(page, /^Reading group, Monday, Oct 26/).click();
    await detail(page).getByRole('button', { name: 'Edit…' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit event' });
    await expect(edit.getByText('It repeats. To change its time, use Move.')).toBeVisible();
    await edit.getByLabel('People to invite').fill('juno@example.com, ines@example.com, kai@example.com');
    await edit.getByRole('button', { name: 'Save' }).click();
    const ask2 = page.getByRole('dialog', { name: 'Change a repeating event' });
    await expect(ask2.getByRole('button')).toHaveText(['This and following', 'All events', "Don't change"]);
    await ask2.getByRole('button', { name: 'All events' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved “Reading group”.' })).toBeVisible();
    // the people it had keep their names and answers; the new one waits for an answer
    expect(ops(d).at(-1)).toMatchObject({ op: 'update', id: 'fx-reading', scope: 'all', recurrence_id: '2026-10-27T01:00:00Z', fields: { attendees: [
      { address: 'mailto:juno@example.com', name: 'Juno Park', partstat: 'ACCEPTED' }, { address: 'mailto:ines@example.com', name: 'Ines Varga' }, { address: 'mailto:kai@example.com', partstat: 'NEEDS-ACTION' }] } });
    expect(Object.keys(ops(d).at(-1).fields)).toEqual(['attendees']);
    await noSidewaysScroll(page);
  });

  test('a write over a newer change is refused (409); nothing is saved and the panel shows it as it is now', async ({ page }) => {
    const d = await boot(page);
    await pickView(page, 'Week');
    await ev(page, 'Lunch with Kai').click();
    await expect(detail(page).getByText('Juniper Café', { exact: true })).toBeVisible();
    // meanwhile it changes somewhere else (a phone, Uni in chat)
    d.door.touch('fx-lunch', { location: 'Juniper Café, the patio' });
    await detail(page).getByRole('button', { name: 'Move…' }).click();
    await detail(page).getByLabel('Start').fill('13:00');
    await detail(page).getByRole('button', { name: 'Move', exact: true }).click();
    await expect(detail(page).getByRole('alert')).toHaveText('It changed since you opened it. Here it is now; nothing was saved.');
    await expect(detail(page).getByText('Juniper Café, the patio')).toBeVisible();
    await expect(detail(page).getByText('Thursday, Oct 22 · 12 PM – 1 PM')).toBeVisible();
    expect(d.door.notes.get('fx-lunch')!.start).toBe('2026-10-22T18:00:00Z');
    await shot(page, 'stale');
    // the same move again, now on the revision it was shown
    await detail(page).getByRole('button', { name: 'Move…' }).click();
    await detail(page).getByLabel('Start').fill('13:00');
    await detail(page).getByRole('button', { name: 'Move', exact: true }).click();
    await expect(detail(page).getByText('Thursday, Oct 22 · 1 PM – 2 PM')).toBeVisible();
    expect(ops(d).filter((o) => o.op === 'move').map((o) => o.base_rev)).toEqual([1, 2]);
  });

  test('who can see it: private, shared with named people, public', async ({ page }) => {
    const d = await boot(page);
    await pickView(page, 'Agenda');
    await cal(page).getByRole('button', { name: /^Garden plot rota,.*shared/ }).click();
    const vis = detail(page).getByRole('group', { name: 'Who can see it' });
    await expect(vis.getByRole('radio', { name: /Shared with…/ })).toBeChecked();
    await expect(vis.getByLabel('Shared with', { exact: true })).toHaveValue('People/Mara Quell');
    await vis.getByLabel('Shared with', { exact: true }).fill('People/Mara Quell, juno@example.com');
    await vis.getByRole('button', { name: 'Save who can see it' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Shared with 2 people.' })).toBeVisible();
    expect(ops(d).at(-1)).toMatchObject({ op: 'update', id: 'fx-garden', scope: 'all', fields: { visibility: 'shared', shared_with: ['People/Mara Quell', 'juno@example.com'] } });
    await vis.getByRole('radio', { name: /^Public/ }).check();
    await shot(page, 'visibility');
    await vis.getByRole('button', { name: 'Save who can see it' }).click();
    await expect(detail(page).locator('.cal-detail-marks')).toContainText('PUBLIC');
    expect(ops(d).at(-1)).toMatchObject({ fields: { visibility: 'public', shared_with: [] } });
    await vis.getByRole('radio', { name: /^Private/ }).check();
    await vis.getByRole('button', { name: 'Save who can see it' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Now private: only you see it.' })).toBeVisible();
    expect(d.door.notes.get('fx-garden')!.visibility).toBe('private');
  });

  test('invites go only after their confirm, and only for a key that may send them', async ({ page }) => {
    const d = await boot(page);
    await cal(page).getByRole('button', { name: 'New event', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New event' });
    await form.getByLabel('Title').fill('Seed library planning');
    await form.getByLabel('People to invite').fill('juno@example.com, mara@example.com');
    await expect(form.getByText('Invites wait until you send them from the event.')).toBeVisible();
    await form.getByRole('button', { name: 'Add event' }).click();
    const box = detail(page).getByRole('region', { name: 'Invites' });
    await expect(box).toContainText('Invites not sent.');
    await expect(detail(page).locator('.cal-detail-marks')).toContainText('TENTATIVE');
    await detail(page).getByRole('button', { name: 'Send invites…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Send invites?' });
    await expect(confirm.getByRole('listitem')).toHaveText(['juno@example.com', 'mara@example.com']);
    await shot(page, 'invite-confirm');
    await confirm.getByRole('button', { name: 'Not now' }).click();
    expect(ops(d).some((o) => o.op === 'send_invites')).toBe(false);
    expect(d.door.outbox).toEqual([]);
    await detail(page).getByRole('button', { name: 'Send invites…' }).click();
    await page.getByRole('dialog', { name: 'Send invites?' }).getByRole('button', { name: 'Send invites' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Invites are on their way, from your address.' })).toBeVisible();
    expect(d.door.outbox).toEqual([{ id: 'ev-0001', to: ['mailto:juno@example.com', 'mailto:mara@example.com'] }]);
    // on their way: not offered again
    await expect(box).toHaveCount(0);
    await expect(detail(page).getByRole('status')).toHaveText('Invites are on their way, from your address.');
    await expect(detail(page).getByRole('button', { name: /Send invites/ })).toHaveCount(0);
    expect(ops(d).filter((o) => o.op === 'send_invites')).toMatchObject([{ id: 'ev-0001', base_rev: 1 }]);
  });

  test('Uni\'s key sees no Delete and no Send invites', async ({ page }) => {
    const d = await boot(page, { role: 'uni' });
    await expect(cal(page).getByText('· as Uni')).toBeVisible();
    await cal(page).getByRole('button', { name: 'New event', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New event' });
    await form.getByLabel('Title').fill('Seed library planning');
    await form.getByLabel('People to invite').fill('juno@example.com');
    await form.getByRole('button', { name: 'Add event' }).click();
    await expect(detail(page)).toHaveAccessibleName('Event: Seed library planning');
    await expect(detail(page).getByRole('button', { name: 'Move…' })).toBeVisible();
    await expect(detail(page).getByRole('button', { name: 'Delete…' })).toHaveCount(0);
    await expect(detail(page).getByRole('region', { name: 'Invites' })).toHaveCount(0);
    await expect(detail(page).getByRole('button', { name: /Send invites/ })).toHaveCount(0);
    expect(d.door.notes.get('ev-0001')!.invite_pending).toBe(true);
    // the owner's key gets both
  });

  test('the owner can delete, behind a confirm', async ({ page }) => {
    const d = await boot(page);
    await pickView(page, 'Agenda');
    await cal(page).getByRole('button', { name: /^Board call,/ }).click();
    await detail(page).getByRole('button', { name: 'Delete…' }).click();
    await detail(page).getByRole('group', { name: 'Delete event?' }).getByRole('button', { name: 'Keep it' }).click();
    expect(d.door.notes.has('fx-board')).toBe(true);
    await detail(page).getByRole('button', { name: 'Delete…' }).click();
    await detail(page).getByRole('group', { name: 'Delete event?' }).getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Deleted “Board call”.' })).toBeVisible();
    expect(d.door.notes.has('fx-board')).toBe(false);
    await expect(cal(page).getByRole('button', { name: /^Board call,/ })).toHaveCount(0);
  });

  test('conflicts the sync left are listed', async ({ page }) => {
    await boot(page, { conflict: true });
    await cal(page).getByRole('button', { name: 'Conflicts (1)' }).click();
    const list = cal(page).getByRole('region', { name: 'Conflicts' });
    await expect(list.getByRole('listitem')).toContainText(['Lunch with Kai']);
    await expect(list.getByText(/KEPT Thursday, Oct 22 · 12\sPM – 1\sPM/)).toBeVisible();
    await expect(list.getByText(/Thursday, Oct 22 · 12:30\sPM – 1:30\sPM/)).toBeVisible();
    await expect(list.getByText('(Google)')).toBeVisible();
    await shot(page, 'conflicts');
    await list.getByRole('button', { name: 'Show the event ›' }).click();
    await expect(detail(page)).toHaveAccessibleName('Event: Lunch with Kai');
  });

  test('offline: the last snapshot, read-only, with a badge', async ({ page }) => {
    const d = await boot(page);
    await pickView(page, 'Week');
    await expect(ev(page, 'Lunch with Kai')).toBeVisible();
    d.down = true;
    await page.reload();
    const c = cal(page);
    await expect(c.getByRole('status').filter({ hasText: /^OFFLINE · saved Wed, Oct 21, 10\sAM$/ })).toBeVisible();
    await expect(c.getByRole('note')).toContainText("The calendar door isn't answering.");
    await expect(ev(page, 'Lunch with Kai')).toBeVisible();
    await expect(c.getByRole('button', { name: 'New event', exact: true })).toHaveCount(0);
    await expect(c.locator('.cal-slot')).toHaveCount(0);
    await ev(page, 'Lunch with Kai').click();
    await expect(detail(page).getByText('Offline: read-only until the calendar door answers.')).toBeVisible();
    await expect(detail(page).getByRole('button', { name: /Move|Edit|Cancel|Delete/ })).toHaveCount(0);
    for (const r of await detail(page).getByRole('group', { name: 'Who can see it' }).getByRole('radio').all()) await expect(r).toBeDisabled();
    await shot(page, 'offline');
    // days it never read say so
    await detail(page).getByRole('button', { name: 'Close event' }).click();
    for (let i = 0; i < 6; i++) await c.getByRole('button', { name: 'Later' }).click();
    await expect(c.getByRole('alert')).toContainText("The calendar door isn't answering.");
    await c.getByRole('button', { name: 'Today' }).click();
    // back online
    d.down = false;
    await c.getByRole('button', { name: 'Retry' }).first().click();
    await expect(c.getByText(/^OFFLINE/)).toHaveCount(0);
    await expect(c.getByRole('button', { name: 'New event', exact: true })).toBeVisible();
    await noSidewaysScroll(page);
  });

  test('the rail shows Calendar only once the door has answered this key', async ({ page }) => {
    const d = await boot(page, { open: false });
    const rail = page.getByRole('navigation', { name: 'Main navigation' });
    await expect(rail.getByRole('button', { name: 'Calendar' })).toBeVisible({ timeout: 8000 });
    await rail.getByRole('button', { name: 'Calendar' }).click();
    await expect(cal(page)).toBeVisible();
    await noSidewaysScroll(page);
    // a door that stops taking this key: gone from the rail at the next start
    d.refuse = true;
    await page.evaluate(() => localStorage.removeItem('uni.tabs.v2'));
    await page.reload();
    await expect.poll(() => page.evaluate(() => localStorage.getItem('uni.cal.seen.v1')), { timeout: 8000 }).toBeNull();
    await expect(rail.getByRole('button', { name: 'Calendar' })).toHaveCount(0);
  });

  test('a door without the session route: reads, and offers only what every key may do', async ({ page }) => {
    await boot(page, { noSession: true });
    await pickView(page, 'Agenda');
    await cal(page).getByRole('button', { name: /^Lunch with Kai,/ }).click();
    await expect(detail(page).getByRole('button', { name: 'Move…' })).toBeVisible();
    await expect(detail(page).getByRole('button', { name: 'Delete…' })).toHaveCount(0);
  });

  test('an edit keeps the event\'s days, and a new time goes as start and end together', async ({ page }) => {
    const d = await boot(page);
    await pickView(page, 'Agenda');
    // a three-day all-day event, its title alone changed
    await cal(page).getByRole('button', { name: /^Seed swap week,/ }).first().click();
    await detail(page).getByRole('button', { name: 'Edit…' }).click();
    let edit = page.getByRole('dialog', { name: 'Edit event' });
    await expect(edit.getByLabel('First day')).toHaveValue('2026-10-23');
    await expect(edit.getByLabel('Last day')).toHaveValue('2026-10-25');
    await edit.getByLabel('Title').fill('Seed swap weekend');
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(detail(page)).toHaveAccessibleName('Event: Seed swap weekend');
    expect(ops(d).at(-1).fields).toEqual({ title: 'Seed swap weekend' });
    // a week later: still three days
    await detail(page).getByRole('button', { name: 'Edit…' }).click();
    edit = page.getByRole('dialog', { name: 'Edit event' });
    await edit.getByLabel('First day').fill('2026-10-30');
    await expect(edit.getByLabel('Last day')).toHaveValue('2026-11-01');
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Saved “Seed swap weekend”.' })).toBeVisible();
    expect(ops(d).at(-1).fields).toEqual({ start: '2026-10-30', end: '2026-11-02', all_day: true });
    if (!beside(page)) await detail(page).getByRole('button', { name: 'Close event' }).click();
    // a timed event's end alone: start and end go together, and its zone isn't touched
    await cal(page).getByRole('button', { name: /^Lunch with Kai,/ }).click();
    await detail(page).getByRole('button', { name: 'Edit…' }).click();
    edit = page.getByRole('dialog', { name: 'Edit event' });
    await edit.getByLabel('End').fill('13:30');
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(detail(page).getByText('Thursday, Oct 22 · 12 PM – 1:30 PM')).toBeVisible();
    expect(ops(d).at(-1).fields).toEqual({ start: '2026-10-22T18:00:00Z', end: '2026-10-22T19:30:00Z', all_day: false });
  });

  test('an event past midnight ends the next day and shows on both', async ({ page }) => {
    const d = await boot(page);
    await pickView(page, 'Week');
    await cal(page).getByRole('button', { name: 'New event', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New event' });
    await form.getByLabel('Title').fill('Night sky watch');
    await form.getByLabel('Start').fill('23:00');
    await form.getByLabel('End').fill('01:00');
    await expect(form.getByText('Ends Thursday, Oct 22.')).toBeVisible();
    await form.getByRole('button', { name: 'Add event' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Added “Night sky watch”.' })).toBeVisible();
    expect(ops(d).at(-1).fields).toMatchObject({ start: '2026-10-22T05:00:00Z', end: '2026-10-22T07:00:00Z' });
    if (!beside(page)) await detail(page).getByRole('button', { name: 'Close event' }).click();
    await expect(cal(page).getByRole('group', { name: 'Wednesday, Oct 21' }).getByRole('button', { name: /^Night sky watch,/ })).toBeVisible();
    await expect(cal(page).getByRole('group', { name: 'Thursday, Oct 22' }).getByRole('button', { name: /^Night sky watch,/ })).toBeVisible();
  });

  test('an all-day event moved over the clock change keeps its days', async ({ page }) => {
    const d = await boot(page);
    await pickView(page, 'Agenda');
    await cal(page).getByRole('button', { name: /^Seed swap week,/ }).first().click();
    await detail(page).getByRole('button', { name: 'Move…' }).click();
    await detail(page).getByLabel('Day').fill('2026-10-31');
    await detail(page).getByRole('button', { name: 'Move', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Moved “Seed swap week”' })).toBeVisible();
    expect(ops(d).at(-1)).toMatchObject({ op: 'move', start: '2026-10-31', end: '2026-11-03' });
  });

  test('a failed read leaves nothing writable and says so; old events never show on new days', async ({ page }) => {
    const d = await boot(page);
    await pickView(page, 'Week');
    await expect(ev(page, 'Lunch with Kai')).toBeVisible();
    d.fail = 500;
    await cal(page).getByRole('button', { name: 'Refresh' }).click();
    await expect(cal(page).getByRole('alert')).toContainText("Couldn't read it again: The calendar door couldn't do it: internal error.");
    await expect(cal(page).getByRole('button', { name: 'New event', exact: true })).toHaveCount(0);
    await ev(page, 'Lunch with Kai').click();
    await expect(detail(page).getByRole('button', { name: 'Move…' })).toHaveCount(0);
    await detail(page).getByRole('button', { name: 'Close event' }).click();
    // the next days, unread: no events from the days before
    await cal(page).getByRole('button', { name: 'Later' }).click();
    await expect(cal(page).getByRole('alert')).toContainText("The calendar door couldn't do it");
    await expect(cal(page).locator('.cal-ev')).toHaveCount(0);
    d.fail = null;
    await cal(page).getByRole('button', { name: 'Retry' }).click();
    await expect(cal(page).getByRole('alert')).toHaveCount(0);
    await expect(cal(page).getByRole('button', { name: 'New event', exact: true })).toBeVisible();
  });

  test('an op whose answer never came back is sent again under its op id, and the screen shows what happened', async ({ page }) => {
    const d = await boot(page);
    await pickView(page, 'Agenda');
    await cal(page).getByRole('button', { name: /^Lunch with Kai,/ }).click();
    // lost before the door saw it: still at noon; the same move again reuses its op id
    d.lose = 'before';
    await detail(page).getByRole('button', { name: 'Move…' }).click();
    await detail(page).getByLabel('Start').fill('13:00');
    await detail(page).getByRole('button', { name: 'Move', exact: true }).click();
    await expect(detail(page).getByRole('alert')).toContainText("The calendar door isn't answering.");
    await expect(detail(page).getByText('Thursday, Oct 22 · 12 PM – 1 PM')).toBeVisible();
    await detail(page).getByRole('button', { name: 'Move…' }).click();
    await detail(page).getByLabel('Start').fill('13:00');
    await detail(page).getByRole('button', { name: 'Move', exact: true }).click();
    await expect(detail(page).getByText('Thursday, Oct 22 · 1 PM – 2 PM')).toBeVisible();
    const moves = ops(d).filter((o) => o.op === 'move');
    expect(moves.length).toBe(2);
    expect(moves[1].opId).toBe(moves[0].opId);
    // lost after the door applied it: the read again shows it moved, written once
    d.lose = 'after';
    await detail(page).getByRole('button', { name: 'Move…' }).click();
    await detail(page).getByLabel('Start').fill('15:00');
    await detail(page).getByRole('button', { name: 'Move', exact: true }).click();
    await expect(detail(page).getByText('Thursday, Oct 22 · 3 PM – 4 PM')).toBeVisible();
    expect(d.door.notes.get('fx-lunch')!.rev).toBe(3);
  });

  test('a title-only edit leaves times with seconds alone', async ({ page }) => {
    const d = await boot(page);
    // written by another calendar app, to the second
    d.door.touch('fx-ines', { start: '2026-10-22T17:00:30Z', end: '2026-10-22T17:30:30Z' });
    await cal(page).getByRole('button', { name: 'Refresh' }).click();
    await pickView(page, 'Agenda');
    await cal(page).getByRole('button', { name: /^Call with Ines\?,/ }).click();
    await detail(page).getByRole('button', { name: 'Edit…' }).click();
    const edit = page.getByRole('dialog', { name: 'Edit event' });
    await edit.getByLabel('Title').fill('Call with Ines');
    await edit.getByRole('button', { name: 'Save' }).click();
    await expect(detail(page)).toHaveAccessibleName('Event: Call with Ines');
    expect(ops(d).at(-1).fields).toEqual({ title: 'Call with Ines' });
    expect(d.door.notes.get('fx-ines')!.start).toBe('2026-10-22T17:00:30Z');
  });

  test('Refresh shows the open event as it is now, and what the key may do now', async ({ page }) => {
    test.skip(!beside(page), 'the event panel covers Refresh on narrow screens');
    const d = await boot(page);
    await pickView(page, 'Agenda');
    await cal(page).getByRole('button', { name: /^Lunch with Kai,/ }).click();
    await expect(detail(page).getByText('Juniper Café', { exact: true })).toBeVisible();
    await detail(page).getByRole('button', { name: 'Delete…' }).click();
    await expect(detail(page).getByRole('group', { name: 'Delete event?' })).toBeVisible();
    // elsewhere: it moved, and the door now takes this key as Uni's
    d.door.touch('fx-lunch', { start: '2026-10-22T19:00:00Z', end: '2026-10-22T20:00:00Z', location: 'Juniper Café, upstairs' });
    d.door.role = 'uni';
    await cal(page).getByRole('button', { name: 'Refresh' }).click();
    await expect(detail(page).getByText('Thursday, Oct 22 · 1 PM – 2 PM')).toBeVisible();
    await expect(detail(page).getByText('Juniper Café, upstairs')).toBeVisible();
    await expect(detail(page).getByRole('group', { name: 'Delete event?' })).toHaveCount(0);
    await expect(detail(page).getByRole('button', { name: /Delete/ })).toHaveCount(0);
    expect(ops(d).some((o) => o.op === 'delete')).toBe(false);
  });

  test('the invite confirm sends only what it showed; a send the door calls stale is offered again', async ({ page }) => {
    const d = await boot(page);
    await cal(page).getByRole('button', { name: 'New event', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'New event' });
    await form.getByLabel('Title').fill('Seed library planning');
    await form.getByLabel('People to invite').fill('juno@example.com');
    await form.getByRole('button', { name: 'Add event' }).click();
    await detail(page).getByRole('button', { name: 'Send invites…' }).click();
    await expect(page.getByRole('dialog', { name: 'Send invites?' }).getByRole('listitem')).toHaveText(['juno@example.com']);
    // meanwhile someone else is added
    const n = d.door.notes.get('ev-0001')!;
    d.door.touch('ev-0001', { attendees: [...n.attendees!, { address: 'mailto:kai@example.com', partstat: 'NEEDS-ACTION' }] });
    await page.getByRole('dialog', { name: 'Send invites?' }).getByRole('button', { name: 'Send invites' }).click();
    await expect(detail(page).getByRole('alert')).toHaveText('It changed since you opened it. Here it is now; nothing was saved.');
    expect(d.door.outbox).toEqual([]);
    await expect(detail(page).getByText('kai@example.com')).toBeVisible();
    // asked again, with everyone on it now
    await detail(page).getByRole('button', { name: 'Send invites…' }).click();
    await expect(page.getByRole('dialog', { name: 'Send invites?' }).getByRole('listitem')).toHaveText(['juno@example.com', 'kai@example.com']);
    await page.getByRole('dialog', { name: 'Send invites?' }).getByRole('button', { name: 'Send invites' }).click();
    await expect(detail(page).getByRole('status')).toHaveText('Invites are on their way, from your address.');
    expect(d.door.outbox).toEqual([{ id: 'ev-0001', to: ['mailto:juno@example.com', 'mailto:kai@example.com'] }]);
    // the door says the event changed after the tap: send again
    d.door.touch('ev-0001', { invite_state: 'stale' });
    if (beside(page)) await cal(page).getByRole('button', { name: 'Refresh' }).click();
    else { await detail(page).getByRole('button', { name: 'Close event' }).click(); await cal(page).getByRole('button', { name: 'Refresh' }).click(); await ev(page, 'Seed library planning').click(); }
    await expect(detail(page).getByRole('region', { name: 'Invites' })).toContainText('The event changed after you sent the invites; send them again.');
    await expect(detail(page).getByRole('button', { name: 'Send invites…' })).toBeVisible();
  });

  test('a Move form open when the event changes elsewhere starts again from the event as it is now', async ({ page }) => {
    test.skip(!beside(page), 'the event panel covers Refresh on narrow screens');
    const d = await boot(page);
    await pickView(page, 'Agenda');
    await cal(page).getByRole('button', { name: /^Lunch with Kai,/ }).click();
    await detail(page).getByRole('button', { name: 'Move…' }).click();
    await detail(page).getByLabel('Start').fill('13:00');
    d.door.touch('fx-lunch', { start: '2026-10-22T20:00:00Z', end: '2026-10-22T21:00:00Z' });
    await cal(page).getByRole('button', { name: 'Refresh' }).click();
    await expect(detail(page).getByText('Thursday, Oct 22 · 2 PM – 3 PM')).toBeVisible();
    await expect(detail(page).getByRole('form', { name: 'Move event' })).toHaveCount(0);
    await detail(page).getByRole('button', { name: 'Move…' }).click();
    await expect(detail(page).getByLabel('Start')).toHaveValue('14:00');
    expect(ops(d).some((o) => o.op === 'move')).toBe(false);
  });

  test('on the Daylight nothing moves', async ({ page }) => {
    test.skip(!test.info().project.name.startsWith('daylight'), 'the Daylight only');
    await boot(page);
    await expect(cal(page)).toHaveClass(/cal-still/);
    await pickView(page, 'Week');
    await ev(page, 'Lunch with Kai').click();
    await detail(page).getByRole('button', { name: 'Move…' }).click();
    const moving = await page.evaluate(() => {
      const els = [...document.querySelectorAll('.cal *')];
      // the Calendar's own elements (the app's rail is the shell's, outside this place)
      const mine = document.getAnimations().filter((a) => ((a.effect as KeyframeEffect | null)?.target as Element | null)?.closest('.cal'));
      return { animations: mine.length, transitions: els.filter((e) => parseFloat(getComputedStyle(e).transitionDuration) > 0).length };
    });
    expect(moving).toEqual({ animations: 0, transitions: 0 });
  });
});
