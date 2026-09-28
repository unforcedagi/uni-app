// Pure helpers for the in-app note view and chat scroll memory (unit-tested
// in scripts/noteText.test.ts).

const H1 = /^\s*#\s+(.+?)\s*#*\s*$/m;

/** Title: the note's first H1, else the last path segment, else the id. */
export function noteTitle(content: string | undefined, path: string | undefined, id: string): string {
  const h1 = H1.exec(content ?? "")?.[1]?.trim();
  if (h1) return h1;
  const leaf = path?.split("/").filter(Boolean).pop();
  return leaf || id;
}

/** The body without a leading H1 (it is already shown as the page title). */
export function bodyWithoutTitle(content: string): string {
  const m = /^\s*(?:---\n[\s\S]*?\n---\n\s*)?#\s+.+\n?/.exec(content);
  if (!m) return content;
  // Keep YAML front matter if there was any; drop only the heading line.
  const fm = /^\s*(---\n[\s\S]*?\n---\n)/.exec(m[0])?.[1] ?? "";
  return fm + content.slice(m[0].length).replace(/^\s*\n/, "");
}

/** Quiet meta line: `vault · path · Updated Sep 27, 2026`. */
export function noteMeta(vault: string, path: string | undefined, when: string | undefined, locale?: string): string {
  const parts = [vault];
  if (path) parts.push(path);
  if (when) {
    const d = new Date(when);
    if (!Number.isNaN(d.getTime())) parts.push(`Updated ${d.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" })}`);
  }
  return parts.join(" · ");
}

/** A remembered position in a message list. */
export type ScrollMark = { top: number; atEnd: boolean };

/** Distance from the bottom that still counts as "reading the newest". */
export const END_SLACK = 80;

export function markFor(scrollTop: number, scrollHeight: number, clientHeight: number): ScrollMark {
  return { top: scrollTop, atEnd: scrollHeight - scrollTop - clientHeight <= END_SLACK };
}

/** Where to put a list that just (re)opened: the saved spot, or the newest. */
export function restoreTop(saved: ScrollMark | undefined, scrollHeight: number, clientHeight: number): number {
  const end = Math.max(0, scrollHeight - clientHeight);
  if (!saved || saved.atEnd) return end;
  return Math.min(saved.top, end);
}
