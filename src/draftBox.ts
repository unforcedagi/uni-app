// T-335: the composer's text, kept outside React state. A keystroke then redraws the composer field alone: never the room, its messages,
// the room tree, Needs you or the rail, which on a slow phone took long enough that typed keys queued up behind each other and the text
// showed up long after it was typed. The room reads the text when it needs it (send, a room switch, a mention) and
// redraws only when the composer goes from empty to not, or from blank to not (Discard, Send).

export type DraftBox = {
  get(): string;
  /** Replaces the text; listeners hear only a real change. */
  set(text: string): void;
  subscribe(listener: () => void): () => void;
};

export function draftBox(initial = ""): DraftBox {
  let text = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => text,
    set: (next) => {
      if (next === text) return;
      text = next;
      for (const f of [...listeners]) f();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
