// T-335 cards expand (11-11): what joins a card to its room and its ask, and the one "ask the room to repost" action.
// Aaron: "I can't see the full text, theres no option to expand; and the cards often contain not much context". A card in a room (or pinned on
// home) reads, through this context, its room's name and the ask in that same room that points at it (`sealed_card`), so its expanded head can
// say who asked and why now. A card, or an ask's card, that no longer waits offers to ask the room for a fresh one: one message addressed to
// the room's Uni (so it wakes), sent once per card on this device (kept, so the card and its ask both say it was asked).
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { clockTime } from "./CompactCard";
import type { Asking, CardAsk } from "./sealedCardCore";
import { postIn } from "./shape/useAsks";

export type CardLinks = {
  /** A room's name, no `#`; null when this device doesn't know it. */ roomName: (channel: string) => string | null;
  /** The ask in this card's own room that points at it (asks are vetted per room: never one from elsewhere). */ askFor: (channel: string, ref: string) => CardAsk | null;
};
export const CardLinksContext = createContext<CardLinks | null>(null);
export const useCardLinks = (): CardLinks | null => useContext(CardLinksContext);

// ── the repost asks, by card id: kept on this device, shared by every place that shows the card ──
type Asked = { at: number; room: string | null };
const KEY = "uni.cards.repost.v1";
const read = (): Record<string, Asked> => { try { const v = JSON.parse(localStorage.getItem(KEY) ?? "{}"); return v && typeof v === "object" ? v : {}; } catch { return {}; } };
const subs = new Set<() => void>();
function keep(ref: string, a: Asked) {
  const all = read();
  all[ref] = a;
  // a week is longer than any card lives: older ones go
  for (const [k, v] of Object.entries(all)) if (Date.now() / 1000 - v.at > 7 * 86_400) delete all[k];
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* this session only */ }
  subs.forEach((f) => f());
}
function useAsked(ref: string): Asked | null {
  const [, bump] = useState(0);
  useEffect(() => { const f = () => bump((n) => n + 1); subs.add(f); return () => { subs.delete(f); }; }, []);
  return read()[ref] ?? null;
}

/** "Ask the room to repost": one message to the card's room, addressed to its Uni. Once sent it says so, here and wherever the card shows. */
export function RepostButton({ channel, cardRef, body }: { channel: string; cardRef: string; body: string }) {
  const links = useCardLinks();
  const asked = useAsked(cardRef);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const room = links?.roomName(channel) ?? null;
  if (asked) return <p className="cc-repost cc-repost-done" role="status">Asked {asked.room ? `#${asked.room}` : "the room"} for a fresh card · {clockTime(asked.at)}</p>;
  const send = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await postIn(channel, body, null); keep(cardRef, { at: Math.floor(Date.now() / 1000), room }); }
    catch (e) { setError((typeof e === "string" ? e : (e as Error)?.message ?? "it didn't go").slice(0, 140)); }
    finally { setBusy(false); }
  };
  return <div className="cc-repost">
    <button type="button" className="pairing-secondary cc-repost-btn" disabled={busy} onClick={() => void send()}>{busy ? "Asking…" : `Ask ${room ? `#${room}` : "the room"} to repost`}</button>
    {error && <p className="secret-status warn" role="alert">Not sent: {error}</p>}
  </div>;
}

/** The expanded card's head: what a yes does, what it touches, who asked, why now. */
export function AskingBlock({ a, yes = "If you approve" }: { a: Asking; yes?: string }): ReactNode {
  return <dl className="cc-asking" aria-label="What this card asks">
    <dt>{yes}</dt><dd>{a.approve}</dd>
    <dt>Touches</dt><dd>{a.touches}</dd>
    <dt>Asked by</dt><dd>{a.asked}</dd>
    {a.why && <><dt>Why now</dt><dd>{a.why}</dd></>}
  </dl>;
}
