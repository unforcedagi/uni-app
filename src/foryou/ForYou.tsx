// For you (0.3.0), the top of the home. It only draws the view forYouCore.ts makes: Yours (what only he can answer, the earliest default
// first, five shown), Ready to look at, Moving (card lines since he last looked; quiet cards counted). Each item: where (tap: the card),
// what (tap: its sheet in its room), why now, one tap = the default with its date, the other options, hold to talk, where it goes.
// States read by shape, never by colour alone (Daylight is greyscale): a filled dot is yours, a half-filled one ready to look at, a ring
// moving, a dash resting; the default is filled, the other options outlined.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRecorder } from "../recorder";
import { transcribe } from "./useForYou";
import type { Answered, CardView, ForYouView, Item, MovingLine, PrivateLine } from "./forYouCore";
import { quietLine } from "../projects/FrontDoor";
import { headWords } from "./scope";
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
};

const Mark = ({ kind }: { kind: "yours" | "look" | "moving" | "rest" }) => <i className="fy-mark" data-mark={kind} aria-hidden="true" />;
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
  return <div className="fy-said">
    <textarea aria-label="Your answer" value={t} rows={Math.min(5, Math.max(2, Math.ceil(t.length / 40)))} onChange={(e) => setT(e.target.value)} />
    <div className="fy-said-row">
      <button type="button" className="fy-send" disabled={!t.trim()} onClick={() => onSend(t)}>Send</button>
      <button type="button" className="fy-opt" onClick={onCancel}>Cancel</button>
      <small>{footer}</small>
    </div>
  </div>;
}

function ItemView({ item, p, onCard }: { item: Item; p: ForYouProps; onCard: (path: string) => void }) {
  const busy = p.busy.has(item.id);
  const go = (text: string) => void p.answer(item, text);
  const card = item.where.cardPath ? p.view.cards.get(item.where.cardPath) ?? null : null;
  return <article className="fy-item" data-id={item.id} data-kind={item.kind} aria-busy={busy || undefined}>
    <div className="fy-head">
      <Mark kind={item.band} />
      {item.where.cardPath ? <button type="button" className="fy-where" onClick={() => onCard(item.where.cardPath!)}>{item.where.label}</button>
        : <span className="fy-where">{item.where.label}</span>}
      {card?.hill && <Hill pos={card.hill.pos} />}
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
    {m.private ? <span className="fy-mv-t">{m.text}</span>
      : <button type="button" className="fy-mv-t" onClick={() => onCard(m.cardPath)}><b>{m.card}</b> · {m.text}</button>}
    <span className="fy-at">{ago(m.at, now)}</span>
  </li>;
}

/** The card: where it stands, the hill, the last lines, and what on it waits for him. A private card: its lines as stored, nothing else. */
function CardSheet({ card, items, p, onClose }: { card: CardView; items: Item[]; p: ForYouProps; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus(); const k = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }; window.addEventListener("keydown", k, true); return () => window.removeEventListener("keydown", k, true); }, [onClose]);
  return <>
    <button type="button" className="fy-scrim" aria-label="Close the card" tabIndex={-1} onClick={onClose} />
    <div className="fy-card" role="dialog" aria-modal="true" aria-label={`${card.name} card`} ref={ref} tabIndex={-1}>
      <div className="fy-card-top"><span className="fy-card-kicker">{card.area ? `${card.area} · card` : "card"}{card.status === "resting" ? " · resting" : ""}</span>
        <button type="button" className="fy-link-btn fy-card-close" onClick={onClose}>Close</button></div>
      <h3 className="fy-card-name">{card.name}</h3>
      {card.stands && <p className="fy-card-stands">{card.stands}{card.standsAt && <small>as of {new Date(card.standsAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}</small>}</p>}
      {card.hill && <p className="fy-card-hill"><Hill pos={card.hill.pos} w={120} h={38} /><span><b>{card.hill.words}.</b>{card.hill.stuck ? " It hasn't moved in a while." : card.hill.pos >= 50 ? " Past figuring out; now making." : " Still figuring it out."}</span></p>}
      {items.length > 0 && <div className="fy-card-asks">{items.map((i) => <ItemView key={i.id} item={i} p={p} onCard={() => {}} />)}</div>}
      {card.lines.length > 0 ? <ul className="fy-card-lines">{card.lines.slice(0, 6).map((l, i) => <li key={i}><span className="fy-at">{l.at ? new Date(l.at).toLocaleDateString(undefined, { month: "numeric", day: "numeric" }) : ""}</span><span>{l.text}</span></li>)}</ul>
        : <p className="fy-none">No sessions on it yet.</p>}
    </div>
  </>;
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
  const [cardOpen, setCardOpen] = useState<string | null>(null);
  const now = Date.now();
  const card = cardOpen ? view.cards.get(cardOpen) ?? null : null;
  const all = [...view.yours, ...view.more, ...view.look];
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
    {card && <CardSheet card={card} items={all.filter((i) => i.where.cardPath === card.path)} p={p} onClose={() => setCardOpen(null)} />}
  </section>;
}
