// T-335 Uni 0.2: the sweep's measures, boot and ways around (shared by the sweep and the walkthrough's before/after shots). Made-up world only.
import { appendFileSync, mkdirSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import { bootAreas, focusSheet } from './areasFixture';

export const SHOTS = process.env.V02_SHOTS ?? 'test-results/v02-shots';
export const project = () => test.info().project.name;
export const phone = (page: Page) => (page.viewportSize()?.width ?? 0) < 600;
export const rail = (page: Page) => page.getByRole('navigation', { name: 'Main navigation' });

/** The audit's targets: the most visible controls each screen may show, per device (phone 360, Daylight 828, desktop 1440): 0.2's count, plus one where
 *  that stays under 0.1.103's. The old home's numbers are its places page; All was a second screen (13 / 21 / 19) and is now the same one. */
export const TARGETS: Record<string, { phone: number; daylight: number; desktop: number }> = {
  'home': { phone: 11, daylight: 15, desktop: 17 }, // 0.1.103 11 / 20 / 18 → 0.2 11 / 14 / 17
  'home-open': { phone: 15, daylight: 18, desktop: 20 }, // 0.1.103 14 / 23 / 21 → 0.2 15 / 17 / 19
  'room': { phone: 16, daylight: 16, desktop: 22 }, // 0.1.103 18 / 23 / 23 → 0.2 15 / 15 / 21
  'room-details': { phone: 9, daylight: 10, desktop: 14 }, // 0.1.103 10 / 15 / 15 → 0.2 9 / 9 / 13
  'task': { phone: 5, daylight: 5, desktop: 5 }, // 0.1.103 5 / 5 / 5 → 0.2 5 / 5 / 5
  'journal': { phone: 11, daylight: 12, desktop: 15 }, // 0.1.103 13 / 18 / 16 → 0.2 10 / 11 / 15
  'mail': { phone: 14, daylight: 14, desktop: 28 }, // 0.1.103 15 / 20 / 30 → 0.2 13 / 13 / 27
  'vault': { phone: 10, daylight: 10, desktop: 14 }, // 0.1.103 16 / 21 / 21 → 0.2 9 / 9 / 13
  'note': { phone: 11, daylight: 11, desktop: 15 }, // 0.1.103 14 / 19 / 19 → 0.2 10 / 10 / 14
  'search': { phone: 8, daylight: 9, desktop: 4 }, // 0.1.103 9 / 14 / 4 → 0.2 8 / 8 / 4
  'settings': { phone: 11, daylight: 12, desktop: 16 }, // 0.1.103 12 / 17 / 17 → 0.2 11 / 11 / 15
  'for-you': { phone: 6, daylight: 7, desktop: 11 }, // 0.1.103 7 / 12 / 12 → 0.2 6 / 6 / 10
  'arcade': { phone: 8, daylight: 12, desktop: 17 }, // 0.1.103 9 / 18 / 18 → 0.2 8 / 11 / 16
  'more': { phone: 10, daylight: 10, desktop: 10 }, // 0.1.103 11 / - / - → 0.2 9 / - / -
};

export type Measure = { controls: number; names: string[]; overflow: string[]; overlap: string[]; small: string[]; contrast: string[] };
/** What a person meets on screen: the controls they can reach (not behind a sheet, not a full-screen scrim), anything past the edge, controls
 *  on top of each other or too small to tap, and words too faint to read once the screen is grey. */
export async function measure(page: Page): Promise<Measure> {
  return page.evaluate(() => {
    const W = innerWidth, H = innerHeight;
    const SEL = 'button, a[href], input:not([type=hidden]), textarea, select, summary, [role=button], [role=tab], [role=switch], [role=menuitem], [contenteditable=true]';
    const shown = (el: Element) => {
      const r = el.getBoundingClientRect(), s = getComputedStyle(el);
      if (r.width < 1 || r.height < 1 || s.visibility === 'hidden' || s.display === 'none') return false;
      // (a closed <details> keeps its content's boxes in Chromium; checkVisibility knows it isn't drawn)
      if (!(el as any).checkVisibility?.({ contentVisibilityAuto: true, opacityProperty: true, visibilityProperty: true }) ?? false) return false;
      for (let e: Element | null = el; e; e = e.parentElement) { const st = getComputedStyle(e); if (Number(st.opacity) === 0 || e.hasAttribute('inert') || e.getAttribute('aria-hidden') === 'true') return false; }
      return r.bottom > 0 && r.right > 0 && r.top < H && r.left < W;
    };
    // a control is what a finger can land on: the topmost thing at its own centre, or inside it
    const reachable = (el: Element) => { const r = el.getBoundingClientRect(); const x = Math.min(Math.max(r.left + r.width / 2, 1), W - 1), y = Math.min(Math.max(r.top + r.height / 2, 1), H - 1); const top = document.elementFromPoint(x, y); return !!top && (top === el || el.contains(top) || top.contains(el)); };
    const name = (el: Element) => (el.getAttribute('aria-label') || (el as HTMLElement).innerText || (el as HTMLInputElement).placeholder || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
    const all = Array.from(document.querySelectorAll(SEL)).filter((el) => !el.parentElement?.closest(SEL) && shown(el) && reachable(el));
    const controls = all.filter((el) => { const r = el.getBoundingClientRect(); return r.width * r.height < W * H * 0.5; });
    const clipped = (el: Element) => { for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) { const s = getComputedStyle(e); if (s.overflowX !== 'visible' || s.position === 'fixed') return true; } return false; };
    const overflow: string[] = [];
    if (document.documentElement.scrollWidth > W + 1) overflow.push(`page ${document.documentElement.scrollWidth}px wide`);
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (el.closest('svg') || !shown(el) || clipped(el)) continue;
      const r = el.getBoundingClientRect();
      if (r.right > W + 1 || r.left < -1) overflow.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).split(' ')[0]}`);
    }
    const overlap: string[] = [], small: string[] = [];
    // what shows of each control: its box cut to the scrolling or clipping boxes it sits in
    const rs = controls.map((el) => { const r = el.getBoundingClientRect(); let l = r.left, t = r.top, rt = r.right, b = r.bottom;
      for (let e = el.parentElement; e && e !== document.body; e = e.parentElement) { const st = getComputedStyle(e); if (st.overflowX !== 'visible' || st.overflowY !== 'visible') { const q = e.getBoundingClientRect(); l = Math.max(l, q.left); t = Math.max(t, q.top); rt = Math.min(rt, q.right); b = Math.min(b, q.bottom); } }
      return { left: l, top: t, right: rt, bottom: b, width: Math.max(0, rt - l), height: Math.max(0, b - t) }; });
    controls.forEach((el, i) => {
      const r = rs[i];
      const full = el.getBoundingClientRect();
      // (a link inside running text is exempt, as WCAG's target size exempts it)
      if (Math.min(full.width, full.height) < 24 && !el.matches('input[type=checkbox], input[type=radio]') && getComputedStyle(el).display !== 'inline') small.push(`${name(el)} ${Math.round(full.width)}×${Math.round(full.height)}`);
      for (let j = i + 1; j < controls.length; j++) {
        const q = rs[j], ix = Math.min(r.right, q.right) - Math.max(r.left, q.left), iy = Math.min(r.bottom, q.bottom) - Math.max(r.top, q.top);
        // (a field may hold a mark inside its own padding, as the composer's "Uni listening" ring does: r12)
        const field = (x: Element) => x.matches('textarea, input[type=text], input[type=search]');
        if (ix > 4 && iy > 4 && !el.contains(controls[j]) && !controls[j].contains(el) && !field(el) && !field(controls[j])) overlap.push(`${name(el)} / ${name(controls[j])}`);
      }
    });
    // contrast after the Daylight's greyscale (CSS grayscale matrix on sRGB), WCAG luminance
    const rgba = (c: string) => { const m = c.match(/[\d.]+/g)!.map(Number); return { r: m[0], g: m[1], b: m[2], a: m[3] ?? 1 }; };
    const grey = (c: { r: number; g: number; b: number }) => { const y = 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b; return { r: y, g: y, b: y }; };
    const lum = (c: { r: number; g: number; b: number }) => { const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
    const over = (top: { r: number; g: number; b: number; a: number }, under: { r: number; g: number; b: number }) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a) });
    const bgOf = (el: Element): { r: number; g: number; b: number } | null => {
      const layers: { r: number; g: number; b: number; a: number }[] = [];
      for (let e: Element | null = el; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.backgroundImage !== 'none' && !/gradient/.test(s.backgroundImage)) return null; // over a picture: not judged here
        const c = rgba(s.backgroundColor); if (c.a > 0) { layers.push(c); if (c.a >= 1) break; }
      }
      let base = { r: 255, g: 255, b: 255 };
      for (const l of layers.reverse()) base = over(l, base);
      return base;
    };
    const contrast: string[] = [];
    for (const el of Array.from(document.body.querySelectorAll('*'))) {
      if (el.closest('svg, iframe, .lightbox, [data-place="arcade-game"]')) continue;
      if (!Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || '').trim()) || !shown(el)) continue;
      const s = getComputedStyle(el), bg = bgOf(el);
      if (!bg) continue;
      let op = 1; for (let e: Element | null = el; e; e = e.parentElement) op *= Number(getComputedStyle(e).opacity);
      const fg = rgba(s.color); fg.a *= op;
      const a = lum(grey(over(fg, bg))), b = lum(grey(bg));
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const px = parseFloat(s.fontSize), large = px >= 24 || (px >= 18.66 && Number(s.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) contrast.push(`${(el.textContent || '').trim().slice(0, 30)} ${ratio.toFixed(2)}`);
    }
    return { controls: controls.length, names: controls.map(name), overflow: [...new Set(overflow)], overlap, small, contrast: [...new Set(contrast)] };
  });
}

/** Settles the screen, shoots it (greyscale on the Daylight), measures it and holds it to its target. */
export async function check(page: Page, screen: string) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  mkdirSync(`${SHOTS}/${project()}`, { recursive: true });
  if (project() === 'daylight') await page.addStyleTag({ content: 'html { filter: grayscale(1) !important; }' });
  await page.screenshot({ path: `${SHOTS}/${project()}/${screen}.png` });
  const m = await measure(page);
  if (process.env.V02_COUNTS) appendFileSync(process.env.V02_COUNTS, JSON.stringify({ project: project(), screen, ...m }) + '\n');
  const target = TARGETS[screen]?.[project() as 'phone' | 'daylight' | 'desktop'];
  if (target !== undefined) expect(m.controls, `controls on ${screen}: ${m.names.join(' | ')}`).toBeLessThanOrEqual(target);
  expect(m.overflow, `past the edge on ${screen}`).toEqual([]);
  if (phone(page)) { expect(m.overlap, `controls on top of each other on ${screen}`).toEqual([]); expect(m.small, `controls too small to tap on ${screen}`).toEqual([]); }
  if (project() === 'daylight') expect(m.contrast, `too faint in greyscale on ${screen}`).toEqual([]);
}

const T0 = '2026-10-10T08:00:00.000Z';
const FOR_YOU = '01M3ZQF7EM4ADC7HEY36D3DC3B';
export async function boot(page: Page, extra: Record<string, unknown> = {}) {
  await page.addInitScript(({ calm, tasks, forYou }) => {
    const w = window as any;
    if (calm) { try { localStorage.setItem('uni.motion', 'calm'); } catch { /* */ } }
    w.__seedTasks = tasks;
    w.__extraInvoke = async (cmd: string, args: any) => {
      if (cmd === 'route_suggest') throw 'route door unreachable';
      if (cmd === 'route_outcome') return {};
      if (cmd === 'vault_note' && args.noteRef === forYou) return { hub: 'https://example.invalid', vault: 'uni', note: { id: forYou, path: 'For you', createdAt: '2026-11-01T08:00:00Z', updatedAt: new Date().toISOString(), tags: [], metadata: {},
        content: '# For you\n\nThursday, November 5.\n\n## Worth a look\n\n- The bisque load is cooled; unload before the glaze tests.\n- Choir wants the hall booked for Tuesday: one yes or no from you.\n\n## Waiting on others\n\n- Long Table: menu for Friday.\n' } };
      if (cmd === 'search') { const now = Math.floor(Date.now() / 1000); return [{ channel_name: 'kiln-studio', snippet: 'The bisque firing finished overnight', message: { ref: 'k1', channel: 'ch-kiln', author: 'b'.repeat(64), author_name: 'Uni', ts: now - 3000, body: 'The bisque firing finished overnight.', mentions_me: false, root: null, parent: null, mentions: [], reply_count: 0, last_reply_ts: null, edited: false, reactions: [], media: [] } }].filter((h) => h.snippet.toLowerCase().includes(String(args.query).toLowerCase())); }
      return undefined;
    };
  }, { calm: project() === 'daylight', forYou: FOR_YOU, tasks: [{ id: 't-jars', path: 'Tasks/T-41 Find jars for the honey', extension: 'md', tags: ['task'], createdAt: T0, updatedAt: T0, fixtureTask: true, metadata: { node: 'Areas/Bee Garden', state: 'open', owner: 'aaron', priority: 'now', next: 'Ask the neighbours for twenty jars.' } }] });
  await bootAreas(page, 'seed', { world: 'unread', glow: true, uniMember: true, tasks: true, noWait: true, unread: { 'ch-kiln': 1, 'ch-bees': 2 }, ...extra } as any);
  await page.locator('[data-place="front-door"], nav[aria-label="Rooms and areas"]').first().waitFor();
}
/** A place on the rail, or behind More on a phone. */
export async function go(page: Page, name: string) {
  const r = rail(page);
  if (!(await r.getByRole('button', { name, exact: true }).isVisible())) await r.getByRole('button', { name: 'More', exact: true }).click();
  await r.getByRole('button', { name, exact: true }).click();
}
/** The home's head, opened: what needs you and the places. */
export async function openHead(page: Page) {
  const pull = page.locator('[data-place="front-door"] .fd-pull');
  await pull.click();
  await expect(pull).toHaveAttribute('aria-expanded', 'true');
}
export async function openPlace(page: Page, name: string) {
  await rail(page).getByRole('button', { name: 'Uni', exact: true }).click();
  if (!(await page.locator(`.fd-door[data-path="Areas/${name}"]`).isVisible())) await openHead(page);
  await page.locator(`.fd-door[data-path="Areas/${name}"]`).click();
  await expect(focusSheet(page).locator('.all-focus-title')).toHaveText(name);
}

