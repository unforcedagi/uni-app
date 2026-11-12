// T-335 cards expand: a task that tells him to tap a card (`sealed_card`) says where that card stands when it no longer waits (expired,
// answered, ended at the broker, refused, or not on this device), with a way to ask the room for a fresh one. While the card waits the task
// is that card (T-335 one ask: oneAsk.oneList folds it in), so this line only ever speaks for a card that is gone or one this device can't see.
// Moved from AskMessage.tsx (retired with the ask sheet: the one card, AskCard.tsx).
import { clockTime } from "../CompactCard";
import { RepostButton, useCardLinks } from "../cardLinks";
import { repostable, repostBody, staleLine, type CardState } from "../sealedCardCore";

export type CardLineAsk = { id: string; tid: string | null; what: string; room: string | null; sealedCard?: string | null };

export function CardLine({ ask, state }: { ask: CardLineAsk; state: CardState | null }) {
  const links = useCardLinks();
  if (!state || state.state === "checking") return null;
  if (state.state === "waiting") {
    const other = state.channel !== ask.room ? links?.roomName(state.channel) ?? null : null;
    const where = state.channel !== ask.room ? (other ? `#${other}` : "another room") : "its room";
    return <div className="sh-ask-card" data-card-state="waiting">
      <p className="sh-ask-card-line"><span aria-hidden="true">🔑</span> Its card waits in {where} · answer by {clockTime(state.expires)}</p>
    </div>;
  }
  const line = staleLine(state, clockTime) ?? "";
  // (not found here may only mean not synced yet, or posted elsewhere: said plainly, with no repost)
  if (!repostable(state)) return <div className="sh-ask-card" data-card-state={state.state} role="note">
    <p className="sh-ask-card-line"><span aria-hidden="true">🔑</span> {line}.</p>
  </div>;
  const channel = "channel" in state ? state.channel : ask.room;
  return <div className="sh-ask-card sh-ask-card-stale" data-card-state={state.state} role="note">
    <p className="sh-ask-card-line"><span aria-hidden="true">⌛</span> {line}. Nothing to tap.</p>
    {channel && <RepostButton channel={channel} cardRef={"ref" in state ? state.ref : ask.sealedCard ?? ask.id}
      body={repostBody({ tid: ask.tid, what: ask.what, fp: null, why: line.replace(/^Its card /, "it ") })} />}
  </div>;
}
