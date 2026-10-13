// Bookkeeping markers a room appends to a message (`[done T-124]`, `[decision T-9]`, `[blocked T-3]`, `[active T-7]`): pulled off the
// start or end of the text so the chat can show them as quiet chips. Anything in the middle of a message stays as written.
export type Marker = { state: "done" | "decision" | "blocked" | "active"; task: string };
const ONE = "\\[(done|decision|blocked|active)\\s+(T-\\d+)\\]";
const TAIL = new RegExp(`(?:^|[\\s]+)${ONE}\\s*$`, "i");
const HEAD = new RegExp(`^\\s*${ONE}(?=\\s|$)`, "i");

export function splitMarkers(body: string): { text: string; markers: Marker[] } {
  let text = body;
  const tail: Marker[] = []; const head: Marker[] = [];
  for (let m = TAIL.exec(text); m; m = TAIL.exec(text)) { tail.unshift({ state: m[1].toLowerCase() as Marker["state"], task: m[2].toUpperCase() }); text = text.slice(0, m.index); }
  for (let m = HEAD.exec(text); m; m = HEAD.exec(text)) { head.push({ state: m[1].toLowerCase() as Marker["state"], task: m[2].toUpperCase() }); text = text.slice(m[0].length); }
  const markers = [...head, ...tail];
  return markers.length ? { text: text.trim(), markers } : { text: body, markers: [] };
}
