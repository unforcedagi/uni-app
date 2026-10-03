import { SettingsIcon, MicIcon } from "./Icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useRecorder } from "./recorder";
import { entryText, greeting, mmss, newDraft, type FlushReport, type JournalNote, type QueuedEntry } from "./journalCore";

type Room = { id: string; name: string };
type VaultConfig = { hub: string; vault: string };
/** Post `note` to a room; `toUni` addresses Uni there. Resolves when accepted. */
export type ShareFn = (note: JournalNote, roomId: string, toUni: boolean, vault: string, hub: string) => Promise<void>;

const PAGE = 30;

const DRAFT_KEY = "uni.journal.draft";

function when(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function Journal({ rooms, uniRoomId, onShare, onBack, onRecordingChange, focus, onFocus }: { focus: boolean; onFocus: () => void; rooms: Room[]; uniRoomId: string | null; onShare: ShareFn; onBack: () => void; onRecordingChange?: (recording: boolean, elapsed: number, stop: () => void) => void }) {
  const [cfg, setCfg] = useState<VaultConfig | null>(null);
  const [entries, setEntries] = useState<JournalNote[]>([]);
  const [queued, setQueued] = useState<QueuedEntry[]>([]);
  // The draft outlives the Journal screen: leaving to answer a message, or the
  // app being closed, must never lose what you were writing.
  const [text, setText] = useState(() => localStorage.getItem(DRAFT_KEY) ?? "");
  useEffect(() => {
    if (text) localStorage.setItem(DRAFT_KEY, text); else localStorage.removeItem(DRAFT_KEY);
  }, [text]);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [more, setMore] = useState(true);
  const [shareFor, setShareFor] = useState<string | null>(null);
  const [shared, setShared] = useState<Record<string, string>>({});
  const [settings, setSettings] = useState(false);
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

  const afterFlush = useCallback(async (r: FlushReport, what: string) => {
    await loadQueue();
    if (r.error) {
      setStatus(`${what} saved on this device · will send when the vault is reachable`);
      setError(r.error);
    } else {
      setStatus(r.sent.length ? `${what} saved to your vault` : what);
      setError(null);
    }
    if (r.sent.length) {
      await load(false);
      r.sent.forEach(watch);
    }
  }, [load, loadQueue, watch]);

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

  async function saveText() {
    const body = text.trim();
    if (!body || saving) return;
    setSaving(true);
    setStatus("Saving…");
    try {
      const r = await invoke<FlushReport>("journal_save_text", { entry: newDraft(body, "text") });
      setText("");
      await afterFlush(r, "Journal entry");
    } catch (e) { setError(String(e)); setStatus("Not saved · your text is still here"); }
    finally { setSaving(false); }
  }

  const recorder = useRecorder(async (blob, mime) => {
    if (blob.size < 200) { setStatus("Recording was empty"); return; }
    setSaving(true);
    setStatus("Saving journal entry…");
    const note = text.trim();
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const r = await invoke<FlushReport>("journal_save_voice", bytes, { headers: { "x-entry": JSON.stringify(newDraft(note, "voice")), "x-audio-mime": mime } });
      setText("");
      await afterFlush(r, "Journal entry");
      if (!r.error) setStatus("Journal entry saved · transcribing on uni-1…");
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
    if (!cfg) return;
    setShareFor(null);
    setStatus(toUni ? "Passing to Uni…" : "Sharing…");
    try {
      await onShare(note, roomId, toUni, cfg.vault, cfg.hub);
      const name = rooms.find((r) => r.id === roomId)?.name ?? "room";
      setShared((s) => ({ ...s, [note.id]: toUni ? "Uni" : name }));
      setStatus(toUni ? "Passed to Uni in #Uni" : `Shared to #${name}`);
    } catch (e) { setError(String(e)); setStatus("Share failed"); }
  }

  const queuedOnly = queued.filter((q) => !q.note_id || !entries.some((e) => e.id === q.note_id));

  return <>
    <header className="conversation-header">
      <button className="back icon-button" onClick={onBack} aria-label="Back to conversations">‹</button>
      <div><strong>Journal</strong><small>{cfg ? `Private · saved to vault ${cfg.vault} with your key` : "Private · your vault"}</small></div>
      <button className="icon-button" onClick={() => setSettings(!settings)} aria-label="Journal settings" aria-expanded={settings}><SettingsIcon /></button>
      <button className="icon-button" onClick={() => { void load(false); void invoke<FlushReport>("journal_flush").then((r) => afterFlush(r, "Synced")).catch((e) => setError(String(e))); }} disabled={loading} aria-label="Refresh journal">↻</button>
    </header>
    {settings && cfg && <JournalSettings cfg={cfg} onSaved={(c) => { setCfg(c); setSettings(false); void load(false); }} />}
    <div className="journal-compose">
      <div className="journal-writing-heading"><p className="journal-prompt">{greeting(new Date())}</p><button className="note-action" aria-pressed={focus} onClick={onFocus}>Focus</button></div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="What's here right now…" rows={4} maxLength={65536} aria-label="Journal entry"
        onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveText(); } }} />
      <div className="journal-actions">
        <button className={`mic ${recorder.recording ? "on" : ""}`} onClick={() => void toggleMic()} disabled={saving && !recorder.recording} aria-label={recorder.recording ? "Stop recording and save" : "Record a journal entry"}>
          {recorder.recording ? <>■ <span>{mmss(recorder.elapsed)}</span></> : <MicIcon />}
        </button>
        <span className="journal-status" role="status">{recorder.recording ? `Recording · ${mmss(recorder.elapsed)}${text.trim() ? " · your typed text is kept with it" : ""}` : status}</span>
        <button className="send" onClick={() => void saveText()} disabled={!text.trim() || saving || recorder.recording}>{saving ? "Saving…" : "Save"}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
    </div>
    <div className="message-list journal-list" aria-label="Journal entries">
      {queuedOnly.map((q) => <article key={q.entry_id} className="journal-entry queued">
        <div className="journal-meta"><span>{q.source === "voice" ? <MicIcon /> : "✎"} {when(q.created_at)}</span><span className="queued-tag">{q.note_id ? "uploading audio…" : "on this device · not sent yet"}</span></div>
        <p className="journal-body">{entryText(q.content) || (q.has_audio ? "Voice recording, transcribed after upload." : "")}</p>
        {q.last_error && <small className="journal-error">{q.last_error}</small>}
      </article>)}
      {entries.length === 0 && queuedOnly.length === 0 && !loading && <p className="empty">No journal entries yet. Your first one is a tap away.</p>}
      {entries.map((e) => <article key={e.id} className="journal-entry">
        <div className="journal-meta"><span>{e.source === "voice" ? <MicIcon /> : e.source === "text" ? "✎" : "•"} {when(e.created_at)}</span>{shared[e.id] && <span className="queued-tag">shared · {shared[e.id]}</span>}</div>
        {e.pending ? <p className="journal-body pending">{entryText(e.content) ? <>{entryText(e.content)}<br /></> : null}<em>Transcribing…</em></p>
          : <p className="journal-body">{entryText(e.content)}</p>}
        <div className="message-actions journal-entry-actions">
          <button onClick={() => uniRoomId && void share(e, uniRoomId, true)} disabled={!uniRoomId || e.pending} aria-label="Pass this journal entry to Uni">✦ Pass to Uni</button>
          <button onClick={() => setShareFor(shareFor === e.id ? null : e.id)} disabled={e.pending} aria-expanded={shareFor === e.id}>Share to…</button>
        </div>
        {shareFor === e.id && <div className="share-picker" role="menu" aria-label="Choose a room">
          {rooms.map((r) => <button key={r.id} role="menuitem" onClick={() => void share(e, r.id, false)}>#{r.name}</button>)}
          {rooms.length === 0 && <span className="empty">No rooms cached. Refresh conversations first.</span>}
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
    try { await invoke("journal_set_config", { hub, vault }); onSaved({ hub: hub.trim().replace(/\/+$/, ""), vault: vault.trim() }); }
    catch (e) { setError(String(e)); }
  }
  return <div className="journal-settings">
    <label>Parachute hub<input value={hub} onChange={(e) => setHub(e.target.value)} autoComplete="off" spellCheck={false} /></label>
    <label>Vault<input value={vault} onChange={(e) => setVault(e.target.value)} autoComplete="off" spellCheck={false} /></label>
    <button className="send" onClick={() => void save()}>Save</button>
    {error && <p className="error">{error}</p>}
  </div>;
}
