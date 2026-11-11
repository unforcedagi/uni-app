// T-335 the shape: a run's story, as a bottom sheet over the room or home. Its title, how long it has run (or since when it waits on you),
// its steps as a timeline with the current one marked "now", then what it said of itself (the wait, the summary, what is open, what it made).
// The words come from the run note's body (mts writes it) read through `vault_note`, and its steps from the steps note mts keeps beside it.
// No pause: the app has no such action. A modal dialog by the app's one contract (src/areas/focusTrap.ts): focus in, Tab kept inside,
// Escape or the scrim closes, focus goes back to what opened it.
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { openDialog } from "../areas/focusTrap";
import { useFeed } from "../projects/feed";
import { isLive, span, stateWords, waitsOnYou } from "../projects/model";
import { useWork } from "../projects/store";
import { runStory } from "./runsCore";
import type { RoomRun } from "./types";
import "./runs.css";

const clock = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const since = (ms: number, now: number) => {
  const d = new Date(ms), today = new Date(now).toDateString() === d.toDateString();
  return today ? clock(ms) : `${d.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${clock(ms)}`;
};

type Read = { body: string | null; error: string | null; loading: boolean };

export function RunStory({ vault, run, roomName, onClose, onOpenNote }: { vault: string; run: RoomRun; roomName: string; onClose: () => void; onOpenNote: (id: string) => void }) {
  const { work } = useWork();
  const session = work.sessions.find((s) => s.id === run.id);
  const live = session ? isLive(session) : run.state === "moving";
  const feed = useFeed(session?.feed ?? null, live);
  const [read, setRead] = useState<Read>({ body: null, error: null, loading: true });
  const [now, setNow] = useState(() => Date.now());
  const box = useRef<HTMLDivElement>(null), layer = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    let gone = false;
    setRead((r) => ({ ...r, error: null, loading: true }));
    invoke<{ note: { content?: string | null } }>("vault_note", { vault, noteRef: run.id })
      .then((d) => { if (!gone) setRead({ body: d.note?.content ?? "", error: null, loading: false }); })
      .catch((e) => { if (!gone) setRead((r) => ({ ...r, error: String(e), loading: false })); });
    return () => { gone = true; };
  }, [vault, run.id]);
  useEffect(load, [load]);
  // "Running for N min" keeps time while the sheet is open
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t); }, []);
  useEffect(() => {
    if (!box.current) return;
    return openDialog(box.current, onClose, { root: layer.current, initial: box.current.querySelector<HTMLButtonElement>(".sh-story-acts button") });
  }, [onClose]);

  const story = useMemo(() => runStory(read.body ?? "", session, feed.items), [read.body, session, feed.items]);
  const title = session?.ask || run.title || story.title;
  const startMs = session?.startedAt ?? (run.startedAt !== null ? run.startedAt * 1000 : null);
  const where = roomName ? ` · in ${roomName}` : "";
  const sub = live && startMs !== null ? `Running for ${span(now - startMs)}${where}`
    : (session ? waitsOnYou(session) : run.state === "waiting") ? `Waiting on you${(session?.endedAt ?? startMs) ? ` since ${since((session?.endedAt ?? startMs)!, now)}` : ""}${where}`
    : session ? `${stateWords(session, now)}${where}` : where.slice(3);
  const has = (xs: unknown[]) => xs.length > 0;

  return <div className="sh-story-layer" ref={layer}>
    <div className="sh-story-scrim" onClick={onClose} />
    <div className="sh-story" role="dialog" aria-modal="true" aria-labelledby="sh-story-title" ref={box} data-run={run.state}>
      <div className="sh-story-grab" aria-hidden="true" />
      <h2 id="sh-story-title">{title}</h2>
      {sub && <p className="sh-story-sub">{live ? <i className="sh-run-dot" aria-hidden="true" /> : run.state === "waiting" ? <i className="sh-run-needs" aria-hidden="true">◆</i> : null}{sub}</p>}
      {read.loading && read.body === null && <p className="sh-story-quiet" role="status">Reading its story…</p>}
      {read.error && <p className="sh-story-error" role="alert">Couldn't read its story just now. <button type="button" className="sh-story-retry" onClick={load}>Retry</button></p>}
      {story.lead && <p className="sh-story-lead">{story.lead}</p>}
      {has(story.steps) && <ol className="sh-story-steps" aria-label="Steps">
        {story.steps.map((s, i) => <li key={i} className={s.now ? "sh-now" : undefined} aria-current={s.now ? "step" : undefined}>
          <time>{s.now ? "now" : s.at !== null ? clock(s.at * 1000) : ""}</time><p>{s.text}</p></li>)}
      </ol>}
      {story.summary && <p className="sh-story-summary">{story.summary}</p>}
      {has(story.open) && <section className="sh-story-sec"><h3>Open</h3><ul>{story.open.map((t, i) => <li key={i}>{t}</li>)}</ul></section>}
      {has(story.made) && <section className="sh-story-sec"><h3>What it made</h3><ul>{story.made.map((t, i) => <li key={i}>{t}</li>)}</ul></section>}
      <div className="sh-story-acts">
        <button type="button" className="sh-story-btn" onClick={() => onOpenNote(run.id)}>Open the note</button>
        <button type="button" className="sh-story-btn" onClick={onClose}>Close</button>
      </div>
    </div>
  </div>;
}
