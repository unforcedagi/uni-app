// Area notes (pure, unit-tested in scripts/areasCore.test.ts): parse the
// `Areas/<Name>` notes and find an area's app note. The sandbox, scoping and
// message handling live in src/interface. No React, no Tauri.

import { refKey } from "./refs.ts";
import { activeProfile, UNI_VAULT } from "./profile.ts";
import { linksOf } from "./nodeLinks.ts";

export const AREAS_ROOT = "Areas";
export type AreaStatus = "foreground" | "background" | "archived" | "done";
export type Area = {
  id: string; path: string; name: string; purpose: string; status: AreaStatus;
  channels: string[]; since: string | null; title: string; body: string;
  metadata: Record<string, unknown>; updatedAt: string | null;
  /** "area": an `Areas/<Name>` note; "project": a tagged note that names its parent (`metadata.parent`). */
  kind: "area" | "project";
  /** The parent as written in `metadata.parent`: an id, a path or a link (null: a top-level node). The tree resolves and validates it. */
  parent: string | null;
  /** T-140: `metadata.links` as written (ids, paths or links). Two-way and joined with `parent` by nodeLinks.ts; absent = none. */
  links?: string[];
  /** The rooms this node shows: `channels` minus the rooms its children claim. `channels` itself stays what the note says. */
  rooms: string[];
};
export type AreaNoteLike = { id: string; path?: string | null; content?: string | null; tags?: string[] | null; metadata?: Record<string, unknown> | null; updatedAt?: string | null };
export type PathRow = { id: string; path: string | null; extension?: string | null; updatedAt?: string | null };

/** `active` (the life-os pack) is `foreground`; `dormant` and `incubating` are background. Anything unknown is background. */
/** A node's status. Pack vaults say `active` for foreground; the uni vault keeps today's reading (its live projects are `active` and stay background). */
export const nodeStatus = (status: unknown, packStatuses: boolean = activeProfile().vault !== UNI_VAULT): AreaStatus => packStatuses && status === "active" ? "foreground" : status === "foreground" || status === "archived" || status === "done" ? status : "background";

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
    status: nodeStatus(metadata.status),
    channels: splitChannels(metadata.channel),
    since: typeof metadata.since === "string" ? metadata.since : null,
    title: titleOf(content, name), body: content, metadata, updatedAt: note.updatedAt ?? null,
    kind: "area", parent: parentOf(metadata), links: linksOf(metadata), rooms: splitChannels(metadata.channel),
  };
}

/** `metadata.parent` as written: a note id, a path or a `[[link]]` (the tree resolves it; see refs.ts). */
export function parentOf(metadata: Record<string, unknown>): string | null {
  return refKey(metadata.parent);
}

/** A project note: tagged `project` and joined to the tree by `metadata.links` (or the legacy `parent`) or filed directly under `Projects/`. Its Brief and app notes are not nodes. */
export function parseProject(note: AreaNoteLike): Area | null {
  const path = note.path ? stripExt(note.path) : "";
  const metadata = note.metadata ?? {};
  const parent = parentOf(metadata);
  const links = linksOf(metadata);
  if (!path || !(parent || links.length || /^Projects\/[^/]+$/.test(path)) || !(note.tags ?? []).includes("project") || /\/(Brief|app)$/.test(path)) return null;
  const content = note.content ?? "";
  const name = leaf(path);
  return {
    id: note.id, path, name, purpose: typeof metadata.summary === "string" && metadata.summary.trim() ? metadata.summary.trim() : purposeOf(content),
    status: nodeStatus(metadata.status),
    channels: splitChannels(metadata.channel),
    since: typeof metadata.since === "string" ? metadata.since : null,
    title: titleOf(content, name), body: content, metadata, updatedAt: note.updatedAt ?? null,
    kind: "project", parent, links, rooms: splitChannels(metadata.channel),
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

/**
 * The Brief a node's `brief` field points to, if it may be trusted: the reference (an id, a path or a link) must resolve to a note
 * whose path is `<node path>/Brief` (`Areas/Today` for the Uni root, path ""). Anything else is refused, so a node cannot adopt
 * another node's brief by naming it; the caller then keeps the Brief found by path.
 */
export function trustedBrief<T extends { id: string; path?: string | null }>(nodePath: string, ref: unknown, notes: readonly T[]): T | null {
  const key = refKey(ref);
  if (!key) return null;
  const want = nodePath === "" ? "Areas/Today" : `${stripExt(nodePath)}/Brief`;
  const hit = notes.find((n) => n.id === key || (!!n.path && stripExt(n.path) === key));
  return hit && !!hit.path && stripExt(hit.path) === want ? hit : null;
}
