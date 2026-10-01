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
          case 'get_rooms': return [{ id: 'test', name: 'Test room', unread: 0 }];
          case 'get_members': return [{ pubkey: 'b'.repeat(64), name: 'Test member' }];
          case 'get_messages': case 'vault_list': return [];
          case 'journal_config': return { hub: 'test' };
          case 'refresh': return { total_items: 0, channel_errors: {}, truncated_channels: [] };
          case 'media_upload': return { url: 'https://example.invalid/test.txt', mime: 'text/plain', name: 'test.txt', size: 4 };
          case 'voice_transcribe': return { text: 'voice transcript' };
          case 'post_message':
            if (w.holdSend) await new Promise(resolve => { w.finishSend = resolve; });
            return {};
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
