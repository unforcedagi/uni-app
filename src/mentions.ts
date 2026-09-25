// Mention contract (after Buzz desktop docs/mention-editor.md):
// - picking a member inserts its full label plus a separator and binds that
//   label to one exact pubkey;
// - on send, only labels still present in the draft become recipients;
// - a typed `@Name` binds only when exactly one member carries that name, and
//   an ambiguous typed name fails visibly (the caller keeps the draft);
// - the longest literal label at an `@` wins, so `@Uni Bot` is not read as `@Uni`.

export type Member = { pubkey: string; name: string; named: boolean };
export type Bindings = Map<string, string>; // label -> pubkey

const WORD = /[\p{L}\p{N}_]/u;

/** Unique composer label per member. Duplicate names get a key suffix. */
export function memberLabels(members: Member[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const m of members) counts.set(m.name.toLowerCase(), (counts.get(m.name.toLowerCase()) ?? 0) + 1);
  const out = new Map<string, string>(); // pubkey -> label
  for (const m of members) {
    const dup = (counts.get(m.name.toLowerCase()) ?? 0) > 1 || !m.named;
    out.set(m.pubkey, dup && m.named ? `${m.name} (${m.pubkey.slice(0, 8)})` : m.name);
  }
  return out;
}

/**
 * The `@query` being typed at `caret`, if any.
 *
 * - `settled`: labels already chosen (bindings). An `@label` the user picked is
 *   finished: typing after it never reopens the picker or grows it into a
 *   longer name (`@Uni ` + `B` must not become `@Uni Bot`).
 * - `names`: member names. A query may contain spaces only while it is still a
 *   prefix of some multi-word name; otherwise the first space ends it.
 */
export function activeQuery(
  text: string,
  caret: number,
  opts: { settled?: Iterable<string>; names?: Iterable<string> } = {},
): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s|[([{"'“]/u.test(before[at - 1])) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /[\n@]/.test(query) || /\s{2}/.test(query)) return null;
  const lower = query.toLowerCase();
  for (const label of opts.settled ?? []) {
    const l = label.toLowerCase();
    if (lower.startsWith(l) && (lower.length === l.length || !WORD.test(query[l.length]))) return null;
  }
  if (/\s/.test(query)) {
    const names = [...(opts.names ?? [])].map((n) => n.toLowerCase());
    if (!names.some((n) => n.startsWith(lower))) return null;
  }
  return { start: at, query };
}

/** Members matching `query`: prefix matches first, then word/substring matches. */
export function filterMembers(members: Member[], query: string, exclude?: string): Member[] {
  const q = query.trim().toLowerCase();
  const pool = members.filter((m) => m.pubkey !== exclude);
  if (!q) return pool.slice(0, 8);
  const scored = pool
    .map((m) => {
      const n = m.name.toLowerCase();
      const score = n.startsWith(q) ? 0 : n.split(/\s+/).some((w) => w.startsWith(q)) ? 1 : n.includes(q) ? 2 : m.pubkey.startsWith(q) ? 3 : -1;
      return { m, score };
    })
    .filter((x) => x.score >= 0);
  scored.sort((a, b) => a.score - b.score || a.m.name.localeCompare(b.m.name));
  return scored.slice(0, 8).map((x) => x.m);
}

/** Replace `text[start..caret]` with `@label ` and return the new text and caret. */
export function insertMention(text: string, start: number, caret: number, label: string): { text: string; caret: number } {
  const after = text.slice(caret).replace(/^ /, "");
  const inserted = `@${label} `;
  return { text: text.slice(0, start) + inserted + after, caret: start + inserted.length };
}

type Occurrence = { start: number; end: number; label: string };

/**
 * Longest literal `@label` occurrences in `text` among `labels`
 * (case-insensitive). `preferred` labels (the user's picks) are tried first at
 * each `@`, so a chosen `@Uni` followed by "Bot…" stays `@Uni`.
 */
export function occurrences(text: string, labels: string[], preferred: string[] = []): Occurrence[] {
  const byLen = (xs: string[]) => [...new Set(xs)].filter(Boolean).sort((a, b) => b.length - a.length);
  const sorted = [...byLen(preferred), ...byLen(labels)];
  const out: Occurrence[] = [];
  const lower = text.toLowerCase();
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "@" || (i > 0 && WORD.test(text[i - 1]))) continue;
    for (const label of sorted) {
      const end = i + 1 + label.length;
      if (lower.slice(i + 1, end) !== label.toLowerCase()) continue;
      if (end < text.length && WORD.test(text[end])) continue;
      out.push({ start: i, end, label: text.slice(i + 1, end) });
      i = end - 1;
      break;
    }
  }
  return out;
}

export type Resolution = { recipients: string[] } | { error: string };

/** Recipients for a draft. Bound labels win; typed names must be unambiguous. */
export function resolveRecipients(text: string, bindings: Bindings, members: Member[]): Resolution {
  const labels = memberLabels(members);
  const byLabel = new Map<string, Set<string>>();
  const add = (label: string, pk: string) => {
    const k = label.toLowerCase();
    if (!byLabel.has(k)) byLabel.set(k, new Set());
    byLabel.get(k)?.add(pk);
  };
  for (const m of members) {
    add(m.name, m.pubkey);
    const l = labels.get(m.pubkey);
    if (l) add(l, m.pubkey);
  }
  const candidates = [...bindings.keys(), ...members.map((m) => m.name), ...labels.values()];
  const recipients: string[] = [];
  const ambiguous: string[] = [];
  for (const occ of occurrences(text, candidates, [...bindings.keys()])) {
    const bound = [...bindings.entries()].find(([l]) => l.toLowerCase() === occ.label.toLowerCase());
    let pk: string | undefined = bound?.[1];
    if (!pk) {
      const set = byLabel.get(occ.label.toLowerCase());
      if (set && set.size > 1) { ambiguous.push(occ.label); continue; }
      pk = set ? [...set][0] : undefined;
    }
    if (pk && !recipients.includes(pk)) recipients.push(pk);
  }
  if (ambiguous.length) {
    const names = [...new Set(ambiguous)].map((n) => `@${n}`).join(", ");
    return { error: `${names} matches more than one member. Pick the person from the @ list so the right one is notified.` };
  }
  return { recipients };
}

/** Drop bindings whose `@label` no longer appears in `text`. */
export function pruneBindings(text: string, bindings: Bindings): Bindings {
  const present = new Set(occurrences(text, [...bindings.keys()]).map((o) => o.label.toLowerCase()));
  return new Map([...bindings].filter(([l]) => present.has(l.toLowerCase())));
}

export type Segment = { text: string; mention?: string };

/** Split a message body into plain text and `@name` segments for tagged recipients. */
export function mentionSegments(body: string, tagged: Member[]): Segment[] {
  if (!tagged.length) return [{ text: body }];
  const labels = memberLabels(tagged);
  const lookup = new Map<string, string>();
  for (const m of tagged) {
    lookup.set(m.name.toLowerCase(), m.pubkey);
    const l = labels.get(m.pubkey);
    if (l) lookup.set(l.toLowerCase(), m.pubkey);
  }
  const out: Segment[] = [];
  let pos = 0;
  for (const occ of occurrences(body, [...lookup.keys()])) {
    if (occ.start > pos) out.push({ text: body.slice(pos, occ.start) });
    out.push({ text: body.slice(occ.start, occ.end), mention: lookup.get(occ.label.toLowerCase()) });
    pos = occ.end;
  }
  if (pos < body.length) out.push({ text: body.slice(pos) });
  return out;
}
