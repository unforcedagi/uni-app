// T-335 applet contract 2, for an applet built into the app: nothing of it runs until the owner allows its manifest on
// the grant card, and then it gets one thing, the applet port (src/interface/port.ts), which asks the grant before
// every call. The grant is this device's record (src/interface/grants.ts), keyed by what the manifest resolves to
// here, so a manifest that asks for anything else (a new release, another home vault) shows the card again; it ends
// after a year or on Revoke access. `reviewing` (the frame's Access button) shows the same card over the running
// applet, with what was allowed and the way to take it back.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import GrantCard from "../interface/GrantCard";
import { BUILTIN_CODE, builtinSubject, deviceGrants } from "../interface/grants";
import { fingerprint, grantExpiry, grantKey, grantLines, resolveGrant } from "../interface/grant2";
import { createAppletPort, type AppletPort, type PortBackends } from "../interface/port";
import { cleanText } from "../interface/contract";
import type { AppletManifest } from "../interface/applets";
import "./applets.css";

const grants = deviceGrants();

type Flush = { sent?: unknown; error?: unknown; remaining?: unknown; duplicate?: unknown };

/** The shell's side of the port: what runs once the port has said yes. */
function backends(onOpenNote: (vault: string, path: string) => void): PortBackends {
  // The one writer the shell has that queues offline and never doubles a retry is the journal's, and it saves to the journal's own
  // vault (Journal settings), whatever it is asked. So a note is added only when the vault the grant named IS that vault. It is
  // asked from the app core at every write, never from a copy: the setting can change while the applet is open.
  const writable = async (vault: string) => {
    const journal = await invoke<{ vault?: string }>("journal_config").then((c) => c.vault || null, () => null);
    if (journal !== vault) throw new Error(journal ? `Not saved: your journal is kept in the ${journal} vault, and this was allowed for the ${vault} vault.` : "Not saved: the app couldn't tell where your journal is kept.");
  };
  return {
    command: (cmd, args) => invoke(cmd, args),
    // (the vault commands list by tag; a folder alone has no listing here yet)
    query: (vault, q) => (q.type ? invoke<Record<string, unknown>[]>("vault_query", { vault, tag: q.type, includeContent: false, limit: q.limit, offset: q.offset })
      : Promise.reject(new Error("listing a folder without a type isn't built"))),
    note: (vault, ref) => invoke<{ note: Record<string, unknown> }>("vault_note", { vault, noteRef: ref }).then((d) => d.note),
    writable,
    create: async (vault, note, audio, o) => {
      await writable(vault);
      if (!note.path.startsWith("Journal/")) throw new Error("Not saved: the shell can only add journal entries today.");
      const r = await (audio
        ? invoke<Flush>("journal_save_voice", audio.bytes, { headers: { "x-entry": JSON.stringify(note), "x-audio-mime": audio.mime } })
        : invoke<Flush>("journal_save_text", { entry: note, saveAnother: !!o?.saveAnother }));
      // `made` stays empty: the journal's writer reports what a flush sent, which can be another entry that was waiting (a retry
      // of this one queues nothing; the Journal's own flush can send this one first). Until the save command names the note for
      // this entry, nothing is claimed as the applet's own, so an `own` rule lets it add notes and read none back.
      return { result: r, made: [] };
    },
    open: onOpenNote,
  };
}

export function AppletGate({ applet, home, rooms, reviewing, onReviewDone, onAllowed, onOpenNote, children }: {
  /** A built-in on contract 2 (`applet.v2`). */
  applet: AppletManifest;
  /** The owner's own vault on this device. */
  home: string | null;
  rooms: readonly { id: string; name: string }[];
  reviewing: boolean;
  onReviewDone: () => void;
  /** Whether it holds a grant now (the frame shows Access only then: before that there is nothing to review or revoke). */
  onAllowed: (allowed: boolean) => void;
  onOpenNote: (vault: string, path: string) => void;
  children: (port: AppletPort) => ReactNode;
}) {
  const m = applet.v2!;
  // What the manifest resolves to here. Rooms come and go and reorder all day; the grant changes only when its own content does,
  // so it is held by its content (`sig`), and a rooms list that changes nothing the grant names never restarts the applet.
  const fresh = resolveGrant(m, { home, here: null, rooms, author: "shell" });
  const sig = JSON.stringify(fresh);
  const resolved = useMemo(() => fresh, [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  // the key is kept with the grant it was made from: a key for another grant is never read as this one's
  const [keyed, setKeyed] = useState<{ sig: string; key: string } | null>(null);
  const [declined, setDeclined] = useState(false);
  const [, setTick] = useState(0);
  const bump = () => setTick((n) => n + 1);
  useEffect(() => {
    if (!resolved.ok) return;
    let on = true;
    void grantKey(resolved.grant).then((k) => { if (on) setKeyed({ sig, key: k }); });
    return () => { on = false; };
  }, [resolved]); // eslint-disable-line react-hooks/exhaustive-deps
  const key = keyed && keyed.sig === sig ? keyed.key : null;

  const subject = builtinSubject(m.id);
  const allowed = !!key && grants.status(subject, key, BUILTIN_CODE) === "ok";
  const onAllowedRef = useRef(onAllowed); onAllowedRef.current = onAllowed;
  useEffect(() => { onAllowedRef.current(allowed); return () => onAllowedRef.current(false); }, [allowed]);
  // The port asks `live` before every call and again when the shell answers, so after a revoke, an expiry or leaving the screen
  // no new call passes and one in flight gets nothing back.
  // `current` is set while rendering (the applet's own effects run before this component's, and their first calls must pass);
  // `mounted` goes false when the gate leaves the screen.
  const current = useRef<string | null>(null);
  current.current = allowed ? key : null;
  const mounted = useRef(true);
  useLayoutEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const openNoteRef = useRef(onOpenNote); openNoteRef.current = onOpenNote;
  const port = useMemo(() => {
    if (!allowed || !resolved.ok || !key) return null;
    const mine = key;
    return createAppletPort(resolved.grant, backends((v, p) => openNoteRef.current(v, p)), {
      home,
      live: () => mounted.current && current.current === mine && grants.status(subject, mine, BUILTIN_CODE) === "ok",
      onRefused: (r) => console.warn(`[applet ${m.id}] refused (${r.code}): ${r.what}`),
    });
  }, [allowed, resolved, key, home, subject, m.id]);

  // a grant that runs out while the applet is open: the card comes back then, not at the next tap
  const endsAt = allowed ? grants.record(subject)?.expires ?? null : null;
  const [armed, setArmed] = useState(0);
  useEffect(() => {
    const ms = endsAt ? Date.parse(endsAt) - Date.now() : NaN;
    if (!(ms > 0)) return;
    // (a timer can't run a year: it re-arms until the date)
    const t = window.setTimeout(() => setArmed((n) => n + 1), Math.min(ms + 50, 2 ** 31 - 1));
    return () => window.clearTimeout(t);
  }, [endsAt, armed]);

  const roomName = (id: string) => cleanText(rooms.find((r) => r.id === id)?.name.replace(/^#/, "") ?? id);
  if (!resolved.ok) return <div className="sh-ap-calm sh-ap-gate" role="alert"><p className="sh-ap-calm-head">{m.name} can't open</p><p>It was not run: {resolved.error}.</p></div>;
  if (!key) return <div className="sh-ap-calm sh-ap-gate"><p className="sh-ap-calm-head">Opening…</p></div>;
  const lines = grantLines(resolved.grant, roomName);
  const record = grants.record(subject);
  if (!allowed) {
    return declined
      ? <div className="sh-ap-calm sh-ap-gate"><p className="sh-ap-calm-head">{m.name} isn't allowed to run</p>
          <button type="button" className="sh-ap-btn sh-ap-gate-ask" onClick={(e) => { if (e.isTrusted) setDeclined(false); }}>Ask again</button></div>
      : <div className="sh-ap-gate sh-ap-gate-card"><GrantCard name={m.name} glyph={m.glyph} runs="built-in" state="ask" lines={lines} fingerprint={fingerprint(key)} expires={grantExpiry(new Date())}
          onAllow={() => { grants.grant(subject, key, BUILTIN_CODE, "sealed", grantExpiry); bump(); }} onNotNow={() => setDeclined(true)} /></div>;
  }
  return <>
    {reviewing && <div className="sh-ap-gate sh-ap-gate-card"><GrantCard name={m.name} glyph={m.glyph} runs="built-in" state="granted" lines={lines} fingerprint={fingerprint(key)}
      grantedAt={record?.grantedAt} expires={record?.expires}
      onRevoke={() => { grants.revoke(subject); setDeclined(true); onReviewDone(); bump(); }} onDone={onReviewDone} /></div>}
    {/* the applet stays mounted under the card, so a game in play is still there after Done */}
    <div className="sh-ap-gated" hidden={reviewing}>{port && children(port)}</div>
  </>;
}
