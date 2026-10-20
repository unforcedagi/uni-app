import { useEffect, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { optionLabel, parseDecisionNote, pickedLine, type DecisionView } from "./decisionCard";
import { useNoteOpener } from "./noteLinks";
import { activeProfile } from "./areas/profile";
import { decisionDecided, onDecisionsGone } from "./decisionLinks";

// T-212: a decision in the chat as a card you can tap. The note is read once per decision and shared by every card of it (a message's
// card and the room's list, or the "Picked" message's own), so one tap shows "Decided" on all of them. A tap is the vault's
// compare-and-set (`vault_pick_decision`); only a tap that won posts "Picked: …" in the room, as you, so the room's Uni hears it.
// A tap that lost (the room or another device decided first) shows the stored answer and posts nothing.

type Entry = { view: DecisionView | null; error: string | null; read: number; vault: string };
const entries = new Map<string, Entry>();
const loading = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;
const bump = () => { version++; for (const f of listeners) f(); };
const put = (id: string, e: Entry) => { entries.set(id, e); bump(); };
const msg = (e: unknown) => (typeof e === "string" ? e : (e as Error)?.message ?? "failed").replace(/^Error:\s*/, "");

function load(id: string, vault: string): Promise<void> {
  const busy = loading.get(id);
  if (busy) return busy;
  const p = invoke<{ note: unknown }>("vault_note", { vault, noteRef: id })
    .then((r) => put(id, { view: parseDecisionNote(r.note), error: null, read: Date.now(), vault }))
    .catch((e) => { if (!entries.get(id)?.view) put(id, { view: null, error: msg(e), read: Date.now(), vault }); })
    .finally(() => loading.delete(id));
  loading.set(id, p);
  return p;
}

// Coming back to the app re-reads the open ones (the room or another device may have decided meanwhile) and the ones that couldn't be
// read (offline then), at most every 15 s each.
const stale = (e: Entry) => (e.view?.state === "open" || (!e.view && !!e.error)) && Date.now() - e.read > 15_000;
if (typeof window !== "undefined") window.addEventListener("focus", () => {
  for (const [id, e] of entries) if (stale(e)) void load(id, e.vault);
});

// An open decision the shell stops listing was decided (in its sheet, by the room): its cards re-read it.
onDecisionsGone((ids) => { for (const id of ids) { const e = entries.get(id); if (e?.view?.state === "open") void load(id, e.vault); } });

const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };
function useDecision(id: string, vault: string): Entry | undefined {
  useSyncExternalStore(subscribe, () => version, () => version);
  // a card shown again retries a read that failed (offline then)
  useEffect(() => { const e = entries.get(id); if (!e || (!e.view && e.error)) void load(id, vault); }, [id, vault]);
  return entries.get(id);
}

type Props = {
  id: string;
  vault: string;
  /** Posts the room message for a won tap (as you, to the room the card is in). */
  post: (body: string) => Promise<void>;
};

export function DecisionCard({ id, vault, post }: Props) {
  const entry = useDecision(id, vault);
  const openNote = useNoteOpener();
  const [phase, setPhase] = useState<"idle" | "saving" | "telling" | "told" | "untold">("idle");
  const [error, setError] = useState<string | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  const d = entry?.view;
  // a ref to a note that is not a decision (or not read yet) is only its chip; a note that exists but can't be read now says so quietly
  if (!entry) return null;
  if (!d) return entry.error && !/not found/i.test(entry.error) ? <p className="decision-card decision-loading">Couldn't read this note to show its decision: {entry.error}
    <button type="button" className="decision-retry" onClick={() => void load(id, vault)}>Try again</button></p> : null;

  const tell = async (body: string) => {
    setPhase("telling");
    try { await post(body); setPhase("told"); } catch (e) { setError(`Couldn't tell the room: ${msg(e)}`); setPhase("untold"); }
  };
  const pick = async (option: string) => {
    setError(null); setPhase("saving");
    try {
      const r = await invoke<{ outcome: "picked" | "already_decided"; decided: string; decided_by?: string | null; note: unknown }>("vault_pick_decision",
        { vault, id, option, by: activeProfile().me, at: new Date().toISOString(), ifUpdatedAt: d.updatedAt });
      const now = parseDecisionNote(r.note);
      // the question stays the one read with its content (the write answers without it)
      const view: DecisionView = { ...d, updatedAt: now?.updatedAt ?? d.updatedAt, state: "decided", decided: r.decided, decidedBy: r.outcome === "picked" ? activeProfile().me : r.decided_by ?? now?.decidedBy ?? null };
      put(id, { view, error: null, read: Date.now(), vault });
      decisionDecided();
      if (r.outcome === "picked") { const body = pickedLine(r.decided, d); setLine(body); await tell(body); }
      else { setLost(true); setPhase("idle"); }
    } catch (e) {
      // a question changed since it was shown is never answered blind: the card shows the new one, and you tap again
      setError(/changed since it was shown|modified since|conflict/i.test(msg(e)) ? "The question changed since you saw it. Here it is again; nothing was saved." : `Couldn't save your pick: ${msg(e)}`);
      setPhase("idle");
      void load(id, vault);
    }
  };
  const context = openNote ? <button type="button" className="decision-context" onClick={() => openNote({ hub: null, vault, ref: id }, null)}>Context ›</button> : null;
  const head = <header className="decision-head"><span className="decision-kind">Decision{d.task ? ` · ${d.task}` : ""}</span>{context}</header>;

  if (d.state !== "open") return <section className="decision-card decided" aria-label={`Decision: ${d.question}`} data-state={d.state}>
    {head}
    <p className="decision-q">{d.question}</p>
    {d.state === "decided"
      ? <p className="decision-result" role="status">Decided: <strong>{d.decided ? optionLabel(d.decided) : "yes"}</strong>{d.decidedBy ? <span className="decision-by"> · by {d.decidedBy === activeProfile().me ? "you" : d.decidedBy}</span> : null}</p>
      : <p className="decision-result" role="status">No longer open.</p>}
    {lost && <p className="decision-note" role="status">Already decided before your tap; nothing was sent.</p>}
    {phase === "telling" && <p className="decision-note" role="status">Telling the room…</p>}
    {phase === "told" && <p className="decision-note" role="status">Sent to the room.</p>}
    {phase === "untold" && line && <p className="decision-note warn" role="alert">{error} <button type="button" className="decision-retry" onClick={() => void tell(line)}>Tell the room</button></p>}
  </section>;

  return <section className="decision-card" aria-label={`Decision: ${d.question}`} data-state="open">
    {head}
    <p className="decision-q">{d.question}</p>
    {d.options.length >= 2
      ? <div className="decision-options" role="group" aria-label={`Pick one: ${d.question}`}>
          {d.options.map((o) => <button key={o} type="button" className={`decision-opt ${o === d.dflt ? "dflt" : ""}`} disabled={phase === "saving"}
            aria-label={o === d.dflt ? `${optionLabel(o)} (default)` : optionLabel(o)} onClick={() => void pick(o)}>
            <span>{optionLabel(o)}</span>{o === d.dflt && <span className="decision-dflt">default</span>}
          </button>)}
        </div>
      : <p className="decision-note">This decision has no options to tap; answer it in words.</p>}
    {phase === "saving" && <p className="decision-note" role="status">Saving your pick…</p>}
    {error && <p className="decision-note warn" role="alert">{error}</p>}
  </section>;
}
