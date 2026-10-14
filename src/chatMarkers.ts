// Bookkeeping markers a room appends to a message (`[done T-124]`, `[decision T-9]`, `[blocked T-3]`, `[active T-7]`): pulled off the
// start or end of the text, or a whole line of only markers anywhere, so the chat can show them as quiet chips. Brackets inside a sentence stay as written.
export type Marker = { state: "done" | "decision" | "blocked" | "active"; task: string };
// r14: a one-word qualifier after the id is part of the marker too (`[done T-02 step]`)
const ONE = "\\[(done|decision|blocked|active)\\s+(T-\\d+)(?:\\s+[a-z]+)?\\]";
const TAIL = new RegExp(`(?:^|[\\s]+)${ONE}\\s*$`, "i");
const HEAD = new RegExp(`^\\s*${ONE}(?=\\s|$)`, "i");

export function splitMarkers(body: string): { text: string; markers: Marker[] } {
  let text = body;
  const tail: Marker[] = []; const head: Marker[] = [];
  for (let m = TAIL.exec(text); m; m = TAIL.exec(text)) { tail.unshift({ state: m[1].toLowerCase() as Marker["state"], task: m[2].toUpperCase() }); text = text.slice(0, m.index); }
  for (let m = HEAD.exec(text); m; m = HEAD.exec(text)) { head.push({ state: m[1].toLowerCase() as Marker["state"], task: m[2].toUpperCase() }); text = text.slice(m[0].length); }
  // a line holding nothing but markers, wherever it sits
  const mid: Marker[] = [];
  const LINE = new RegExp(`^\\s*(?:${ONE}\\s*)+$`, "i");
  const ALL = new RegExp(ONE, "gi");
  const kept = text.split("\n").filter((ln) => {
    if (!LINE.test(ln)) return true;
    for (const m of ln.matchAll(ALL)) mid.push({ state: m[1].toLowerCase() as Marker["state"], task: m[2].toUpperCase() });
    return false;
  });
  if (mid.length) text = kept.join("\n").replace(/\n{3,}/g, "\n\n");
  const markers = [...head, ...mid, ...tail];
  return markers.length ? { text: text.trim(), markers } : { text: body, markers: [] };
}

/** A worker's progress ping ("⏳ Working — 6 min — iteration 7", possibly edited): shown as one muted line, not a bubble. */
export const isWorkerStatus = (body: string): boolean => /^\s*⏳\s*Working\s*[—–-]\s*\d+\s*(?:min|mins|minutes|m|s|sec|secs|h)\b[^\n]*$/i.test(body);

/** Uni's maintenance notes to itself ("Self-improvement review: Skill 'client-site-copy' patched."): bookkeeping, shown as one muted line (r17). */
export const isMaintenance = (body: string): boolean => /^\W{0,4}(?:self-improvement review|skill review|memory review)\s*[:—–-]/i.test(body) && body.trim().split("\n").length <= 3;

/** A progress ping older than this (seconds) is no longer news (r18). */
export const STATUS_STALE_S = 3600;
/**
 * A worker's progress ping that no longer says what is happening (r18): older than about an hour. A ping is edited in place while its worker
 * runs and the relay keeps only its first time, so an edited ping that is still the room's newest message may be live and is not called stale.
 * A stale one is folded into "Earlier progress update", never shown as the room's current state.
 */
export const staleStatus = (m: { ts: number; edited: boolean }, nowS: number, newest: boolean): boolean => nowS - m.ts > STATUS_STALE_S && !(newest && m.edited);
