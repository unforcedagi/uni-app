import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { NoteRenderer } from "@openparachute/surface-render";
import InterfaceFrame from "../interface/frame";
import GrantPrompt from "../interface/grantPrompt";
import SuggestionBar from "../interface/consent";
import { createGrantStore } from "../interface/grants";
import { describeNeeds, parseManifest, resolveNeeds } from "../interface/manifest";
import { createRouter } from "../interface/router";
import { createSuggestionStore } from "../interface/suggestions";
import { createVaultModule } from "../interface/modules/vault";
import { createChatModule, type RoomMessage } from "../interface/modules/chat";
import { createNoteModule } from "../interface/modules/note";
import { createThemeModule, readHostTheme } from "../interface/modules/theme";
import { findAppRow, type Area, type PathRow } from "./areasCore";
import { AREA_VAULT, areaPaths } from "./useAreas";
import { bodyWithoutTitle } from "../noteText";
import { safeHref } from "../markdown";

const clock = (ts: number) => new Date(ts * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const getMessages = (channel: string, limit: number) => invoke<RoomMessage[]>("get_messages", { channel, root: null, limit });

const grants = createGrantStore();
type AppNote = { id: string; html: string; metadata: unknown };

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
  const [app, setApp] = useState<AppNote | null>(null);
  const [appError, setAppError] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [, setGrantVersion] = useState(0);
  useEffect(() => {
    setApp(null); setAppError(false); setDeclined(false);
    if (!live || !appRow) return;
    let on = true;
    invoke<{ note: { id: string; content?: string; metadata?: unknown } }>("vault_note", { vault: AREA_VAULT, noteRef: appRow.id })
      .then((d) => { if (on) setApp({ id: d.note.id ?? appRow.id, html: d.note.content ?? "", metadata: d.note.metadata }); }).catch(() => { if (on) setAppError(true); });
    return () => { on = false; };
  }, [live, appRow?.id]);

  // What the app asked for (or the default), resolved against this area.
  const ctx = useMemo(() => ({ areaPath: area.path, channels: area.channels }), [area.path, area.channels]);
  const manifest = useMemo(() => (app ? parseManifest(app.metadata, ctx) : null), [app, ctx]);
  const granted = !!app && manifest?.ok === true && grants.isGranted(app.id, manifest.hash);
  const grant = useMemo(() => (manifest?.ok ? resolveNeeds(manifest.manifest.needs, ctx) : {}), [manifest, ctx]);

  const suggestions = useMemo(() => createSuggestionStore({
    onAccept: (s) => { if (s.kind === "draft") actions.compose(s.room, s.text); else actions.openNote(s.ref); },
  }), [actions, area.path]);
  const router = useMemo(() => createRouter([
    createVaultModule({
      listPaths: () => areaPaths.get(),
      getNote: (ref) => invoke<{ note: { id: string } }>("vault_note", { vault: AREA_VAULT, noteRef: ref }).then((d) => d.note),
      search: (query, limit, pathPrefix) => invoke<{ id: string; path: string; snippet: string }[]>("vault_search", { query, limit, mode: "keyword", vault: AREA_VAULT, pathPrefix }),
    }),
    createChatModule({ getMessages, suggest: (s) => suggestions.add(s), roomName }),
    createNoteModule({ suggest: (s) => suggestions.add(s) }),
    createThemeModule({ theme: readHostTheme }),
  ]), [suggestions, roomName]);
  const ready = useMemo(() => ({ area: { name: area.name, title: area.title, purpose: area.purpose, status: area.status, since: typeof area.metadata.since === "string" ? area.metadata.since : null } }), [area]);

  const framed = live && !!appRow && !!app && !appError && granted;
  const asking = live && !!appRow && !!app && !appError && !granted && !declined && manifest?.ok === true;
  // A running app has its own hero, so the host bar drops the title (kept for screen readers).
  const header = <header className={`area-bar ${framed ? "chromeless" : ""}`}>
    <button className="note-back" onClick={onBack} aria-label="Back to Areas"><span className="note-back-arrow" aria-hidden="true">←</span><span className="note-back-label">Areas</span></button>
    <strong className={`area-bar-title ${framed ? "sr-only" : ""}`}>{area.name}</strong>
    <span className={`area-mark ${area.status}`}>{area.status}</span>
  </header>;

  if (framed) return <div className="area-view framed">{header}<SuggestionBar store={suggestions} appName={area.name} roomName={roomName} /><InterfaceFrame html={app!.html} title={`${area.name} app`} router={router} grant={grant} ready={ready} /></div>;
  if (asking && manifest?.ok) return <div className="area-view">{header}<GrantPrompt name={area.name} lines={describeNeeds(manifest.manifest.needs, ctx, roomName)}
    onAllow={() => { grants.grant(app!.id, manifest.hash); setGrantVersion((v) => v + 1); }} onNotNow={() => setDeclined(true)} /></div>;
  return <div className="area-view">{header}<DefaultArea area={area} actions={actions} roomName={roomName} pending={live && !!appRow && !appError && !app}
    notice={manifest && !manifest.ok ? `This area's app was not opened: ${manifest.error}.` : null} /></div>;
}

function DefaultArea({ area, actions, roomName, pending, notice }: { area: Area; actions: AreaActions; roomName: (id: string) => string; pending: boolean; notice: string | null }) {
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
    {notice && <p className="area-quiet" role="status">{notice}</p>}
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
