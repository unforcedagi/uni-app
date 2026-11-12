// T-335 copy: where a finger lands on a chat message, and a long press as Android's WebView makes one. Shared by the chat specs.
import type { Locator, Page } from '@playwright/test';

/** A point on `msg` beside its words, where a hold opens the message's sheet: the name and time line's empty end (someone else's
 *  message), else the bubble's padding (your own, whose time is hidden). */
export async function besideWords(msg: Locator) {
  await msg.scrollIntoViewIfNeeded();
  const meta = msg.locator('.message-meta').first();
  if (await meta.count() && await meta.evaluate((el) => getComputedStyle(el).opacity !== '0' && getComputedStyle(el).position !== 'absolute')) {
    const b = (await meta.boundingBox())!;
    return { x: b.x + b.width - 8, y: b.y + b.height / 2 };
  }
  const b = (await msg.locator('.message-content').first().boundingBox())!;
  return { x: b.x + 4, y: b.y + 4 };
}

/** T-335 copy: a finger held on `point`, as Android's WebView handles it. Desktop Chromium (headless or headed) runs no touch long-press
 *  gesture from CDP input, so the platform's part is played here, in its order: the finger down (pointerdown, touch), held; at the
 *  long-press moment a cancelable `contextmenu`; if the page didn't cancel it and the text there is selectable (not inert, not
 *  user-select: none, not a button's label), the word under the finger is selected and the touch is cancelled; else the finger lifts. */
export async function holdTouch(page: Page, point: { x: number; y: number }, ms = 900) {
  await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y)!;
    (window as any).__held = el;
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true, pointerId: 7 }));
  }, point);
  await page.waitForTimeout(ms);
  await page.evaluate(({ x, y }) => {
    const el: Element = (window as any).__held;
    const menu = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y });
    const live = el.isConnected && !el.closest('[inert]');
    if (live && el.dispatchEvent(menu)) {
      const style = getComputedStyle(el.nodeType === 1 ? el : el.parentElement!);
      const at = document.caretRangeFromPoint(x, y);
      if (at && !el.closest('button, [role="button"]') && style.userSelect !== 'none' && (style as any).webkitUserSelect !== 'none' && at.startContainer.nodeType === 3) {
        const sel = window.getSelection()!;
        sel.removeAllRanges(); sel.addRange(at);
        sel.modify('move', 'backward', 'word'); sel.modify('extend', 'forward', 'word');
        el.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true, pointerId: 7 }));
        return;
      }
    }
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, clientX: x, clientY: y, pointerType: 'touch', isPrimary: true, pointerId: 7 }));
  }, point);
}
/** The middle of a word in `text` (an element holding words): the third word of its first text of four words or more. */
export async function wordPoint(text: Locator) {
  await text.scrollIntoViewIfNeeded();
  return text.evaluate((p) => {
    const w = document.createTreeWalker(p, NodeFilter.SHOW_TEXT); let t = w.nextNode()!;
    while (t && t.textContent!.split(' ').length < 4) t = w.nextNode()!;
    const s = t.textContent!, at = s.indexOf(' ', s.indexOf(' ') + 1) + 2;
    const r = document.createRange(); r.setStart(t, at); r.setEnd(t, at + 1);
    const b = r.getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  });
}

