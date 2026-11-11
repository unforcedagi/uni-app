// The few most recent places (T-124 r7), as Search offers them. The App owns the history (navHistory.ts).

/** A recent place: its identity (`placeKey`), its name, and for an area or project its path, so a name two places share can show where each sits. */
export type NavRecent = { key: string; title: string; path?: string | null; room?: string | null; go: () => void };
