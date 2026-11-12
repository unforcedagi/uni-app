// T-335 one ask, step 2: the one card. Every ask (a room's ask, a task that needs him, an approval waiting for a tap) is drawn by this one
// component, the same in its room's chat (where it was asked: `chat`; after the chat when it has no message there: `tail`) and on home
// (`home`, smaller). It opens in place to its whole context and every button (there is no separate sheet); an ask that is over folds to
// one line where it was asked ("You picked B", "Seen", "Lapsed"). Buttons come from oneAsk.cardButtons (one rule, by kind); each says what
// it does. An approval card's answer is the card itself (SealedCard: hold to approve), drawn inside this frame.
// Replaces AskMessage.tsx and AskSheet.tsx (the ask's line and its sheet) and home's pinned approval (T-335 one ask: four designs, one card).
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Body } from "../MessageBody";
import { SealedCard } from "../SealedCard";
import { askBody, askFault, whenLabel } from "./asksCore.ts";
import { CardLine } from "./CardLine";
import { ago } from "./homeCore";
import { cardButtons, type Card, type CardButton } from "./oneAsk.ts";
import { useAskCard } from "./useAskCard";
import "./runs.css";
import "./asks.css";

/** Kind in one word, for the card's head. */
export const KIND_WORD: Record<Card["kind"], string> = { do: "To do", choose: "Choose", look: "Look", tell: "For you to know", approve: "Approve", give: "Give" };

export type AskCardProps = {
  card: Card;
  /** Where it is drawn: its message in the chat, after the chat (no message here), or home's row. */ place: "chat" | "tail" | "home";
  /** Its room's name, no `#` ("" when it has none here). */ roomName: string;
  /** The life vault (a task's context is its note). */ vault: string;
  busy: boolean;
  error: string | null | undefined;
  onAct: (card: Card, b: CardButton) => void;
  /** Seconds: what its times are read against. */ now: number;
};

/** Cards opened, by id: a card that leaves while its write is out and comes back (a write that failed) comes back as it was. */
const OPENED = new Set<string>();

const sAgo = (t: number, now: number) => { const a = ago(t, now); return a === "now" ? "just now" : /^\d/.test(a) ? `${a} ago` : a; };
const at = (s: number, now: number) => whenLabel(new Date(s * 1000).toISOString(), now * 1000);

export function AskCard({ card, place, roomName, vault, busy, error, onAct, now }: AskCardProps) {
  const [open, setOpen] = useState(() => OPENED.has(card.id));
  const id = useId();
  const home = place === "home";
  const ended = card.state !== "open" && card.state !== "later";
  if (ended) return <article className="sh-ask sh-card sh-card-ended" data-card={card.id} data-state={card.state} data-kind={card.kind} data-source={card.source} aria-label={`${card.what}: ${card.ended ?? card.state}`}>
    <span className="sh-card-mark" aria-hidden="true">◇</span><span className="sh-ask-what">{card.what}</span>
    <span className="sh-card-ended-line"> · {card.ended}{card.state === "lapsed" ? (roomName ? `, with #${roomName}` : ", with its room") : ""}</span>
  </article>;
  const buttons = cardButtons(card, { open, roomName, now });
  const toggle = () => setOpen((o) => { if (o) OPENED.delete(card.id); else OPENED.add(card.id); return !o; });
  return <article className={`sh-ask sh-card ${home ? "sh-ask-wants" : "sh-ask-msg"}`} data-card={card.id} data-state={card.state} data-kind={card.kind} data-source={card.source}
    data-open={open || undefined} aria-busy={busy || undefined} aria-labelledby={id}>
    {!home && <div className="sh-ask-meta">{place === "tail" && <b>Uni</b>}<span className="sh-ask-mark" aria-hidden="true">◆</span> wants you · {KIND_WORD[card.kind]}
      {card.tid ? <span className="sh-ask-tid"> · {card.tid}</span> : null}{card.until !== null ? <span className="sh-card-until"> · until {at(card.until, now)}</span> : null}</div>}
    <Line card={card} home={home} open={open} onToggle={toggle} labelId={id} />
    {card.state === "later" && card.later !== null && <p className="sh-card-note" role="note">Put off until {at(card.later, now)}. It comes back then on its own.</p>}
    {open && <Details card={card} roomName={roomName} vault={vault} now={now} />}
    {card.source === "card" && card.room && <SealedCard channel={card.room} reference={card.id} />}
    {card.source === "task" && card.task?.sealedCard && <TaskCardLine card={card} />}
    {buttons.length > 0 && <div className="sh-ask-acts" role="group" aria-label="Answer">
      {buttons.map((b) => <button key={`${b.act}:${b.value}`} type="button" className="sh-ask-btn" data-primary={b.primary || undefined} data-act={b.act}
        disabled={busy && b.act !== "open" && b.act !== "reply" && b.act !== "room"} onClick={() => onAct(card, b)} title={`${b.label}: ${b.does}`}>
        {b.label}{b.act === "open" && <span aria-hidden="true"> ↗</span>}</button>)}
    </div>}
    {open && buttons.length > 0 && <>
      <dl className="sh-ask-does" aria-label="What each button does">
        {legend(card, buttons).map((l) => <div key={l.act} data-act={l.act}><dt>{l.label}</dt><dd>{l.does}</dd></div>)}
      </dl>
      <p className="sh-ask-nochat">No button here starts a new chat or a thread. {roomName ? `Your words go to #${roomName}'s main line.` : "Your words go to its room's main line."}</p>
    </>}
    {error && <p className="sh-ask-error" role="alert">{error}</p>}
  </article>;
}

/** One line per kind of button (a choose ask's options share one). */
function legend(card: Card, buttons: CardButton[]) {
  const picks = buttons.filter((b) => b.act === "pick").length;
  return buttons.filter((b, i, all) => b.act !== "pick" || all.findIndex((x) => x.act === "pick") === i)
    .map((b) => ({ act: b.act, label: b.act === "pick" && picks > 1 ? "An option" : b.label, does: b.does, kind: card.kind }));
}

/**
 * Its words (T-335 copy: text, so a long press selects them). A tap opens it in place, and closes it again; a mouse's click waits out a
 * double-click and a drag-selection opens nothing. The chevron is the control a keyboard and a screen reader use.
 */
function Line({ card, home, open, onToggle, labelId }: { card: Card; home: boolean; open: boolean; onToggle: () => void; labelId: string }) {
  const mouse = useRef(false), wait = useRef(0), box = useRef<HTMLDivElement>(null);
  useEffect(() => () => window.clearTimeout(wait.current), []);
  const picked = () => { const sel = window.getSelection(); return !!sel && !sel.isCollapsed && !!box.current && sel.containsNode(box.current, true); };
  const sub = card.next && card.next !== card.what ? card.next : card.why;
  return <div className="sh-ask-body" ref={box} onPointerDown={(e) => { mouse.current = e.pointerType === "mouse"; }} onClick={(e) => {
    window.clearTimeout(wait.current);
    if (e.detail > 1 || picked() || (e.target as HTMLElement).closest("button")) return;
    if (!mouse.current) { onToggle(); return; }
    wait.current = window.setTimeout(() => { if (!picked()) onToggle(); }, 260);
  }}>
    <span className="sh-ask-what">{home && <><span className="sh-ask-mark" aria-hidden="true">◆ </span><span className="sh-vh">Wants you: </span></>}<span id={labelId}>{card.what}</span>
      <button type="button" className="sh-ask-open sh-ask-chev" data-card-open aria-expanded={open} aria-label={open ? "Show less" : "Open this ask"} aria-describedby={labelId}
        onClick={(e) => { e.stopPropagation(); onToggle(); }}>{open ? " ˅" : " ›"}</button></span>
    {sub && !open && <span className="sh-ask-why">{sub}</span>}
  </div>;
}

/** Opened in place: who asked and when, why now, its next action, its default and its lapse, its link, and its whole context. */
function Details({ card, roomName, vault, now }: { card: Card; roomName: string; vault: string; now: number }) {
  const fallback = card.fallback ? `If you do nothing: ${card.fallback}` : card.kind === "choose" || card.kind === "do" ? "No default: it waits for you" : null;
  return <div className="sh-card-details">
    <dl className="sh-ask-facts">
      <dt>Asked by</dt><dd>{roomName ? `#${roomName}` : "Uni"}{card.at ? ` · ${sAgo(card.at, now)}` : ""}</dd>
      {card.next && card.next !== card.what && <><dt>Next</dt><dd className="sh-ask-next">{card.next}</dd></>}
      {card.why && <><dt>Why now</dt><dd>{card.why}</dd></>}
      {fallback && <><dt>Default</dt><dd>{fallback}</dd></>}
      {card.until !== null && <><dt>Until</dt><dd>{at(card.until, now)}, then it leaves your list on its own</dd></>}
      {card.link && <><dt>Link</dt><dd>{card.link}</dd></>}
    </dl>
    {card.source === "room" && card.context && <div className="sh-ask-context"><Body body={card.context} mentions={[]} me={null} /></div>}
    {card.source === "task" && <TaskContext card={card} vault={vault} />}
  </div>;
}

/** A task's context is its note's body (tasks.py's ## Why, ## Steps, ## Links…), read when the card is opened. */
function TaskContext({ card, vault }: { card: Card; vault: string }) {
  const [read, setRead] = useState<{ body: string | null; error: string | null; loading: boolean }>({ body: null, error: null, loading: true });
  const load = useCallback(() => {
    let gone = false;
    setRead((r) => ({ ...r, error: null, loading: true }));
    invoke<{ note: { content?: string | null } }>("vault_note", { vault, noteRef: card.id })
      .then((d) => { if (!gone) setRead({ body: askBody(d.note?.content), error: null, loading: false }); })
      .catch((e) => { if (!gone) setRead((r) => ({ ...r, error: String(e), loading: false })); });
    return () => { gone = true; };
  }, [vault, card.id]);
  useEffect(load, [load]);
  const fault = !read.loading && !read.error && askFault(card, read.body);
  return <>
    {read.loading && read.body === null && <p className="sh-story-quiet" role="status">Reading its context…</p>}
    {read.error && <p className="sh-story-error" role="alert">Couldn't read its context just now. <button type="button" className="sh-story-retry" onClick={load}>Retry</button></p>}
    {read.body && <div className="sh-ask-context"><Body body={read.body} mentions={[]} me={null} /></div>}
    {fault && <p className="sh-story-quiet sh-ask-fault" role="note">This ask came without its context. You can still answer it or archive it.</p>}
  </>;
}

/** A task that names a card that no longer waits (ended, expired, not on this device): where that card stands (T-335 cards expand). */
function TaskCardLine({ card }: { card: Card }) {
  const ask = { id: card.id, tid: card.tid, what: card.what, room: card.room, sealedCard: card.task?.sealedCard ?? null };
  const state = useAskCard(ask);
  return <CardLine ask={ask} state={state} />;
}
