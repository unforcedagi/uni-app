// 0.3.0 For you: a made-up world of asks and cards on top of the areas fixture's `unread` world (North Field, Kiln Studio, Bee Garden,
// Choir, Long Table, the private Sanctum). Every name, line and date here is invented. The fake vault answers the For you reads; the fake relay
// is the fixture's `post_message` (it records every call in `window.__calls`, nothing leaves the page).
import type { Page } from '@playwright/test';
import { bootAreas } from './areasFixture';

const H = 3600_000, D = 24 * H;
/** A local time `days` from now at `hour`:00, as the vault stores a date with a time (ISO, UTC). */
const at = (now: number, days: number, hour: number) => { const d = new Date(now + days * D); d.setHours(hour, 0, 0, 0); return d.toISOString(); };
const ago = (now: number, ms: number) => new Date(now - ms).toISOString();

/** The asks: seven of Aaron's (one an old decision), one to look at, one in the private area, one a room's own, one already answered. */
export function asks(now: number) {
  const T0 = ago(now, 2 * D);
  const task = (id: string, title: string, meta: Record<string, unknown>, tags = ['task']) => ({ id, path: `Tasks/${title}`, extension: 'md', tags, fy: true, createdAt: T0, updatedAt: ago(now, 3 * H),
    lastUpdatedBy: 'someone-else', lastUpdatedVia: 'mcp', metadata: { state: 'open', owner: 'aaron', ...meta } });
  return [
    task('fy-glaze', 'T-501 Pick the glaze for the test tiles', { node: 'Areas/Kiln Studio', kind: 'choose', options: ['Celadon', 'Tenmoku', 'Shino'], default: 'Celadon', default_at: at(now, 2, 17),
      card: 'Cards/Kiln Studio/Glaze Tests', why_now: 'The tiles go in the kiln on Friday.', reply_room: 'kiln-studio', reply_root: 'k3', asked_at: ago(now, 1 * D) }),
    // (its `room` names a room that was archived: the relay doesn't list it, so its answer goes to its node's live room, 0.3.3)
    task('fy-gate', 'T-502 Sign the gravel delivery note', { node: 'Areas/North Field', kind: 'do', no_default: true, why_now: 'The lorry comes Wednesday and needs your name.', asked_at: ago(now, 3 * D), room: 'Old-Barn' }),
    task('fy-hall', 'T-503 Keep the hall on Tuesdays?', { node: 'Areas/Choir', kind: 'choose', options: ['Keep Tuesdays', 'Move to Thursdays'], default: 'Keep Tuesdays', default_at: at(now, 4, 9),
      card: 'Cards/Choir/Winter Set', why_now: 'The hall wants an answer for the new term.', reply_room: 'choir', asked_at: ago(now, 2 * D) }),
    task('fy-soup', 'T-504 Bring the soup pot on Saturday', { node: 'Areas/Long Table', kind: 'do', default: 'Uni asks Rowan instead', default_at: at(now, 1, 12), why_now: 'Nine people said yes.', asked_at: ago(now, 1 * D) }),
    task('fy-jars', 'T-505 Find twenty jars for the honey', { node: 'Areas/Bee Garden', kind: 'do', default: 'Uni asks the neighbours', default_at: at(now, 3, 18), card: 'Cards/Bee Garden/Honey Harvest',
      why_now: 'The harvest is on Saturday.', reply_room: 'bee-garden', asked_at: ago(now, 1 * D) }),
    task('fy-hedge', 'T-506 Say which corner stays wild', { node: 'Areas/North Field', kind: 'tell', no_default: true, why_now: 'The hedge cutters come on Thursday.', asked_at: ago(now, 5 * D) }),
    // an old-style decision: tagged `decision` only, open, no card and no default (the vault may soon return it for `tag: task` too)
    { ...task('fy-paint', 'Choose the hive paint', { node: 'Areas/Bee Garden', options: ['White', 'Pale yellow'] }, ['decision']), path: 'Decisions/Choose the hive paint', createdAt: ago(now, 6 * D) },
    // 0.3.3: asked nine days ago and never confirmed by its room since: it went back to that room, so For you only counts it
    task('fy-stale', 'T-507 Mend the old fence', { node: 'Areas/North Field', kind: 'do', no_default: true, why_now: 'Asked a long time ago.', asked_at: ago(now, 9 * D) }),
    task('fy-look', 'T-510 Look at the glaze tile photos', { node: 'Areas/Kiln Studio', kind: 'look', no_default: true, card: 'Cards/Kiln Studio/Glaze Tests', why_now: 'Twelve tiles, photographed on the shelf.',
      link: 'https://example.com/kiln/tiles', reply_room: 'kiln-studio', asked_at: ago(now, 2 * H) }),
    task('fy-quiet', 'T-520 Morning practice note', { node: 'Areas/Sanctum', kind: 'tell', no_default: true, card: 'Cards/Sanctum/daily practice', why_now: 'Private words that never leave the area.', asked_at: ago(now, 1 * D) }),
    task('fy-room', 'T-530 Fire the second bisque load', { node: 'Areas/Kiln Studio', owner: 'room:kiln-studio', state: 'doing' }),
    task('fy-was', 'T-531 Answered from the phone already', { node: 'Areas/Kiln Studio', kind: 'tell', answered_at: ago(now, H), answer: 'Seen', no_default: true }),
  ];
}

const line = (now: number, run: string, hoursAgo: number, text: string) => ({ run, at: ago(now, (hoursAgo + 1) * H), ended: ago(now, hoursAgo * H), status: 'completed', text });
/** The cards: two moved in the last day (and the private one), two quiet, one resting. `more` (0.3.2, the card itself): the glaze card also
 *  carries one of Aaron's answers as a line, its threads and its asks; Kiln Studio gains a quiet card with eight lines and a resting one; the
 *  private card counts its ask. */
export function cards(now: number, more = false) {
  const card = (area: string, name: string, meta: Record<string, unknown>) => ({ id: `card-${name.replace(/\W+/g, '-').toLowerCase()}`, path: `Cards/${area}/${name}`, extension: 'md', tags: ['card'], createdAt: ago(now, 30 * D), updatedAt: ago(now, H),
    metadata: { schema: 'card/1', name, area, area_node: `Areas/${area}`, origin: 'project', private: false, status: 'active', stands: '', hill: { pos: null }, lines: [], ...meta } });
  return [
    card('Kiln Studio', 'Glaze Tests', { project: 'Projects/Glaze Tests', stands: 'Twelve test tiles are fired; one glaze crawled.', stands_at: ago(now, 2 * H), hill: { pos: 64, phase: 'downhill', stuck: false },
      needs_you: true, open_asks: ['T-501', 'T-510'], lines: [line(now, 'r2', 2, 'The test tiles came out of the kiln.'), line(now, 'r1', 72, 'Mixed three glazes for the tiles.')] }),
    card('Bee Garden', 'Honey Harvest', { stands: 'Hive two is heavy; jars are the last thing.', hill: { pos: 80, phase: 'downhill' }, lines: [line(now, 'r3', 3, 'Hive two was weighed: about twelve kilos.')] }),
    card('Choir', 'Winter Set', { status: 'resting', stands: 'The winter set is printed.', hill: { pos: 92, phase: 'downhill' }, lines: [line(now, 'r4', 200, 'Printed the sheet music.')] }),
    card('North Field', 'Gate Path', { origin: 'thread', stands: 'Gravel is ordered.', hill: { pos: 30, phase: 'uphill' }, lines: [line(now, 'r5', 120, 'Measured the path by the gate.')] }),
    card('Long Table', 'Supper Club', { stands: 'Saturday is set.', hill: { pos: 50 }, lines: [line(now, 'r6', 90, 'Counted the chairs.')] }),
    card('Sanctum', 'daily practice', { private: true, origin: 'thread', lines: [line(now, 'r7', 1, 'A session on daily practice: completed.')] }),
  ].map((c) => (!more ? c : c.metadata.name === 'Glaze Tests' ? { ...c, metadata: { ...c.metadata, threads: ['test tiles', 'glaze recipes'], last_session_at: ago(now, 3 * H),
    lines: [...(c.metadata.lines as unknown[]), { at: ago(now, 30 * H), by: 'aaron', status: 'answer', text: 'Aaron: Keep the cracked pot for the glaze tests.' }] } }
    : c.metadata.name === 'daily practice' ? { ...c, metadata: { ...c.metadata, threads: ['daily practice'], open_asks: ['T-520'] } } : c)).concat(!more ? [] : [
    card('Kiln Studio', 'Kiln Shelves', { stands: 'The new shelves are level.', hill: { pos: 40, phase: 'uphill' }, last_session_at: ago(now, 31 * H),
      lines: Array.from({ length: 8 }, (_, i) => line(now, `s${i}`, 30 + 24 * i, `Shelf session ${8 - i}.`)) }),
    card('Kiln Studio', 'Clay Order', { status: 'resting', stands: 'The clay came in October.', hill: { pos: 100 }, lines: [line(now, 'c1', 400, 'Ordered the clay.')] }),
  ]);
}

/** Boots the made-up world with these asks and cards. `postFails`: the fake relay refuses that many posts first. */
export async function bootForYou(page: Page, opts: { postFails?: number; transcript?: string; more?: boolean } = {}) {
  const now = Date.now();
  await page.addInitScript(({ seed, deck, postFails, transcript }) => {
    const w = window as any;
    w.__seedTasks = seed; w.__postFails = postFails; w.__transcript = transcript;
    w.__extraInvoke = async (cmd: string, args: any) => {
      // the fake vault: only this world's asks; `tag: task` also returns the old decision-only notes, as the vault will once `decision`
      // is declared a child of `task` (the app must keep only real tasks there)
      if (cmd === 'vault_query_meta' && (args.tag === 'task' || args.tag === 'decision')) {
        const st = args.metadata?.state?.in as string[] | undefined;
        const rows = (w.__tasks as any[]).filter((t) => t.fy && (args.tag === 'task' ? t.tags.some((x: string) => x === 'task' || x === 'decision') : t.tags.includes('decision')) && (!st || st.includes(t.metadata.state)));
        return JSON.parse(JSON.stringify(rows.slice(args.offset ?? 0, (args.offset ?? 0) + (args.limit ?? 200))));
      }
      if (cmd === 'vault_query' && args.tag === 'card') return JSON.parse(JSON.stringify(deck));
      if (cmd === 'voice_transcribe') return { text: w.__transcript ?? 'Made-up words.', language: 'en', duration: 1 };
      if (cmd === 'post_message' && w.__postFails > 0) { w.__postFails--; throw 'relay unreachable: connection refused'; }
      return undefined;
    };
  }, { seed: asks(now), deck: cards(now, !!opts.more), postFails: opts.postFails ?? 0, transcript: opts.transcript ?? null });
  await bootAreas(page, 'seed', { world: 'unread', glow: true, uniMember: true, tasks: true, noWait: true } as any);
  await page.locator('[data-place="front-door"]').first().waitFor();
}
