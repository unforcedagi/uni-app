import { writeFile } from 'node:fs/promises';
import { test, expect, type Page, type Locator } from '@playwright/test';

async function press(page: Page, target: Locator) {
  if (test.info().project.name === 'mobile') await target.tap();
  else await target.click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as any;
    w.events = [];
    w.calls = [];
    // Observe the real input activation without replacing the native implementation.
    const nativeClick = HTMLInputElement.prototype.click;
    HTMLInputElement.prototype.click = function () {
      w.events.push({ type: 'input.click', active: navigator.userActivation.isActive });
      return nativeClick.call(this);
    };
    for (const name of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'focusin', 'focusout', 'click']) {
      document.addEventListener(name, (e) => {
        const target = e.target as HTMLElement;
        w.events.push({ type: e.type, target: target.closest('button')?.textContent || target.tagName,
          related: (e as FocusEvent).relatedTarget instanceof HTMLElement ? ((e as FocusEvent).relatedTarget as HTMLElement).outerHTML : null,
          active: navigator.userActivation.isActive, connected: target.isConnected });
      }, true);
    }
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "main" }, currentWebview: { label: "main" } },
      transformCallback: () => 1,
      invoke: async (cmd: string, args: any) => {
        w.calls.push({ cmd, args });
        switch (cmd) {
          case 'identity_status': return { paired: true, pubkey: 'a'.repeat(64) };
          case 'get_identity': return 'a'.repeat(64);
          case 'relay_origin': return 'https://example.invalid';
          case 'get_npub': return 'test';
          case 'get_rooms': return [{ id: 'test', name: 'Test room', unread: 0 }, { id: 'other', name: 'Other room', unread: 0 }];
          case 'get_members':
            if (w.holdMembers) await new Promise<void>(resolve => { w.finishMembers = resolve; });
            return w.uniMember ? [{ pubkey: 'c'.repeat(64), name: 'Uni' }, { pubkey: 'b'.repeat(64), name: 'Test member' }] : [{ pubkey: 'b'.repeat(64), name: 'Test member' }];
          case 'get_messages': return w.knownMessages ?? [];
          case 'vault_list': return [];
          case 'journal_config': return { hub: 'test' };
          case 'refresh': return { total_items: 0, channel_errors: {}, truncated_channels: [] };
          case 'media_upload':
            if (w.holdUpload) await new Promise<void>(resolve => { w.finishUpload = resolve; });
            if (w.failUpload) throw new Error('upload rejected');
            return { url: 'https://example.invalid/test.txt', mime: 'text/plain', name: 'test.txt', size: 4 };
          case 'voice_transcribe': throw new Error('Chat must not transcribe');
          case 'prepare_voice_message': return JSON.stringify({ id: args.channel + ':' + args.replyTo + ':' + crypto.randomUUID() });
          case 'post_message':
            sessionStorage.setItem('voicePostCount', String(Number(sessionStorage.getItem('voicePostCount') ?? 0) + 1));
            if (w.acceptedError) throw { accepted: true, eventId: 'audio-message-ref', message: 'store: no such table: items' };
            if (w.holdSend) await new Promise(resolve => { w.finishSend = resolve; });
            if (w.failSend) throw new Error('relay rejected');
            return { ref: 'audio-message-ref', channel: args.channel };
          default: return null;
        }
      },
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message Test room' })).toBeVisible();
});

test.afterEach(async ({ page }, info) => {
  const evidence = await page.evaluate(() => ({ events: (window as any).events,
    draft: document.querySelector('textarea')?.value,
    picker: !!document.querySelector('.mention-picker'), menu: !!document.querySelector('.compose-menu'),
    chooser: (window as any).chooser,
  }));
  await writeFile(info.outputPath('event-order.json'), JSON.stringify(evidence, null, 2));
  await info.attach('event-order', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
});

test('Mention touch/pointer retains caret and picker', async ({ page }) => {
  const input = page.getByRole('textbox', { name: 'Message Test room' });
  await input.fill('hello ');
  await press(page, page.getByRole('button', { name: 'More message options' }));
  await press(page, page.getByRole('menuitem', { name: 'Mention', exact: true }));
  await expect(input).toHaveValue('hello @');
  await expect(input).toBeFocused();
  await expect(page.getByRole('listbox', { name: 'Mention a member' })).toBeVisible();
  expect(await input.evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(7);
});

test('Attach opens native chooser, cancellation preserves draft, selection adds attachment', async ({ page }) => {
  const input = page.getByRole('textbox', { name: 'Message Test room' });
  await input.fill('keep me');
  const opened: unknown[] = [];
  page.on('filechooser', chooser => opened.push({ multiple: chooser.isMultiple() }));
  for (const select of [false, true]) {
    await press(page, page.getByRole('button', { name: 'More message options' }));
    const chooserPromise = page.waitForEvent('filechooser', { timeout: 2000 });
    await press(page, page.getByRole('menuitem', { name: 'Attach file/photo' }));
    const chooser = await chooserPromise;
    await chooser.setFiles(select ? { name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('test') } : []);
    await expect(input).toHaveValue('keep me');
  }
  expect(opened).toHaveLength(2);
  expect(await page.evaluate(() => (window as any).events.filter((e: any) => e.type === 'input.click').map((e: any) => e.active))).toEqual([true, true]);
  await page.evaluate(value => { (window as any).chooser = value; }, opened);
  await expect(page.locator('.compose-file')).toContainText('test.txt');
  await expect(page.locator('.compose-file')).toContainText('Ready');
});

test('Mic coexists with Send for text and attachments', async ({ page }) => {
  const input = page.getByRole('textbox', { name: 'Message Test room' });
  const mic = page.getByRole('button', { name: 'Record a voice message' });
  await expect(mic).toBeEnabled();
  await input.fill('draft');
  await expect(mic).toBeVisible();
  await expect(mic).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await page.locator('input[type=file]').setInputFiles({ name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('test') });
  await expect(page.locator('.compose-file')).toContainText('Ready');
  await expect(mic).toBeEnabled();
  await input.fill('');
  await expect(mic).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  const box = await mic.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test('Keyboard menu navigation, Mention and Attach', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'More message options' });
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Mention', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: 'Message Test room' })).toHaveValue('@');
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('End');
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.press('Enter');
  await (await chooser).setFiles([]);
  await trigger.focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(page.getByRole('menu')).toHaveCount(0);
});

// macOS WebKit (Safari/WKWebView) does not make buttons mouse-focusable: an un-prevented
// mousedown on a button moves focus off the focused element with relatedTarget=null.
// Linux Chromium/WebKit focus the button instead, so emulate the macOS rule here.
async function emulateMacButtonFocus(page: Page) {
  await page.evaluate(() => window.addEventListener('mousedown', (e) => {
    if (e.defaultPrevented || !(e.target as HTMLElement).closest('button')) return;
    (document.activeElement as HTMLElement | null)?.blur();
  }));
}

for (const action of ['Mention', 'Attach file/photo']) {
  test(`macOS button-focus model: centered ${action}`, async ({ page }) => {
    await emulateMacButtonFocus(page);
    const input = page.getByRole('textbox', { name: 'Message Test room' });
    await input.fill('hello ');
    await press(page, page.getByRole('button', { name: 'More message options' }));
    const chooser = action.startsWith('Attach') ? page.waitForEvent('filechooser', { timeout: 2000 }).catch(() => null) : null;
    await press(page, page.getByRole('menuitem', { name: action, exact: true }));
    if (chooser) {
      const result = await chooser;
      expect(result).not.toBeNull();
      await result!.setFiles([]);
      await expect(input).toHaveValue('hello ');
    } else {
      await expect(input).toHaveValue('hello @');
      await expect(page.getByRole('listbox', { name: 'Mention a member' })).toBeVisible();
    }
  });
}

for (const action of ['Mention', 'Attach file/photo']) {
  for (const probe of [false, true]) {
    test(`Edge press ${action}, transform probe=${probe}`, async ({ page }) => {
      if (probe) await page.addStyleTag({ content: '.compose-menu button:active:not(:disabled) { transform: none; }' });
      await press(page, page.getByRole('button', { name: 'More message options' }));
      const item = page.getByRole('menuitem', { name: action, exact: true });
      const box = (await item.boundingBox())!;
      const x = box.x + 1, y = box.y + box.height / 2;
      await page.evaluate(({ x, y }) => { (window as any).events.push({ hit: document.elementFromPoint(x, y)?.outerHTML }); }, { x, y });
      const chooser = action.startsWith('Attach') ? page.waitForEvent('filechooser', { timeout: 2000 }).catch(() => null) : null;
      if (test.info().project.name === 'mobile') {
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await page.waitForTimeout(250);
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.waitForTimeout(250);
        await page.evaluate(({ x, y }) => { (window as any).events.push({ heldHit: document.elementFromPoint(x, y)?.outerHTML, menu: !!document.querySelector('.compose-menu'), active: navigator.userActivation.isActive }); }, { x, y });
        await page.mouse.up();
      }
      if (chooser) {
        const result = await chooser;
        expect(result).not.toBeNull();
        await result!.setFiles([]);
      } else {
        await expect(page.getByRole('textbox', { name: 'Message Test room' })).toHaveValue('@');
      }
    });
  }
}

test('Recording with text and attachment keeps Stop available and Send blocked', async ({ page }) => {
  const input = page.getByRole('textbox', { name: 'Message Test room' });
  await input.fill('draft');
  await page.locator('input[type=file]').setInputFiles({ name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('test') });
  await expect(page.locator('.compose-file')).toContainText('Ready');
  await press(page, page.getByRole('button', { name: 'Record a voice message', exact: true }));
  const stop = page.getByRole('button', { name: 'Stop recording voice message', exact: true });
  await expect(stop).toBeEnabled();
  await expect(stop).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  await page.waitForTimeout(300);
  await press(page, stop);
  await expect(page.getByRole('button', { name: 'Record a voice message', exact: true })).toBeEnabled();
  await expect(input).toHaveValue('draft');
  await expect.poll(() => page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message').length)).toBe(1);
  await expect(page.locator('.compose-file')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
});

test('Send retains text and attachment payload and disables mic while sending', async ({ page }) => {
  const input = page.getByRole('textbox', { name: 'Message Test room' });
  await input.fill('send this');
  await page.locator('input[type=file]').setInputFiles({ name: 'test.txt', mimeType: 'text/plain', buffer: Buffer.from('test') });
  await expect(page.locator('.compose-file')).toContainText('Ready');
  await page.evaluate(() => { (window as any).holdSend = true; });
  await press(page, page.getByRole('button', { name: 'Send message', exact: true }));
  await expect(page.getByRole('button', { name: 'Record a voice message', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeDisabled();
  const calls = await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message'));
  expect(calls).toHaveLength(1);
  expect(calls[0].args.body).toBe('send this');
  expect(calls[0].args.media).toHaveLength(1);
  await page.evaluate(() => { (window as any).finishSend(); });
  await expect(input).toHaveValue('');
  await expect(page.locator('.compose-file')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Record a voice message', exact: true })).toBeEnabled();
});

test('Mobile Enter inserts newline even with a mention picker; desktop shortcuts remain', async ({ page }) => {
  const input = page.getByRole('textbox', { name: 'Message Test room' });
  await input.fill('first');
  await input.press('Shift+Enter');
  await expect(input).toHaveValue('first\n');
  await input.fill('first');
  await input.press('Enter');
  if (test.info().project.name === 'mobile') {
    await expect(input).toHaveValue('first\n');
    await input.fill('@Test');
    await input.press('Enter');
    await expect(input).toHaveValue('@Test\n');
    expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message'))).toHaveLength(0);
    await input.fill('first\nsecond');
    await press(page, page.getByRole('button', { name: 'Send message', exact: true }));
  }
  await expect(input).toHaveValue('');
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message').map((c: any) => c.args.body))).toEqual([test.info().project.name === 'mobile' ? 'first\nsecond' : 'first']);
});

for (const replacement of ['first draft', 'next draft']) {
  test(`Same-turn Enter submissions send once and preserve replacement: ${replacement}`, async ({ page }) => {
    test.skip(test.info().project.name === 'mobile', 'Desktop Enter shortcut only');
    const input = page.getByRole('textbox', { name: 'Message Test room' });
    await input.fill('first draft');
    await page.evaluate(() => {
      (window as any).holdSend = true;
      const input = document.querySelector('textarea')!;
      for (let i = 0; i < 2; i++) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message'))).toHaveLength(1);
    await input.fill('');
    await input.fill(replacement);
    await page.evaluate(() => (window as any).finishSend());
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await expect(input).toHaveValue(replacement);
    await input.press('Enter');
    expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message').map((c: any) => c.args.body))).toEqual(['first draft', replacement]);
    await page.evaluate(() => (window as any).finishSend());
    await expect(input).toHaveValue('');
  });
}

for (const replace of [false, true]) {
  test(`Held send across room navigation preserves scoped drafts and bindings, replace=${replace}`, async ({ page }) => {
    const switchRoom = async (name: string) => {
      if (test.info().project.name === 'mobile') await press(page, page.getByRole('button', { name: 'Back to conversations', exact: true }));
      if (test.info().project.name !== 'mobile') await page.getByRole('button', { name: 'Rooms', exact: true }).click();
      await press(page, page.locator('.rooms nav button').filter({ hasText: name }));
    };
    const input = page.getByRole('textbox', { name: 'Message Test room' });
    const chooseMention = async (target: Locator) => {
      await target.fill('@Test');
      await press(page, page.getByRole('option').getByRole('button'));
      await expect(target).toHaveValue('@Test member ');
      await expect(page.getByRole('listbox', { name: 'Mention a member' })).toHaveCount(0);
    };
    await chooseMention(input);
    await page.evaluate(() => { (window as any).holdSend = true; });
    await press(page, page.getByRole('button', { name: 'Send message', exact: true }));
    if (replace) {
      await input.fill('');
      await chooseMention(input);
    }
    await switchRoom('Other room');
    const other = page.getByRole('textbox', { name: 'Message Other room' });
    await chooseMention(other);
    await other.dispatchEvent('keydown', { key: 'Enter' }); // The in-flight send still owns the global send lock.
    await switchRoom('Test room');
    await expect(input).toHaveValue('@Test member ');
    await switchRoom('Other room');
    await page.evaluate(() => (window as any).finishSend());
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await expect(other).toHaveValue('@Test member ');
    // A settled mention must stay settled after completion and scope restoration.
    await other.press('End');
    await expect(page.getByRole('listbox', { name: 'Mention a member' })).toHaveCount(0);
    await switchRoom('Test room');
    await expect(input).toHaveValue(replace ? '@Test member ' : '');
    if (replace) {
      await input.press('End');
      await expect(page.getByRole('listbox', { name: 'Mention a member' })).toHaveCount(0);
    }
    await switchRoom('Other room');
    await press(page, page.getByRole('button', { name: 'Send message', exact: true }));
    const calls = await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message'));
    expect(calls.map((c: any) => ({ channel: c.args.channel, body: c.args.body, recipients: c.args.recipients }))).toEqual([
      { channel: 'test', body: '@Test member ', recipients: ['b'.repeat(64)] },
      { channel: 'other', body: '@Test member ', recipients: ['b'.repeat(64)] },
    ]);
    await page.evaluate(() => (window as any).finishSend());
    await expect(other).toHaveValue('');
  });
}

async function recordClip(page: Page) {
  await press(page, page.getByRole('button', { name: 'Record a voice message', exact: true }));
  await expect(page.getByRole('button', { name: 'Stop recording voice message', exact: true })).toBeEnabled();
  await page.waitForTimeout(300);
  await press(page, page.getByRole('button', { name: 'Stop recording voice message', exact: true }));
}
const voicePosts = (page: Page) => page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message'));

test('Stop automatically sends only audio, preserves draft and never transcribes', async ({ page }) => {
  const input = page.getByRole('textbox', { name: 'Message Test room' });
  await input.fill('keep this draft');
  await recordClip(page);
  await expect.poll(async () => (await voicePosts(page)).length).toBe(1);
  const [post] = await voicePosts(page);
  expect(post.args).toMatchObject({ channel: 'test', body: '', replyTo: null, recipients: [] });
  expect(post.args.media).toHaveLength(1);
  await expect(input).toHaveValue('keep this draft');
  await expect(page.locator('.compose-file')).toHaveCount(0);
  await expect(page.locator('.voice-status')).toHaveText('Voice message sent');
  expect(await page.evaluate(() => (window as any).calls.some((c: any) => c.cmd === 'voice_transcribe'))).toBe(false);
});

test('Voice upload leaves Send and a second recording usable and delivers in order', async ({ page }) => {
  await page.getByRole('textbox', { name: 'Message Test room' }).fill('draft');
  await page.evaluate(() => { (window as any).holdUpload = true; });
  await recordClip(page);
  await page.waitForFunction(() => !!(window as any).finishUpload);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(page.locator('.voice-status')).toHaveText('Sending voice message…');
  await recordClip(page);
  await expect(page.locator('.compose-file')).toHaveCount(2);
  expect(await voicePosts(page)).toHaveLength(0);
  await page.evaluate(() => { (window as any).holdUpload = false; (window as any).finishUpload(); });
  await expect.poll(async () => (await voicePosts(page)).length).toBe(2);
  await expect(page.locator('.compose-file')).toHaveCount(0);
  expect((await voicePosts(page)).map((p: any) => p.args.body)).toEqual(['', '']);
  const calls = await page.evaluate(() => (window as any).calls.filter((c: any) => ['media_upload', 'post_message'].includes(c.cmd)).map((c: any) => c.cmd));
  expect(calls).toEqual(['media_upload', 'post_message', 'media_upload', 'post_message']);
});

for (const phase of ['recording', 'upload']) {
  test(`Voice navigation during ${phase} posts to origin and preserves both drafts`, async ({ page }) => {
    const input = page.getByRole('textbox', { name: 'Message Test room' });
    await input.fill('origin draft');
    await page.evaluate(() => { (window as any).holdUpload = true; });
    if (phase === 'recording') {
      await press(page, page.getByRole('button', { name: 'Record a voice message', exact: true }));
      await expect(page.getByRole('button', { name: 'Stop recording voice message', exact: true })).toBeEnabled();
      await page.waitForTimeout(300);
    } else {
      await recordClip(page);
      await page.waitForFunction(() => !!(window as any).finishUpload);
    }
    await input.blur();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Rooms', exact: true }).click();
    await page.locator('.rooms nav button').filter({ hasText: 'Other room' }).click();
    const other = page.getByRole('textbox', { name: 'Message Other room' });
    await other.fill('other draft');
    if (phase === 'recording') {
      await page.locator('.recording-stop').click();
      await page.waitForFunction(() => !!(window as any).finishUpload);
    }
    await page.evaluate(() => { (window as any).holdUpload = false; (window as any).finishUpload(); });
    await expect.poll(async () => (await voicePosts(page)).length).toBe(1);
    expect((await voicePosts(page))[0].args.channel).toBe('test');
    await expect(other).toHaveValue('other draft');
    await other.blur();
    await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('button', { name: 'Rooms', exact: true }).click();
    await page.locator('.rooms nav button').filter({ hasText: 'Test room' }).click();
    await expect(input).toHaveValue('origin draft');
  });
}

for (const failure of ['Upload', 'Send']) {
  test(`Voice ${failure} failure retains audio; repeated retry posts once`, async ({ page }) => {
    await page.getByRole('textbox', { name: 'Message Test room' }).fill('draft');
    await page.evaluate(failure => { (window as any)[`fail${failure}`] = true; }, failure);
    await recordClip(page);
    await expect(page.locator('.compose-file')).toContainText('Failed');
    await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
    await expect(page.locator('p.error').last()).toContainText('Voice message failed');
    await page.evaluate(failure => { (window as any)[`fail${failure}`] = false; }, failure);
    await page.locator('.compose-file-retry').evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
    await expect(page.locator('.compose-file')).toHaveCount(0);
    expect(await voicePosts(page)).toHaveLength(failure === 'Send' ? 2 : 1);
    if (failure === 'Send') expect((await voicePosts(page))[1].args.signedEvent).toBe((await voicePosts(page))[0].args.signedEvent);
    await expect(page.getByRole('textbox', { name: 'Message Test room' })).toHaveValue('draft');
    expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'media_upload').length)).toBe(failure === 'Send' ? 1 : 2);
  });
}

test('Removed voice delivery never posts', async ({ page }) => {
  await page.evaluate(() => { (window as any).holdMembers = true; });
  await recordClip(page);
  await page.waitForFunction(() => !!(window as any).finishMembers);
  await page.locator('.compose-file-remove').click();
  await page.evaluate(() => (window as any).finishMembers());
  await expect(page.locator('.compose-file')).toHaveCount(0);
  await page.waitForTimeout(100);
  expect(await voicePosts(page)).toHaveLength(0);
});

for (const notify of [true, false]) {
  test(`Explicit thread voice keeps its root and notifies only Uni, notify=${notify}`, async ({ page }) => {
    await page.evaluate(() => {
      const w = window as any;
      w.uniMember = true;
      const invoke = w.__TAURI_INTERNALS__.invoke;
      w.__TAURI_INTERNALS__.invoke = async (cmd: string, args: any) => {
        if (cmd === 'get_messages') return [{ ref: 'thread-root', channel: 'test', author: 'b'.repeat(64), author_name: 'Test member', ts: 1790942400, body: 'Start a thread', root: null, parent: null, mentions: [], reply_count: 0, reactions: [] }];
        return invoke(cmd, args);
      };
    });
    await page.getByRole('button', { name: 'Refresh messages', exact: true }).click();
    if (test.info().project.name === 'desktop') await page.locator('article.message').first().hover();
    await page.getByRole('button', { name: 'Reply in thread to Test member', exact: true }).click();
    await expect(page.locator('.compose-destination')).toContainText('Replying in thread');
    if (!notify) await page.getByRole('button', { name: 'Uni is listening', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message Test room' }).fill('@Test member stays in draft');
    await recordClip(page);
    await expect.poll(async () => (await voicePosts(page)).length).toBe(1);
    expect((await voicePosts(page))[0].args).toMatchObject({ channel: 'test', body: '', replyTo: 'thread-root', recipients: notify ? ['c'.repeat(64)] : [] });
    await expect(page.getByRole('textbox', { name: 'Message Test room' })).toHaveValue('@Test member stays in draft');
  });
}

test('Enter and repeated Stop cannot submit through recording phases', async ({ page }) => {
  await page.evaluate(() => {
    const w = window as any;
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
      document.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await new Promise<void>(resolve => { w.allowRecording = resolve; });
      return getUserMedia(constraints);
    };
    const stop = MediaRecorder.prototype.stop;
    MediaRecorder.prototype.stop = function () {
      const onstop = this.onstop;
      this.onstop = event => { w.finishRecording = () => onstop?.call(this, event); };
      stop.call(this);
    };
  });
  await press(page, page.getByRole('button', { name: 'Record a voice message', exact: true }));
  const input = page.getByRole('textbox', { name: 'Message Test room' });
  await input.dispatchEvent('keydown', { key: 'Enter' });
  expect(await voicePosts(page)).toHaveLength(0);
  await page.evaluate(() => (window as any).allowRecording());
  const stop = page.getByRole('button', { name: 'Stop recording voice message', exact: true });
  await expect(stop).toBeEnabled();
  await page.waitForTimeout(300);
  await input.dispatchEvent('keydown', { key: 'Enter' });
  expect(await voicePosts(page)).toHaveLength(0);
  await stop.evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await page.waitForFunction(() => !!(window as any).finishRecording);
  await input.dispatchEvent('keydown', { key: 'Enter' });
  expect(await voicePosts(page)).toHaveLength(0);
  await page.evaluate(() => (window as any).finishRecording());
  await expect.poll(async () => (await voicePosts(page)).length).toBe(1);
  await input.dispatchEvent('keydown', { key: 'Enter' });
  await page.getByRole('button', { name: 'Send message', exact: true }).dispatchEvent('click');
  expect(await voicePosts(page)).toHaveLength(1);
});


test('Relay accepted local ingestion error clears clip without Retry or another post', async ({ page }) => {
  await page.evaluate(() => { (window as any).acceptedError = true; });
  await recordClip(page);
  await expect(page.locator('.voice-status')).toHaveText('Voice message sent');
  await expect(page.locator('.compose-file-retry')).toHaveCount(0);
  await expect(page.locator('.compose-file')).toHaveCount(0);
  expect(await voicePosts(page)).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message Test room' })).toBeVisible();
  await expect(page.locator('.compose-file')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('voicePostCount'))).toBe('1');
});

test('Failed voice survives reload with Retry and same signed event', async ({ page }) => {
  await page.evaluate(() => { (window as any).failSend = true; });
  await recordClip(page);
  await expect(page.locator('.compose-file-retry')).toBeVisible();
  const event = (await voicePosts(page))[0].args.signedEvent;
  await expect(page.locator('.voice-status')).toHaveText('Voice message failed');
  await page.reload();
  await expect(page.locator('.compose-file-retry')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('voicePostCount'))).toBe('1');
  await page.locator('.compose-file-retry').click();
  await expect(page.locator('.compose-file')).toHaveCount(0);
  expect((await voicePosts(page))[0].args.signedEvent).toBe(event);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message Test room' })).toBeVisible();
  await expect(page.locator('.compose-file')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('voicePostCount'))).toBe('2');
});

test('Pending voice resumes once after reload in original thread', async ({ page }) => {
  // Use the same durable record shape as a stopped clip whose send is pending.
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open('uni-voice-outbox', 1); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('clips', 'readwrite');
      tx.objectStore('clips').put({ id: 'pending', key: 'other:thread-root', file: new Blob(['audio'], { type: 'audio/webm' }), filename: 'voice.webm', mime: 'audio/webm', created: 1, state: 'uploading', owner: 'a'.repeat(64), relay: 'https://example.invalid', signedEvent: 'persisted-signed-event', media: { url: 'https://example.invalid/audio', mime: 'audio/webm' }, voice: { channel: 'other', replyTo: 'thread-root', notifyUni: false } });
      tx.oncomplete = () => { db.close(); resolve(); }; tx.onerror = () => reject(tx.error);
    });
  });
  await page.reload();
  await expect.poll(async () => (await voicePosts(page)).length).toBe(1);
  expect((await voicePosts(page))[0].args).toMatchObject({ channel: 'other', replyTo: 'thread-root', signedEvent: 'persisted-signed-event' });
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'prepare_voice_message'))).toHaveLength(0);
  await expect(page.locator('.voice-status')).toHaveText('Voice message sent');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message Test room' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('voicePostCount'))).toBe('1');
});


test('Unavailable IndexedDB shows warning and keeps failed recording retryable in memory', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'indexedDB', { get() { throw new Error('disabled'); } });
  });
  await page.reload();
  await expect(page.getByText('Voice storage unavailable. Recordings are kept only until this app closes.')).toBeVisible();
  await page.evaluate(() => { (window as any).failSend = true; });
  await recordClip(page);
  await expect(page.locator('.compose-file-retry')).toBeVisible();
  await page.evaluate(() => { (window as any).failSend = false; });
  await page.locator('.compose-file-retry').click();
  await expect(page.locator('.compose-file')).toHaveCount(0);
  expect(await voicePosts(page)).toHaveLength(2);
});

test('Stopped clip pending at publish survives restart without signing or uploading again', async ({ page }) => {
  await page.evaluate(() => { (window as any).holdSend = true; });
  await recordClip(page);
  await page.waitForFunction(() => !!(window as any).finishSend);
  const event = (await voicePosts(page))[0].args.signedEvent;
  await page.reload();
  await expect(page.locator('.voice-status')).toHaveText('Voice message sent');
  expect((await voicePosts(page))[0].args).toMatchObject({ channel: 'test', replyTo: null, signedEvent: event });
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => ['media_upload', 'prepare_voice_message'].includes(c.cmd)))).toHaveLength(0);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message Test room' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('voicePostCount'))).toBe('2');
});

test('Restored pending clips preserve FIFO across rooms', async ({ page }) => {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open('uni-voice-outbox', 1); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>(resolve => {
      const tx = db.transaction('clips', 'readwrite');
      for (const [id, created, channel] of [['second', 2, 'other'], ['first', 1, 'test']] as const) {
        tx.objectStore('clips').put({ id, key: `${channel}:room`, file: new Blob([id], { type: 'audio/webm' }), filename: `${id}.webm`, mime: 'audio/webm', created, state: 'uploading', owner: 'a'.repeat(64), relay: 'https://example.invalid', signedEvent: id, media: { url: `https://example.invalid/${id}`, mime: 'audio/webm' }, voice: { channel, replyTo: null, notifyUni: false } });
      }
      tx.oncomplete = () => { db.close(); resolve(); };
    });
  });
  await page.reload();
  await expect(page.locator('.voice-status')).toHaveText('Voice message sent');
  expect((await voicePosts(page)).map((p: any) => p.args.signedEvent)).toEqual(['first', 'second']);
});

test('Removing failed voice deletes durable record', async ({ page }) => {
  await page.evaluate(() => { (window as any).failSend = true; });
  await recordClip(page);
  await expect(page.locator('.compose-file-retry')).toBeVisible();
  await page.locator('.compose-file-remove').click();
  await expect.poll(() => page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const r = indexedDB.open('uni-voice-outbox', 1); r.onsuccess = () => resolve(r.result); });
    return await new Promise(resolve => { const r = db.transaction('clips').objectStore('clips').count(); r.onsuccess = () => { db.close(); resolve(r.result); }; });
  })).toBe(0);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message Test room' })).toBeVisible();
  await expect(page.locator('.compose-file')).toHaveCount(0);
  expect(await page.evaluate(() => sessionStorage.getItem('voicePostCount'))).toBe('1');
});

// Abort real Chromium transactions, leaving the previous durable record intact.
async function storageFault(page: Page, fault: 'signed-put' | 'delete') {
  await page.evaluate(fault => {
    const w = window as any;
    w.storageFault = fault;
    const put = IDBObjectStore.prototype.put;
    const del = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.put = function(value, key) {
      const request = put.call(this, value, key);
      if (this.name === 'clips' && w.storageFault === 'signed-put' && value.signedEvent) this.transaction.abort();
      return request;
    };
    IDBObjectStore.prototype.delete = function(key) {
      const request = del.call(this, key);
      if (this.name === 'clips' && w.storageFault === 'delete') this.transaction.abort();
      return request;
    };
  }, fault);
}

test('Signed event storage failure blocks publish; Retry saves the same event', async ({ page }) => {
  await storageFault(page, 'signed-put');
  await recordClip(page);
  await expect(page.locator('.compose-file-retry')).toBeVisible();
  await expect(page.locator('.compose-file')).toContainText('save the voice note safely');
  expect(await voicePosts(page)).toHaveLength(0);
  const prepares = await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'prepare_voice_message').length);
  await page.evaluate(() => { (window as any).storageFault = null; });
  await page.locator('.compose-file-retry').click();
  await expect(page.locator('.voice-status')).toHaveText('Voice message sent');
  expect(await voicePosts(page)).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'prepare_voice_message').length)).toBe(prepares);
});

test('Delete failure after delivery does not resend or show a clip on reload', async ({ page }) => {
  await storageFault(page, 'delete');
  await recordClip(page);
  await expect(page.locator('.voice-status')).toHaveText('Voice message sent');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message Test room' })).toBeVisible();
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => sessionStorage.getItem('voicePostCount'))).toBe('1');
  await expect(page.locator('.compose-file')).toHaveCount(0);
});

async function seedForeign(page: Page, owner = 'b'.repeat(64), relay = 'https://example.invalid') {
  await page.evaluate(async ({ owner, relay }) => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('uni-voice-outbox', 1); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('clips', 'readwrite');
      tx.objectStore('clips').put({ id: 'foreign', key: 'test:room', owner, relay, file: new Blob(['audio']), filename: 'foreign.webm', mime: 'audio/webm', created: 1, state: 'uploading', signedEvent: 'foreign-event', voice: { channel: 'test', replyTo: null, notifyUni: false } });
      tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
    });
    db.close();
  }, { owner, relay });
}
for (const boundary of ['account', 'relay']) test(`Outbox ignores another ${boundary}`, async ({ page }) => {
  await seedForeign(page, boundary === 'account' ? 'b'.repeat(64) : 'a'.repeat(64), boundary === 'relay' ? 'https://other.invalid' : 'https://example.invalid');
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Message Test room' })).toBeVisible();
  await page.waitForTimeout(400);
  expect(await voicePosts(page)).toHaveLength(0);
  await expect(page.locator('.compose-file')).toHaveCount(0);
});

test('Forget device key clears the whole outbox', async ({ page }) => {
  await seedForeign(page);
  if (test.info().project.name === 'mobile') await page.getByRole('button', { name: 'Back to conversations', exact: true }).click();
  await (test.info().project.name === 'mobile' ? page.locator('.rooms-header') : page.getByRole('navigation', { name: 'Main navigation' })).getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Forget this device key', exact: true }).click();
  await page.getByRole('button', { name: /Tap again to forget/ }).click();
  await expect(page.locator('.pairing-card')).toBeVisible();
  expect(await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('uni-voice-outbox', 1); r.onsuccess = () => resolve(r.result); });
    return new Promise<number>(resolve => { const r = db.transaction('clips').objectStore('clips').count(); r.onsuccess = () => { resolve(r.result); db.close(); }; });
  })).toBe(0);
});

test('Restored signed event already in local messages is removed without publishing', async ({ page }) => {
  await seedForeign(page, 'a'.repeat(64));
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const r = indexedDB.open('uni-voice-outbox', 1); r.onsuccess = () => resolve(r.result); });
    await new Promise<void>(resolve => {
      const tx = db.transaction('clips', 'readwrite');
      const store = tx.objectStore('clips');
      const r = store.get('foreign');
      r.onsuccess = () => store.put({ ...r.result, signedEvent: JSON.stringify({ id: 'known-event' }) });
      tx.oncomplete = () => { db.close(); resolve(); };
    });
  });
  await page.addInitScript(() => { (window as any).knownMessages = [{ ref: 'known-event', channel: 'test', author: 'a'.repeat(64), author_name: 'Me', ts: 1, body: '', mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [] }]; });
  await page.reload();
  await expect(page.locator('.voice-status')).toHaveText('Voice message sent');
  expect(await voicePosts(page)).toHaveLength(0);
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'prepare_voice_message'))).toHaveLength(0);
  await expect(page.locator('.compose-file')).toHaveCount(0);
});
