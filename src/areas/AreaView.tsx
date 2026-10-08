import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { NoteRenderer } from "@openparachute/surface-render";
import AreaFrame from "./AreaFrame";
import { createAreaApi, type RoomMessage } from "./areaApi";
import { findAppRow, type Area, type PathRow } from "./areasCore";
import { AREA_VAULT } from "./useAreas";
import { bodyWithoutTitle } from "../noteText";
import { safeHref } from "../markdown";

const clock = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const getMessages = (channel: string, limit: number) => invoke<RoomMessage[]>("get_messages", { channel, root: null, limit });

export type AreaActions = {
  openRoom(channel: string): void;
  openNote(ref: string): void;
  /** Draft `text` in the room's composer and show the room; never sends. */
  compose(channel: string, text: string): void;
};

export default function AreaView({ area, rows, live, roomName, actions, onBack }: {
  area: Area; rows: PathRow[]; live: boolean; roomName: (id: string) => string; actions: AreaActions; onBack: () => void;
}) {
  const appRow = useMemo(() => findAppRow(rows, area.path), [rows, area.path]);
  const [html, setHtml] = useState<string | null>(null);
  const [appError, setAppError] = useState(false);
  useEffect(() => {
    setHtml(null); setAppError(false);
    if (!live || !appRow) return;
    let on = true;
    invoke<{ note: { content?: string } }>("vault_note", { vault: AREA_VAULT, noteRef: appRow.id })
      .then((d) => { if (on) setHtml(d.note.content ?? ""); }).catch(() => { if (on) setAppError(true); });
    return () => { on = false; };
  }, [live, appRow?.id]);

  const api = useMemo(() => createAreaApi(area, {
    listPaths: () => invoke<PathRow[]>("vault_paths", { vault: AREA_VAULT }),
    getNote: (path) => invoke<{ note: { id: string; path?: string; content?: string; updatedAt?: string } }>("vault_note", { vault: AREA_VAULT, noteRef: path }).then((d) => d.note),
    getMessages,
    compose: actions.compose,
    openNote: actions.openNote,
  }), [area, actions]);

  const header = <header className="area-bar">
    <button className="note-back" onClick={onBack} aria-label="Back to Areas"><span className="note-back-arrow" aria-hidden="true">←</span><span className="note-back-label">Areas</span></button>
    <strong className="area-bar-title">{area.name}</strong>
    <span className={`area-mark ${area.status}`}>{area.status}</span>
  </header>;

  if (live && appRow && html !== null && !appError) return <div className="area-view framed">{header}<AreaFrame html={html} api={api} title={`${area.name} app`} /></div>;
  return <div className="area-view">{header}<DefaultArea area={area} actions={actions} roomName={roomName} pending={live && !!appRow && !appError} /></div>;
}

function DefaultArea({ area, actions, roomName, pending }: { area: Area; actions: AreaActions; roomName: (id: string) => string; pending: boolean }) {
  const [messages, setMessages] = useState<RoomMessage[] | null>(null);
  useEffect(() => {
    let on = true;
    Promise.all(area.channels.map((c) => getMessages(c, 10).catch(() => [] as RoomMessage[])))
      .then((l) => { if (on) setMessages(l.flat().sort((a, b) => b.ts - a.ts).slice(0, 10).reverse()); });
    return () => { on = false; };
  }, [area]);
  const note = useMemo(() => ({ id: area.id, path: area.path, content: bodyWithoutTitle(area.body), tags: ["area"] }), [area]);
  const channel = area.channels[0];
  return <div className="area-scroll"><article className="area-default">
    <h1 className="note-title">{area.title}</h1>
    {pending && <p className="area-quiet">Opening this area's app…</p>}
    <NoteRenderer note={note as never} className="md note-body" linkComponent={({ href, className, children }) => {
      const safe = safeHref(href);
      return safe ? <a href={safe} className={className} rel="noreferrer noopener" onClick={(e) => { e.preventDefault(); void invoke("open_link", { url: safe }).catch(() => {}); }}>{children}</a> : <span className={className}>{children}</span>;
    }} />
    <section className="area-recent" aria-label="Recent messages">
      <h2>Recent in {channel ? roomName(channel) : "room"}</h2>
      {!channel && <p className="area-quiet">No room is linked to this area.</p>}
      {channel && messages === null && <p className="area-quiet">Loading…</p>}
      {messages?.length === 0 && <p className="area-quiet">No messages yet.</p>}
      {messages?.map((m) => <p key={m.ref} className="area-msg"><span><strong>{m.author_name || m.author.slice(0, 8)}</strong><time>{clock(m.ts)}</time></span>{m.body.slice(0, 280)}</p>)}
    </section>
    <div className="area-actions">
      {channel && <button className="pairing-secondary" onClick={() => actions.openRoom(channel)}>Open room</button>}
      <button className="pairing-secondary" onClick={() => actions.openNote(area.path)}>Open note</button>
    </div>
  </article></div>;
}
