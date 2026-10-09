import { invoke } from "@tauri-apps/api/core";
import type { Area } from "./areasCore";
const projectBodies = new Map<string, Promise<string>>();
/** Scoped to the signed-in owner and note revision; failed reads can be retried. */
export function projectBody(identity: string, node: Area): Promise<string> {
  const key = JSON.stringify([identity, node.id, node.updatedAt]);
  const cached = projectBodies.get(key);
  if (cached) return cached;
  const request = invoke<{ note: { content?: string | null } }>("vault_note", { vault: "uni", noteRef: node.id })
    .then((d) => d.note.content ?? "").catch((e) => { projectBodies.delete(key); throw e; });
  projectBodies.set(key, request);
  return request;
}
export const clearProjectBodies = () => projectBodies.clear();
