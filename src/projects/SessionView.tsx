// T-304: one session, zoomed in, in place of the project's session list (Back returns to it). A working session shows a live view: a calm
// list of its steps and what it wrote, newest last, read again every few seconds while it is open (feed.ts). An ended one says why it
// ended in a sentence, then its report in plain words: what it did, what it left (links where they are links) and what it needs; one that
// needs you shows the exact ask and a way to answer it in the area's room (the words go in the composer; nothing is sent for you).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ago, isLive, stateWords, whyWords, type Project, type Session } from "./model";
import { useFeed, type FeedState } from "./feed";
import { answerDraft, askOf, endWords, leftItems, needsYou, redact, type FeedItem } from "./sessionWords";

/** Steps shown at most (the note keeps the last 60). */
const SHOWN = 60;
const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** The steps, newest last, in a box of their own that stays at the newest unless you have scrolled up to read. */
function Steps({ items, live }: { items: readonly FeedItem[]; live: boolean }) {
  const box = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  useLayoutEffect(() => { const b = box.current; if (b && pinned.current) b.scrollTop = b.scrollHeight; }, [items]);
  const shown = items.slice(-SHOWN);
  // keyed by what each line is, not where it sits: when the note drops its oldest line the rest stay put (and aren't read out again)
  const seen = new Map<string, number>();
  const keys = shown.map((it) => { const k = `${it.at ?? "x"}|${it.kind}|${it.text}`; const n = seen.get(k) ?? 0; seen.set(k, n + 1); return `${k}|${n}`; });
  return <ol ref={box} className="sv-steps" aria-label={live ? "What it is doing, newest last" : "What it did, newest last"} aria-live={live ? "polite" : undefined}
    tabIndex={0} onScroll={(e) => { const b = e.currentTarget; pinned.current = b.scrollHeight - b.scrollTop - b.clientHeight < 24; }}>
    {shown.map((it, i) => <li key={keys[i]} className={`sv-${it.kind}`} data-kind={it.kind}>
      {it.at !== null && <time dateTime={new Date(it.at).toISOString()}>{clock(it.at)}</time>}
      <span>{it.text}</span>
    </li>)}
  </ol>;
}

function LiveView({ s, feed, now }: { s: Session; feed: FeedState; now: number }) {
  return <section className="sv-live" aria-label="Live">
    <p className="sv-live-head"><i className="sv-dot" aria-hidden="true" /><span>Live</span>
      {s.steps > 0 && <span>· {s.steps} step{s.steps === 1 ? "" : "s"}</span>}
      {feed.at && <small>{feed.error ? `couldn't read its steps · shown from ${ago(now - feed.at)}` : `read ${ago(now - feed.at)}`}</small>}
    </p>
    {feed.items.length > 0 ? <Steps items={feed.items} live />
      : <p className="pj-hint sv-empty">{!s.feed ? "This session doesn't share its steps yet (it started before they were kept)."
        : !feed.ready ? "Reading its steps…" : feed.error ? "Couldn't read its steps. Trying again in a moment." : "No steps yet. They show here as it works."}</p>}
    <p className="pj-now sv-now"><span>{s.now ? `Now: ${redact(s.now)}` : "Working; it hasn't said on what yet."}</span>{s.nowAt && <small>{ago(now - s.nowAt)}</small>}</p>
  </section>;
}

/** An ended session's steps, read when opened. */
function EndedSteps({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const feed = useFeed(open ? id : null, false);
  return <details className="sv-more" onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary>Its steps{feed.items.length ? ` · ${feed.items.length}` : ""}</summary>
    {feed.items.length ? <Steps items={feed.items} live={false} /> : <p className="pj-hint">{!feed.ready ? "Reading its steps…" : feed.error ? "Couldn't read its steps." : "It kept no steps."}</p>}
  </details>;
}

function Part({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="sv-part" aria-label={title}><h4>{title}</h4>{children}</section>;
}

export function SessionView({ s, all, project, now, roomName, onAnswer, onBack, asked }: { s: Session; all: readonly Session[]; project: Project; now: number;
  /** The area's room, by name, for "Answer in #room" (null: no room to answer in). */ roomName: string | null;
  onAnswer: ((text: string) => void) | null; onBack: () => void; asked: string | null }) {
  const live = isLive(s);
  const feed = useFeed(live ? s.feed : null, true);
  const back = useRef<HTMLButtonElement>(null);
  useEffect(() => { back.current?.focus({ preventScroll: true }); }, [s.id]);
  const why = whyWords(s, all);
  const end = endWords(s, now);
  const left = leftItems(s.end?.left);
  const needs = needsYou(s);
  const did = s.end?.did ? redact(s.end.did) : null;
  const reported = !!(s.end?.did || s.end?.left || s.end?.needs);
  return <section className={`sv pj-session ${s.state}`} aria-label={`Session: ${redact(s.ask)}`} data-place="session-view" data-session={s.id} data-state={s.state}>
    <button ref={back} type="button" className="sv-back" onClick={onBack}><i className="ps-chev" aria-hidden="true" />Sessions</button>
    <p className="pj-state"><i aria-hidden="true" />{stateWords(s, now)}</p>
    <h3 className="sv-ask">{redact(s.ask)}</h3>
    {why && <p className="pj-why">{why}</p>}
    {asked && <p className="pj-asked" role="status">{asked}</p>}
    {live ? <LiveView s={s} feed={feed} now={now} /> : <>
      {end && <div className="sv-end" role="note"><p className="sv-end-head">{end.head}</p>{end.more && <p>{end.more}</p>}</div>}
      {needs && <section className="sv-needs" aria-label="What it needs from you">
        <h4>It needs you</h4>
        <blockquote>{askOf(s)}</blockquote>
        {onAnswer && roomName && <div className="pj-row"><button type="button" className="task-do primary sv-answer" onClick={() => onAnswer(answerDraft(s, project.name))}>Answer in #{roomName.replace(/^#/, "")}</button></div>}
      </section>}
      {did && <Part title="What it did"><p>{did}</p></Part>}
      {left.length > 0 && <Part title="What it left"><ul className="sv-left">{left.map((it, i) => <li key={i}>
        {it.url ? <a className="pj-link" href={it.url} target="_blank" rel="noreferrer">{it.text}</a> : <span>{it.text}</span>}</li>)}</ul></Part>}
      {s.end?.needs && !needs && <Part title="What it needs"><p>{redact(s.end.needs)}</p></Part>}
      {s.end?.checks && <details className="sv-more"><summary>How it checked</summary><p>{redact(s.end.checks)}</p></details>}
      {!reported && <>{s.result && <p className="pj-result">{redact(s.result)}</p>}<p className="pj-hint">Its note has no report (it ended before reports were kept, or it left none).</p></>}
      {s.video && <div className="pj-row"><a className="pj-link" href={s.video} target="_blank" rel="noreferrer">Watch the walkthrough</a></div>}
      {s.feed && <EndedSteps id={s.feed} />}
    </>}
  </section>;
}
