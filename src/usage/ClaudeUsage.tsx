// T-295: the Claude accounts card at the top of Settings. It reads the launcher's usage note over the same signed vault
// door as every note (`vault_note`), shows each account's session and week at a glance, and sets which account new
// workers prefer (`usage_set_preference`). No note on this install (or no vault): the card isn't there.
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useState } from "react";
import { ageText, accountLabel, howText, USAGE_NOTE, USAGE_VAULT, usageView, type Meter } from "./usageCore";
import "./usage.css";

type Note = { id: string; path?: string; metadata?: unknown; updatedAt?: string };
const CACHE_KEY = "uni.usage.v1";

function cached(): Note | null {
  try { const n = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null"); return n && typeof n.id === "string" ? n : null; } catch { return null; }
}

function MeterLine({ label, m, extra }: { label: string; m: Meter; extra?: React.ReactNode }) {
  const pct = m.pct === null ? 0 : Math.max(0, Math.min(100, m.pct));
  return <div className={`usage-meter ${m.full ? "full" : ""}`}>
    <span className="usage-k">{label}</span>
    <b className="usage-pct">{m.full ? "Full" : m.text}</b>
    <span className="usage-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
    <span className="usage-sub">{[m.reset && `resets ${m.reset}`, extra].filter(Boolean).map((x, i) => <span key={i}>{x}</span>)}</span>
  </div>;
}

export default function ClaudeUsage() {
  const [note, setNote] = useState<Note | null>(cached);
  const [now, setNow] = useState(() => new Date());
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<Note | null> => {
    try {
      const r = await invoke<{ note: Note }>("vault_note", { vault: USAGE_VAULT, noteRef: USAGE_NOTE });
      const n = r?.note && typeof r.note.id === "string" ? r.note : null;
      setNote(n);
      setNow(new Date());
      try { if (n) localStorage.setItem(CACHE_KEY, JSON.stringify({ id: n.id, path: n.path, metadata: n.metadata, updatedAt: n.updatedAt })); } catch { /* unavailable storage */ }
      return n;
    } catch { return null; /* offline or no such note: keep what we had */ }
  }, []);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, [load]);

  const view = note ? usageView(note.metadata, now) : null;
  if (!note || !view) return null;

  async function choose(p: string) {
    if (!note || saving || p === view?.preference) return;
    setSaving(p); setError(null);
    const send = (n: Note) => invoke("usage_set_preference", { vault: USAGE_VAULT, id: n.id, preference: p, setAt: new Date().toISOString(), ifUpdatedAt: n.updatedAt ?? "" });
    try {
      try { await send(note); }
      catch (e) {
        // the launcher rewrote the note since it was read: read it again and set once more
        if (!/^conflict:/.test(String(e))) throw e;
        const fresh = await load();
        if (!fresh) throw e;
        await send(fresh);
      }
      await load();
    } catch {
      setError("Couldn't save that. Try again in a moment.");
    } finally { setSaving(null); }
  }

  const shown = saving ?? view.preference;
  return <section className="usage-card" aria-label="Claude accounts">
    <header className="usage-head"><h2>Claude accounts</h2>
      <span className={`usage-age ${view.stale ? "stale" : ""}`}>{view.stale ? `Last reading ${ageText(view.readAt, now)}` : `Updated ${ageText(view.readAt, now)}`}</span></header>
    {view.rows.map((r) => <div className="usage-row" key={r.name} aria-label={r.label}>
      <strong className="usage-name">{r.label}</strong>
      {r.missing ? <p className="usage-sub">No reading yet</p> : <>
        <MeterLine label="Session" m={r.session} />
        <MeterLine label="Week" m={r.week} extra={r.week.pace && <span className={r.week.pace === "ahead of pace" ? "usage-ahead" : "usage-on"}>{r.week.pace}</span>} />
      </>}
    </div>)}
    <div className="usage-pick" role="radiogroup" aria-label="New workers use">
      <span className="usage-k">New workers use</span>
      <span className="usage-seg">{view.choices.map((c) => <button key={c} role="radio" aria-checked={shown === c} disabled={!!saving}
        onClick={() => void choose(c)}>{c === "auto" ? "Auto" : c.toUpperCase()}</button>)}</span>
    </div>
    <p className="usage-next" role="status">{error ? <span className="usage-error">{error}</span>
      : saving ? "Saving…"
      : view.next ? <>Next worker: <b>{view.next.label}</b> ({howText(view.next.how)})</>
      : shown === "auto" ? "Saved: the launcher picks the account with the most room."
      : `Saved: new workers go to ${accountLabel(shown)} while it has room.`}</p>
  </section>;
}
