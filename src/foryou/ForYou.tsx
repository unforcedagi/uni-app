// For you (0.3.0), the top of the home. It only draws the view forYouCore.ts makes: Yours (what only he can answer, the earliest default
// first, five shown), Ready to look at, Moving (card lines since he last looked; quiet cards counted). Each item: where (tap: the card),
// what (tap: its sheet in its room), why now, one tap = the default with its date, the other options, hold to talk, where it goes.
// States read by shape, never by colour alone (Daylight is greyscale): a filled dot is yours, a half-filled one ready to look at, a ring
// moving, a dash resting; the default is filled, the other options outlined.
// 0.3.2: the card is its own panel (CardPanel, below), opened from For you, the stream and an area alike (AreasSurface holds which is open).
import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useRecorder } from "../recorder";
import { transcribe } from "./useForYou";
import { cardItems, cardLines, cardMark, MARK_WORDS, ms, privateAsks, waitsWords, type AreaCard, type Answered, type CardMark, type CardView, type ForYouView, type Item, type MovingLine, type PrivateLine } from "./forYouCore";
import { quietLine } from "../projects/FrontDoor";
import { headWords } from "./scope";
import { dialogOpen, openDialog } from "../areas/focusTrap";
import "./foryou.css";

export type ForYouProps = {
  view: ForYouView;
  answer: (item: Item, text: string) => void | Promise<void>;
  retry: (id: string) => void;
  errors: Record<string, string>;
  busy: ReadonlySet<string>;
  /** The item's own sheet, in its room (snooze, priority, the note): a tap on what it asks. */
  onOpenAsk?: (item: Item) => void;
  /** A private area's line opens that area (its words stay inside it). */
  onOpenPrivate?: (p: PrivateLine) => void;
  /** The tasks couldn't be read: "Couldn't check" with Try again, never "Nothing for you". */
  failed?: (() => void) | null;
  reading?: boolean;
  /** 0.3.2: open a card (by its path): the one card panel, wherever its name was tapped. */
  onCard: (path: string) => void;
};

export const Mark = ({ kind }: { kind: CardMark }) => <i className="fy-mark" data-mark={kind} aria-hidden="true" />;
const MIC = <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="5.5" y="1.5" width="5" height="9" rx="2.5" /><path d="M3 8a5 5 0 0 0 10 0M8 13v2" /></svg>;

/** A small hill: left of the top is figuring out, right is making; the dot is where the card is. */
export function Hill({ pos, w = 34, h = 14 }: { pos: number; w?: number; h?: number }) {
  const x = 2 + (w - 4) * pos / 100, y = h - 2 - (h - 4) * Math.sin(Math.PI * pos / 100);
  return <svg className="fy-hill" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
    <path d={`M2 ${h - 2} Q ${w / 2} ${-h + 6} ${w - 2} ${h - 2}`} fill="none" stroke="currentColor" strokeOpacity=".4" strokeWidth="1.4" />
    <circle cx={x.toFixed(1)} cy={y.toFixed(1)} r="3" fill="currentColor" />
  </svg>;
}

/** "2 h", "35 min", "yesterday": how long ago a line landed. */
function ago(at: string, now: number): string {
  const m = Math.max(0, Math.round((now - Date.parse(at)) / 60_000));
  if (m < 60) return `${Math.max(1, m)} min`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h` : h < 48 ? "yesterday" : `${Math.round(h / 24)} days`;
}

type Talk = { state: "idle" } | { state: "listening" } | { state: "hearing" } | { state: "said"; text: string } | { state: "failed"; why: string };

/** Hold to talk: press and hold, speak, let go; the words come back to read (and fix) before they go. */
function HoldToTalk({ item, onSend, disabled }: { item: Item; onSend: (text: string) => void; disabled: boolean }) {
  const [talk, setTalk] = useState<Talk>({ state: "idle" });
  const live = useRef(true);
  /** Let go before the microphone opened (a quick tap): it stops as soon as it starts. */
  const released = useRef(false);
  useEffect(() => () => { live.current = false; }, []);
  const rec = useRecorder(async (blob, mime) => {
    if (!blob.size) { if (live.current) setTalk({ state: "failed", why: "Nothing was heard. Hold, speak, then let go." }); return; }
    if (live.current) setTalk({ state: "hearing" });
    try {
      const text = await transcribe(blob, mime);
      if (live.current) setTalk(text ? { state: "said", text } : { state: "failed", why: "No words came through. Try again." });
    } catch (e) { if (live.current) setTalk({ state: "failed", why: `Couldn't hear it: ${String(e).replace(/^Error:\s*/, "").slice(0, 100)}` }); }
  }, `for ${item.what}`);
  const down = async (e: React.PointerEvent) => {
    e.preventDefault();
    if (disabled || rec.busy) return;
    released.current = false;
    setTalk({ state: "listening" });
    try {
      if (!(await rec.start(undefined))) { setTalk({ state: "idle" }); return; }
      if (released.current) rec.stop();
    }
    catch (err) { setTalk({ state: "failed", why: `Microphone unavailable: ${String(err).slice(0, 80)}` }); }
  };
  const up = () => { released.current = true; if (rec.recording) rec.stop(); };
  const mic = <button type="button" className="fy-mic" aria-label="Hold to talk" title="Hold to talk" data-on={talk.state === "listening" || undefined} disabled={disabled}
    onPointerDown={(e) => void down(e)} onPointerUp={up} onPointerCancel={up} onPointerLeave={up} onContextMenu={(e) => e.preventDefault()}
    onKeyDown={(e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat && !rec.busy) { e.preventDefault(); void down(e as unknown as React.PointerEvent); } }}
    onKeyUp={(e) => { if (e.key === " " || e.key === "Enter") up(); }}>{MIC}</button>;
  const panel = talk.state === "listening" || talk.state === "hearing" ? <p className="fy-rec" role="status">{talk.state === "listening" ? `Listening… let go to stop · ${item.footer.replace(/^Goes/, "goes")}` : "Writing down what you said…"}</p>
    : talk.state === "failed" ? <p className="fy-rec fy-rec-failed" role="alert">{talk.why} <button type="button" className="fy-link-btn" onClick={() => setTalk({ state: "idle" })}>OK</button></p>
    : talk.state === "said" ? <Said text={talk.text} footer={item.footer} onSend={(t) => { setTalk({ state: "idle" }); onSend(t); }} onCancel={() => setTalk({ state: "idle" })} />
    : null;
  return <>{mic}{panel && <div className="fy-talk">{panel}</div>}</>;
}

/** What he said, to read and fix before it goes. */
function Said({ text, footer, onSend, onCancel }: { text: string; footer: string; onSend: (t: string) => void; onCancel: () => void }) {
  const [t, setT] = useState(text);
  // in the box, Escape only leaves it (the card around it never closes over his words: CardPanel; Send or Cancel decides)
  return <div className="fy-said">
    <textarea aria-label="Your answer" value={t} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); e.currentTarget.blur(); } }} rows={Math.min(5, Math.max(2, Math.ceil(t.length / 40)))} onChange={(e) => setT(e.target.value)} />
    <div className="fy-said-row">
      <button type="button" className="fy-send" disabled={!t.trim()} onClick={() => onSend(t)}>Send</button>
      <button type="button" className="fy-opt" onClick={onCancel}>Cancel</button>
      <small>{footer}</small>
    </div>
  </div>;
}

/** What an item needs to be answered from wherever it is drawn (For you, or the card). */
export type ItemActions = Pick<ForYouProps, "view" | "answer" | "retry" | "errors" | "busy" | "onOpenAsk">;

function ItemView({ item, p, onCard, inCard = false }: { item: Item; p: ItemActions; onCard: ((path: string) => void) | null; inCard?: boolean }) {
  const busy = p.busy.has(item.id);
  const go = (text: string) => void p.answer(item, text);
  const card = item.where.cardPath ? p.view.cards.get(item.where.cardPath) ?? null : null;
  return <article className="fy-item" data-id={item.id} data-kind={item.kind} aria-busy={busy || undefined}>
    <div className="fy-head">
      <Mark kind={item.band} />
      {/* (on its own card, the card is said already: the head says whose it is instead) */}
      {inCard ? <span className="fy-where">{item.band === "look" ? "Ready to look at" : "Yours"}</span>
        : item.where.cardPath && onCard ? <button type="button" className="fy-where" onClick={() => onCard(item.where.cardPath!)}>{item.where.label}</button>
        : <span className="fy-where">{item.where.label}</span>}
      {card?.hill && !inCard && <Hill pos={card.hill.pos} />}
    </div>
    {p.onOpenAsk ? <button type="button" className="fy-what" onClick={() => p.onOpenAsk!(item)}>{item.what}</button> : <p className="fy-what">{item.what}</p>}
    {item.why && <p className="fy-why">{item.why}</p>}
    <div className="fy-acts">
      {item.default && <button type="button" className="fy-default" disabled={busy} onClick={() => go(item.default!.value)} aria-label={`${item.default.label}: the default${item.default.at ? `, which applies then` : ""}. Take it now`}>
        {item.default.label}</button>}
      {item.options.map((o) => <button key={o} type="button" className="fy-opt" disabled={busy} onClick={() => go(o)}>{o}</button>)}
      {item.action && <button type="button" className="fy-opt fy-act" disabled={busy} onClick={() => go(item.action!)}>{item.action}</button>}
      {item.link && <a className="fy-opt fy-open" href={item.link} target="_blank" rel="noreferrer">Open ↗</a>}
      <HoldToTalk item={item} onSend={go} disabled={busy} />
    </div>
    {!item.default && item.band === "yours" && <p className="fy-nodefault">No default: waits for you</p>}
    {p.errors[item.id] && <p className="fy-error" role="alert">{p.errors[item.id]}</p>}
    <p className="fy-goes">{item.footer}</p>
  </article>;
}

function DoneLine({ a, retry }: { a: Answered; retry: (id: string) => void }) {
  return <li className="fy-done" data-post={a.post}>
    <Mark kind="moving" />
    <span className="fy-done-t"><b>{a.what}</b> · “{a.answer}”{a.room ? ` → #${a.room}` : ""}</span>
    {a.post === "failed" ? <span className="fy-done-fail" role="alert">Couldn't post in #{a.room}{a.error ? `: ${a.error}` : ""} <button type="button" className="fy-link-btn" onClick={() => retry(a.id)}>Retry</button></span>
      : a.post === "sending" ? <span className="fy-at">sending…</span>
      : a.post === "none" ? <span className="fy-done-fail" role="alert">Not posted yet: {a.error ?? "no room to post in"} <button type="button" className="fy-link-btn" onClick={() => retry(a.id)}>Retry</button></span>
      : <span className="fy-at">{new Date(a.at).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}</span>}
  </li>;
}

function MovingRow({ m, now, onCard }: { m: MovingLine; now: number; onCard: (path: string) => void }) {
  return <li className="fy-mv">
    <Mark kind="moving" />
    {/* (a private card opens too: it shows only what its note already says, its lines as stored and its count) */}
    {m.private ? <button type="button" className="fy-mv-t" onClick={() => onCard(m.cardPath)}>{m.mine ? `You ${m.text}` : m.text}</button>
      : <button type="button" className="fy-mv-t" onClick={() => onCard(m.cardPath)}><b>{m.card}</b> · {m.mine ? <>You: “{m.text}”</> : m.text}</button>}
    <span className="fy-at">{ago(m.at, now)}</span>
  </li>;
}

function Band({ name, n, children }: { name: string; n?: ReactNode; children: ReactNode }) {
  return <section className="fy-band" aria-label={name}><h2>{name}{n !== undefined && <span className="fy-n">{n}</span>}</h2>{children}</section>;
}

/** Open or folded, kept for the session: a redraw of the home (a key arriving, a scope change) leaves it as he left it; a fresh launch opens folded. */
const openMemory = { open: false };
/** Forget this device's key: the next home opens folded. */
export const forgetForYouFold = () => { openMemory.open = false; };

export function ForYou(p: ForYouProps & { /** The head says this place's name: For you is scoped to it. */ scope?: string | null;
  /** Approvals waiting for his OK (shown over the home): the head counts them, so it never says "Nothing" beside one. */ approvals?: number }) {
  const { view } = p;
  const [more, setMore] = useState(false);
  const [open, setOpenState] = useState(openMemory.open);
  const setOpen = (v: boolean) => { openMemory.open = v; setOpenState(v); };
  const now = Date.now();
  const setCardOpen = p.onCard;
  const yours = more ? [...view.yours, ...view.more] : view.yours;
  const nothing = !view.count && !view.look.length;
  const day = Math.floor((now - new Date(now).getTimezoneOffset() * 60_000) / 86_400_000);
  const head = headWords(view, { failed: !!p.failed, reading: !!p.reading, approvals: p.approvals ?? 0, quiet: quietLine(day) });
  const first = view.yours[0] ?? view.look[0] ?? null;
  // an answer whose post didn't go keeps its Retry in sight, folded or not
  const owed = view.answered.filter((a) => a.post === "failed" || a.post === "none");
  return <section className="fy" aria-label="For you" data-open={open || undefined}>
    {/* folded: one line of counts and the first ask; a tap opens the bands. Calm at first glance, the stream keeps the screen. */}
    <div className="fy-top">
      <button type="button" className="fy-toggle" aria-expanded={open} aria-controls={open ? "fy-bands" : undefined} onClick={() => setOpen(!open)}
        aria-label={`${[head.lead, ...head.rest].join(", ")}${p.scope ? ` in ${p.scope}` : ""}. ${open ? "Fold" : "Open"} For you`}>
        <span className="fy-sum" aria-hidden="true"><b>{head.lead}</b>{head.rest.map((r) => <span key={r}> · {r}</span>)}</span>
        <i className="ps-chev" aria-hidden="true" />
      </button>
      {p.failed && <button type="button" className="fy-link-btn fy-retry" onClick={p.failed}>Try again</button>}
    </div>
    {!open && first && <button type="button" className="fy-first" data-id={first.id} onClick={() => setOpen(true)} aria-label={`${first.what}, ${first.where.label}. Open For you`}>
      <Mark kind={first.band} /><span className="fy-first-t">{first.what}</span><span className="fy-first-w">{first.where.label}</span></button>}
    {!open && owed.length > 0 && <ul className="fy-list fy-owed">{owed.map((a) => <DoneLine key={a.id} a={a} retry={p.retry} />)}</ul>}
    {open && <div id="fy-bands" className="fy-bands">
    {/* what he just answered, first: where it went, and a post that didn't go with its Retry, in sight where he tapped */}
    {view.answered.length > 0 && <Band name="Answered today"><ul className="fy-list">{view.answered.map((a) => <DoneLine key={a.id} a={a} retry={p.retry} />)}</ul></Band>}
    <Band name="Yours" n={view.count || undefined}>
      {p.failed && !view.count ? <p className="fy-none" role="status">Couldn't check what's yours. <button type="button" className="fy-link-btn" onClick={p.failed}>Try again</button></p>
        : p.reading && !view.count ? <p className="fy-none" role="status">Looking for what's yours…</p>
        : nothing ? <p className="fy-none">Nothing for you{p.scope ? ` in ${p.scope}` : ""}. The rooms have it.</p> : null}
      {yours.map((i) => <ItemView key={i.id} item={i} p={p} onCard={setCardOpen} />)}
      {view.privates.map((x) => <button key={x.area} type="button" className="fy-private" onClick={() => p.onOpenPrivate?.(x)}><Mark kind="yours" />{x.area}: {x.count} thing{x.count === 1 ? "" : "s"} for you ›</button>)}
      {view.more.length > 0 && !more && <button type="button" className="fy-more" onClick={() => setMore(true)}>{view.more.length} more</button>}
    </Band>
    {view.look.length > 0 && <Band name="Ready to look at" n={view.look.length}>{view.look.map((i) => <ItemView key={i.id} item={i} p={p} onCard={setCardOpen} />)}</Band>}
    {(view.moving.length > 0 || view.quiet.line) && <Band name="Moving" n={view.moving.length ? `since ${view.since >= now - 86_400_000 + 60_000 ? "you last looked" : "yesterday"}` : undefined}>
      <ul className="fy-list fy-moving">
        {view.moving.slice(0, 8).map((m, i) => <MovingRow key={`${m.cardPath}-${i}`} m={m} now={now} onCard={setCardOpen} />)}
        {view.quiet.line && <li className="fy-quiet"><Mark kind="rest" />{view.quiet.line}</li>}
      </ul>
    </Band>}
    </div>}
  </section>;
}

// ------------------------------------------------------------------ 0.3.2: the card, and an area's cards

/** A wide screen (Daylight, desktop): the card opens beside the list, and the list stays in use; a phone: a sheet from the bottom. */
const WIDE = "(min-width: 760px)";
const onWide = (f: () => void) => { const m = window.matchMedia(WIDE); m.addEventListener("change", f); return () => m.removeEventListener("change", f); };
export const useCardBeside = () => useSyncExternalStore(onWide, () => window.matchMedia(WIDE).matches, () => true);

const LINES_SHOWN = 6;
const lineDate = (at: string | null, now: number) => {
  const t = ms(at);
  if (t === null) return "";
  if (now - t < 60 * 60_000) return "now";
  return new Date(t).toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
};

/**
 * The card: where it stands (and since when), the hill, its last lines (one per session, newest first, his own answers marked), what on it is
 * open for him (answerable right here, as in For you), its threads, and where an answer lands. A private card shows only what its note already
 * says: its lines as stored, its thread topics and how many things wait on him; never a stand, a hill or an ask's words.
 */
export function CardPanel({ card, p, onClose, onThread, beside }: { card: CardView; p: ItemActions; onClose: () => void;
  /** The room thread its answers land in (the card's post), when there is one: opens it. */ onThread?: { label: string; open: () => void } | null;
  /** Beside the list (wide screens), not over it. */ beside: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  const [all, setAll] = useState(false);
  const now = Date.now();
  // over the list (a phone): the app's one dialog contract (focus in and back, Tab kept inside, the rest inert, Escape when it is on top)
  /** His dictated words are up to read in the card: Escape never closes it over them (they would be lost with it); Send or Cancel decides. */
  const holding = () => !!ref.current?.querySelector(".fy-said");
  useEffect(() => (!beside && ref.current && layer.current ? openDialog(ref.current, () => { if (!holding()) closeRef.current(); }, { root: layer.current, initial: ref.current }) : undefined), [beside]);
  // beside the list: the list stays in use, so Escape is the card's only when no dialog is up over it and no field is being typed in; on
  // close, focus goes back to what opened it
  useEffect(() => {
    if (!beside) return;
    const opener = document.activeElement instanceof HTMLElement && !ref.current?.contains(document.activeElement) ? document.activeElement : null;
    const k = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || dialogOpen() || holding()) return;
      const t = e.target instanceof HTMLElement ? e.target : null;
      if (t && !ref.current?.contains(t) && (t.closest("input, textarea, select, [contenteditable=''], [contenteditable='true'], [role='dialog']"))) return;
      e.preventDefault(); e.stopPropagation(); closeRef.current();
    };
    window.addEventListener("keydown", k, true);
    const box = ref.current;
    return () => {
      window.removeEventListener("keydown", k, true);
      const at = document.activeElement;
      if (opener?.isConnected && (!at || at === document.body || !at.isConnected || !!box?.contains(at))) opener.focus({ preventScroll: true });
    };
  }, [beside]);
  // a new card opened in the same panel: its top, its first lines (after the effects above have noted what opened it)
  useEffect(() => { setAll(false); ref.current?.scrollTo?.({ top: 0 }); ref.current?.focus({ preventScroll: true }); }, [card.path]);
  // beside the list, the home makes room for it (the list stays in sight and in use)
  useEffect(() => {
    if (!beside) return;
    document.documentElement.dataset.card = "beside";
    return () => { delete document.documentElement.dataset.card; };
  }, [beside]);
  const mark = cardMark(p.view, card);
  const items = cardItems(p.view, card);
  const lines = cardLines(card, p.view.answered);
  const shown = all ? lines : lines.slice(0, LINES_SHOWN);
  return <div className="fy-card-layer" ref={layer}>
    {!beside && <button type="button" className="fy-scrim" aria-label="Close the card" tabIndex={-1} onClick={onClose} />}
    <div className="fy-card" data-beside={beside || undefined} data-card={card.path} role="dialog" aria-modal={beside ? undefined : true} aria-label={`${card.name} card`} ref={ref} tabIndex={-1}>
      <div className="fy-card-top">
        <span className="fy-card-kicker"><Mark kind={mark} /><span>{card.area ? `${card.area} · card` : "card"}<span className="fy-card-state"> · {MARK_WORDS[mark]}</span></span></span>
        <button type="button" className="fy-link-btn fy-card-close" onClick={onClose}>Close</button></div>
      <h3 className="fy-card-name">{card.name}</h3>
      {card.stands && <p className="fy-card-stands">{card.stands}{ms(card.standsAt) !== null && <small>as of {new Date(ms(card.standsAt)!).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</small>}</p>}
      {card.hill && <p className="fy-card-hill"><Hill pos={card.hill.pos} w={120} h={38} /><span><b>{card.hill.words}.</b>{card.hill.stuck ? " It hasn't moved in a while." : card.hill.pos >= 100 ? "" : card.hill.pos >= 50 ? " Past figuring out; now making." : " Still figuring it out."}</span></p>}
      {lines.length > 0 ? <ul className="fy-card-lines" aria-label="Its last lines, newest first">
        {shown.map((l, i) => <li key={i} data-mine={l.mine || undefined}><span className="fy-at">{lineDate(l.at, now)}</span>
          <span className="fy-card-line">{l.mine && <b className="fy-you">You</b>}{l.mine && !card.private ? `“${l.text}”` : l.text}</span></li>)}
        {lines.length > shown.length && <li className="fy-card-earlier"><button type="button" className="fy-link-btn" onClick={() => setAll(true)}>{lines.length - shown.length} earlier</button></li>}
      </ul> : <p className="fy-none">No sessions on it yet.</p>}
      {card.private ? privateAsks(p.view, card) > 0 && <p className="fy-card-count"><Mark kind="yours" />{waitsWords(privateAsks(p.view, card))}<small>Open its area to answer</small></p>
        : items.length > 0 && <section className="fy-card-asks" aria-label="Open on this card"><h4>Open on this card <span className="fy-n">{items.length}</span></h4>
          {items.map((i) => <ItemView key={i.id} item={i} p={p} onCard={null} inCard />)}</section>}
      {card.threads.length > 0 && <p className="fy-card-threads"><span>Threads</span>{card.threads.map((t) => <i key={t}>{t}</i>)}</p>}
      {onThread && <p className="fy-card-room"><button type="button" className="fy-link-btn" onClick={onThread.open}>{onThread.label} ›</button></p>}
    </div>
  </div>;
}

/** An area's cards (on its stream and in its details): the active ones, each with its mark and hill, and the resting ones folded under one line. */
export function AreaCardList({ name, cards, onCard, compact = false }: { name: string; cards: { active: AreaCard[]; resting: AreaCard[] }; onCard: (path: string) => void;
  /** One row (the area's stream): names only; otherwise each card's stand too. */ compact?: boolean }) {
  const [rest, setRest] = useState(false);
  if (!cards.active.length && !cards.resting.length) return null;
  const row = ({ card, mark }: AreaCard) => <li key={card.path}><button type="button" className="fy-ac" data-card={card.path} data-mark={mark} onClick={() => onCard(card.path)}
    aria-label={`${card.name}, ${MARK_WORDS[mark]}. Open the card`}>
    <Mark kind={mark} /><span className="fy-ac-name">{card.name}</span>{!compact && card.hill && <Hill pos={card.hill.pos} />}
    {!compact && card.stands && <span className="fy-ac-stands">{card.stands}</span>}</button></li>;
  return <section className={`fy-acs${compact ? " fy-acs-row" : ""}`} aria-label={`${name}'s cards`}>
    {!compact && <h3 className="cp-h">Cards</h3>}
    <ul>
      {cards.active.map(row)}
      {cards.resting.length > 0 && (rest ? cards.resting.map(row)
        : <li><button type="button" className="fy-ac fy-ac-rest" aria-expanded={false} onClick={() => setRest(true)}><Mark kind="rest" /><span className="fy-ac-name">{cards.resting.length} resting</span></button></li>)}
    </ul>
  </section>;
}
