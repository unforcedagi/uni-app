// T-335: typing in a room with a long history paints each key at once (typed text was showing up long after it was typed).
// Every key used to redraw the whole room view (and through it the room tree's shell) and re-lay out the room's column twice (the composer's
// height set to auto, then read back); every live event in the room redrew every message, its markdown and links parsed again, its time
// formatted with a new formatter. On a slow phone the keys queued behind that work.
// The fixture's made-up world with a long history (`big`: 2000 messages a room, 45 rooms, 12 areas of 6 projects with ~720 tasks).
// Two kinds of check:
// - what redraws (React commits, read through the DevTools hook): exact and independent of the machine's load, so they are the guards
//   that fail when the fix is undone;
// - how long a key takes to paint (Event Timing: input to the next paint) with the CPU slowed 4x, the best of three passes (a busy machine
//   only adds time): the 50 ms bound the brief asks for.
// Run: TYPING_TEST_PORT=5771 npx playwright test --config playwright.typing.config.ts
import { test, expect, type Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const THROTTLE = Number(process.env.TYPING_THROTTLE ?? 4);
const LIMIT_MS = Number(process.env.TYPING_LIMIT_MS ?? 50);
const TEXT = 'the kiln is ready';

/** Counts the components React renders in each commit while `__counting` is on (as React DevTools reads a commit). */
function countRenders() {
  const w = window as any;
  w.__renders = 0;
  w.__rendered = {} as Record<string, number>;
  const name = (f: any) => { const t = f.type; return typeof t === 'function' ? (t.displayName || t.name || 'anonymous') : t && typeof t === 'object' ? ((t.type && (t.type.displayName || t.type.name)) || (t.render && (t.render.displayName || t.render.name)) || 'wrapped') : null; };
  const hit = (f: any) => { const k = name(f); if (k) { w.__renders++; w.__rendered[k] = (w.__rendered[k] ?? 0) + 1; } };
  const mount = (f: any) => { for (let c = f; c; c = c.sibling) { hit(c); if (c.child) mount(c.child); } };
  // a fiber with no alternate mounted; one whose children are the very fibers it had before was skipped, and so were they
  const visit = (f: any) => { for (let c = f; c; c = c.sibling) { const prev = c.alternate; if (!prev) { hit(c); if (c.child) mount(c.child); continue; } if (c.flags & 1) hit(c); if (c.child && c.child !== prev.child) visit(c.child); } };
  w.__REACT_DEVTOOLS_GLOBAL_HOOK__ = { isDisabled: false, supportsFiber: true, renderers: new Map(), inject: () => 1,
    onScheduleFiberRoot() {}, onCommitFiberUnmount() {}, onPostCommitFiberRoot() {},
    onCommitFiberRoot(_id: number, root: any) { if (w.__counting) visit(root.current); } };
}

async function openRoom(page: Page) {
  await page.addInitScript(countRenders);
  await bootAreas(page, 'seed', { world: 'unread', pinned: true, big: 2000, tasks: true, unread: { 'ch-kiln': 2, 'ch-allot': 3 } });
  // 0.2 one home: the doors are in the drawer under the home's head, pulled down once the rooms are read
  const pull = page.locator('[data-place="front-door"][data-view="all"] .fd-pull');
  await expect(pull).toBeEnabled({ timeout: 20_000 });
  if ((await pull.getAttribute('aria-expanded')) !== 'true') await pull.click();
  await page.getByRole('region', { name: 'Your places' }).locator('.fd-door[data-path="Areas/North Field"]').click();
  const box = page.getByRole('textbox', { name: 'Message north-field' });
  await box.waitFor();
  await expect(page.locator('.message-list article.message').first()).toBeVisible();
  // the room settles (its read, the approvals read, the tasks) before anything is counted
  await page.waitForTimeout(2500);
  await box.click();
  return box;
}

/** What renders while `act` runs (and for `settleMs` after): the count and the components most often redrawn. */
async function rendersDuring(page: Page, act: () => Promise<void>, settleMs = 1500) {
  await page.evaluate(() => { const w = window as any; w.__renders = 0; w.__rendered = {}; w.__counting = true; });
  await act();
  await page.waitForTimeout(settleMs);
  return page.evaluate(() => {
    const w = window as any; w.__counting = false;
    return { n: w.__renders as number, most: Object.entries(w.__rendered as Record<string, number>).sort((a, b) => b[1] - a[1]).slice(0, 6) };
  });
}

/** Types `text` a key at a time, each let settle, and returns each key's input-to-paint time (ms) from Event Timing. */
async function keyLatencies(page: Page, text: string): Promise<number[]> {
  await page.evaluate(() => {
    const w = window as any;
    w.__keyTimes = new Map<number, number>();
    w.__keyObserver?.disconnect();
    w.__keyObserver = new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) if (e.interactionId) w.__keyTimes.set(e.interactionId, Math.max(w.__keyTimes.get(e.interactionId) ?? 0, e.duration));
    });
    w.__keyObserver.observe({ type: 'event', durationThreshold: 16, buffered: false } as any);
  });
  for (const ch of text) {
    await page.keyboard.type(ch);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30))));
  }
  await page.waitForTimeout(300);
  // Event Timing reports only keys slower than 16 ms: the others count as 16
  const slow = await page.evaluate(() => [...(window as any).__keyTimes.values()] as number[]);
  return [...slow, ...Array(Math.max(0, text.length - slow.length)).fill(16)];
}

/** The component names redrawn (a bundler may add a number to a name it renamed: `Body2`), without that number. */
const names = (most: [string, number][]) => most.map(([name]) => name.replace(/\d+$/, ''));

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)] ?? 0; };

/** The best median of three passes of `TEXT` at the slowed CPU (each pass clears the composer first). */
async function bestMedian(page: Page, label: string, during?: () => Promise<() => Promise<void>>) {
  const cdp = await page.context().newCDPSession(page);
  const box = page.getByRole('textbox', { name: 'Message north-field' });
  const medians: number[] = [];
  for (let pass = 0; pass < 3; pass++) {
    await box.fill('');
    await box.click();
    const stop = during ? await during() : null;
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
    const times = await keyLatencies(page, TEXT);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    if (stop) await stop();
    await expect(box).toHaveValue(TEXT);
    medians.push(median(times));
    console.log(`typing ${label} ${test.info().project.name} pass ${pass + 1}: ${THROTTLE}x CPU, median ${median(times)} ms, worst ${Math.max(...times)} ms`);
  }
  return Math.min(...medians);
}

/** Uni busy here and elsewhere: in turn a new message in this room, an edit announced in it, a message in another room, every `ms`. */
const uniBusy = (page: Page, ms: number) => async () => {
  await page.evaluate((every) => {
    const w = window as any;
    let n = 0;
    w.__busy = setInterval(() => {
      const k = n++ % 3;
      if (k === 0) w.__arrive('ch-north', 'Uni', `Still on it: step ${n} of the firing plan is done.`);
      else if (k === 1) for (const h of w.__listeners['uni://live'] ?? []) w.__cbs[h]?.({ event: 'uni://live', id: 1, payload: { kind: 'edit', channel: 'ch-north' } });
      else w.__arrive('ch-kiln', 'Uni', `Kiln note ${n}.`);
    }, every);
  }, ms);
  return async () => { await page.evaluate(() => clearInterval((window as any).__busy)); };
};

test('a key typed in a long room redraws the composer field alone, and paints within the limit', async ({ page }) => {
  const box = await openRoom(page);
  await box.pressSequentially('a');
  // the composer's own size is written only when it changes: setting it to auto and back on every key re-laid out the room's whole column
  await box.evaluate((el) => { const w = window as any; w.__sized = 0; new MutationObserver((rs) => { w.__sized += rs.length; }).observe(el, { attributes: true, attributeFilter: ['style'] }); });
  const r = await rendersDuring(page, async () => { for (const ch of TEXT) await page.keyboard.type(ch); }, 500);
  const sized = await page.evaluate(() => (window as any).__sized as number);
  console.log(`typing renders ${test.info().project.name}: ${r.n} components for ${TEXT.length} keys; most ${JSON.stringify(r.most)}; composer resized ${sized} times`);
  await expect(box).toHaveValue('a' + TEXT);
  // one line of text, perhaps wrapping once: a height change or two, never one per key
  expect(sized, 'writes to the composer\'s size while typing one line').toBeLessThanOrEqual(4);
  // the field, once a key; the room view only when the composer turns from empty to not (it didn't here)
  expect(r.n, `components redrawn for ${TEXT.length} keys: ${JSON.stringify(r.most)}`).toBeLessThanOrEqual(TEXT.length);
  expect(names(r.most)).not.toContain('Conversations');
  const best = await bestMedian(page, 'quiet');
  expect(best, `best median key ${best} ms at ${THROTTLE}x CPU`).toBeLessThanOrEqual(LIMIT_MS);
});

test('a live event in the room redraws only what changed', async ({ page }) => {
  await openRoom(page);
  const rows = await page.locator('.message-list article.message').count();
  // an edit announced in the room that changed nothing it shows: the room view takes the event (a re-read), and no message redraws
  const same = await rendersDuring(page, () => page.evaluate(() => { const w = window as any; for (const h of w.__listeners['uni://live'] ?? []) w.__cbs[h]?.({ event: 'uni://live', id: 1, payload: { kind: 'edit', channel: 'ch-north' } }); }));
  console.log(`typing renders ${test.info().project.name}: ${same.n} components for an unchanged re-read; most ${JSON.stringify(same.most)}`);
  // the room view and its own parts, a few dozen; never anything like a component per message (0.1.83: 679 for 284 rows)
  expect(same.n, `an unchanged re-read redrew ${JSON.stringify(same.most)}`).toBeLessThan(rows / 4);
  expect(names(same.most)).not.toContain('Body');
  // a new message: the new row, the cards whose state is read again, the room view; never every message's body and attachments
  const arrived = await rendersDuring(page, () => page.evaluate(() => { (window as any).__arrive('ch-north', 'Uni', 'A new line from Uni.'); }));
  console.log(`typing renders ${test.info().project.name}: ${arrived.n} components for one new message (${rows} rows on screen); most ${JSON.stringify(arrived.most)}`);
  await expect(page.locator('.message-list').getByText('A new line from Uni.')).toBeVisible();
  expect(arrived.n, `one new message redrew ${JSON.stringify(arrived.most)}`).toBeLessThan(rows / 2);
  expect(names(arrived.most)).not.toContain('Attachments');
  expect(names(arrived.most)).not.toContain('Body');
});

test('a key typed while Uni is busy in the room paints within the limit', async ({ page }) => {
  await openRoom(page);
  const best = await bestMedian(page, 'busy', uniBusy(page, 400));
  expect(best, `best median key ${best} ms at ${THROTTLE}x CPU while Uni is busy`).toBeLessThanOrEqual(LIMIT_MS);
});

test('the composer grows a line at a time, scrolls past its cap, and shrinks back (measured off to the side)', async ({ page }) => {
  const box = await openRoom(page);
  const size = () => box.evaluate((el: HTMLTextAreaElement) => {
    const s = getComputedStyle(el);
    return { h: el.getBoundingClientRect().height, line: parseFloat(s.lineHeight), pad: parseFloat(s.paddingTop) + parseFloat(s.paddingBottom), min: parseFloat(s.minHeight), scrolls: el.scrollHeight > el.clientHeight + 1, overflow: s.overflowY };
  });
  const one = await size();
  await box.fill('one\ntwo\nthree');
  const three = await size();
  expect(three.h).toBeCloseTo(Math.max(three.min, 3 * three.line + three.pad), 0);
  expect(three.scrolls).toBe(false);
  await box.fill(Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n'));
  const ten = await size();
  // six lines, then it scrolls
  expect(ten.h).toBeCloseTo(6 * ten.line + ten.pad, 0);
  expect(ten.overflow).toBe('auto');
  expect(ten.scrolls).toBe(true);
  await box.fill('one');
  expect((await size()).h).toBeCloseTo(one.h, 0);
  // a long line wraps as the field does (the copy measures at the field's own width): the height the old way (auto, then read back) would give
  for (const words of [9, 14, 22]) {
    await box.fill('word '.repeat(words).trim());
    const got = await box.evaluate((el: HTMLTextAreaElement) => {
      const h = el.getBoundingClientRect().height, was = el.style.height;
      el.style.height = 'auto'; const content = el.scrollHeight; el.style.height = was;
      const s = getComputedStyle(el), cap = 6 * parseFloat(s.lineHeight) + parseFloat(s.paddingTop) + parseFloat(s.paddingBottom);
      return { h, want: Math.max(parseFloat(s.minHeight), Math.min(content, cap)) };
    });
    expect(got.h, `${words} words`).toBeCloseTo(got.want, 0);
  }
  // a short landscape window caps the field at its CSS 64px, and the rest scrolls
  await page.setViewportSize({ width: 740, height: 360 });
  await box.fill(Array.from({ length: 5 }, (_, i) => `line ${i + 1}`).join('\n'));
  await expect.poll(async () => (await size()).h).toBeLessThanOrEqual(64.5);
  const short = await size();
  expect(short.overflow).toBe('auto');
  expect(short.scrolls).toBe(true);
  // and the measuring copy never keeps the text
  expect(await page.evaluate(() => [...document.querySelectorAll('textarea[aria-hidden="true"]')].map((t) => (t as HTMLTextAreaElement).value))).toEqual(['']);
});
