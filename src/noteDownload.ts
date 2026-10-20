// T-204: a Parachute note downloaded as a .md file (unit-tested in
// scripts/noteDownload.test.ts; the Save itself is in src-tauri/src/files.rs).

/** Characters file systems refuse in a name (Windows' set covers Linux, macOS and Android). */
const FORBIDDEN = /[/\\:*?"<>|]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * The longest stem, in UTF-8 bytes. ext4 allows 255 bytes, eCryptfs (encrypted
 * home folders) 143, and long non-ASCII names failed in the Linux Save dialog
 * (T-185); 120 bytes leaves room for ".md" and a " (12)" a Downloads folder adds.
 */
export const MAX_STEM_BYTES = 120;

const utf8 = new TextEncoder();

/** `s` cut to at most `max` UTF-8 bytes, never inside a character or after a joiner. */
function capBytes(s: string, max: number): string {
  if (utf8.encode(s).length <= max) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const n = utf8.encode(ch).length;
    if (used + n > max) break;
    out += ch;
    used += n;
  }
  // A cut emoji sequence must not end in a zero-width joiner or a variation selector.
  return out.replace(/[‍︎️]+$/u, "");
}

function clean(s: string): string {
  const cleaned = s.replace(CONTROL, " ").replace(FORBIDDEN, "").replace(/\s+/g, " ");
  // Leading dots would hide the file; trailing dots and spaces are dropped by Windows and some share targets.
  return capBytes(cleaned.trim().replace(/^[.\s]+|[.\s]+$/g, ""), MAX_STEM_BYTES).trim();
}

/** The file name for a note: its title made safe, else its id, else "note"; with ".md". */
export function downloadName(title: string | undefined, id: string): string {
  const stem = clean(title ?? "") || clean(id) || "note";
  return `${stem}.md`;
}

export type NoteDates = { path?: string | null; createdAt?: string | null; updatedAt?: string | null };

const FENCE = /^---\r?\n/;

/**
 * The file's text: the note exactly as stored. With `frontmatter`, `path`,
 * `created` and `updated` go first as YAML; a note that already starts with
 * front matter gets only the keys it lacks, added inside its own block, so the
 * rest of it stays byte for byte as stored.
 */
export function markdownFile(content: string, note: NoteDates, frontmatter: boolean): string {
  if (!frontmatter) return content;
  const fields: [string, string | null | undefined][] = [["path", note.path], ["created", note.createdAt], ["updated", note.updatedAt]];
  const existing = FENCE.test(content) ? frontmatterKeys(content) : null;
  // JSON strings are valid YAML scalars, so a path with ": " or "#" stays one value.
  const lines = fields
    .filter(([key, value]) => value && !existing?.has(key))
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  if (!lines.length) return content;
  if (existing) {
    const fence = FENCE.exec(content)![0];
    const nl = fence.endsWith("\r\n") ? "\r\n" : "\n";
    return fence + lines.map((l) => l + nl).join("") + content.slice(fence.length);
  }
  return `---\n${lines.join("\n")}\n---\n${content}`;
}

/** The top-level keys of a note's leading front matter block, or null when it has none (no closing fence). */
function frontmatterKeys(content: string): Set<string> | null {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  if (!block) return null;
  const keys = new Set<string>();
  for (const line of block[1].split(/\r?\n/)) {
    const key = /^([A-Za-z_][\w-]*)\s*:/.exec(line)?.[1];
    if (key) keys.add(key);
  }
  return keys;
}

const FRONTMATTER_PREF = "uni.noteDownload.frontmatter";

/** Whether downloads add front matter: off unless the user turned it on. */
export function frontmatterPref(): boolean {
  try { return localStorage.getItem(FRONTMATTER_PREF) === "1"; } catch { return false; }
}

export function setFrontmatterPref(on: boolean): void {
  try { localStorage.setItem(FRONTMATTER_PREF, on ? "1" : "0"); } catch { /* private mode: not remembered */ }
}
