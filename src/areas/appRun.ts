// Which area apps the user has started in THIS process. An area tab restored
// from the last session is not in the set, so its app never starts by itself:
// a faulty app that froze Uni can't freeze it again on every launch. Starting
// is a tap (the area card, Allow, or "Open app").

const started = new Set<string>();
/** Areas whose app changed since the user allowed it, for this process (the bar says so). */
const updated = new Set<string>();

export const isStarted = (areaPath: string) => started.has(areaPath);
export const markStarted = (areaPath: string) => { started.add(areaPath); };
export const markStopped = (areaPath: string) => { started.delete(areaPath); };
export const wasUpdated = (noteId: string) => updated.has(noteId);
export const markUpdated = (noteId: string) => { updated.add(noteId); };
export const clearUpdated = (noteId: string) => { updated.delete(noteId); };
