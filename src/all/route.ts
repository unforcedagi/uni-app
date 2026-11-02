// T-335 All view: where a message typed in the All composer should go. A small, cheap decider that runs on the device: it names the
// room(s) and says why in a few words, and the person sees and can change the pick before anything is sent (nothing is sent on a guess).
// Rules, in order:
// 1. The message names a place (its name, or its room's #slug): every place named, in the order named. "names North Field".
// 2. Otherwise the place whose own words (its name, its one line on where it stands, its recent messages) share the message's most
//    telling word: a word few places use counts for more than one most use. "talks about glaze".
// 3. Otherwise where you last wrote ("where you last wrote"), or failing that where the latest talk was ("latest talk").
// No model call: the app has no AI gateway of its own (a hosted one would mean sending the message off the device before it is sent).

export type RouteRoom = {
  /** The room's id (where a message is posted). */ id: string;
  /** The place's name, as the person knows it. */ name: string;
  /** The room's own short name ("kiln-studio"), when it has one. */ slug?: string | null;
  /** Words the place is known by: its line on where it stands, its recent messages. */ text?: string;
  /** When the person last wrote there (unix seconds). */ lastMine?: number | null;
  /** When anyone last wrote there (unix seconds). */ lastTs?: number | null;
};

export type RoutePick = { id: string; why: string };

const STOP = new Set(("the and for with that this from have has had was were are you your our out about into over under then than them they " +
  "there here what when where which who why how can could would should will just like some more most much many any all not but also its it's " +
  "let lets let's me my mine we us his her him she he i'm i've i'd i'll one two get got make made need needs want wants please thanks thank " +
  "today tomorrow yesterday now soon later again still yet very really maybe perhaps sure okay ok yes no do does did done doing going go " +
  "see say said tell ask asked new old good great back way time day week next last first other same each every both").split(/\s+/));

/** The words of a text that can tell places apart: lower case, three letters or more, not a common word, a plural folded to its singular. */
export function routeWords(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/[a-z][a-z0-9'-]*/g) ?? []) {
    const w = raw.replace(/'s$/, "").replace(/^-+|-+$/g, "");
    if (w.length < 3 || STOP.has(w)) continue;
    out.push(w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  }
  return out;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Where in the text a place is named (its name or its #slug, as whole words), or -1. */
function namedAt(text: string, room: RouteRoom): number {
  const lower = text.toLowerCase();
  let at = -1;
  const names = [room.name, room.slug ? `#${room.slug.replace(/^#/, "")}` : null, room.slug && room.slug.includes("-") ? room.slug.replace(/-/g, " ") : null];
  for (const n of names) {
    if (!n || n.trim().length < 3) continue;
    const m = new RegExp(`(^|[^\\p{L}\\p{N}])${escape(n.toLowerCase())}(?=$|[^\\p{L}\\p{N}])`, "u").exec(lower);
    if (m && (at < 0 || m.index < at)) at = m.index;
  }
  return at;
}

/** The suggested room(s) for `text` among `rooms`, each with its reason; empty only when there is no room to suggest. */
export function suggestRoute(text: string, rooms: readonly RouteRoom[]): RoutePick[] {
  if (!rooms.length) return [];
  // 1. places named
  const named = rooms.map((r) => ({ r, at: namedAt(text, r) })).filter((x) => x.at >= 0).sort((a, b) => a.at - b.at);
  if (named.length) return named.slice(0, 3).map(({ r }) => ({ id: r.id, why: `names ${r.name}` }));
  // 2. the most telling shared word: each word weighs log(1 + places / places using it)
  const words = [...new Set(routeWords(text))];
  if (words.length) {
    const vocab = rooms.map((r) => new Set(routeWords(`${r.name} ${r.slug ?? ""} ${r.text ?? ""}`)));
    const df = new Map(words.map((w) => [w, vocab.filter((v) => v.has(w)).length]));
    let best: { i: number; score: number; word: string; wordScore: number } | null = null;
    rooms.forEach((_, i) => {
      let score = 0, word = "", wordScore = 0;
      for (const w of words) {
        if (!vocab[i].has(w)) continue;
        const s = Math.log(1 + rooms.length / df.get(w)!);
        score += s;
        if (s > wordScore) { wordScore = s; word = w; }
      }
      // ties go to the place talked in most lately
      if (score > 0 && (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && (rooms[i].lastTs ?? 0) > (rooms[best.i].lastTs ?? 0)))) best = { i, score, word, wordScore };
    });
    // a word every place uses tells them apart no better than chance: only a word some places lack counts
    const b = best as { i: number; score: number; word: string } | null;
    if (b && df.get(b.word)! < rooms.length) return [{ id: rooms[b.i].id, why: `talks about ${b.word}` }];
  }
  // 3. where you last wrote, else the latest talk
  const byMine = [...rooms].filter((r) => r.lastMine).sort((a, b) => (b.lastMine ?? 0) - (a.lastMine ?? 0))[0];
  if (byMine) return [{ id: byMine.id, why: "where you last wrote" }];
  const byTalk = [...rooms].sort((a, b) => (b.lastTs ?? 0) - (a.lastTs ?? 0))[0];
  return [{ id: byTalk.id, why: "latest talk" }];
}
