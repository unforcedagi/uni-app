// T-335 a sealed applet in the drawer: an interface note from the vault, run in the sealed frame on the interface contract
// (src/interface). It was an area's sealed app (T-74, src/areas/AreaView.tsx) and is now an applet of its own, with no area and no room:
// - every scope is explicit (a folder prefix it declares, a room id this device has); the `area` scope is refused with a screen that says
//   why (src/interface/sealedApplet.ts `appletHostNeeds`), never guessed at;
// - the grant is keyed by what the needs resolve to plus the note's path (`grantKey`) and by the HTML's hash: a change re-asks, or (sealed)
//   runs with a host-rendered "updated since you allowed it" line until Accept;
// - the platform gate (the sandbox self-test, src/interface/selftest/gate.ts) and `runDecision` decide as they did for an area's app;
// - nothing starts by itself: a restored tab waits for a tap (src/interface/appRun.ts).
// Its note may be in any vault here; that vault is the only one it reaches, and the card names it. It reads, and (contract 2, folders it
// names) adds and changes notes there through the frame's vault module; it can only suggest opening a note in its folders, or (with
// chat.draft for a named room) a draft for that room's composer.
import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { currentUserAgent, gateMode, platformName, runDecision } from "../interface/selftest/gate";
import { useAppVersion, useWebviewRuntime } from "../interface/selftest/useAppVersion";
import { useStoredSelfTest } from "../interface/selftest/useSelfTest";
import InterfaceFrame from "../interface/frame";
import GrantCard from "../interface/GrantCard";
import SuggestionBar from "../interface/consent";
import { deviceGrants } from "../interface/grants";
import { grantKey, htmlHash } from "../interface/manifest";
import { cleanText, WRITE_CAPS } from "../interface/contract";
import { isStarted, markStarted, markStopped } from "../interface/appRun";
import { createRouter } from "../interface/router";
import { createSuggestionStore } from "../interface/suggestions";
import { createVaultModule } from "../interface/modules/vault";
import { createChatModule, type RoomMessage } from "../interface/modules/chat";
import { createNoteModule } from "../interface/modules/note";
import { createThemeModule, readHostTheme } from "../interface/modules/theme";
import { appletHostNeeds, needsGrant, ownFolder, type SealedEntry } from "../interface/sealedApplet";
import { fingerprint, grantExpiry, grantLines } from "../interface/grant2";
import { bridgePaths } from "../interface/bridgePaths";
import { invalidatePaths } from "../vaultPaths";
import { activeProfile } from "../areas/profile";
import "./sealedApplet.css";

const grants = deviceGrants();
const PLATFORM = platformName(currentUserAgent());
const getMessages = (channel: string, limit: number) => invoke<RoomMessage[]>("get_messages", { channel, root: null, limit });
type AppNote = { id: string; path: string; html: string; metadata: unknown };

/**
 * The tile's tap is the user's own press: it starts the applet's note (App calls this before opening it). Only a real gesture counts: the
 * tile's own click event, trusted (a script's `click()` or dispatched event is not, even while the page still holds the user's activation
 * from an earlier tap), and, where the webview reports it, live user activation. No event, or an untrusted one: the applet opens stopped,
 * with its "Open" button, as a restored tab does.
 */
export function startSealedApplet(noteId: string, tap: { isTrusted: boolean } | null): void {
  if (!tap?.isTrusted) return;
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation;
  if (ua && !ua.isActive) return;
  markStarted(noteId);
}

export function SealedApplet({ id, entry, listed, vault, rooms, onOpenNote, onCompose }: {
  /** The applet's id (the tab's). */
  id: string;
  /** Its note, as the drawer found it; null while the vault hasn't answered or when it is gone. */
  entry: SealedEntry | null;
  /** The drawer's list has been read at least once (null entry then means: no such applet now). */
  listed: boolean;
  vault: string | null;
  /** The rooms this device has: a chat need must name one of them. */
  rooms: readonly { id: string; name: string }[];
  onOpenNote: (ref: string) => void;
  /** Put `text` in that room's composer and show the room; never sends. */
  onCompose: (room: string, text: string) => void;
}) {
  // (as for an area's app: with chat off in this profile, no room is the applet's to read, and chat.recent reads nothing)
  const chatOn = activeProfile().chat.provider === "buzz";
  const version = useAppVersion();
  const runtime = useWebviewRuntime();
  const stored = useStoredSelfTest();
  // Live: a self-test pass (or a revoke) updates an open applet without a remount.
  const mode = useMemo(() => gateMode(PLATFORM, version, stored, currentUserAgent(), undefined, runtime), [version, stored, runtime]);
  const live = mode !== "closed" && !!entry && !!vault;
  // A tile tapped while the gate is closed is no start: once a self-test pass opens it, the applet still waits for a tap (or Allow).
  // (The version and webview are null while they load, which reads as closed too: only a known closed gate stops it.)
  const noteId = entry?.noteId ?? null;
  useEffect(() => { if (mode === "closed" && version !== null && runtime !== null && noteId) markStopped(noteId); }, [mode, version, runtime, noteId]);
  const [app, setApp] = useState<AppNote | null>(null);
  const [found, setFound] = useState<{ state: "loading" | "failed" | "ready" | "absent"; error?: string }>({ state: "loading" });
  const [lookups, setLookups] = useState(0);
  const [declined, setDeclined] = useState(false);
  const [keys, setKeys] = useState<{ scope: string; html: string } | null>(null);
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  // The note is read when the applet opens: its HTML and its metadata as they are now (the drawer's list may be a minute old).
  useEffect(() => {
    setApp(null); setDeclined(false); setFound({ state: "loading" });
    if (!live || !noteId) return;
    let on = true;
    invoke<{ note: { id: string; path?: string | null; extension?: string | null; content?: string; metadata?: unknown } }>("vault_note", { vault, noteRef: noteId })
      .then((d) => {
        if (!on) return;
        if ((d.note.extension ?? "html").replace(/^\./, "").toLowerCase() !== "html") { setFound({ state: "absent", error: "its note is not an HTML note" }); return; }
        setApp({ id: d.note.id, path: d.note.path ?? entry!.path, html: d.note.content ?? "", metadata: d.note.metadata });
        setFound({ state: "ready" });
      }).catch((e) => { if (on) setFound({ state: "failed", error: String(e).replace(/^Error:\s*/, "").slice(0, 160) }); });
    return () => { on = false; };
  }, [live, noteId, vault, lookups]); // eslint-disable-line react-hooks/exhaustive-deps

  const roomIds = useMemo(() => (chatOn ? rooms.map((r) => r.id) : []), [rooms, chatOn]);
  const roomKey = roomIds.join("\n");
  const host = useMemo(() => {
    if (!app) return null;
    const h = appletHostNeeds(app.metadata, roomIds);
    // the note may have been changed into another applet since the drawer listed it
    return h.ok && h.manifest.id !== id ? { ok: false as const, error: "its note now declares another applet" } : h;
  }, [app, roomKey, id]); // eslint-disable-line react-hooks/exhaustive-deps
  const grant = useMemo(() => (host?.ok ? host.resolved : {}), [host]);
  // The grant is keyed by what the needs RESOLVE to plus the note's path, and by the applet's HTML.
  useEffect(() => {
    setKeys(null);
    if (!app || host?.ok !== true) return;
    let on = true;
    // the vault is part of where the note is: the same folder and path in another vault is another grant
    void Promise.all([grantKey(grant, `${vault}:${app.path}`), htmlHash(app.html)]).then(([scope, html]) => { if (on) setKeys({ scope, html }); });
    return () => { on = false; };
  }, [app, host, grant, vault]);
  const status = app && keys ? grants.status(app.id, keys.scope, keys.html) : "none";
  // a grant that runs out while the applet is open: the frame goes and the card comes back then (re-armed, since a timer can't run a year)
  const endsAt = app && status !== "none" ? grants.record(app.id)?.expires ?? null : null;
  const [armed, setArmed] = useState(0);
  useEffect(() => {
    const ms = endsAt ? Date.parse(endsAt) - Date.now() : NaN;
    if (!(ms > 0)) return;
    const t = window.setTimeout(() => setArmed((n) => n + 1), Math.min(ms + 50, 2 ** 31 - 1));
    return () => window.clearTimeout(t);
  }, [endsAt, armed]);
  // Sealed: a changed applet runs with a notice until Accept. Approved-code: it does not run; it asks again.
  const decision = runDecision(mode, status, app ? grants.grantedUnder(app.id) : null);
  const granted = decision === "run" || decision === "run-notice";
  const codeChanged = decision === "ask-updated";
  // started is kept per note, never per applet id: another note that later takes this id needs its own tap
  const running = !!noteId && isStarted(noteId);

  const roomName = (rid: string) => cleanText(rooms.find((r) => r.id === rid)?.name.replace(/^#/, "") ?? rid);
  const roomNameRef = useRef(roomName); roomNameRef.current = roomName;
  const onOpenNoteRef = useRef(onOpenNote); onOpenNoteRef.current = onOpenNote;
  const onComposeRef = useRef(onCompose); onComposeRef.current = onCompose;
  const suggestions = useMemo(() => createSuggestionStore({
    onAccept: (s) => { if (s.kind === "draft") onComposeRef.current(s.room, s.text); else onOpenNoteRef.current(s.ref); },
  }), [id]);
  const router = useMemo(() => !vault ? null : createRouter([
    createVaultModule({
      listPaths: () => bridgePaths(vault),
      getNote: (ref) => invoke<{ note: { id: string } }>("vault_note", { vault, noteRef: ref }).then((d) => d.note),
      search: (query, limit, pathPrefix) => invoke<{ id: string; path: string; snippet: string }[]>("vault_search", { query, limit, mode: "keyword", vault, pathPrefix }),
      // the two writes, asked only for a grant that names them (modules/vault.ts holds every call to its folders)
      // (a write drops the path listings, the frame's and the app's, so the next list shows it)
      create: (path, content) => invoke<{ id: string; path?: string | null; updatedAt?: string | null }>("vault_create", { vault, path, content }).finally(() => invalidatePaths(vault)),
      save: (noteId, content, ifUpdatedAt) => invoke<{ id: string; path?: string | null; updatedAt?: string | null }>("vault_save", { vault, id: noteId, content, ifUpdatedAt, force: false }).finally(() => invalidatePaths(vault)),
    }),
    createChatModule({ getMessages: chatOn ? getMessages : async () => [], suggest: (s) => suggestions.add(s), roomName: (rid) => roomNameRef.current(rid) }),
    createNoteModule({ suggest: (s) => suggestions.add(s), resolve: (ref) => invoke<{ note: { id: string; path?: string | null } }>("vault_note", { vault, noteRef: ref }).then((d) => d.note) }),
    createThemeModule({ theme: readHostTheme }),
  ]), [suggestions, vault, chatOn]);
  // the name the prompt and the bar show is the note's as read now (the one the grant is for), not the drawer's minute-old copy
  const name = cleanText(host?.ok ? host.manifest.name : entry?.manifest.name ?? "");
  const ready = useMemo(() => ({ applet: { id, name } }), [id, name]);

  const stop = () => { suggestions.clear(); if (noteId) markStopped(noteId); bump(); };
  const revoke = () => { if (!app) return; grants.revoke(app.id); suggestions.clear(); if (noteId) markStopped(noteId); setDeclined(false); bump(); };
  const start = () => { if (noteId) markStarted(noteId); bump(); };
  // what the frame suggested belongs to the code that ran: once it isn't running (stopped, changed, refused, gone), it goes
  const framedNow = !!(app && host?.ok && keys && granted && running && router);
  useEffect(() => { if (!framedNow) suggestions.clear(); }, [framedNow, suggestions]);
  const accept = () => { if (app && keys && running) { grants.acknowledge(app.id, keys.html); bump(); } };
  const trusted = (f: () => void) => (e: React.MouseEvent) => { if (e.isTrusted) f(); };

  // ── what shows ──
  if (!entry) return <Calm head={listed ? "This applet isn't in your vault now" : "Looking for this applet…"} />;
  if (!vault) return <Calm head="No vault to read this applet from" />;
  if (mode === "closed") return <Calm head="Applets from your vault are off on this device">
    <p>They run only after the sandbox self-test passes here: Settings, Developer, Run sandbox self-test.</p></Calm>;
  if (found.state === "failed") return <Calm head="Couldn't open this applet" role="status">
    <p>{found.error ?? "The vault couldn't be read"}.</p>
    <button type="button" className="sh-ap-btn sh-sa-retry" onClick={() => setLookups((n) => n + 1)}>Retry</button></Calm>;
  if (found.state === "absent") return <Refused error={found.error ?? "its note is gone"} />;
  if (!app || !host) return <Calm head="Opening…" />;
  if (!host.ok) return <Refused error={host.error} />;
  if (!keys) return <Calm head="Opening…" />;

  const framed = granted && running;
  // it adds or changes notes: the card's closing line says what it still can't, and whether a room's words can reach its notes
  const writes = host.needs.some((n) => (WRITE_CAPS as readonly string[]).includes(n.cap));
  const asking = !granted && !declined;
  return <div className={`sh-sa ${framed ? "framed" : ""}`}>
    {decision === "run-notice" && <p className="sh-sa-updated area-updated" role="status">This applet was updated since you allowed it. <button type="button" className="sh-ap-btn area-accept" onClick={trusted(accept)}>Accept</button></p>}
    {framed && <div className="sh-sa-bar">
      {mode === "approved-code" && <span className="sh-sa-chip area-mode-chip" title="On this device applets can reach the network through WebRTC, so this applet is only as safe as its code. You approved this version.">Approved code</span>}
      <button type="button" className="sh-ap-btn area-stop" onClick={trusted(stop)}>Stop</button>
      <button type="button" className="sh-ap-btn area-revoke" onClick={trusted(revoke)}>Revoke access</button>
    </div>}
    {framed && <SuggestionBar store={suggestions} appName={name} roomName={roomName} />}
    <div className="sh-sa-stage">
      {framed && router ? <InterfaceFrame html={app.html} title={name} router={router} grant={grant} ready={ready} />
        : asking ? <GrantCard name={name} runs={mode === "approved-code" ? "approved-code" : "sealed"} state="ask" codeChanged={codeChanged && status === "updated"}
          changes={writes} copies={writes && host.needs.some((n) => n.cap === "chat.read")}
          lines={grantLines(needsGrant(host.needs, vault, { id, name }), roomName, { ownFolder: ownFolder(app.path) })} fingerprint={fingerprint(keys.scope)} expires={grantExpiry(new Date())}
          onAllow={() => { grants.grant(app.id, keys.scope, keys.html, mode === "approved-code" ? "approved-code" : "sealed", grantExpiry); markStarted(app.id); bump(); }} onNotNow={() => setDeclined(true)} />
        : <Calm head={granted ? `${name} is stopped` : `${name} isn't allowed to run`}>
          <div className="sh-sa-actions">
            <button type="button" className="sh-ap-btn sh-sa-open" onClick={trusted(granted ? start : () => setDeclined(false))}>{granted ? `Open ${name}` : "Ask again"}</button>
            {granted && <button type="button" className="sh-ap-btn area-revoke" onClick={trusted(revoke)}>Revoke access</button>}
          </div>
        </Calm>}
    </div>
  </div>;
}

function Calm({ head, role, children }: { head: string; role?: "status"; children?: React.ReactNode }) {
  return <div className="sh-ap-calm sh-sa-calm" role={role}><p className="sh-ap-calm-head">{head}</p>{children}</div>;
}

/** A manifest the drawer won't run: the reason, in the host's words around the check's. */
function Refused({ error }: { error: string }) {
  return <div className="sh-ap-calm sh-sa-refused" role="alert">
    <p className="sh-ap-calm-head">This applet can't open</p>
    <p>It was not run: {error}.</p>
  </div>;
}
