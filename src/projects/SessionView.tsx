// T-304: one session, zoomed in, in place of the project's session list (Back returns to it). A working session shows a live view: a calm
// list of its steps and what it wrote, newest last, read again every few seconds while it is open (feed.ts). An ended one says why it
// ended in a sentence, then its report in plain words: what it did, what it left (links where they are links) and what it needs; one that
// needs you shows the exact ask and a way to answer it in the area's room (the words go in the composer; nothing is sent for you).
// T-319: the whole session, not its last minutes: "Load earlier steps" (or scrolling to the top of the list) loads the part before.
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ago, isLive, stateWords, whyWords, type Project, type Session } from "./model";
import { hasEarlier, loadEarlier, useFeed, type FeedState } from "./feed";
import { answerDraft, askOf, endWords, leftItems, needsYou, type FeedItem } from "./sessionWords";

const clock = (t: number) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** One line. The lines held before the steps note's own keep their objects across reads, so only the note's lines render again. */
const Line = memo(function Line({ it }: { it: FeedItem }) {
  return <li className={`sv-${it.kind}`} data-kind={it.kind}>
    {it.at !== null && <time dateTime={new Date(it.at).toISOString()}>{clock(it.at)}</time>}
    <span>{it.text}</span>
  </li>;
});

/** The steps, newest last, in a box of their own that stays at the newest unless you have scrolled up to read. Above it, a way to the
 *  session's earlier steps while there are more; loaded, they go in above the ones you were reading, which stay where they were. */
function Steps({ id, feed, live }: { id: string; feed: FeedState; live: boolean }) {
  const items: readonly FeedItem[] = feed.items;
  const box = useRef<HTMLOListElement>(null);
  const pinned = useRef(true);
  /** The list as last laid out: its first line, height and scroll; and whether the next earlier part was asked for by the button. */
  const last = useRef<{ first: number | null; height: number; top: number }>({ first: null, height: 0, top: 0 });
  const asked = useRef(false);
  const more = hasEarlier(feed);
  useLayoutEffect(() => {
    const b = box.current;
    if (!b) return;
    const first = items[0]?.n ?? null, was = last.current;
    if (was.first !== null && first !== null && first < was.first) {
      const added = b.scrollHeight - was.height;
      // asked for with the button: show where the earlier steps meet the ones you had; scrolled to the top: keep your place
      // (never quite the top: that would load the next part by itself)
      b.scrollTop = asked.current ? Math.max(12, added - b.clientHeight / 2) : was.top + added;
      asked.current = false;
      pinned.current = b.scrollHeight - b.scrollTop - b.clientHeight < 24;
    } else if (pinned.current) b.scrollTop = b.scrollHeight;
    last.current = { first, height: b.scrollHeight, top: b.scrollTop };
  }, [items]);
  const earlier = (byButton: boolean) => { if (!more || feed.earlier.loading) return; asked.current = byButton; void loadEarlier(id); };
  // keyed by which line of the session it is (T-319: numbered for good); a note from before T-319 by what each line is, not where it
  // sits: when that note drops its oldest line the rest stay put
  const seen = new Map<string, number>();
  const keys = feed.pages ? items.map((it) => `n${it.n}`)
    : items.map((it) => { const k = `${it.at ?? "x"}|${it.kind}|${it.text}`; const n = seen.get(k) ?? 0; seen.set(k, n + 1); return `${k}|${n}`; });
  const dropped = feed.pages?.dropped ?? 0;
  const newest = items[items.length - 1];
  return <>
    {more ? <p className="sv-earlier"><button type="button" className="task-do" disabled={feed.earlier.loading} onClick={() => earlier(true)}>
        {feed.earlier.loading ? "Loading earlier steps…" : "Load earlier steps"}</button>
        {feed.earlier.error && <small role="status">{feed.earlier.error} Try again.</small>}</p>
      : !feed.held || !feed.pages || feed.held.from === 0 ? (feed.pages?.parts.length && feed.held?.from === 0 ? <p className="pj-hint sv-earlier">From its first step.</p> : null)
      : <p className="pj-hint sv-earlier">{dropped > 0 && feed.held.from <= dropped ? `Its first ${dropped} steps are no longer kept.`
        : feed.earlier.error ?? "Its earlier steps can't be loaded here."}</p>}
    {/* the newest line is read out as it comes (not the earlier ones loaded above) */}
    {live && <p className="sv-sr" aria-live="polite">{newest ? newest.text : ""}</p>}
    <ol ref={box} className="sv-steps" aria-label={live ? "What it is doing, newest last" : "What it did, newest last"}
      tabIndex={0} onScroll={(e) => {
        const b = e.currentTarget;
        pinned.current = b.scrollHeight - b.scrollTop - b.clientHeight < 24;
        last.current.top = b.scrollTop;
        // scrolled to the top: the part before, unless the last try failed (then only the button tries again)
        if (b.scrollTop < 8 && b.scrollHeight > b.clientHeight + 8 && !feed.earlier.error) earlier(false);
      }}>
      {items.map((it, i) => <Line key={keys[i]} it={it} />)}
    </ol>
  </>;
}

function LiveView({ s, feed, now }: { s: Session; feed: FeedState; now: number }) {
  return <section className="sv-live" aria-label="Live">
    <p className="sv-live-head"><i className="sv-dot" aria-hidden="true" /><span>Live</span>
      {s.steps > 0 && <span>· {s.steps} step{s.steps === 1 ? "" : "s"}</span>}
      {feed.at && <small>{feed.error ? `couldn't read its steps · shown from ${ago(now - feed.at)}` : `read ${ago(now - feed.at)}`}</small>}
    </p>
    {feed.items.length > 0 && s.feed ? <Steps id={s.feed} feed={feed} live />
      : <p className="pj-hint sv-empty">{!s.feed ? "This session doesn't share its steps yet (it started before they were kept)."
        : !feed.ready ? "Reading its steps…" : feed.error ? "Couldn't read its steps. Trying again in a moment." : "No steps yet. They show here as it works."}</p>}
    <p className="pj-now sv-now"><span>{s.now ? `Now: ${s.now}` : "Working; it hasn't said on what yet."}</span>{s.nowAt && <small>{ago(now - s.nowAt)}</small>}</p>
  </section>;
}

/** An ended session's steps, read when opened. */
function EndedSteps({ id }: { id: string }) {
  const [open, setOpen] = useState(false);
  const feed = useFeed(open ? id : null, false);
  return <details className="sv-more" onToggle={(e) => setOpen(e.currentTarget.open)}>
    <summary>Its steps{feed.items.length ? ` · ${feed.pages?.total ?? feed.items.length}` : ""}</summary>
    {feed.items.length ? <Steps id={id} feed={feed} live={false} /> : <p className="pj-hint">{!feed.ready ? "Reading its steps…" : feed.error ? "Couldn't read its steps." : "It kept no steps."}</p>}
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
  const did = s.end?.did ?? null;
  const reported = !!(s.end?.did || s.end?.left || s.end?.needs);
  return <section className={`sv pj-session ${s.state}`} aria-label={`Session: ${s.ask}`} data-place="session-view" data-session={s.id} data-state={s.state}>
    <button ref={back} type="button" className="sv-back" onClick={onBack}><i className="ps-chev" aria-hidden="true" />Sessions</button>
    <p className="pj-state"><i aria-hidden="true" />{stateWords(s, now)}</p>
    <h3 className="sv-ask">{s.ask}</h3>
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
      {s.end?.needs && !needs && <Part title="What it needs"><p>{s.end.needs}</p></Part>}
      {s.end?.checks && <details className="sv-more"><summary>How it checked</summary><p>{s.end.checks}</p></details>}
      {!reported && <>{s.result && <p className="pj-result">{s.result}</p>}<p className="pj-hint">Its note has no report (it ended before reports were kept, or it left none).</p></>}
      {s.video && <div className="pj-row"><a className="pj-link" href={s.video} target="_blank" rel="noreferrer">Watch the walkthrough</a></div>}
      {s.feed && <EndedSteps id={s.feed} />}
    </>}
  </section>;
}
