// Area notes (pure, unit-tested in scripts/areasCore.test.ts): parse the
// `Areas/<Name>` notes and find an area's app note. The sandbox, scoping and
// message handling live in src/interface. No React, no Tauri.

export const AREAS_ROOT = "Areas";
export type AreaStatus = "foreground" | "background";
export type Area = {
  id: string; path: string; name: string; purpose: string; status: AreaStatus;
  channels: string[]; since: string | null; title: string; body: string;
  metadata: Record<string, unknown>; updatedAt: string | null;
};
export type AreaNoteLike = { id: string; path?: string | null; content?: string | null; tags?: string[] | null; metadata?: Record<string, unknown> | null; updatedAt?: string | null };
export type PathRow = { id: string; path: string | null; extension?: string | null; updatedAt?: string | null };

const leaf = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
const stripExt = (path: string) => path.replace(/\.(md|html)$/i, "");

/** `Areas/<Name>` (one level, markdown or extensionless) — never `Areas/<Name>/app` or deeper. */
export function isAreaPath(path: string | null | undefined): boolean {
  return !!path && /^Areas\/[^/]+$/.test(stripExt(path)) && !/\.html$/i.test(path);
}

export function splitChannels(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return [...new Set(parts.map((p) => (typeof p === "string" ? p.trim() : "")).filter(Boolean))];
}

/** First paragraph after the H1 (front matter skipped), markdown punctuation stripped. */
export function purposeOf(content: string): string {
  const body = content.replace(/^\s*---\n[\s\S]*?\n---\n/, "");
  const blocks = body.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  for (const block of blocks) {
    if (/^#{1,6}\s/.test(block) && !block.includes("\n")) continue;
    const lines = block.split("\n").filter((l) => !/^#{1,6}\s/.test(l));
    const text = lines.join(" ").replace(/!?\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_m, a, b) => b || a)
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[*_`>]/g, "").replace(/\s+/g, " ").trim();
    if (text) return text.slice(0, 400);
  }
  return "";
}

export function titleOf(content: string, fallback: string): string {
  return /^\s*#\s+(.+?)\s*#*\s*$/m.exec(content)?.[1]?.trim() || fallback;
}

/** An area note → Area, or null when it isn't a tagged `Areas/<Name>` note. */
export function parseArea(note: AreaNoteLike): Area | null {
  const path = note.path ? stripExt(note.path) : "";
  if (!isAreaPath(note.path) || !(note.tags ?? []).includes("area")) return null;
  const metadata = note.metadata ?? {};
  const content = note.content ?? "";
  const name = leaf(path);
  return {
    id: note.id, path, name, purpose: purposeOf(content),
    status: metadata.status === "foreground" ? "foreground" : "background",
    channels: splitChannels(metadata.channel),
    since: typeof metadata.since === "string" ? metadata.since : null,
    title: titleOf(content, name), body: content, metadata, updatedAt: note.updatedAt ?? null,
  };
}

/** Foreground first, then by name. */
export function sortAreas(areas: Area[]): Area[] {
  const rank = (a: Area) => (a.status === "foreground" ? 0 : 1);
  return [...areas].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.name.localeCompare(b.name));
}

export const appPathOf = (areaPath: string) => `${stripExt(areaPath)}/app`;

/** The area's app note in a path listing: `Areas/<Name>/app` with extension html. */
export function findAppRow(rows: PathRow[], areaPath: string): PathRow | null {
  const want = appPathOf(areaPath);
  return rows.find((r) => !!r.path && stripExt(r.path) === want && (r.extension ?? (/\.html$/i.test(r.path ?? "") ? "html" : "")).toLowerCase().replace(/^\./, "") === "html") ?? null;
}
