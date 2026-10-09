import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { NoteRenderer } from "@openparachute/surface-render";
import { runDecision, type GateMode } from "../interface/selftest/gate";
import InterfaceFrame from "../interface/frame";
import type { Session } from "../interface/session";
import { pushChatMessage } from "../interface/modules/chatPush";
import { ChatSheet, EmptyChat, type AreaRoom } from "./AreaChat";
import { CHAT_WIDTH_KEY, chatMode, clampChatWidth, createSeen, DESKTOP_MIN, parseStoredWidth } from "./areaLayout";
import GrantPrompt from "../interface/grantPrompt";
import SuggestionBar from "../interface/consent";
import { createGrantStore } from "../interface/grants";
import { describeNeeds, grantKey, htmlHash, parseManifest, resolveNeeds } from "../interface/manifest";
import { cleanText } from "../interface/contract";
import { isStarted, markStarted, markStopped } from "./appRun";
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

const desktopQuery = `(min-width: ${DESKTOP_MIN}px)`;
const subscribeDesktop = (f: () => void) => { const mq = window.matchMedia(desktopQuery); mq.addEventListener("change", f); return () => mq.removeEventListener("change", f); };
const isDesktop = () => window.matchMedia(desktopQuery).matches;

export default function AreaView({ area, rows, mode, roomName, actions, room, onBack }: {
  area: Area; rows: PathRow[]; mode: GateMode | "closed"; roomName: (id: string) => string; actions: AreaActions;
  /** The host's real room view for this area's room; null while it opens (or when the area has none). */
  room: AreaRoom | null; onBack: () => void;
}) {
  const appRow = useMemo(() => findAppRow(rows, area.path), [rows, area.path]);
  const live = mode !== "closed";
  const [app, setApp] = useState<AppNote | null>(null);
  const [appError, setAppError] = useState(false);
  const [declined, setDeclined] = useState(false);
  const [menu, setMenu] = useState(false);
  const [keys, setKeys] = useState<{ scope: string; html: string } | null>(null);
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const name = cleanText(area.name);
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
  const grant = useMemo(() => (manifest?.ok ? resolveNeeds(manifest.manifest.needs, ctx) : {}), [manifest, ctx]);
  // The grant is keyed by what the needs RESOLVE to (folder, rooms, area) and by the app's HTML.
  useEffect(() => {
    setKeys(null);
    if (!app || manifest?.ok !== true) return;
    let on = true;
    void Promise.all([grantKey(grant, area.path), htmlHash(app.html)]).then(([scope, html]) => { if (on) setKeys({ scope, html }); });
    return () => { on = false; };
  }, [app, manifest, grant, area.path]);
  const status = app && keys ? grants.status(app.id, keys.scope, keys.html) : "none";
  // Sealed: a changed app runs with a notice until Accept. Approved-code: it does not run; it asks again.
  const decision = runDecision(mode, status, app ? grants.grantedUnder(app.id) : null);
  const granted = decision === "run" || decision === "run-notice";
  const codeChanged = decision === "ask-updated";
  const running = isStarted(area.path);
  // Values that change under a running app (new room names, new action callbacks) must not recreate its session.
  const roomNameRef = useRef(roomName); roomNameRef.current = roomName;
  const actionsRef = useRef(actions); actionsRef.current = actions;
  const roomRef = useRef(room); roomRef.current = room;
  // Where the chat goes: the manifest's hint, else beside the interface on a desktop and a sheet on a phone.
  const desktop = useSyncExternalStore(subscribeDesktop, isDesktop, () => true);
  const layout = chatMode(manifest?.ok ? manifest.manifest.layout.chat : null, desktop);
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const hasRoom = area.channels.length > 0;
  const suggestions = useMemo(() => createSuggestionStore({
    onAccept: (s) => {
      if (s.kind !== "draft") { actionsRef.current.openNote(s.ref); return; }
      // The composer is right there: fill it. Without a visible pane (hidden hint, other room) zoom into the room as before.
      const r = roomRef.current;
      if (r && layoutRef.current !== "hidden" && r.id === s.room) r.compose(s.text); else actionsRef.current.compose(s.room, s.text);
    },
  }), [area.path]);
  const pendingSuggestions = useSyncExternalStore(suggestions.subscribe, () => suggestions.list().length, () => 0);

  // Live messages: with chat.read the interface hears each new message in its room as it arrives.
  const session = useRef<Session | null>(null);
  const grantRef = useRef(grant); grantRef.current = grant;
  const seen = useMemo(() => createSeen(), [area.path]);
  useEffect(() => { seen.reset(); }, [seen, room?.id]);
  useEffect(() => {
    if (!room?.loaded) return;
    for (const m of seen.fresh(room.messages)) if (session.current) pushChatMessage(session.current, grantRef.current, room.id, m);
  }, [seen, room?.loaded, room?.messages, room?.id]);
  const [stoppedNote, setStoppedNote] = useState<string | null>(null);
  const stop = () => { suggestions.clear(); markStopped(area.path); bump(); };
  const takeover = () => { setStoppedNote("This app kept taking the keyboard from the chat while you typed, so it was stopped."); stop(); };
  const revoke = () => { if (!app) return; grants.revoke(app.id); suggestions.clear(); markStopped(area.path); setDeclined(false); bump(); };
  const start = () => { setStoppedNote(null); markStarted(area.path); bump(); };
  const accept = () => { if (app && keys && running) { grants.acknowledge(app.id, keys.html); bump(); } };
  const router = useMemo(() => createRouter([
    createVaultModule({
      listPaths: () => areaPaths.get(),
      getNote: (ref) => invoke<{ note: { id: string } }>("vault_note", { vault: AREA_VAULT, noteRef: ref }).then((d) => d.note),
      search: (query, limit, pathPrefix) => invoke<{ id: string; path: string; snippet: string }[]>("vault_search", { query, limit, mode: "keyword", vault: AREA_VAULT, pathPrefix }),
    }),
    createChatModule({ getMessages, suggest: (s) => suggestions.add(s), roomName: (id) => roomNameRef.current(id) }),
    createNoteModule({ suggest: (s) => suggestions.add(s), resolve: (ref) => invoke<{ note: { id: string; path?: string | null } }>("vault_note", { vault: AREA_VAULT, noteRef: ref }).then((d) => d.note) }),
    createThemeModule({ theme: readHostTheme }),
  ]), [suggestions]);
  const ready = useMemo(() => ({ area: { name: area.name, title: area.title, purpose: area.purpose, status: area.status, since: typeof area.metadata.since === "string" ? area.metadata.since : null } }), [area]);

  const ready_ = live && !!appRow && !!app && !appError && !!keys;
  const framed = ready_ && granted && running;
  const asking = ready_ && !granted && !declined && manifest?.ok === true;
  const idle = ready_ && granted && !running;
  const channel = area.channels[0];
  // A running app has its own hero, so the host bar drops the title (kept for screen readers).
  const header = <header className={`area-bar ${framed ? "chromeless" : ""}`}>
    <button className="note-back" onClick={onBack} aria-label="Back to Areas"><span className="note-back-arrow" aria-hidden="true">←</span><span className="note-back-label">Areas</span></button>
    <strong className={`area-bar-title ${framed ? "sr-only" : ""}`}>{name}</strong>
    {framed && mode === "approved-code" && <span className="area-mode-chip" title="On this device apps can reach the network through WebRTC, so this app is only as safe as its code. You approved this version.">Approved code</span>}
    <span className="area-bar-controls">
      {channel && <button className="pairing-secondary area-zoom" onClick={() => actions.openRoom(channel)} aria-label={`Open #${roomName(channel)} as a full room`}>Open #{roomName(channel)}</button>}
      {framed && <>
        <button type="button" className="pairing-secondary area-menu-toggle" aria-label="App controls" aria-haspopup="true" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>⋯</button>
        <span className={`area-app-actions ${menu ? "open" : ""}`}>
          <button className="pairing-secondary area-stop" onClick={(e) => { if (e.isTrusted) { setMenu(false); stop(); } }}>Stop app</button>
          <button className="pairing-secondary area-revoke" onClick={(e) => { if (e.isTrusted) { setMenu(false); revoke(); } }}>Revoke access</button>
        </span>
      </>}
    </span>
    <span className={`area-mark ${area.status}`}>{area.status}</span>
  </header>;
  const bar = <SuggestionBar store={suggestions} appName={name} roomName={roomName} />;
  const chatShown = layout !== "hidden";
  // The suggestion bar sits directly above the chat composer; with no chat pane it stays above the interface.
  const withChat = (main: ReactNode, above: ReactNode, cls = "") => <div className={`area-view ${cls}`}>{header}
    {decision === "run-notice" && <p className="area-updated" role="status">This app was updated since you allowed it. <button className="pairing-secondary area-accept" onClick={(e) => { if (e.isTrusted) accept(); }}>Accept</button></p>}
    <ChatLayout framed={framed} onTheft={takeover} mode={layout} main={main} aboveMain={chatShown && room ? null : above}
      chat={layout === "side" ? <SideChat labelled={framed} room={room} hasRoom={hasRoom} above={above} label={`Chat in ${channel ? "#" + roomName(channel) : name}`} />
        : layout === "sheet" ? <ChatSheet room={room} hasRoom={hasRoom} above={above} forceOpen={pendingSuggestions} label={`Chat in ${channel ? "#" + roomName(channel) : name}`} /> : null} /></div>;

  if (framed) return withChat(<InterfaceFrame html={app!.html} title={`${name} app`} router={router} grant={grant} ready={ready} onSession={(s) => { session.current = s; }} />, bar, "framed");
  if (asking && manifest?.ok) return withChat(<GrantPrompt name={name} codeChanged={codeChanged && status === "updated"} approvedCode={mode === "approved-code"} lines={describeNeeds(manifest.manifest.needs, ctx, roomName)}
    onAllow={() => { grants.grant(app!.id, keys!.scope, keys!.html, mode === "approved-code" ? "approved-code" : "sealed"); markStarted(area.path); bump(); }} onNotNow={() => setDeclined(true)} />, null);
  return withChat(<DefaultArea area={area} actions={actions} roomName={roomName} pending={live && !!appRow && !appError && !app} showRecent={!chatShown}
    onOpenApp={idle ? start : null} onRevoke={idle ? revoke : null}
    notice={manifest && !manifest.ok ? `This area's app was not opened: ${manifest.error}.` : !running ? stoppedNote : null} />, null);
}

function SideChat({ room, hasRoom, above, label, labelled }: { labelled: boolean; room: AreaRoom | null; hasRoom: boolean; above: ReactNode; label: string }) {
  return <section className="area-chat side" aria-label={label}>{labelled && <p className="pane-label">Chat, drawn by Uni</p>}{room ? room.render(above) : <EmptyChat hasRoom={hasRoom} />}</section>;
}

/** The interface (or the default view) and the chat: side by side with a draggable divider, or a sheet over the bottom. */
function ChatLayout({ mode, main, aboveMain, chat, framed, onTheft }: { framed: boolean; onTheft: () => void; mode: "side" | "sheet" | "hidden"; main: ReactNode; aboveMain: ReactNode; chat: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [cw, setCw] = useState(0);
  const [stored, setStored] = useState<number | undefined>(() => { try { return parseStoredWidth(localStorage.getItem(CHAT_WIDTH_KEY)); } catch { return undefined; } });
  const [drag, setDrag] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current; if (!el) return;
    const measure = () => setCw(el.clientWidth);
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [mode]);
  const width = clampChatWidth(drag ?? stored, cw);
  const persist = (w: number) => { setStored(w); try { localStorage.setItem(CHAT_WIDTH_KEY, String(w)); } catch { /* private storage */ } };
  const widthAt = (clientX: number) => { const r = box.current!.getBoundingClientRect(); return clampChatWidth(r.right - clientX, r.width); };
  const down = (e: ReactPointerEvent<HTMLDivElement>) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag(widthAt(e.clientX)); };
  const move = (e: ReactPointerEvent<HTMLDivElement>) => { if (drag !== null) setDrag(widthAt(e.clientX)); };
  const up = (e: ReactPointerEvent<HTMLDivElement>) => { if (drag === null) return; const w = widthAt(e.clientX); setDrag(null); persist(w); };
  const key = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 80 : 24;
    if (e.key === "ArrowLeft") { e.preventDefault(); persist(clampChatWidth(width + step, cw)); }
    else if (e.key === "ArrowRight") { e.preventDefault(); persist(clampChatWidth(width - step, cw)); }
  };
  // While focus is in the chat composer the interface is inert, so the user cannot land in it by accident.
  // A frame can still focus itself from inside (its script calls window.focus(); no parent-side switch prevents that),
  // and the keys typed meanwhile would be its to read. So the host takes the keyboard back at once, and an app that does it
  // a second time while the user is typing is stopped. A press on the interface, caught by the overlay, hands it the keyboard.
  const [guard, setGuard] = useState(false);
  const inChat = (el: EventTarget | null) => el instanceof Element && !!el.closest(".area-chat.side, .area-chat .sheet-body");
  const guardRef = useRef(false); guardRef.current = guard;
  const lastChat = useRef<HTMLElement | null>(null);
  const onTheftRef = useRef(onTheft); onTheftRef.current = onTheft;
  useEffect(() => {
    if (!guard || !framed) return;
    let retaken = -Infinity, thefts = 0;
    // The frame taking focus blurs the host window. Whether it was the frame or the user leaving the window, the composer
    // is where focus belongs, and refocusing it is harmless either way.
    const back = () => {
      const el = lastChat.current; if (!guardRef.current || !el || !el.isConnected) return;
      const retake = () => { window.focus(); el.focus(); };
      retaken = performance.now(); retake(); setTimeout(() => { if (guardRef.current) retake(); }, 0);
    };
    // Our own refocus came back as a window focus right after the blur: the window never really left, so the frame took it.
    const focused = () => { if (guardRef.current && performance.now() - retaken < 150 && ++thefts >= 2) onTheftRef.current(); };
    window.addEventListener("blur", back);
    window.addEventListener("focus", focused);
    return () => { window.removeEventListener("blur", back); window.removeEventListener("focus", focused); };
  }, [guard, framed]);
  useLayoutEffect(() => {
    const f = box.current?.querySelector("iframe");
    if (f) f.inert = framed && guard;
  });
  const focusIn = (e: ReactFocusEvent<HTMLDivElement>) => { if (inChat(e.target)) { lastChat.current = e.target as HTMLElement; setGuard(true); } };
  const focusOut = (e: ReactFocusEvent<HTMLDivElement>) => {
    if (!inChat(e.target) || inChat(e.relatedTarget)) return;
    // Decide once focus has settled. An inert frame can still focus itself from inside (its script calls focus()):
    // that is theft, not the user, so the keyboard goes straight back to the composer.
    setTimeout(() => {
      const now = document.activeElement;
      if (guardRef.current && now instanceof HTMLIFrameElement && box.current?.contains(now)) { lastChat.current?.focus(); return; }
      // Focus that left with the whole window keeps the guard: the frame must not win it back meanwhile.
      if (inChat(now) || (now === document.body && !document.hasFocus())) return;
      setGuard(false);
    }, 0);
  };
  const lift = (e: ReactPointerEvent<HTMLDivElement>) => {
    const f = e.currentTarget.parentElement?.querySelector("iframe");
    // Drop the guard in this task (the frame is inert until the render lands), then give the frame the keyboard.
    guardRef.current = false; // the press is the user's: the blur that follows must not be undone
    flushSync(() => setGuard(false));
    f?.focus();
    // the press's own default handling (mousedown on what is now under the pointer) can clear that; once it has settled, again
    requestAnimationFrame(() => { if (document.activeElement !== f) f?.focus(); });
  };
  return <div ref={box} className={`area-split mode-${mode} ${drag !== null ? "dragging" : ""}`} style={mode === "side" ? { "--chat-w": `${width}px` } as CSSProperties : undefined} onFocus={focusIn} onBlur={focusOut}>
    <div className="area-main">{framed && mode === "side" && <p className="pane-label">App</p>}{aboveMain}<div className="area-stage" inert={framed && guard}>{main}</div>{framed && guard && <div className="area-catcher" onPointerDown={lift} onMouseDown={(e) => e.preventDefault()} />}</div>
    {mode === "side" && <div className="area-divider" role="separator" aria-orientation="vertical" aria-label="Resize chat" aria-valuenow={width} aria-valuemin={0} aria-valuemax={cw} tabIndex={0}
      onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={() => setDrag(null)} onKeyDown={key} />}
    {chat}
  </div>;
}

function DefaultArea({ area, actions, roomName, pending, notice, showRecent, onOpenApp, onRevoke }: { area: Area; actions: AreaActions; roomName: (id: string) => string; pending: boolean; notice: string | null; showRecent: boolean; onOpenApp: (() => void) | null; onRevoke: (() => void) | null }) {
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
    {showRecent && <section className="area-recent" aria-label="Recent messages">
      <h2>Recent in {channel ? roomName(channel) : "room"}</h2>
      {!channel && <p className="area-quiet">No room is linked to this area.</p>}
      {channel && messages === null && <p className="area-quiet">Loading…</p>}
      {messages?.length === 0 && <p className="area-quiet">No messages yet.</p>}
      {messages?.map((m) => <p key={m.ref} className="area-msg"><span><strong>{m.author_name || m.author.slice(0, 8)}</strong><time>{clock(m.ts)}</time></span>{m.body.slice(0, 280)}</p>)}
    </section>}
    <div className="area-actions">
      {onOpenApp && <button className="suggestion-go area-open-app" onClick={(e) => { if (e.isTrusted) onOpenApp(); }}>Open {cleanText(area.name)} app</button>}
      {onRevoke && <button className="pairing-secondary area-revoke" onClick={(e) => { if (e.isTrusted) onRevoke(); }}>Revoke access</button>}
      <button className="pairing-secondary" onClick={() => actions.openNote(area.path)}>Open note</button>
    </div>
  </article></div>;
}
