// Which sealed applets the user has started in THIS process. An applet tab restored from the last session is not in the set, so its
// frame never starts by itself: a faulty applet that froze Uni can't freeze it again on every launch. Starting is a tap (its tile in
// the drawer, Allow, or "Open").

const started = new Set<string>();

export const isStarted = (id: string) => started.has(id);
export const markStarted = (id: string) => { started.add(id); };
export const markStopped = (id: string) => { started.delete(id); };
