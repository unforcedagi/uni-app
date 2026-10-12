import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cleanText } from "../interface/contract";
import type { RoomMessage } from "../interface/modules/chat";
import { groupTasks, type Task } from "./taskCore";
import type { RoomRef } from "./talkCore";
import type { TaskAction, Undo } from "./useTasks";
import { activeProfile, type VaultProfile } from "./profile";

const SHOW = 8;
const HOLD_MS = 220;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** What the host gives the talk bar: the app's own send and voice paths (the durable outbox), nothing else. */
export type Talk = {
  sendText(channel: string, text: string): Promise<void>;
  startVoice(channel: string): Promise<boolean>;
  stopVoice(): void;
  recording: { channel: string; elapsed: number; phase: string } | null;
  /** The last voice note's delivery: "" idle, sending, sent, failed (kept in the outbox and retried). */
  voice: "" | "sending" | "sent" | "failed";
};

/** Hold to talk (a voice note to the level's room), tap to type one line. Names the room it goes to; sends nothing by itself. */
export function TalkBar({ room, talk, label }: { room: RoomRef | null; talk: Talk; label: string }) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const press = useRef<{ timer: ReturnType<typeof setTimeout> | null; started: boolean; released: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [wasVoice, setWasVoice] = useState(false);
  const mine = !!room && talk.recording?.channel === room.id;
  useEffect(() => { if (typing) input.current?.focus(); }, [typing]);
  useEffect(() => { if (!sent) return; const t = setTimeout(() => setSent(null), 6000); return () => clearTimeout(t); }, [sent]);
  useEffect(() => () => { if (press.current?.timer) clearTimeout(press.current.timer); }, []);

  const down = () => {
    if (!room || press.current || talk.recording) return;
    setError(null);
    const p = { timer: null as ReturnType<typeof setTimeout> | null, started: false, released: false };
    press.current = p;
    p.timer = setTimeout(async () => {
      p.timer = null; p.started = true; setWasVoice(true);
      try {
        const ok = await talk.startVoice(room.id);
        if (!ok) setError("Couldn't start recording.");
        else if (p.released) talk.stopVoice();
      } catch (e) { setError(`Microphone unavailable: ${String(e)}`); }
    }, HOLD_MS);
  };
  const up = () => {
    const p = press.current; if (!p) return;
    p.released = true;
    if (p.timer) { clearTimeout(p.timer); p.timer = null; press.current = null; setTyping(true); return; }
    press.current = null;
    if (talk.recording) talk.stopVoice();
  };
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === " " && !e.repeat) { e.preventDefault(); down(); }
    else if (e.key === "Enter") { e.preventDefault(); setTyping(true); }
  };
  const onKeyUp = (e: ReactKeyboardEvent) => { if (e.key === " ") { e.preventDefault(); up(); } };
  const submit = async (e: { preventDefault(): void }) => {
    e.preventDefault();
    const body = text.trim();
    if (!room || !body || busy) return;
    setBusy(true); setError(null);
    try { await talk.sendText(room.id, body); setText(""); setTyping(false); setWasVoice(false); setSent(`Sent to #${room.name}`); }
    catch (err) { setError(`Couldn't send: ${String(err).replace(/^Error:\s*/, "").slice(0, 120)}`); }
    finally { setBusy(false); }
  };
  const voiceLine = wasVoice && !mine && talk.voice === "sending" ? `Sending voice note to #${room?.name}…` : wasVoice && !mine && talk.voice === "sent" ? `Sent to #${room?.name}` : wasVoice && talk.voice === "failed" ? "Voice note not sent yet, it will retry" : null;
  const status = error ?? sent ?? voiceLine;
  const name = room ? `#${room.name}` : "no room";
  return <section className="talk" aria-label={`Talk to ${label}`}>
    <button type="button" className={`talk-hold ${mine ? "recording" : ""}`} disabled={!room} aria-pressed={mine}
      aria-label={mine ? `Recording for ${name}. Release to send.` : `Hold to talk to ${name}. Tap to type a note.`}
      onPointerDown={(e: ReactPointerEvent<HTMLButtonElement>) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture?.(e.pointerId); down(); }}
      onPointerUp={up} onPointerCancel={up} onLostPointerCapture={up} onContextMenu={(e) => e.preventDefault()} onKeyDown={onKey} onKeyUp={onKeyUp}>
      <span className="talk-dot" aria-hidden="true" />
      <span className="talk-text">{mine ? <>Recording {mmss(talk.recording!.elapsed)} · release to send</> : <>Hold to talk</>}<small>{mine ? `to ${name}` : `${room ? `to ${name} · tap to type` : "This level has no room yet"}`}</small></span>
    </button>
    {typing && room && <form className="talk-form" onSubmit={submit}>
      <input ref={input} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} aria-label={`Note to ${name}`} placeholder={`One line to ${name}…`} enterKeyHint="send" disabled={busy} />
      <button type="submit" className="suggestion-go" disabled={busy || !text.trim()}>Send</button>
      <button type="button" className="pairing-secondary" onClick={() => { setTyping(false); setText(""); }}>Cancel</button>
    </form>}
    <p className={`talk-status ${error ? "bad" : ""}`} role={error ? "alert" : "status"} aria-live="polite">{status}</p>
  </section>;
}

/** The last two messages of a room, as text. */
export function RecentMessages({ room, tick }: { room: RoomRef | null; tick: number }) {
  const [list, setList] = useState<{ room: string; messages: RoomMessage[] } | null>(null);
  useEffect(() => {
    if (!room) return;
    let live = true;
    invoke<RoomMessage[]>("get_messages", { channel: room.id, root: null, limit: 2 }).then((m) => { if (live) setList({ room: room.id, messages: m.slice(-2) }); }).catch(() => { if (live) setList({ room: room.id, messages: [] }); });
    return () => { live = false; };
  }, [room?.id, tick]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!room || !list || list.room !== room.id || !list.messages.length) return null;
  return <ul className="talk-recent" aria-label={`Latest in #${room.name}`}>{list.messages.map((m) => <li key={m.ref}><strong>{cleanText(m.author_name || m.author.slice(0, 8))}</strong> <span>{cleanText(m.body).replace(/\s+/g, " ")}</span></li>)}</ul>;
}

export const ownerLabel = (o: string, p: VaultProfile = activeProfile()) => (o === p.me ? p.meLabel : p.roomOwnerPrefix && o.startsWith(p.roomOwnerPrefix) ? `#${o.slice(p.roomOwnerPrefix.length)}` : o.startsWith("person:") ? o.slice(7) : p.agentOwners.includes(o) ? o.charAt(0).toUpperCase() + o.slice(1) : o || "unassigned");
const OWNER = (o: string) => ownerLabel(o);
const dueText = (iso: string | null) => {
  if (!iso) return null;
  const d = new Date(`${iso}T12:00:00`);
  return Number.isNaN(d.getTime()) ? iso : `due ${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
};

function Meta({ t, here, nodeName }: { t: Task; here: string; nodeName: (path: string) => string }) {
  const parts = [t.kind === "decision" ? "Decide" : null, t.waitingOn === activeProfile().me ? "Waiting on you" : t.state === "doing" ? "In progress" : t.state === "waiting" ? "Waiting" : null, dueText(t.due), t.node !== here ? `in ${nodeName(t.node)}` : null].filter(Boolean);
  return parts.length ? <span className="task-meta">{parts.map((p, i) => <span key={i} className={p === "Decide" ? "task-decide" : ""}>{p}</span>)}</span> : null;
}

/** What needs doing at this level and below, grouped You / Rooms / Others, with a one-tap check-off. */
export function TaskList({ tasks, leaving, here, nodeName, loading, ready, error, truncated, treeTruncated, onOpen, onAct, onRetry }: {
  tasks: readonly Task[]; leaving: ReadonlySet<string>; here: string; nodeName: (path: string) => string;
  loading: boolean; ready: boolean; error: string | null; truncated: boolean; treeTruncated?: boolean;
  onOpen: (t: Task) => void; onAct: (t: Task, a: TaskAction) => void; onRetry: () => void;
}) {
  const [all, setAll] = useState<Record<string, boolean>>({});
  const groups = groupTasks(tasks);
  return <section className="work" aria-label="What needs doing here" aria-busy={loading && !ready}>
    <h2 className="work-head">Needs doing<span className="brief-count">{tasks.length}</span></h2>
    {error && <p className="work-error" role="alert">Couldn't load tasks: {error.slice(0, 160)} <button type="button" className="pairing-secondary" onClick={onRetry}>Retry</button></p>}
    {!ready && !error && <p className="area-quiet" role="status">Loading tasks…</p>}
    {ready && !tasks.length && !error && <p className="area-quiet">Nothing open here.</p>}
    {groups.map((g) => {
      const rows = all[g.group] ? g.tasks : g.tasks.slice(0, SHOW);
      return <div className={`work-group g-${g.group}`} key={g.group}>
        <h3>{g.label}<span>{g.tasks.length}</span></h3>
        <ul>{rows.map((t) => <li key={t.id} className={`task-row ${leaving.has(t.id) ? "leaving" : ""} ${t.kind}`}>
          <button type="button" className="task-main" onClick={() => onOpen(t)}>
            <span className="task-title">{cleanText(t.title)}</span>
            <Meta t={t} here={here} nodeName={nodeName} />
          </button>
          <button type="button" className="task-check" aria-label={`${t.kind === "decision" ? "Mark decided" : "Mark done"}: ${cleanText(t.title)}`} onClick={() => onAct(t, "done")}><span aria-hidden="true" /></button>
        </li>)}</ul>
        {g.tasks.length > SHOW && <button type="button" className="work-more" onClick={() => setAll((a) => ({ ...a, [g.group]: !a[g.group] }))}>{all[g.group] ? "Show fewer" : `Show ${g.tasks.length - SHOW} more`}</button>}
      </div>;
    })}
    {truncated && <p className="area-quiet" role="status">Showing the first 200; more may exist.</p>}
    {treeTruncated && <p className="area-quiet" role="status">The tree was cut short at 200 nodes; some areas or projects may be missing.</p>}
  </section>;
}

const who = (id: string | null) => (id ? (/^[0-9a-f-]{32,}$/i.test(id) ? id.slice(0, 8) : id) : null);

/** One task: what it is, who changed it last, and the four things you can do. Text only; the vault's words are never HTML. */
export function TaskSheet({ task, here, nodeName, room, onClose, onAct, onOpenRoom }: {
  task: Task; here: string; nodeName: (path: string) => string; room: RoomRef | null;
  onClose: () => void; onAct: (t: Task, a: TaskAction) => void; onOpenRoom: (id: string) => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const opener = useRef<Element | null>(typeof document === "undefined" ? null : document.activeElement);
  useEffect(() => { box.current?.querySelector<HTMLElement>("button.task-do")?.focus(); const back = opener.current as HTMLElement | null; return () => { if (back?.isConnected) back.focus(); }; }, []);
  const key = (e: ReactKeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); onClose(); }
    if (e.key === "Tab") {
      const f = [...box.current!.querySelectorAll<HTMLElement>("button:not(:disabled)")];
      if (!f.length) return;
      if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
      else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
    }
  };
  const go = (a: TaskAction) => { onAct(task, a); onClose(); };
  const by = who(task.lastUpdatedBy), via = task.lastUpdatedVia;
  return <div className="task-sheet-wrap" onKeyDown={key}>
    <button type="button" className="task-backdrop" aria-label="Close" tabIndex={-1} onClick={onClose} />
    <div ref={box} className="task-sheet" role="dialog" aria-modal="true" aria-labelledby="task-sheet-title">
      <p className="task-kind">{task.kind === "decision" ? "Decision" : "Task"}{task.node !== here ? ` · in ${nodeName(task.node)}` : ""}</p>
      <h2 id="task-sheet-title">{cleanText(task.title)}</h2>
      {task.next && <p className="task-next">{cleanText(task.next)}</p>}
      <dl className="task-facts">
        <dt>Owner</dt><dd>{OWNER(task.owner)}</dd>
        <dt>State</dt><dd>{task.state}{task.waitingOn ? `, waiting on ${task.waitingOn}` : ""}</dd>
        {task.due && <><dt>Due</dt><dd>{task.due}</dd></>}
      </dl>
      {(by || via) && <p className="task-by">Changed by {by ?? "unknown"}{via ? ` via ${via}` : ""}</p>}
      <div className="task-actions">
        <button type="button" className="task-do primary" onClick={() => go("done")}>{task.kind === "decision" ? "Mark decided" : "Mark done"}</button>
        {task.kind === "task" && <button type="button" className="task-do" onClick={() => go("archive")}>Archive</button>}
        <button type="button" className="task-do" onClick={() => go("snooze")}>Snooze until tomorrow</button>
        {room && <button type="button" className="task-do" onClick={() => { onOpenRoom(room.id); onClose(); }}>Open in #{room.name}</button>}
        <button type="button" className="task-do quiet" onClick={onClose}>Close</button>
      </div>
    </div>
  </div>;
}

/** The last action, with five seconds to take it back. */
export function UndoBar({ undo, notice, onDismiss }: { undo: Undo | null; notice: string | null; onDismiss: () => void }) {
  const [busy, setBusy] = useState(false);
  if (!undo && !notice) return null;
  return <div className="undo-bar" role="status" aria-live="polite">
    {notice && <span className="undo-note">{notice}<button type="button" className="undo-x" aria-label="Dismiss" onClick={onDismiss}>×</button></span>}
    {undo && <span className="undo-main">{undo.label}<button type="button" className="undo-go" disabled={busy} onClick={async () => { setBusy(true); try { await undo.run(); } finally { setBusy(false); } }}>Undo</button></span>}
  </div>;
}
