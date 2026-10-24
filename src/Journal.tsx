import { SettingsIcon, MicIcon } from "./Icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useRecorder } from "./recorder";
import { areaRooms, entryText, greeting, mmss, newDraft, sameWordsLine, type FlushReport, type JournalDraft, type JournalNote, type QueuedEntry, type SameWords } from "./journalCore";
import { forgetPublishOrigins } from "./PublishedPlayer";

type Room = { id: string; name: string; dm?: boolean | null };
type VaultConfig = { hub: string; vault: string };
/** Post `note` to a room, addressed to its Uni; `toUni`: the room is #Uni, so Uni must be there. Resolves when accepted. */
export type ShareFn = (note: JournalNote, roomId: string, toUni: boolean, vault: string, hub: string) => Promise<void>;

const PAGE = 30;

const DRAFT_KEY = "uni.journal.draft";

function when(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function Journal({ rooms, uniRoomId, onShare, onBack, backTo = "Uni", onRecordingChange, focus, onFocus }: { focus: boolean; onFocus: () => void; rooms: Room[]; uniRoomId: string | null; onShare: ShareFn; onBack: () => void; /** r22: the place Back returns to */ backTo?: string; onRecordingChange?: (recording: boolean, elapsed: number, stop: () => void) => void }) {
  const [cfg, setCfg] = useState<VaultConfig | null>(null);
  const [entries, setEntries] = useState<JournalNote[]>([]);
  const [queued, setQueued] = useState<QueuedEntry[]>([]);
  // The draft outlives the Journal screen: leaving to answer a message, or the
  // app being closed, must never lose what you were writing.
  const [text, setText] = useState(() => localStorage.getItem(DRAFT_KEY) ?? "");
  /** The composer's words as of now, and a count of every change to them: a save that returns later checks it is still the words it was sent with. */
  const live = useRef({ text, rev: 0 });
  function edit(next: string) {
    live.current = { text: next, rev: live.current.rev + 1 };
    setText(next);
  }
  /** Empty the composer, but only if it still holds the words that were submitted at `rev`; anything typed since stays. */
  function clearIf(rev: number, submitted: string) {
    if (live.current.rev !== rev) return false;
    live.current = { text: "", rev: rev + 1 };
    setText("");
    // the Journal screen may have closed while the save was out: its draft must not come back as unsent words
    if (!alive.current && localStorage.getItem(DRAFT_KEY) === submitted) localStorage.removeItem(DRAFT_KEY);
    return true;
  }
  useEffect(() => {
    if (text) localStorage.setItem(DRAFT_KEY, text); else localStorage.removeItem(DRAFT_KEY);
  }, [text]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(true);
  const [shareFor, setShareFor] = useState<string | null>(null);
  /** r21 (Codex 6): the entry whose one menu is open. */
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** The rooms each entry was sent to, in order. */
  const [shared, setShared] = useState<Record<string, { id: string; name: string }[]>>({});
  /** T-263: the entry (its device entry id) just saved, offered to the area rooms until dismissed or the next save. */
  const [offer, setOffer] = useState<string | null>(null);
  /** `note id room id` pairs on their way (the ref also holds back a second tap before the re-render). */
  const [sending, setSending] = useState<Record<string, true>>({});
  const inFlight = useRef(new Set<string>());
  // without a hub there is no link, and a room must never get the entry's words instead
  const areas = cfg?.hub ? areaRooms(rooms, uniRoomId) : [];
  const [settings, setSettings] = useState(false);
  /** The entry the same words were already saved as (a duplicate save shows it instead of adding one). */
  const [again, setAgain] = useState<string | null>(null);
  /** The new words match this entry: nothing is saved until "Save another" or "Keep one". */
  const [same, setSame] = useState<SameWords | null>(null);
  /** The words (revision) the "Same words" question was raised for. */
  const sameFor = useRef<number | null>(null);
  /** This composer send: its ids stay the same when it is retried, so the outbox knows a retry from new words. */
  const send = useRef<{ body: string; draft: JournalDraft } | null>(null);
  const watching = useRef(new Set<string>());
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const loadQueue = useCallback(async () => {
    try { setQueued(await invoke<QueuedEntry[]>("journal_pending")); } catch { /* store not ready */ }
  }, []);

  const load = useCallback(async (append = false) => {
    setLoading(true);
    try {
      const page = await invoke<JournalNote[]>("journal_list", { limit: PAGE, offset: append ? entries.length : 0 });
      setEntries((old) => {
        const base = append ? old : [];
        const seen = new Set(base.map((e) => e.id));
        return [...base, ...page.filter((e) => !seen.has(e.id))];
      });
      setMore(page.length === PAGE);
      setError(null);
    } catch (e) { setError(`Couldn't load the journal: ${e}`); }
    finally { setLoading(false); }
  }, [entries.length]);

  // Watch a voice entry until its transcript lands (the vault replaces the placeholder).
  const watch = useCallback((id: string) => {
    if (watching.current.has(id)) return;
    watching.current.add(id);
    let tries = 0;
    const tick = async () => {
      // Journal closed: stop polling (it restarts for pending entries on reopen).
      if (!alive.current) { watching.current.delete(id); return; }
      tries++;
      try {
        const e = await invoke<JournalNote>("journal_entry", { id });
        if (!alive.current) { watching.current.delete(id); return; }
        setEntries((old) => old.some((x) => x.id === id) ? old.map((x) => x.id === id ? e : x) : [e, ...old]);
        if (!e.pending) { watching.current.delete(id); return; }
      } catch { /* retry */ }
      if (tries < 60) setTimeout(tick, 3000); else watching.current.delete(id);
    };
    setTimeout(tick, 2000);
  }, []);

  const afterFlush = useCallback(async (r: FlushReport, what: string, rev?: number) => {
    // what was sent is in the list before it leaves the queue, so a sent entry never blinks out of view
    if (r.sent.length) await load(false);
    await loadQueue();
    if (r.duplicate && rev !== undefined && live.current.rev !== rev) {
      // the words were changed while this save was out: the question is about words that are gone, and nothing was saved
      setStatus("");
      if (r.error) setError(r.error);
    } else if (r.duplicate) {
      sameFor.current = rev ?? live.current.rev;
      setSame(r.duplicate);
      setAgain(r.duplicate.id);
      setStatus(sameWordsLine(r.duplicate));
      if (r.error) setError(r.error);
    } else if (r.error) {
      setStatus(`${what} saved on this device · will send when the vault is reachable`);
      setError(r.error);
    } else {
      setStatus(r.sent.length ? `${what} saved to your vault` : what);
      setError(null);
    }
    if (r.sent.length) r.sent.forEach(watch);
  }, [load, loadQueue, watch]);

  // the entry a duplicate save pointed at comes into view, marked for a moment
  useEffect(() => {
    if (!again) return;
    document.querySelector(`.journal-entry[data-id="${CSS.escape(again)}"]`)?.scrollIntoView({ block: "nearest" });
    const t = setTimeout(() => setAgain(null), 4000);
    return () => clearTimeout(t);
  }, [again, entries, queued]);

  useEffect(() => {
    invoke<VaultConfig>("journal_config").then(setCfg).catch(() => {});
    void loadQueue();
    void load(false);
    invoke<FlushReport>("journal_flush").then((r) => { if (r.sent.length) void afterFlush(r, "Queued journal entries"); }).catch(() => {});
    const online = () => invoke<FlushReport>("journal_flush").then((r) => afterFlush(r, "Queued journal entries")).catch(() => {});
    window.addEventListener("online", online);
    return () => window.removeEventListener("online", online);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { entries.filter((e) => e.pending).forEach((e) => watch(e.id)); }, [entries, watch]);

  async function saveText(saveAnother = false) {
    const body = text.trim();
    if (!body || saving) return;
    if (send.current?.body !== body) send.current = { body, draft: newDraft(body, "text") };
    const draft = send.current.draft;
    const rev = live.current.rev;
    setSaving(true);
    setSame(null);
    setStatus("Saving…");
    try {
      const r = await invoke<FlushReport>("journal_save_text", { entry: draft, saveAnother });
      // same words as another entry: nothing was saved, and the text stays until a choice is made
      if (!r.duplicate) {
        // this send is finished whatever the composer holds now; the composer clears only if it still holds these words
        if (send.current?.draft === draft) send.current = null;
        clearIf(rev, text);
        // offered only when it reached the vault; a queued entry can still be sent from its menu later
        if (!r.error) setOffer(draft.entry_id);
      }
      await afterFlush(r, "Journal entry", rev);
    } catch (e) { setError(String(e)); setStatus("Not saved · your text is still here"); }
    finally { setSaving(false); }
  }

  function keepOne() {
    // only the words the question was raised for are dropped
    if (!same || sameFor.current !== live.current.rev) { setSame(null); return; }
    setSame(null);
    clearIf(live.current.rev, live.current.text);
    send.current = null;
    setAgain(same.id);
    setStatus(same.kind === "saved" ? "Kept one · it's in your vault" : "Kept one · waiting to send");
  }

  const recorder = useRecorder(async (blob, mime) => {
    if (blob.size < 200) { setStatus("Recording was empty"); return; }
    setSaving(true);
    setStatus("Saving journal entry…");
    const note = live.current.text.trim();
    const rev = live.current.rev;
    const submitted = live.current.text;
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const draft = newDraft(note, "voice");
      const r = await invoke<FlushReport>("journal_save_voice", bytes, { headers: { "x-entry": JSON.stringify(draft), "x-audio-mime": mime } });
      // offered once its transcript lands (the menu waits for it too), and only when it reached the vault
      if (!r.error) setOffer(draft.entry_id);
      // the typed words went with the recording: clear them only if they are still what was sent
      if (clearIf(rev, submitted)) { setSame(null); send.current = null; }
      await afterFlush(r, "Journal entry");
      if (!r.error) setStatus("Journal entry saved · transcribing…");
    } catch (e) { setError(String(e)); setStatus("Journal entry not saved"); }
    finally { setSaving(false); }
  }, "in the Journal");
  const reportRecording = useRef(onRecordingChange);
  reportRecording.current = onRecordingChange;
  useEffect(() => {
    reportRecording.current?.(recorder.recording, recorder.elapsed, recorder.stop);
  }, [recorder.recording, recorder.elapsed]);
  useEffect(() => () => reportRecording.current?.(false, 0, () => {}), []);

  async function toggleMic() {
    setError(null);
    if (recorder.recording) { recorder.stop(); return; }
    try { if (await recorder.start(undefined)) setStatus("Listening… tap ■ when you're done"); }
    catch (e) { setError(`Microphone unavailable: ${e}`); }
  }

  async function share(note: JournalNote, roomId: string, toUni: boolean) {
    const key = `${note.id} ${roomId}`;
    if (!cfg || inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setShareFor(null);
    setSending((s) => ({ ...s, [key]: true }));
    setStatus(toUni ? "Passing to Uni…" : "Sending…");
    try {
      await onShare(note, roomId, toUni, cfg.vault, cfg.hub);
      const name = toUni ? "Uni" : rooms.find((r) => r.id === roomId)?.name ?? "room";
      setShared((s) => ({ ...s, [note.id]: [...(s[note.id] ?? []).filter((x) => x.id !== roomId), { id: roomId, name }] }));
      setStatus(toUni ? "Passed to Uni in #Uni" : `Sent to #${name}`);
    } catch (e) { setError(String(e)); setStatus("Not sent"); }
    finally { inFlight.current.delete(key); setSending((s) => { const { [key]: _, ...rest } = s; return rest; }); }
  }
  const sentTo = (noteId: string, roomId: string) => !!shared[noteId]?.some((x) => x.id === roomId);
  /** One chip per area room: a tap sends the entry there; a sent room stays marked. */
  const areaChip = (e: JournalNote, r: Room, after?: () => void) => {
    const sent = sentTo(e.id, r.id);
    return <button key={r.id} type="button" className={sent ? "sent" : undefined} disabled={sent || !!sending[`${e.id} ${r.id}`]}
      aria-label={sent ? `#${r.name}, sent` : `Send to #${r.name}`} onClick={() => { after?.(); void share(e, r.id, false); }}>{sent ? "✓ " : ""}#{r.name}</button>;
  };

  const queuedOnly = queued.filter((q) => !q.note_id || !entries.some((e) => e.id === q.note_id));

  return <>
    <header className="conversation-header">
      <button className="back icon-button" onClick={onBack} aria-label={`Back to ${backTo}`} title={`Back to ${backTo}`}>‹</button>
      <div><strong>Journal</strong><small>{cfg ? `Private · saved to vault ${cfg.vault} with your key` : "Private · your vault"}</small></div>
      <button className="icon-button" onClick={() => setSettings(!settings)} aria-label="Journal settings" aria-expanded={settings}><SettingsIcon /></button>
      <button className="icon-button" onClick={() => { void load(false); void invoke<FlushReport>("journal_flush").then((r) => afterFlush(r, "Synced")).catch((e) => setError(String(e))); }} disabled={loading} aria-label="Refresh journal">↻</button>
    </header>
    {settings && cfg && <JournalSettings cfg={cfg} onSaved={(c) => { setCfg(c); setSettings(false); void load(false); }} />}
    <div className="journal-compose">
      <div className="journal-writing-heading"><p className="journal-prompt">{greeting(new Date())}</p><button className="note-action" aria-pressed={focus} onClick={onFocus}>Focus</button></div>
      <textarea value={text} onChange={(e) => { edit(e.target.value); if (same) { setSame(null); setStatus(""); } }} placeholder="What's here right now…" rows={4} maxLength={65536} aria-label="Journal entry"
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveText(); } }} />
      <div className="journal-actions">
        <button className={`mic ${recorder.recording ? "on" : ""}`} onClick={() => void toggleMic()} disabled={saving && !recorder.recording} aria-label={recorder.recording ? "Stop recording and save" : "Record a journal entry"}>
          {recorder.recording ? <>■ <span>{mmss(recorder.elapsed)}</span></> : <MicIcon />}
        </button>
        <span className="journal-status" role="status">{recorder.recording ? `Recording · ${mmss(recorder.elapsed)}${text.trim() ? " · your typed text is kept with it" : ""}` : status}</span>
        <button className="send" onClick={() => void saveText()} disabled={!text.trim() || saving || recorder.recording}>{saving ? "Saving…" : "Save"}</button>
      </div>
      {same && <div className="journal-same" role="group" aria-label="Same words as another entry">
        <button type="button" className="note-action" onClick={() => void saveText(true)} disabled={saving}>Save another</button>
        <button type="button" className="note-action" onClick={keepOne} disabled={saving}>Keep one</button>
      </div>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
    <div className="message-list journal-list" aria-label="Journal entries">
      {queuedOnly.map((q) => <article key={q.entry_id} data-id={q.entry_id} data-again={again === q.entry_id || undefined} className="journal-entry queued">
        <div className="journal-meta"><span>{q.source === "voice" ? <MicIcon /> : "✎"} {when(q.created_at)}</span><span className="queued-tag">{q.note_id ? "uploading audio…" : "Waiting to send"}</span></div>
        <p className="journal-body">{entryText(q.content) || (q.has_audio ? "Voice recording, transcribed after upload." : "")}</p>
        {q.last_error && <small className="journal-error">{q.last_error}</small>}
      </article>)}
      {entries.length === 0 && queuedOnly.length === 0 && !loading && <p className="empty">No journal entries yet. Your first one is a tap away.</p>}
      {entries.map((e) => <article key={e.id} data-id={e.id} data-again={again === e.id || undefined} className="journal-entry">
        <div className="journal-meta"><span>{e.source === "voice" ? <MicIcon /> : e.source === "text" ? "✎" : "•"} {when(e.created_at)}</span>{shared[e.id]?.length ? <span className="queued-tag">shared · {shared[e.id].map((x) => x.name).join(", ")}</span> : null}</div>
        {e.pending ? <p className="journal-body pending">{entryText(e.content) ? <>{entryText(e.content)}<br /></> : null}<em>Transcribing…</em></p>
          : <p className="journal-body">{entryText(e.content)}</p>}
        {/* T-263: right after a save, a quiet offer to send the entry to area rooms; it never blocks and posts nothing until a chip is tapped */}
        {offer !== null && e.entry_id === offer && !e.pending && cfg && areas.length > 0 && <div className="share-picker journal-offer" role="group" aria-label="Send to an area">
          <span className="journal-offer-label">Send to an area?</span>
          {areas.map((r) => areaChip(e, r))}
          <button type="button" className="journal-offer-close" onClick={() => setOffer(null)}>{shared[e.id]?.some((x) => x.id !== uniRoomId) ? "Done" : "Not now"}</button>
        </div>}
        {/* r21 (Codex 6): no action strip repeated under every entry: one menu per entry, as in the chat ("⋯", then Pass to Uni, Share to a room) */}
        {!e.pending && <div className={`message-more journal-more ${menuFor === e.id ? "open" : ""}`}>
          <button type="button" className="message-more-go" aria-label="More for this entry" aria-expanded={menuFor === e.id} onClick={() => { setMenuFor(menuFor === e.id ? null : e.id); setShareFor(null); }}>⋯</button>
          {menuFor === e.id && <div className="message-menu" role="group" aria-label="Entry actions">
            <button type="button" onClick={() => { setMenuFor(null); if (uniRoomId) void share(e, uniRoomId, true); }} disabled={!uniRoomId}>Pass to Uni</button>
            <button type="button" aria-expanded={shareFor === e.id} onClick={() => setShareFor(shareFor === e.id ? null : e.id)}>Share to a room…</button>
            {shareFor === e.id && <div className="share-picker" role="group" aria-label="Choose a room">
              {areas.map((r) => areaChip(e, r, () => setMenuFor(null)))}
              {areas.length === 0 && <span className="empty">{cfg?.hub ? "No area rooms cached. Refresh conversations first." : "Set the Parachute hub in Journal settings to send a link."}</span>}
            </div>}
          </div>}
        </div>}
      </article>)}
      {more && entries.length > 0 && <div className="older"><button onClick={() => void load(true)} disabled={loading}>{loading ? "Loading…" : "Older journal entries"}</button></div>}
    </div>
  </>;
}

function JournalSettings({ cfg, onSaved }: { cfg: VaultConfig; onSaved: (c: VaultConfig) => void }) {
  const [hub, setHub] = useState(cfg.hub);
  const [vault, setVault] = useState(cfg.vault);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    try { await invoke("journal_set_config", { hub, vault }); forgetPublishOrigins(); onSaved({ hub: hub.trim().replace(/\/+$/, ""), vault: vault.trim() }); }
    catch (e) { setError(String(e)); }
  }
  return <div className="journal-settings">
    <label>Parachute hub<input value={hub} onChange={(e) => setHub(e.target.value)} autoComplete="off" spellCheck={false} /></label>
    <label>Vault<input value={vault} onChange={(e) => setVault(e.target.value)} autoComplete="off" spellCheck={false} /></label>
    <button className="send" onClick={() => void save()}>Save</button>
    {error && <p className="error">{error}</p>}
  </div>;
}
