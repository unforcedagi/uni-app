// Vault note links (pure, unit-tested).
//
// One URL grammar, Parachute's own (parachute-app `src/lib/vault/deep-link.ts`):
//   <hub>/surface/parachute/v/<vault>/n/<note-id-or-encoded-path>[/edit]
// Anyone without this app lands on the same note in the Parachute app on the
// hub; inside the app the link opens the in-app note view instead.
//
// Agents also write a shorthand in chat, `uni:System/Now` or
// `unforced:Notes/2026/09-05/07-03-09`, which maps to the configured hub.

export type VaultRef = {
  /** Hub origin the link names (`https://…`), or null for a shorthand ref. */
  hub: string | null;
  /** Allow bounded prose-prefix recovery for bare references and wikilinks. */
  recover?: boolean;
  vault: string;
  /** Note id (ULID) or path. */
  ref: string;
};

/** Vault names the `<vault>:<path>` shorthand is recognised for. */
export const SHORTHAND_VAULTS = ["uni", "unforced", "parachute", "uni-1"] as const;

const VAULT_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
// <origin>[/surface/<name>]/v/<vault>/n/<ref>[/edit][/][?…][#…]
const NOTE_URL = /^(https?:\/\/[^/?#\s]+)(?:\/surface\/[^/?#\s]+)?\/v\/([^/?#\s]+)\/n\/([^?#\s]+?)(?:\/edit)?\/?(?:[?#]\S*)?$/i;

function decode(s: string): string | null {
  try { return decodeURIComponent(s); } catch { return null; }
}

/** A canonical Parachute note URL → its parts, or null. */
export function parseNoteUrl(url: string): VaultRef | null {
  const m = NOTE_URL.exec(url.trim());
  if (!m) return null;
  const vault = decode(m[2]);
  const ref = decode(m[3]);
  if (!vault || !VAULT_NAME.test(vault) || !ref || !ref.trim()) return null;
  return { hub: m[1].toLowerCase(), vault, ref };
}

/**
 * `uni:System/Now` / `unforced:Notes/…` → a ref. The whole string must be
 * the shorthand (used for inline-code spans, where paths may contain spaces).
 * A path needs a `/` or must be a bare note id, so prose like `uni:1939`
 * isn't taken for a note.
 */
export function parseShorthand(s: string, vaults: readonly string[] = SHORTHAND_VAULTS): VaultRef | null {
  const m = /^([a-z][a-z0-9_-]*):(\S.*)$/.exec(s.trim());
  if (!m || !vaults.includes(m[1])) return null;
  const ref = m[2].trim();
  if (ref.startsWith("//") || ref.length > 1024) return null;
  if (!ref.includes("/") && !ULID.test(ref)) return null;
  if (!/[A-Za-z]/.test(ref)) return null;
  return { hub: null, vault: m[1], ref };
}

/**
 * Shorthand in running text, including spaces. Matches at
 * `i` (which must start a word) and returns the consumed length. Trailing
 * sentence punctuation is left out.
 */
export function matchShorthandAt(src: string, i: number, vaults: readonly string[] = SHORTHAND_VAULTS): { ref: VaultRef; end: number } | null {
  if (i > 0 && /[\w/:.@-]/.test(src[i - 1])) return null;
  const head = /^[a-z][a-z0-9_-]*:/.exec(src.slice(i));
  if (!head) return null;
  let end = i + head[0].length;
  let parens = 0;
  // parseShorthand rejects refs over 1024 chars, so never scan further: an
  // unbounded scan made a long line of repeated refs quadratic.
  const limit = Math.min(src.length, end + 1025);
  for (; end < limit; end++) {
    const ch = src[end];
    if (/[\r\n`<>"\]]/.test(ch)) break;
    if (ch === "(") parens++;
    if (ch === ")") { if (!parens) break; parens--; }
    if (/[.,;:!?]/.test(ch) && (end + 1 === src.length || /\s/.test(src[end + 1]))) break;
  }
  const text = src.slice(i, end).trimEnd().replace(/[*_~]+$/, "").trimEnd();
  const ref = parseShorthand(text, vaults);
  return ref ? { ref: { ...ref, recover: true }, end: i + text.length } : null;
}

/** The canonical, shareable URL for a note (prefer the id: it survives renames). */
export function noteUrl(hub: string, vault: string, idOrPath: string): string {
  return `${hub.replace(/\/+$/, "")}/surface/parachute/v/${encodeURIComponent(vault)}/n/${encodeURIComponent(idOrPath)}`;
}

/** Whether a link's hub is the one this app reads from (null = shorthand = ours). */
export function sameHub(ref: VaultRef, hub: string | null | undefined): boolean {
  if (!ref.hub) return true;
  if (!hub) return false;
  try { return new URL(ref.hub).origin === new URL(hub).origin; } catch { return false; }
}

/** Short visible label for a bare link: `uni · System/Now`, ids abbreviated. */
export function refLabel(ref: VaultRef): string {
  const r = ULID.test(ref.ref) ? `${ref.ref.slice(0, 8)}…` : ref.ref;
  return `${ref.vault} · ${r}`;
}

// ── In-app routes for wikilinks inside a rendered note ─────────────────────
// The note view hands surface-render hrefs in this private space; its link
// component intercepts them, so they never reach the WebView or the browser.

const ROUTE = "#note/";

export function noteRoute(vault: string, ref: string): string {
  return `${ROUTE}${encodeURIComponent(vault)}/${encodeURIComponent(ref)}`;
}

export function parseNoteRoute(href: string): VaultRef | null {
  if (!href.startsWith(ROUTE)) return null;
  const [v, r, ...rest] = href.slice(ROUTE.length).split("/");
  if (rest.length || !v || !r) return null;
  const vault = decode(v), ref = decode(r);
  if (!vault || !VAULT_NAME.test(vault) || !ref) return null;
  return { hub: null, vault, ref };
}

export type LinkRecord = { sourceId?: string; targetId?: string; targetNote?: { id: string; path?: string } | null };

/**
 * `[[target]]` → an in-app route, built from the note's outbound link records
 * like parachute-app's `buildWikilinkResolver`. Unresolved targets still link
 * (by path; the vault resolves paths and titles), styled as unresolved.
 */
export function wikilinkResolver(note: { id: string; links?: LinkRecord[] }, vault: string) {
  const byTarget = new Map<string, string>();
  for (const l of note.links ?? []) {
    if (l.sourceId !== note.id || !l.targetNote) continue;
    const t = l.targetNote;
    byTarget.set(t.id, t.id);
    if (t.path) {
      byTarget.set(t.path, t.id);
      byTarget.set(t.path.toLowerCase(), t.id);
      const base = t.path.split("/").pop();
      if (base && !byTarget.has(base.toLowerCase())) byTarget.set(base.toLowerCase(), t.id);
    }
  }
  return (target: string): { href: string; exists: boolean } => {
    const t = target.split("|")[0].split("#")[0].trim();
    const explicit = /^([a-z][a-z0-9_-]*):(.*)$/.exec(t);
    if (explicit && SHORTHAND_VAULTS.includes(explicit[1] as typeof SHORTHAND_VAULTS[number])) {
      if (explicit[1] !== vault) return { href: noteRoute(explicit[1], explicit[2]), exists: false };
    }
    const local = explicit && explicit[1] === vault ? explicit[2] : t;
    const id = byTarget.get(local) ?? byTarget.get(local.toLowerCase());
    return id ? { href: noteRoute(vault, id), exists: true } : { href: noteRoute(vault, local || target), exists: false };
  };
}

/** At most six shorter references, never removing the last segment's first word. */
export function refCandidates(ref: string): string[] {
  const result: string[] = [];
  // The vault rejects refs over 1024 bytes; and a linear backward scan (not a
  // `\s+\S+$` regex, which is quadratic on long whitespace runs) finds the
  // start of the whitespace before the last word.
  if (ref.length > 1024) return result;
  let candidate = ref.trimEnd();
  const floor = candidate.lastIndexOf("/") + 1;
  const ws = (c: string) => /\s/.test(c);
  while (result.length < 6) {
    let j = candidate.length;
    while (j > 0 && !ws(candidate[j - 1])) j--;
    let k = j;
    while (k > 0 && ws(candidate[k - 1])) k--;
    if (k === j || k <= floor) break;
    candidate = candidate.slice(0, k);
    if (!candidate.slice(floor).trim()) break;
    result.push(candidate);
  }
  return result;
}

export function isNoteNotFound(error: unknown): boolean {
  return /\bnote not found:/.test(String(error));
}
