// A vault note as it comes over IPC (every field unknown until read), and how a failed write is told apart. Moved from
// src/areas/taskCore.ts (the old task model) so the readers that outlive it (the runs, the asks) don't need it.
export type RawNote = {
  id?: unknown; path?: unknown; tags?: unknown; metadata?: unknown; updatedAt?: unknown; createdAt?: unknown;
  lastUpdatedBy?: unknown; lastUpdatedVia?: unknown; content?: unknown;
};

export type FailureKind = "conflict" | "invalid" | "error";
/** How a failed write reads: 409 `transition_conflict`, 422 `schema_validation`, anything else. */
export function failureKind(message: string): FailureKind {
  if (/transition_conflict|\b409\b|conflict:/i.test(message)) return "conflict";
  if (/schema_validation|\b422\b|invalid value|not one of/i.test(message)) return "invalid";
  return "error";
}
