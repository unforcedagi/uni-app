import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Page } from '@playwright/test';

type Counts = Record<string, { count: number; examples: string[] }>;
export type Audit = { viewport: { w: number; h: number }; elements: number; overflow: { scrollWidth: number; innerWidth: number; horizontal: boolean }; fontFamily: Counts; fontSize: Counts; fontWeight: Counts; color: Counts; background: Counts; borderColor: Counts; borderRadius: Counts };

/** Computed-style audit of what is on screen: per distinct value, a count and up to 3 `tag.class` examples. No text is recorded. */
export async function audit(page: Page, jsonPath: string) {
  const result: Audit = await page.evaluate(() => {
    const out: any = { fontFamily: {}, fontSize: {}, fontWeight: {}, color: {}, background: {}, borderColor: {}, borderRadius: {} };
    const add = (k: string, v: string, sel: string) => { const e = (out[k][v] ||= { count: 0, examples: [] }); e.count++; if (e.examples.length < 3 && !e.examples.includes(sel)) e.examples.push(sel); };
    const sel = (el: Element) => el.tagName.toLowerCase() + (typeof (el as any).className === 'string' && (el as any).className.trim() ? '.' + (el as any).className.trim().split(/\s+/).slice(0, 3).join('.') : '');
    const clear = (c: string) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
    const bgOf = (el: Element) => { for (let e: Element | null = el; e; e = e.parentElement) { const c = getComputedStyle(e).backgroundColor; if (!clear(c)) return c; } return 'rgb(255, 255, 255) (canvas)'; };
    const visible = (el: Element) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
    const hasOwnText = (el: Element) => Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim());
    let n = 0;
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'PATH'].includes(el.tagName.toUpperCase())) continue;
      const form = el.matches('button, input, textarea, select');
      if (!(form || hasOwnText(el)) || !visible(el)) continue;
      n++;
      const s = getComputedStyle(el), name = sel(el);
      add('fontFamily', s.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, ''), name);
      add('fontSize', s.fontSize, name); add('fontWeight', s.fontWeight, name); add('color', s.color, name);
      add('background', bgOf(el), name);
      add('borderColor', parseFloat(s.borderTopWidth) > 0 || parseFloat(s.borderBottomWidth) > 0 ? s.borderTopColor : 'none', name);
      add('borderRadius', s.borderTopLeftRadius, name);
    }
    const sw = document.documentElement.scrollWidth;
    return { viewport: { w: innerWidth, h: innerHeight }, elements: n, overflow: { scrollWidth: sw, innerWidth, horizontal: sw > innerWidth }, ...out };
  });
  await mkdir(dirname(jsonPath), { recursive: true });
  await writeFile(jsonPath, JSON.stringify(result, null, 1));
  return result;
}

/**
 * The look's rules, checked on what is on screen (T-335): every word in one of the look's four faces, nothing shouted in capitals, nothing too small to read,
 * no Field Book ink outline around anything bigger than a mark. A room's own area app is sealed in its frame and out of this.
 */
export async function lookViolations(page: Page, opts: { ink: boolean; night: boolean }): Promise<string[]> {
  return page.evaluate(({ ink, night }) => {
    const bad = new Set<string>();
    const FACES = ['Literata', 'Instrument Sans', 'Fraunces Glow', 'JetBrains Mono'];
    const INK = night ? 'rgb(236, 230, 218)' : 'rgb(29, 26, 22)';
    const name = (el: Element) => el.tagName.toLowerCase() + (typeof (el as any).className === 'string' && (el as any).className.trim() ? '.' + (el as any).className.trim().split(/\s+/).slice(0, 2).join('.') : '');
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (el.closest('svg')) continue;
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      if (r.width <= 0 || r.height <= 0 || s.visibility === 'hidden' || s.display === 'none') continue;
      const text = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim()) || el.matches('button, input, textarea, select');
      if (text) {
        const face = s.fontFamily.split(',')[0].trim().replace(/^["']|["']$/g, '');
        if (!FACES.includes(face)) bad.add(`face ${face}: ${name(el)}`);
        if (s.textTransform === 'uppercase') bad.add(`capitals: ${name(el)}`);
        if (parseFloat(s.fontSize) > 0 && parseFloat(s.fontSize) < (el.closest('.rail') ? 10 : 11)) bad.add(`small ${s.fontSize}: ${name(el)}`);
      }
      if (!ink && r.width > 24 && r.height > 24 && !el.matches('input[type="checkbox"], input[type="radio"], .lightbox *')) {
        for (const side of ['Top', 'Right', 'Bottom', 'Left'] as const) {
          if (parseFloat((s as any)[`border${side}Width`]) >= 1.5 && (s as any)[`border${side}Style`] === 'solid' && (s as any)[`border${side}Color`] === INK) bad.add(`ink outline: ${name(el)}`);
        }
      }
    }
    return [...bad];
  }, opts);
}
