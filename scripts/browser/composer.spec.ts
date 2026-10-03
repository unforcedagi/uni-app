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
          case 'get_npub': return 'test';
          case 'get_rooms': return [{ id: 'test', name: 'Test room', unread: 0 }, { id: 'other', name: 'Other room', unread: 0 }];
          case 'get_members': return [{ pubkey: 'b'.repeat(64), name: 'Test member' }];
          case 'get_messages': case 'vault_list': return [];
          case 'journal_config': return { hub: 'test' };
          case 'refresh': return { total_items: 0, channel_errors: {}, truncated_channels: [] };
          case 'media_upload':
            if (w.holdUpload) await new Promise<void>(resolve => { w.finishUpload = resolve; });
            if (w.failUpload) throw new Error('upload rejected');
            return { url: 'https://example.invalid/test.txt', mime: 'text/plain', name: 'test.txt', size: 4 };
          case 'voice_transcribe':
            if (w.holdTranscript) await new Promise<void>(resolve => { w.finishTranscript = resolve; });
            if (w.failTranscript) throw new Error('transcription unavailable');
            return { text: 'voice transcript' };
          case 'post_message':
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
  await expect(input).toHaveValue('draft\nvoice transcript');
  await expect(page.locator('.compose-file')).toHaveCount(2);
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

for (const submit of ['Enter', 'Send button']) {
  test(`Enter is blocked through recorder phases, then ${submit} sends once`, async ({ page }) => {
    test.skip(test.info().project.name === 'mobile' && submit === 'Enter', 'Mobile Enter never submits');
    const input = page.getByRole('textbox', { name: 'Message Test room' });
    const send = page.getByRole('button', { name: 'Send message', exact: true });
    const mobile = test.info().project.name === 'mobile';
    await input.fill('draft');
    await page.evaluate(() => {
      const w = window as any;
      const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async constraints => {
        // Exercise the synchronous start boundary before React renders starting.
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
      w.holdSend = true;
    });
    const posts = () => page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message'));
    await press(page, page.getByRole('button', { name: 'Record a voice message', exact: true }));
    await expect(send).toBeDisabled();
    await input.press('Enter'); // starting: microphone permission/device promise is pending
    expect(await posts()).toHaveLength(0);
    await expect(input).toHaveValue(mobile ? 'draft\n' : 'draft');
    if (mobile) await input.fill('draft');
    await page.evaluate(() => (window as any).allowRecording());
    const stop = page.getByRole('button', { name: 'Stop recording voice message', exact: true });
    await expect(stop).toBeEnabled();
    await input.press('Enter'); // recording
    expect(await posts()).toHaveLength(0);
    await expect(input).toHaveValue(mobile ? 'draft\n' : 'draft');
    if (mobile) await input.fill('draft');
    await press(page, stop);
    await page.waitForFunction(() => !!(window as any).finishRecording);
    await expect(send).toBeDisabled();
    await input.press('Enter'); // finishing: native onstop completion is held
    expect(await posts()).toHaveLength(0);
    await expect(input).toHaveValue(mobile ? 'draft\n' : 'draft');
    if (mobile) await input.fill('draft');
    await page.evaluate(() => (window as any).finishRecording());
    await expect(input).toHaveValue('draft\nvoice transcript');
    await expect(send).toBeEnabled();
    expect(await posts()).toHaveLength(0); // Completion itself must never submit.
    if (submit === 'Enter') await input.press('Enter');
    else await press(page, send);
    if (mobile) await send.dispatchEvent('click');
    else await input.press('Enter'); // Repeated submission while IPC is pending.
    const calls = await posts();
    expect(calls).toHaveLength(1);
    expect(calls[0].args.body).toBe('draft\nvoice transcript');
    expect(calls[0].args.media).toHaveLength(1);
    await page.evaluate(() => (window as any).finishSend());
    await expect(input).toHaveValue('');
    await expect(page.locator('.compose-file')).toHaveCount(0);
    expect(await posts()).toHaveLength(1);
  });
}

for (const duringSend of [false, true]) {
  test(`Voice sends before transcription; late transcript follows original message, duringSend=${duringSend}`, async ({ page }) => {
    const input = page.getByRole('textbox', { name: 'Message Test room' });
    await page.evaluate(() => { (window as any).holdTranscript = true; });
    await press(page, page.getByRole('button', { name: 'Record a voice message', exact: true }));
    await page.waitForTimeout(300);
    await press(page, page.getByRole('button', { name: 'Stop recording voice message', exact: true }));
    await page.waitForFunction(() => !!(window as any).finishTranscript);
    await expect(page.locator('.compose-file')).toContainText('Ready');
    const send = page.getByRole('button', { name: 'Send message', exact: true });
    await expect(send).toBeEnabled();
    if (duringSend) await page.evaluate(() => { (window as any).holdSend = true; });
    await press(page, send);
    if (duringSend) {
      await page.evaluate(() => (window as any).finishTranscript());
      await input.fill('next draft');
      await page.evaluate(() => { (window as any).holdSend = false; (window as any).finishSend(); });
    } else {
      await expect(page.locator('.compose-file')).toHaveCount(0);
      await input.fill('next draft');
      if (test.info().project.name === 'mobile') await press(page, page.getByRole('button', { name: 'Back to conversations', exact: true }));
      if (test.info().project.name !== 'mobile') await page.getByRole('button', { name: 'Rooms', exact: true }).click();
      await press(page, page.locator('.rooms nav button').filter({ hasText: 'Other room' }));
      await page.getByRole('textbox', { name: 'Message Other room' }).fill('other draft');
      await page.evaluate(() => (window as any).finishTranscript());
    }
    await expect.poll(() => page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message').length)).toBe(2);
    const calls = await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message'));
    expect(calls[0].args.body).toBe('');
    expect(calls[0].args.media).toHaveLength(1);
    expect(calls[1].args).toEqual({ channel: 'test', body: 'voice transcript', replyTo: 'audio-message-ref', recipients: [], media: [] });
    await expect(page.getByRole('textbox', { name: duringSend ? 'Message Test room' : 'Message Other room' })).toHaveValue(duringSend ? 'next draft' : 'other draft');
  });
}

test('Late transcript never posts after forgetting the device identity', async ({ page }) => {
  await page.evaluate(() => { (window as any).holdTranscript = true; });
  await press(page, page.getByRole('button', { name: 'Record a voice message', exact: true }));
  await page.waitForTimeout(300);
  await press(page, page.getByRole('button', { name: 'Stop recording voice message', exact: true }));
  await page.waitForFunction(() => !!(window as any).finishTranscript);
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await press(page, page.getByRole('button', { name: 'Send message', exact: true }));
  await expect(page.locator('.compose-file')).toHaveCount(0);
  if (test.info().project.name === 'mobile') await press(page, page.getByRole('button', { name: 'Back to conversations', exact: true }));
  await press(page, page.getByRole('button', { name: 'Settings', exact: true }));
  await press(page, page.getByRole('button', { name: 'Forget this device key', exact: true }));
  await press(page, page.getByRole('button', { name: "Tap again to forget — you'll need to re-pair", exact: true }));
  await expect(page.locator('textarea[aria-label^="Message"]')).toHaveCount(0);
  await page.evaluate(() => (window as any).finishTranscript());
  await page.waitForTimeout(100);
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message'))).toHaveLength(1);
});

for (const outcome of ['removed', 'rejected', 'transcription failed', 'reply failed', 'upload failed']) {
  test(`Async voice handles ${outcome} without losing audio or polluting the draft`, async ({ page }) => {
    const input = page.getByRole('textbox', { name: 'Message Test room' });
    await page.evaluate(() => { const w = window as any; w.holdTranscript = true; w.holdUpload = true; });
    await press(page, page.getByRole('button', { name: 'Record a voice message', exact: true }));
    await page.waitForTimeout(300);
    await press(page, page.getByRole('button', { name: 'Stop recording voice message', exact: true }));
    await page.waitForFunction(() => !!(window as any).finishTranscript && !!(window as any).finishUpload);
    const send = page.getByRole('button', { name: 'Send message', exact: true });
    await expect(send).toBeDisabled(); // Only upload is a gate, even on desktop Enter.
    await input.dispatchEvent('keydown', { key: 'Enter' });
    expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message'))).toHaveLength(0);
    await page.evaluate(fail => { (window as any).failUpload = fail; (window as any).finishUpload(); }, outcome === 'upload failed');
    if (outcome === 'upload failed') {
      await expect(page.locator('.compose-file')).toContainText('Failed');
      await page.evaluate(() => (window as any).finishTranscript());
      await expect(input).toHaveValue('voice transcript');
      await expect(page.getByRole('button', { name: 'Send transcript without failed audio', exact: true })).toBeEnabled();
      expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message'))).toHaveLength(0);
      return;
    }
    await expect(send).toBeEnabled();
    if (outcome === 'removed') {
      await press(page, page.locator('.compose-file').getByRole('button', { name: 'Remove' }));
      await input.fill('new draft');
    } else {
      if (outcome === 'rejected') await page.evaluate(() => { const w = window as any; w.holdSend = true; w.failSend = true; });
      await press(page, send);
      if (outcome !== 'rejected') await expect(page.locator('.compose-file')).toHaveCount(0);
    }
    await page.evaluate(outcome => {
      const w = window as any;
      w.failTranscript = outcome === 'transcription failed';
      if (outcome === 'reply failed') w.failSend = true;
      w.finishTranscript();
      if (outcome === 'rejected') { w.holdSend = false; w.finishSend(); }
    }, outcome);
    if (outcome === 'rejected') {
      await expect(input).toHaveValue('voice transcript');
      await expect(page.locator('.compose-file')).toHaveCount(1);
      await page.evaluate(() => { (window as any).failSend = false; });
      await press(page, send);
      await expect(input).toHaveValue('');
    } else if (outcome === 'reply failed') {
      await expect(page.locator('.error')).toContainText('Audio sent, but transcript reply failed');
      await expect(input).toHaveValue('');
    } else if (outcome === 'transcription failed') {
      await expect(page.locator('.connection')).toContainText('No transcript');
      await expect(input).toHaveValue('');
    } else {
      await expect(input).toHaveValue('new draft');
      await expect(page.locator('.compose-file')).toHaveCount(0);
    }
    const calls = await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message'));
    expect(calls).toHaveLength(outcome === 'removed' ? 0 : outcome === 'rejected' || outcome === 'reply failed' ? 2 : 1);
  });
}

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

test('Recording blocks another room and send completion preserves that room draft', async ({ page }) => {
  const input = page.getByRole('textbox', { name: 'Message Test room' });
  const switchRoom = async (name: string) => {
    if (test.info().project.name === 'mobile') await press(page, page.getByRole('button', { name: 'Back to conversations', exact: true }));
    if (test.info().project.name !== 'mobile') await page.getByRole('button', { name: 'Rooms', exact: true }).click();
    await press(page, page.locator('.rooms nav button').filter({ hasText: name }));
  };
  await input.fill('draft');
  await press(page, page.getByRole('button', { name: 'Record a voice message', exact: true }));
  await expect(page.getByRole('button', { name: 'Stop recording voice message', exact: true })).toBeEnabled();
  await switchRoom('Other room');
  const other = page.getByRole('textbox', { name: 'Message Other room' });
  await other.fill('draft');
  await other.press('Enter');
  expect(await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message'))).toHaveLength(0);
  await switchRoom('Test room');
  await press(page, page.getByRole('button', { name: 'Stop recording voice message', exact: true }));
  await expect(input).toHaveValue('draft\nvoice transcript');
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await page.evaluate(() => { (window as any).holdSend = true; });
  await press(page, page.getByRole('button', { name: 'Send message', exact: true }));
  await switchRoom('Other room');
  // Matching text in another scope must not be mistaken for the submitted draft.
  await other.fill('draft\nvoice transcript');
  await page.evaluate(() => (window as any).finishSend());
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeEnabled();
  await expect(other).toHaveValue('draft\nvoice transcript');
  await expect(page.locator('.compose-file')).toHaveCount(0);
  await switchRoom('Test room');
  await expect(input).toHaveValue('');
  await expect(page.locator('.compose-file')).toHaveCount(0);
  const calls = await page.evaluate(() => (window as any).calls.filter((c: any) => c.cmd === 'post_message'));
  expect(calls).toHaveLength(1);
  expect(calls[0].args.channel).toBe('test');
  expect(calls[0].args.media).toHaveLength(1);
});

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
