// 0.3.1: the folded head's words, and For you on an area's stream: the same view (forYouCore.ts makes it; nothing here reads or changes the data), with only what is that
// area's: its asks (by the area each one sits in), its cards' lines, its private line. What he answered today stays: it is his, wherever it was.
import type { ForYouView } from "./forYouCore";

/** At most this many in Yours before "N more", as the whole view. */
const CAP = 5;

export function scopeForYou(view: ForYouView, areaPath: string): ForYouView {
  const mine = [...view.yours, ...view.more].filter((i) => i.where.areaPath === areaPath);
  const privates = view.privates.filter((p) => p.areaPath === areaPath);
  return {
    ...view,
    yours: mine.slice(0, CAP),
    more: mine.slice(CAP),
    privates,
    look: view.look.filter((i) => i.where.areaPath === areaPath),
    moving: view.moving.filter((m) => view.cards.get(m.cardPath)?.areaNode === areaPath),
    // the quiet line counts every card: it belongs to All
    quiet: { quiet: 0, resting: 0, line: "" },
    count: mine.length + privates.reduce((n, p) => n + p.count, 0),
  };
}

/** The folded head's one line: how many are his (and approvals waiting for his OK), ready to look at, moving; or that nothing is, with the
 *  day's quiet line; or that it couldn't be checked. It is the home's sentence now, so it never says less than the approvals beside it. */
export function headWords(view: Pick<ForYouView, "count" | "look" | "moving">, state: { failed: boolean; reading: boolean; approvals?: number; quiet?: string }): { lead: string; rest: string[] } {
  const ok = state.approvals ?? 0;
  const okWords = `${ok} waiting for your OK`;
  // a failed read beside approvals: they are counted, and the failure is said too (with its Try again)
  const rest = [view.count && ok ? okWords : "", (view.count || ok) && state.failed ? "couldn't check the rest" : "", view.look.length ? `${view.look.length} to look at` : "", view.moving.length ? `${view.moving.length} moving` : ""].filter(Boolean);
  if (!view.count && !ok && state.failed) return { lead: "Couldn't check what needs you", rest: [] };
  if (!view.count && !ok && state.reading) return { lead: "Looking for what's yours…", rest: [] };
  if (!view.count && !ok && !rest.length) return { lead: "Nothing for you", rest: state.quiet ? [state.quiet] : [] };
  return { lead: view.count ? `${view.count} for you` : ok ? okWords : "Nothing for you", rest };
}
