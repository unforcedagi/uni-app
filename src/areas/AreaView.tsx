import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type FocusEvent as ReactFocusEvent, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { runDecision, type GateMode } from "../interface/selftest/gate";
import InterfaceFrame from "../interface/frame";
import type { Session } from "../interface/session";
import { pushChatMessage } from "../interface/modules/chatPush";
import { ChatSheet, EmptyChat, RoomChips, type AreaRoom } from "./AreaChat";
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
import type { Area } from "./areasCore";
import { areaPaths, type AreaBrief } from "./useAreas";
import BriefView from "./BriefView";
import { useVaultProfile } from "./ProfileContext";

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

export default function AreaView({ area, entry, now, channel, onChannel, mode, roomName, actions, room, onBack, backLabel, onConversations, crumbs, stage, slot, work, lead, kids, freshAt, dataStatus, tree, projectError, projectLoading }: {
  projectError?: string | null;
  projectLoading?: boolean;
  area: Area; mode: GateMode | "closed"; roomName: (id: string) => string; actions: AreaActions;
  /** The area's Brief (null: Uni hasn't written one) and the time it is read against. */
  entry: AreaBrief | null; now: number;
  /** The room shown (one of the area's rooms) and the way to pick another. */
  channel: string | null; onChannel: (id: string) => void;
  /** The host's real room view for this area's room; null while it opens (or when the area has none). */
  room: AreaRoom | null;
  /** Up one level (null: this is Uni, the top) and where that goes, by name. */
  onBack: (() => void) | null; backLabel: string;
  /** Uni (the top) only: reach the conversation list where the rail is out of reach (short landscape screens). */
  onConversations?: () => void;
  /** The page around the Brief: breadcrumb, Uni's Today in place of a Brief, the children, the freshness override. */
  crumbs?: ReactNode; stage?: ReactNode; slot?: ReactNode; work?: ReactNode; lead?: ReactNode; kids?: ReactNode; freshAt?: string | null; dataStatus?: ReactNode;
  /** T-111: the tree home's level (map, panel and composer) in place of the Brief page. It brings its own navigation, chat and bar. */
  tree?: ReactNode;
}) {
  const profile = useVaultProfile();
  const vaultName = profile.vault;
  const chatOn = profile.chat.provider === "buzz";
  // Uni itself (path "") has no app note to look up.
  const live = mode !== "closed" && area.path !== "";
  const [app, setApp] = useState<AppNote | null>(null);
  // Brief is the default page; the sealed app (when the area has one) is the "App" tab.
  const [tab, setTab] = useState<"brief" | "app">("brief");
  const [declined, setDeclined] = useState(false);
  const [menu, setMenu] = useState(false);
  const [keys, setKeys] = useState<{ scope: string; html: string } | null>(null);
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const name = cleanText(area.name);
  // The app note is looked up by its path, in the background: no vault listing, and the Brief never waits for it.
  useEffect(() => {
    setApp(null); setDeclined(false);
    if (!live) return;
    let on = true;
    const get = (ref: string) => invoke<{ note: { id: string; extension?: string | null; content?: string; metadata?: unknown } }>("vault_note", { vault: vaultName, noteRef: ref });
    get(`${area.path}/app`).catch(() => get(`${area.path}/app.html`))
      .then((d) => { if (on && (d.note.extension ?? "html").replace(/^\./, "").toLowerCase() === "html") setApp({ id: d.note.id, html: d.note.content ?? "", metadata: d.note.metadata }); }).catch(() => {});
    return () => { on = false; };
  }, [live, area.path, vaultName]);
  const onApp = tab === "app" && !!app;

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
  // The tree home is its own page (room, composer and navigation inside); only the App tab brings the side chat back.
  const treePage = !!tree && !onApp;
  const layout = treePage || !chatOn ? "hidden" : chatMode(onApp && manifest?.ok ? manifest.manifest.layout.chat : null, desktop);
  const layoutRef = useRef(layout); layoutRef.current = layout;
  const hasRoom = area.rooms.length > 0;
  // Ask Uni: a draft in the shown room's composer (the sheet opens on a phone). Never sends.
  const [poke, setPoke] = useState(0);
  const ask = (text: string) => {
    if (!channel) return;
    const r = roomRef.current;
    if (r && layoutRef.current !== "hidden" && r.id === channel) { r.compose(text); setPoke((n) => n + 1); } else actionsRef.current.compose(channel, text);
  };
  const rooms = area.rooms.length > 1 ? <RoomChips channels={area.rooms} selected={channel} roomName={roomName} onPick={onChannel} /> : null;
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
  const stoppedByUser = useRef(false);
  const stop = () => { stoppedByUser.current = true; suggestions.clear(); markStopped(area.path); bump(); };
  const [theftNote, setTheftNote] = useState(false);
  // First theft: say so. With text in the composer (or a repeat) the app is stopped, and the stop is logged.
  const takeover = (stopApp: boolean) => {
    if (!stopApp) { setTheftNote(true); return; }
    console.warn(`uni: focus theft: stopped the app of area "${area.path}" for taking the keyboard from the chat`);
    setTheftNote(false);
    setStoppedNote("This app kept taking the keyboard from the chat while you typed, so it was stopped.");
    stop();
  };
  const revoke = () => { if (!app) return; grants.revoke(app.id); suggestions.clear(); markStopped(area.path); stoppedByUser.current = true; setDeclined(false); bump(); };
  const start = () => { stoppedByUser.current = false; setStoppedNote(null); setTheftNote(false); markStarted(area.path); bump(); };
  // The App tab is the user's own press: it opens the app unless they stopped it (or it was stopped for stealing the keyboard).
  const openAppTab = () => { setTab("app"); if (!stoppedByUser.current) markStarted(area.path); bump(); };
  const accept = () => { if (app && keys && running) { grants.acknowledge(app.id, keys.html); bump(); } };
  const router = useMemo(() => createRouter([
    createVaultModule({
      listPaths: () => areaPaths.get(),
      getNote: (ref) => invoke<{ note: { id: string } }>("vault_note", { vault: vaultName, noteRef: ref }).then((d) => d.note),
      search: (query, limit, pathPrefix) => invoke<{ id: string; path: string; snippet: string }[]>("vault_search", { query, limit, mode: "keyword", vault: vaultName, pathPrefix }),
    }),
    createChatModule({ getMessages: chatOn ? getMessages : async () => [], suggest: (s) => suggestions.add(s), roomName: (id) => roomNameRef.current(id) }),
    createNoteModule({ suggest: (s) => suggestions.add(s), resolve: (ref) => invoke<{ note: { id: string; path?: string | null } }>("vault_note", { vault: vaultName, noteRef: ref }).then((d) => d.note) }),
    createThemeModule({ theme: readHostTheme }),
  ]), [suggestions, vaultName]);
  const ready = useMemo(() => ({ area: { name: area.name, title: area.title, purpose: area.purpose, status: area.status, since: typeof area.metadata.since === "string" ? area.metadata.since : null } }), [area]);

  const ready_ = live && onApp && !!keys;
  const framed = ready_ && granted && running;
  const asking = ready_ && !granted && !declined && manifest?.ok === true;
  const idle = ready_ && granted && !running;
  // A running app has its own hero, so the host bar drops the title (kept for screen readers).
  const header = treePage ? null : <header className={`area-bar ${framed ? "chromeless" : ""}`}>
    {!onBack && onConversations && <button className="note-back area-conversations" onClick={onConversations} aria-label="Back to conversations"><span className="note-back-arrow" aria-hidden="true">←</span><span className="note-back-label">Rooms</span></button>}
    {onBack && <button className="note-back" onClick={onBack} aria-label={`Back to ${backLabel}`}><span className="note-back-arrow" aria-hidden="true">←</span><span className="note-back-label">{backLabel}</span></button>}
    <strong className={`area-bar-title ${framed ? "sr-only" : ""}`}>{name}</strong>
    {framed && mode === "approved-code" && <span className="area-mode-chip" title="On this device apps can reach the network through WebRTC, so this app is only as safe as its code. You approved this version.">Approved code</span>}
    <span className="area-bar-controls">
      {channel && <button className="pairing-secondary area-zoom" onClick={() => actions.openRoom(channel)} title={`Open #${roomName(channel)} as a full room`} aria-label={`Open #${roomName(channel)} as a full room`}>Open room</button>}
      {framed && <>
        <button type="button" className="pairing-secondary area-menu-toggle" aria-label="App controls" aria-haspopup="true" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>⋯</button>
        <span className={`area-app-actions ${menu ? "open" : ""}`}>
          <button className="pairing-secondary area-stop" onClick={(e) => { if (e.isTrusted) { setMenu(false); stop(); } }}>Stop app</button>
          <button className="pairing-secondary area-revoke" onClick={(e) => { if (e.isTrusted) { setMenu(false); revoke(); } }}>Revoke access</button>
        </span>
      </>}
    </span>
    {onBack && <span className={`area-mark ${area.status}`}>{area.kind === "project" ? "project" : area.status}</span>}
  </header>;
  const bar = <SuggestionBar store={suggestions} appName={name} roomName={roomName} />;
  const chatShown = layout !== "hidden";
  // The suggestion bar sits directly above the chat composer; with no chat pane it stays above the interface.
  const tabs = app ? <nav className="area-tabs" role="tablist" aria-label="Area views">
    <button type="button" role="tab" id="area-tab-brief" aria-selected={tab === "brief"} className={tab === "brief" ? "on" : ""} onClick={() => setTab("brief")}>Brief</button>
    <button type="button" role="tab" id="area-tab-app" aria-selected={tab === "app"} className={tab === "app" ? "on" : ""} onClick={(e) => { if (e.isTrusted) openAppTab(); }}>App</button>
  </nav> : null;
  const withChat = (main: ReactNode, above: ReactNode, cls = "") => <div className={`area-view ${cls} ${treePage ? "tree-page" : ""}`}>{header}{tabs}{dataStatus}
    {decision === "run-notice" && <p className="area-updated" role="status">This app was updated since you allowed it. <button className="pairing-secondary area-accept" onClick={(e) => { if (e.isTrusted) accept(); }}>Accept</button></p>}
    {framed && theftNote && <p className="area-updated" role="status">This app took the keyboard from the chat. If it does that again it will be stopped.</p>}
    <ChatLayout framed={framed} onTheft={takeover} mode={layout} main={main} aboveMain={chatShown && room ? null : above}
      chat={layout === "side" ? <SideChat labelled={framed} room={room} hasRoom={hasRoom} above={above} rooms={rooms} label={`Chat in ${channel ? "#" + roomName(channel) : name}`} />
        : layout === "sheet" ? <ChatSheet room={room} hasRoom={hasRoom} above={above} rooms={rooms} forceOpen={pendingSuggestions} poke={poke} label={`Chat in ${channel ? "#" + roomName(channel) : name}`} /> : null} />{area.path === "" && !treePage && chatOn && <p className="area-quiet uni-router-rule">Uni routes from here: area work goes to its room.</p>}</div>;

  if (framed) return withChat(<InterfaceFrame html={app!.html} title={`${name} app`} router={router} grant={grant} ready={ready} onSession={(s) => { session.current = s; }} />, bar, "framed");
  if (asking && manifest?.ok) return withChat(<GrantPrompt name={name} codeChanged={codeChanged && status === "updated"} approvedCode={mode === "approved-code"} lines={describeNeeds(manifest.manifest.needs, ctx, roomName)}
    onAllow={() => { grants.grant(app!.id, keys!.scope, keys!.html, mode === "approved-code" ? "approved-code" : "sealed"); markStarted(area.path); bump(); }} onNotNow={() => setDeclined(true)} />, null);
  if (!onApp) return withChat(tree ?? <BriefView area={area} entry={entry} now={now} canAsk={!!channel} onNote={actions.openNote} onAsk={ask} crumbs={crumbs} stage={stage} slot={slot} work={work} lead={lead} kids={kids} freshAt={freshAt} projectError={projectError} projectLoading={projectLoading} />, null);
  return withChat(<AppPanel area={area} pending={!keys} onOpenApp={idle ? start : null} onRevoke={idle ? revoke : null}
    notice={manifest && !manifest.ok ? `This area's app was not opened: ${manifest.error}.` : !running ? stoppedNote : null} />, null);
}

function SideChat({ room, hasRoom, above, rooms, label, labelled }: { labelled: boolean; room: AreaRoom | null; hasRoom: boolean; above: ReactNode; rooms: ReactNode; label: string }) {
  return <section className="area-chat side" aria-label={label}>{labelled && <p className="pane-label">Chat, drawn by Uni</p>}{rooms}{room ? room.render(above) : <EmptyChat hasRoom={hasRoom} />}</section>;
}

/** The interface (or the default view) and the chat: side by side with a draggable divider, or a sheet over the bottom. */
function ChatLayout({ mode, main, aboveMain, chat, framed, onTheft }: { framed: boolean; onTheft: (stopApp: boolean) => void; mode: "side" | "sheet" | "hidden"; main: ReactNode; aboveMain: ReactNode; chat: ReactNode }) {
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
  const theftRef = useRef<() => void>(() => {});
  const onTheftRef = useRef(onTheft); onTheftRef.current = onTheft;
  useEffect(() => {
    if (!guard || !framed) return;
    let thefts = 0, lastTheft = -Infinity, lastTab = -Infinity;
    // A theft is counted on the blur side: the host's focus has moved and document.activeElement is the iframe. Tabbing out
    // of the document leaves it on the body or a host button, and a blur right after a Tab press is the user's own.
    const theft = () => {
      const now = performance.now();
      if (!guardRef.current || now - lastTab < 200 || now - lastTheft < 100) return;
      lastTheft = now;
      const f = box.current?.querySelector("iframe");
      if (!f || document.activeElement !== f) return;
      const draft = (lastChat.current as HTMLInputElement | HTMLTextAreaElement | null)?.value ?? "";
      thefts++;
      onTheftRef.current(draft.trim() !== "" || thefts >= 2);
    };
    const tab = (e: KeyboardEvent) => { if (e.key === "Tab") lastTab = performance.now(); };
    theftRef.current = theft;
    // The frame taking focus blurs the host window. Whether it was the frame or the user leaving the window, the composer
    // is where focus belongs, and refocusing it is harmless either way.
    const back = () => {
      const el = lastChat.current; if (!guardRef.current || !el || !el.isConnected) return;
      theft();
      const retake = () => { window.focus(); el.focus(); };
      retake(); setTimeout(() => { if (guardRef.current) retake(); }, 0);
    };
    window.addEventListener("blur", back);
    window.addEventListener("keydown", tab, true);
    return () => { window.removeEventListener("blur", back); window.removeEventListener("keydown", tab, true); theftRef.current = () => {}; };
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
      if (guardRef.current && now instanceof HTMLIFrameElement && box.current?.contains(now)) { theftRef.current(); lastChat.current?.focus(); return; }
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

/** The App tab when the app isn't on screen: it is loading, waiting to be opened, or was stopped. */
function AppPanel({ area, pending, notice, onOpenApp, onRevoke }: { area: Area; pending: boolean; notice: string | null; onOpenApp: (() => void) | null; onRevoke: (() => void) | null }) {
  return <div className="area-scroll"><article className="area-default">
    <h1 className="note-title">{area.title}</h1>
    {pending && <p className="area-quiet">Opening this area's app…</p>}
    {notice && <p className="area-quiet" role="status">{notice}</p>}
    <div className="area-actions">
      {onOpenApp && <button className="suggestion-go area-open-app" onClick={(e) => { if (e.isTrusted) onOpenApp(); }}>Open {cleanText(area.name)} app</button>}
      {onRevoke && <button className="pairing-secondary area-revoke" onClick={(e) => { if (e.isTrusted) onRevoke(); }}>Revoke access</button>}
    </div>
  </article></div>;
}
