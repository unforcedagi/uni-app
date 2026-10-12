import { invoke } from "@tauri-apps/api/core";
import type { Area } from "./areasCore";
import { activeProfile } from "./profile";
const projectBodies = new Map<string, Promise<string>>();
/** Scoped to the signed-in owner and note revision; unversioned and failed reads can be retried. */
export function projectBody(identity: string, node: Area): Promise<string> {
  const vault = activeProfile().vault;
  const key = JSON.stringify([identity, vault, node.id, node.updatedAt]);
  const cached = projectBodies.get(key);
  if (node.updatedAt != null && cached) return cached;
  const request = invoke<{ note: { content?: string | null } }>("vault_note", { vault, noteRef: node.id })
    .then((d) => d.note.content ?? "").catch((e) => { projectBodies.delete(key); throw e; });
  if (node.updatedAt != null) projectBodies.set(key, request);
  return request;
}
export const clearProjectBodies = () => projectBodies.clear();
