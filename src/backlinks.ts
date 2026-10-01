export type Backlink = { id: string; path: string; relationship: string };
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" ? v as Record<string, unknown> : {};
/** Both directions arrive in links; only target == this note is inbound. */
export function backlinks(id: string, links: unknown): Backlink[] {
  if (!Array.isArray(links)) return [];
  const found = new Map<string, Backlink>();
  for (const value of links) {
    const link = object(value), source = object(link.sourceNote), target = object(link.targetNote);
    const sourceId = link.sourceId ?? source.id, targetId = link.targetId ?? target.id;
    if (targetId !== id || typeof sourceId !== "string" || !sourceId) continue;
    const relationship = typeof link.relationship === "string" ? link.relationship : "link";
    found.set(JSON.stringify([sourceId, relationship]), { id: sourceId, path: typeof source.path === "string" && source.path ? source.path : sourceId, relationship });
  }
  return [...found.values()].sort((a, b) => a.path.localeCompare(b.path) || a.relationship.localeCompare(b.relationship));
}
