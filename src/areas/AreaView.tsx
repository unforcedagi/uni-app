import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { runDecision, type GateMode } from "../interface/selftest/gate";
import InterfaceFrame from "../interface/frame";
import type { Session } from "../interface/session";
import { pushChatMessage } from "../interface/modules/chatPush";
import type { AreaRoom } from "./AreaChat";
import { createSeen } from "./areaLayout";
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
import { areaPaths } from "./useAreas";
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

export type AppView = { bar: ReactNode; main: ReactNode };

/**
 * An area's sealed app (T-74), shown inside the room shell (r14): the same header, tree and conversation; the app takes the chat's place, like
 * "All of X's work", with "‹ Back to chat". There is no second chat layout: a draft the app suggests goes into the room's own composer.
 */
export default function AreaView({ area, mode, roomName, actions, room, open, onOpen, render }: {
  area: Area; mode: GateMode | "closed"; roomName: (id: string) => string; actions: AreaActions;
  /** The host's room view for this area's room (null while it opens, or when the area has none): live messages reach the app from it. */
  room: AreaRoom | null;
  /** The app is the view now (opened from the room's header); `onOpen(false)` goes back to the chat. */
  open: boolean; onOpen: (v: boolean) => void;
  /** The room shell, given the app's view while it is open (null: the room) and the way to open it (null: this area has no app). */
  render: (app: AppView | null, openApp: ((e: React.MouseEvent) => void) | null) => ReactNode;
}) {
  const profile = useVaultProfile();
  const vaultName = profile.vault;
  const chatOn = profile.chat.provider === "buzz";
  // Uni itself (path "") has no app note to look up.
  const live = mode !== "closed" && area.path !== "";
  const [app, setApp] = useState<AppNote | null>(null);
  const [declined, setDeclined] = useState(false);
  const [menu, setMenu] = useState(false);
  const [keys, setKeys] = useState<{ scope: string; html: string } | null>(null);
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  const name = cleanText(area.name);
  // The app note is looked up by its path, in the background: no vault listing, and the room never waits for it.
  useEffect(() => {
    setApp(null); setDeclined(false);
    if (!live) return;
    let on = true;
    const get = (ref: string) => invoke<{ note: { id: string; extension?: string | null; content?: string; metadata?: unknown } }>("vault_note", { vault: vaultName, noteRef: ref });
    get(`${area.path}/app`).catch(() => get(`${area.path}/app.html`))
      .then((d) => { if (on && (d.note.extension ?? "html").replace(/^\./, "").toLowerCase() === "html") setApp({ id: d.note.id, html: d.note.content ?? "", metadata: d.note.metadata }); }).catch(() => {});
    return () => { on = false; };
  }, [live, area.path, vaultName]);
  const onApp = open && !!app;

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
  const onOpenRef = useRef(onOpen); onOpenRef.current = onOpen;
  const suggestions = useMemo(() => createSuggestionStore({
    onAccept: (s) => {
      if (s.kind !== "draft") { actionsRef.current.openNote(s.ref); return; }
      // The room's own composer: fill it and go back to the chat; another room opens with the draft.
      const r = roomRef.current;
      if (r && r.id === s.room) { r.compose(s.text); onOpenRef.current(false); } else actionsRef.current.compose(s.room, s.text);
    },
  }), [area.path]);

  // Live messages: with chat.read the interface hears each new message in its room as it arrives.
  const session = useRef<Session | null>(null);
  const grantRef = useRef(grant); grantRef.current = grant;
  const seen = useMemo(() => createSeen(), [area.path]);
  useEffect(() => { seen.reset(); }, [seen, room?.id]);
  useEffect(() => {
    if (!room?.loaded) return;
    for (const m of seen.fresh(room.messages)) if (session.current) pushChatMessage(session.current, grantRef.current, room.id, m);
  }, [seen, room?.loaded, room?.messages, room?.id]);
  const stoppedByUser = useRef(false);
  const stop = () => { stoppedByUser.current = true; suggestions.clear(); markStopped(area.path); bump(); };
  const revoke = () => { if (!app) return; grants.revoke(app.id); suggestions.clear(); markStopped(area.path); stoppedByUser.current = true; setDeclined(false); bump(); };
  const start = () => { stoppedByUser.current = false; markStarted(area.path); bump(); };
  // Opening the app is the user's own press: it starts the app unless they stopped it.
  const openApp = app ? (e: React.MouseEvent) => { if (!e.isTrusted) return; onOpen(true); if (!stoppedByUser.current) markStarted(area.path); bump(); } : null;
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
  if (!onApp) return <>{render(null, openApp)}</>;
  const bar = <div className="sr-thread sr-workbar sr-appbar">
    <button type="button" className="sr-thread-back sr-work-back" onClick={() => onOpen(false)}><span aria-hidden="true">‹</span> {chatOn ? "Back to chat" : "Back to the room"}</button>
    <span className="sr-thread-label">{name} app</span>
    {framed && mode === "approved-code" && <span className="area-mode-chip" title="On this device apps can reach the network through WebRTC, so this app is only as safe as its code. You approved this version.">Approved code</span>}
    {framed && <span className="area-bar-controls">
      <button type="button" className="pairing-secondary area-menu-toggle" aria-label="App controls" aria-haspopup="true" aria-expanded={menu} onClick={() => setMenu((v) => !v)}>⋯</button>
      <span className={`area-app-actions ${menu ? "open" : ""}`}>
        <button className="pairing-secondary area-stop" onClick={(e) => { if (e.isTrusted) { setMenu(false); stop(); } }}>Stop app</button>
        <button className="pairing-secondary area-revoke" onClick={(e) => { if (e.isTrusted) { setMenu(false); revoke(); } }}>Revoke access</button>
      </span>
    </span>}
  </div>;
  const stage = framed ? <InterfaceFrame html={app!.html} title={`${name} app`} router={router} grant={grant} ready={ready} onSession={(s) => { session.current = s; }} />
    : asking && manifest?.ok ? <GrantPrompt name={name} codeChanged={codeChanged && status === "updated"} approvedCode={mode === "approved-code"} lines={describeNeeds(manifest.manifest.needs, ctx, roomName)}
      onAllow={() => { grants.grant(app!.id, keys!.scope, keys!.html, mode === "approved-code" ? "approved-code" : "sealed"); markStarted(area.path); bump(); }} onNotNow={() => setDeclined(true)} />
    : <AppPanel area={area} pending={!keys} onOpenApp={idle ? start : null} onRevoke={idle ? revoke : null}
      notice={manifest && !manifest.ok ? `This area's app was not opened: ${manifest.error}.` : null} />;
  const main = <div className={`area-app ${framed ? "framed" : ""}`}>
    {decision === "run-notice" && <p className="area-updated" role="status">This app was updated since you allowed it. <button className="pairing-secondary area-accept" onClick={(e) => { if (e.isTrusted) accept(); }}>Accept</button></p>}
    {framed && <SuggestionBar store={suggestions} appName={name} roomName={roomName} />}
    <div className="area-stage">{stage}</div>
  </div>;
  return <>{render({ bar, main }, openApp)}</>;
}

/** The app view when the app isn't on screen: it is loading, waiting to be opened, or was stopped. */
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
