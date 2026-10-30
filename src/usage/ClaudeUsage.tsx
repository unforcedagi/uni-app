// T-295: the Claude accounts card at the top of Settings. It reads the launcher's usage note over the same signed vault
// door as every note (`vault_note`), shows each account's session and week at a glance, and sets which account new
// workers prefer (`usage_set_preference`). No note on this install (or no vault): the card isn't there.
import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { ageText, accountLabel, howText, USAGE_VAULT, usageView, type Meter } from "./usageCore";
import { useUsageNote, useUsageRefresh, type UsageNote as Note } from "./usageNote";
import "./usage.css";

function MeterLine({ label, m, extra = [] }: { label: string; m: Meter; extra?: React.ReactNode[] }) {
  const pct = m.pct === null ? 0 : Math.max(0, Math.min(100, m.pct));
  // T-335: at the launcher's stop it is paused (muted, with the headroom it keeps); "Full" only at a real 100
  return <div className={`usage-meter ${m.full ? "full" : m.paused ? "paused" : m.info ? "info" : ""}`} title={m.headroom ?? undefined}>
    <span className="usage-k">{label}</span>
    <b className="usage-pct">{m.full ? "Full" : m.paused ? `Paused · ${m.text}` : m.text}</b>
    <span className="usage-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>
    <span className="usage-sub">{[m.reset && `resets ${m.reset}`, ...extra].filter(Boolean).map((x, i) => <span key={i}>{x}</span>)}</span>
  </div>;
}

export default function ClaudeUsage() {
  // T-302 round 3: the readings are read again while the card is shown (every few minutes, and on focus/visibility), not only once
  const { note, load } = useUsageNote();
  const { busy, failed, refresh } = useUsageRefresh();
  const [now, setNow] = useState(() => new Date());
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { setNow(new Date()); }, [note]);
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);

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
      <span className="usage-when"><span className={`usage-age ${view.stale ? "stale" : ""}`}>{view.stale ? `Last reading ${ageText(view.readAt, now)}` : `As of ${ageText(view.readAt, now)}`}</span>
        <button type="button" className="usage-refresh" aria-label="Refresh Claude usage" disabled={busy} onClick={refresh}>{busy ? "Checking…" : "Refresh"}</button></span></header>
    {failed && <p className="usage-error" role="status">Couldn't read the usage note just now; these are from the last read.</p>}
    {/* T-319: an old reading is not shown as current */}
    {view.stale && <p className="usage-stale" role="note">{view.readAt
      ? `No fresh reading: the last one is from ${ageText(view.readAt, now)}, and these numbers may be out of date. A new one comes every 15 minutes; if this stays, the usage meter on the host has stopped.`
      : "No reading yet."}</p>}
    {view.rows.map((r) => <div className={`usage-row ${r.stale || r.out ? "old" : ""}`} key={r.name} aria-label={r.label}>
      <strong className="usage-name">{r.label}</strong>
      {r.missing ? <p className="usage-sub">No reading yet</p> : <>
        {/* an account whose reading is older than the one the header gives: said on its own row */}
        {r.out ? <p className="usage-row-stale">Signed out: these are its last numbers, from {ageText(r.readAt, now)}.</p>
          : r.stale && r.readAt !== view.readAt && <p className="usage-row-stale">No fresh reading for this account: these are from {ageText(r.readAt, now)}.</p>}
        {/* T-335: Claude Ultra has no 5-hour limit; where the launcher doesn't count the session, its number is info */}
        <MeterLine label="Session" m={r.session} extra={[r.session.info && <span className="usage-info">info, not a limit</span>]} />
        {/* T-335: in a week's last hours the launcher spends it past the flat stop; the card says so instead of "Paused" */}
        <MeterLine label="Week" m={r.week} extra={[r.week.pace && <span className={r.week.pace === "ahead of pace" ? "usage-ahead" : "usage-on"}>{r.week.pace}</span>,
          r.week.spending !== null && <span className="usage-spend" title={r.week.why ?? undefined}>spending to {r.week.spending}%</span>]} />
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
