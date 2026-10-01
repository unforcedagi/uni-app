/** Drafts retain their original revision even if the note changes on the hub. */
export type NoteEdit = { base: string; content: string; updatedAt: string | null; conflict: boolean; restored: boolean };
export const draftKey = (vault: string, id: string) => `uni.noteDraft.v1:${vault}:${id}`;
export const isDirty = (edit: NoteEdit) => edit.content !== edit.base;
export const editableExtension = (extension: string | undefined) => ["md", "txt", "csv", "json", "yaml", "yml", "mdx"].includes((extension ?? "md").replace(/^\./, "").toLowerCase());
export function beginEdit(content: string, updatedAt: string | null, raw: string | null): NoteEdit {
  const clean = { base: content, content, updatedAt, conflict: false, restored: false };
  try {
    const d = JSON.parse(raw ?? "null");
    if (d && typeof d.base === "string" && typeof d.content === "string" && (d.updatedAt === null || typeof d.updatedAt === "string") && d.base !== d.content) {
      if (d.content === content) return clean;
      return { base: d.base, content: d.content, updatedAt: d.updatedAt, conflict: d.updatedAt !== updatedAt, restored: true };
    }
  } catch { /* corrupted drafts do not prevent reading */ }
  return clean;
}
export function changeEdit(edit: NoteEdit, content: string): NoteEdit { return { ...edit, content }; }
export function failedSave(edit: NoteEdit, error: string): NoteEdit { return { ...edit, conflict: edit.conflict || error.startsWith("conflict:") }; }
export function savedEdit(content: string, updatedAt: string | null): NoteEdit { return beginEdit(content, updatedAt, null); }
export function serializeDraft(edit: NoteEdit): string | null {
  return isDirty(edit) ? JSON.stringify({ base: edit.base, content: edit.content, updatedAt: edit.updatedAt }) : null;
}
export function validateNotePath(path: string): string | null {
  if (!path.trim() || new TextEncoder().encode(path).length > 512 || path.startsWith("/") || path.split("/").some((s) => s === ".." || s === "." || !s || s.trim() !== s) || /[\\\x00-\x1f\x7f]/.test(path)) return "Use a relative path of 1–512 bytes, with no empty, dot, whitespace-padded segments, backslashes or control characters.";
  return null;
}
