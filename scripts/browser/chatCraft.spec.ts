import { expect, test, type Locator, type Page } from '@playwright/test';

// T-132: code blocks you can read and copy, and composer drafts that survive a reload without crossing rooms, threads or identities.
// The real app path in the browser; only the Tauri IPC (and the clipboard behind it) is faked. Synthetic data only.
const ME = 'a'.repeat(64), OTHER = 'd'.repeat(64), UNI = 'b'.repeat(64);

const PY = 'def sow(month):\n\treturn [s for s in SEEDS if s.month == month]  # tab, then spaces\n\n\n    # two blank lines above, four spaces here';
const PLAIN = 'plain block, no language   \n  indented line\n\ntrailing spaces   ';
const LONG = 'echo ' + 'seedling-'.repeat(60) + 'end';
const HOSTILE = '<img src=x onerror="window.__pwned=1">\n<script>window.__pwned=2</script>';
const BODY = `Two snippets for the planner.\n\n\`\`\`python\n${PY}\n\`\`\`\n\nInline \`sow(4)\` stays inline.\n\n\`\`\`\n${PLAIN}\n\`\`\``;

type Boot = { identity?: string; tabs?: 'room' | 'thread' };

async function boot(page: Page) {
  await page.addInitScript(({ ME, UNI, BODY, LONG, HOSTILE }) => {
    const w = window as any;
    // a test changes these before a reload: who this device is, and which tab opens
    const id = sessionStorage.getItem('t.identity') ?? ME;
    const tab = sessionStorage.getItem('t.tab') ?? 'room';
    localStorage.removeItem('uni.tabs.v2'); localStorage.removeItem('uni.lastRoom.v1');
    localStorage.setItem('uni.tabs.v1', JSON.stringify(tab === 'thread'
      ? { v: 1, tabs: [{ id: 'th', kind: 'thread', channel: 'garden', root: 'm1', title: 'Thread · Garden' }], active: 'th', recent: ['th'] }
      : { v: 1, tabs: [{ id: 'room', kind: 'room', channel: 'garden', title: 'Garden' }], active: 'room', recent: ['room'] }));
    if (sessionStorage.getItem('t.noStorage')) {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key: string, value: string) {
        if (key.startsWith('uni.chatDraft')) throw new DOMException('full', 'QuotaExceededError');
        return set.call(this, key, value);
      };
    }
    const now = Math.floor(Date.now() / 1000);
    const msg = (ref: string, channel: string, author: string, ago: number, body: string) => ({ ref, channel, author, author_name: author === UNI ? 'Uni' : 'Robin', ts: now - ago, body, mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] });
    w.__msgs = {
      garden: [msg('m1', 'garden', UNI, 300, BODY), msg('m2', 'garden', UNI, 200, '```sh\n' + LONG + '\n```'), msg('m3', 'garden', UNI, 100, '```html\n' + HOSTILE + '\n```')],
      workshop: [msg('w1', 'workshop', UNI, 100, 'The workshop room.')],
    };
    w.__posts = []; w.__clip = [];
    // the clipboard: the Tauri plugin first, then the browser's two ways; a refusal refuses all three
    const nav = navigator.clipboard;
    if (nav) nav.writeText = async (text: string) => { if (w.__clipRefuse) throw new DOMException('denied', 'NotAllowedError'); w.__clip.push(text); };
    const exec = document.execCommand.bind(document);
    document.execCommand = (cmd: string, ...rest: any[]) => (w.__clipRefuse && cmd === 'copy' ? false : exec(cmd, ...rest));
    w.__cbs = []; w.__listeners = {};
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: (cb: any) => { w.__cbs.push(cb); return w.__cbs.length - 1; },
      invoke: async (cmd: string, args: any) => {
        switch (cmd) {
          case 'plugin:event|listen': (w.__listeners[args.event] ??= []).push(args.handler); return args.handler;
          case 'plugin:clipboard-manager|write_text': if (w.__clipRefuse) throw new Error('clipboard refused'); w.__clip.push(args.text); return null;
          case 'identity_status': return { paired: true, pubkey: id };
          case 'get_identity': return id;
          case 'relay_origin': return 'https://example.invalid';
          case 'get_npub': return 'test';
          case 'get_rooms': return [{ id: 'garden', name: 'Garden', unread: 0 }, { id: 'workshop', name: 'Workshop', unread: 0 }];
          case 'get_messages': return JSON.parse(JSON.stringify(w.__msgs[args.channel] ?? []));
          case 'get_members': return [{ pubkey: id, name: 'Robin', named: true }, { pubkey: UNI, name: 'Uni', named: true }];
          case 'post_message':
            if (w.holdSend) await new Promise((resolve) => { w.finishSend = resolve; });
            if (w.failSend) throw new Error('relay rejected the message');
            w.__posts.push({ channel: args.channel, body: args.body, replyTo: args.replyTo });
            return { ref: `p${w.__posts.length}`, channel: args.channel };
          case 'vault_paths': case 'journal_pending': case 'search_messages': case 'vault_search': case 'vault_tree': case 'journal_list': return [];
          case 'vault_list': return ['uni'];
          case 'journal_config': return { hub: 'https://example.invalid', vault: 'uni' };
          case 'journal_flush': return { sent: [], remaining: 0, error: null };
          case 'refresh': return { pubkey: id, total_items: 0, channel_errors: {}, truncated_channels: [] };
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  }, { ME, UNI, BODY, LONG, HOSTILE });
  await page.goto('/');
  await ready(page);
}

async function ready(page: Page) {
  await expect(page.getByRole('textbox', { name: 'Message Garden' })).toBeVisible();
  await expect(page.getByText('Two snippets for the planner.')).toBeVisible();
}

const touch = () => test.info().project.name !== 'desktop';
const press = (target: Locator) => (touch() ? target.tap() : target.click());
const clip = (page: Page) => page.evaluate(() => (window as any).__clip as string[]);
const posts = (page: Page) => page.evaluate(() => (window as any).__posts as { channel: string; body: string }[]);
const composer = (page: Page) => page.getByRole('textbox', { name: /^Message / });

async function reloadAs(page: Page, opts: Boot = {}) {
  await page.evaluate(({ identity, tabs }) => {
    if (identity) sessionStorage.setItem('t.identity', identity);
    if (tabs) sessionStorage.setItem('t.tab', tabs);
  }, opts);
  await page.reload();
  await expect(composer(page)).toBeVisible();
  await expect(page.getByText('Two snippets for the planner.')).toBeVisible();
  await page.waitForTimeout(300); // past the identity read, when a saved draft is put back
}

/** A room no node owns is under "Other rooms" in the room tree; a phone goes back to the tree first. */
async function switchRoom(page: Page, name: string) {
  const drawer = page.locator('.sr-drawer');
  if (await drawer.count()) await press(drawer);
  const tree = page.locator('.th-phone-tree, .th-roomnav').filter({ visible: true }).first();
  const fold = tree.locator('.th-others .th-fold');
  if (await fold.getAttribute('aria-expanded') !== 'true') await press(fold);
  await press(tree.locator('.th-other .th-go').filter({ hasText: '#' + name }));
  await expect(page.getByRole('textbox', { name: `Message ${name}` })).toBeVisible();
}

test.describe('code blocks', () => {
  test('each block copies exactly its own text; a fence with a language shows it, one without does not; inline code stays inline', async ({ page }) => {
    await boot(page);
    const first = page.locator('.message').filter({ hasText: 'Two snippets for the planner.' });
    const blocks = first.locator('.md-code');
    await expect(blocks).toHaveCount(2);
    await expect(blocks.nth(0).locator('.md-code-lang')).toHaveText('python');
    await expect(blocks.nth(1).locator('.md-code-lang')).toHaveCount(0);
    // what is shown is the code exactly, whitespace and blank lines too
    expect(await blocks.nth(0).locator('pre code').evaluate((el) => el.textContent)).toBe(PY);
    // inline code: no bar, no button
    await expect(first.locator('p code')).toHaveText('sow(4)');
    await expect(first.getByRole('button', { name: /^Copy/ })).toHaveCount(2);

    const py = first.getByRole('button', { name: 'Copy python code' });
    await press(py);
    expect((await clip(page)).at(-1)).toBe(PY);
    await expect(first.getByRole('button', { name: 'Copied python code' })).toHaveText('Copied');
    await expect(page.locator('.toast')).toHaveText('Code copied');
    // the other block's Copy is its own
    await press(first.getByRole('button', { name: 'Copy code', exact: true }));
    expect((await clip(page)).at(-1)).toBe(PLAIN);
    // and the feedback lets go
    await expect(first.getByRole('button', { name: 'Copy python code' })).toHaveText('Copy', { timeout: 5000 });
  });

  test('by keyboard: Enter and Space copy; Tab reaches the code, and arrows scroll a long line', async ({ page }) => {
    await boot(page);
    const py = page.getByRole('button', { name: 'Copy python code' });
    await py.focus();
    await page.keyboard.press('Enter');
    expect((await clip(page)).at(-1)).toBe(PY);
    await page.getByRole('button', { name: 'Copy sh code' }).focus();
    await page.keyboard.press('Space');
    expect((await clip(page)).at(-1)).toBe(LONG);
    await page.keyboard.press('Tab');
    const pre = page.locator('.md-code').filter({ hasText: 'seedling-' }).locator('pre');
    await expect(pre).toBeFocused();
    for (let i = 0; i < 5; i++) await page.keyboard.press('ArrowRight');
    await expect.poll(() => pre.evaluate((el) => el.scrollLeft)).toBeGreaterThan(100);
  });

  test('clipboard refused: the code opens selected in a box to copy by hand, exactly', async ({ page }) => {
    await boot(page);
    await page.evaluate(() => { (window as any).__clipRefuse = true; });
    await press(page.getByRole('button', { name: 'Copy python code' }));
    await expect(page.getByRole('alert').filter({ hasText: "Couldn't copy automatically" })).toBeVisible();
    const box = page.getByRole('textbox', { name: 'The python code, to copy by hand' });
    await expect(box).toBeVisible();
    await expect(box).toHaveValue(PY);
    await expect(box).toBeFocused();
    expect(await box.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd])).toEqual([0, PY.length]);
    await expect(page.getByRole('button', { name: 'Copied python code' })).toHaveCount(0);
    await press(page.getByRole('button', { name: 'Done' }));
    await expect(box).toHaveCount(0);
    // the clipboard back: Copy works again
    await page.evaluate(() => { (window as any).__clipRefuse = false; });
    await press(page.getByRole('button', { name: 'Copy python code' }));
    expect((await clip(page)).at(-1)).toBe(PY);
  });

  test('a long line scrolls inside its block: the chat never widens, and Copy stays on screen', async ({ page }) => {
    await boot(page);
    const block = page.locator('.md-code').filter({ hasText: 'seedling-' });
    const pre = block.locator('pre');
    await pre.scrollIntoViewIfNeeded();
    const m = await pre.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
    expect(m.sw).toBeGreaterThan(m.cw);
    const list = page.getByRole('log', { name: 'Messages' });
    expect(await list.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    const listBox = (await list.boundingBox())!, preBox = (await pre.boundingBox())!;
    expect(preBox.x + preBox.width).toBeLessThanOrEqual(listBox.x + listBox.width + 1);
    const copy = block.getByRole('button', { name: 'Copy sh code' });
    await expect(copy).toBeInViewport();
    const b = (await copy.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(page.viewportSize()!.width);
    expect(b.height).toBeGreaterThanOrEqual(touch() ? 40 : 32);
    await press(copy);
    expect((await clip(page)).at(-1)).toBe(LONG);
  });

  test('untrusted code is only text: nothing in it renders or runs', async ({ page }) => {
    await boot(page);
    const block = page.locator('.md-code').filter({ hasText: '<script>' });
    await expect(block.locator('.md-code-lang')).toHaveText('html');
    expect(await block.locator('pre code').evaluate((el) => el.textContent)).toBe(HOSTILE);
    await expect(page.locator('.message-list img, .message-list script')).toHaveCount(0);
    await press(block.getByRole('button', { name: 'Copy html code' }));
    expect((await clip(page)).at(-1)).toBe(HOSTILE);
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
  });
});

test.describe('drafts', () => {
  const A = 'Plan for Saturday:  \n\n\tbeds 1–3, then\n  the compost   ';
  const B = 'Workshop note, unsent.';

  test('a reload gives back each room its exact draft; another room keeps its own', async ({ page }) => {
    await boot(page);
    await composer(page).fill(A);
    await switchRoom(page, 'Workshop');
    await expect(composer(page)).toHaveValue('');
    await composer(page).fill(B);
    await reloadAs(page);
    await expect(page.getByRole('textbox', { name: 'Message Garden' })).toHaveValue(A);
    await switchRoom(page, 'Workshop');
    await expect(composer(page)).toHaveValue(B);
  });

  test('a thread has its own draft, apart from its room', async ({ page }) => {
    await boot(page);
    await composer(page).fill(A);
    await reloadAs(page, { tabs: 'thread' });
    await expect(composer(page)).toHaveAttribute('placeholder', 'Reply in thread…');
    await expect(composer(page)).toHaveValue('');
    await composer(page).fill('A reply, unsent.');
    await reloadAs(page, { tabs: 'room' });
    await expect(composer(page)).toHaveValue(A);
    await reloadAs(page, { tabs: 'thread' });
    await expect(composer(page)).toHaveValue('A reply, unsent.');
  });

  test('another identity on this device never sees the draft, and has its own', async ({ page }) => {
    await boot(page);
    await composer(page).fill(A);
    await reloadAs(page, { identity: OTHER });
    await expect(composer(page)).toHaveValue('');
    await composer(page).fill('The other key’s words.');
    await reloadAs(page, { identity: ME });
    await expect(composer(page)).toHaveValue(A);
    await reloadAs(page, { identity: OTHER });
    await expect(composer(page)).toHaveValue('The other key’s words.');
  });

  test('a failed send keeps the draft, through a reload too; a sent one is cleared and stays cleared', async ({ page }) => {
    await boot(page);
    await composer(page).fill(A);
    await page.evaluate(() => { (window as any).failSend = true; });
    await press(page.getByRole('button', { name: 'Send message', exact: true }));
    await expect(page.getByRole('alert').filter({ hasText: 'relay rejected' })).toBeVisible();
    await expect(composer(page)).toHaveValue(A);
    await reloadAs(page);
    await expect(composer(page)).toHaveValue(A);
    await press(page.getByRole('button', { name: 'Send message', exact: true }));
    await expect.poll(() => posts(page)).toEqual([{ channel: 'garden', body: A, replyTo: null }]);
    await expect(composer(page)).toHaveValue('');
    await reloadAs(page);
    await expect(composer(page)).toHaveValue('');
  });

  test('what is typed while a send is on its way stays, through a reload', async ({ page }) => {
    await boot(page);
    await composer(page).fill('First thought.');
    await page.evaluate(() => { (window as any).holdSend = true; });
    await press(page.getByRole('button', { name: 'Send message', exact: true }));
    await expect(page.locator('[data-outgoing="true"]')).toBeVisible();
    await composer(page).fill('A second thought, typed meanwhile.');
    await page.evaluate(() => { (window as any).holdSend = false; (window as any).finishSend(); });
    await expect.poll(() => posts(page)).toEqual([{ channel: 'garden', body: 'First thought.', replyTo: null }]);
    await expect(page.locator('[data-outgoing="true"]')).toHaveCount(0);
    await expect(composer(page)).toHaveValue('A second thought, typed meanwhile.');
    await reloadAs(page);
    await expect(composer(page)).toHaveValue('A second thought, typed meanwhile.');
  });

  test('Discard draft clears it here and on the device; with nothing typed there is nothing to discard', async ({ page }) => {
    await boot(page);
    const more = page.getByRole('button', { name: 'More message options' });
    await press(more);
    await expect(page.getByRole('menuitem', { name: 'Discard draft' })).toBeDisabled();
    await press(more);
    await composer(page).fill(A);
    await press(more);
    await press(page.getByRole('menuitem', { name: 'Discard draft' }));
    await expect(composer(page)).toHaveValue('');
    await expect(page.locator('.toast')).toHaveText('Draft discarded');
    expect(await posts(page)).toEqual([]);
    await reloadAs(page);
    await expect(composer(page)).toHaveValue('');
  });

  test('Forget device key removes every saved draft, of every identity', async ({ page }) => {
    await boot(page);
    await composer(page).fill(A);
    await reloadAs(page, { identity: OTHER });
    await composer(page).fill(B);
    const saved = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('uni.chatDraft.')).length);
    expect(await saved()).toBe(2);
    await composer(page).blur(); // a phone hides its bottom bar while the composer has focus
    await press(page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Settings', exact: true }));
    await press(page.getByRole('button', { name: 'Forget this device key', exact: true }));
    await press(page.getByRole('button', { name: /Tap again to forget/ }));
    await expect(page.locator('.pairing-card')).toBeVisible();
    expect(await saved()).toBe(0);
  });

  test('storage that refuses: typing, switching rooms and sending all still work, and the app says drafts are not being saved', async ({ page }) => {
    await page.addInitScript(() => sessionStorage.setItem('t.noStorage', '1'));
    await boot(page);
    await composer(page).fill(A);
    await expect(composer(page)).toHaveValue(A);
    await expect(page.getByRole('status').filter({ hasText: "This device isn't saving drafts right now" })).toBeVisible();
    await switchRoom(page, 'Workshop');
    await switchRoom(page, 'Garden');
    await expect(composer(page)).toHaveValue(A);
    await press(page.getByRole('button', { name: 'Send message', exact: true }));
    await expect.poll(() => posts(page)).toEqual([{ channel: 'garden', body: A, replyTo: null }]);
    await expect(composer(page)).toHaveValue('');
  });
});
