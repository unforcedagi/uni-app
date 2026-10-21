import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { cleanNote, NOTE_MAX, NOTE_WARN, noteLine, optionLabel, parseDecisionNote, pickedLine, type DecisionView } from "./decisionView";
import { makeDecisionStore, msg, type Entry } from "./decisionStore";
import { useNoteOpener } from "./noteLinks";
import { activeProfile } from "./areas/profile";
import { decisionDecided, onDecisionsGone } from "./decisionLinks";

// T-212: a decision in the chat as a card you can tap. The note is read once per decision and shared by every card of it (a message's
// card and the room's list, or the "Picked" message's own), so one tap shows "Decided" on all of them. A tap is the vault's
// compare-and-set (`vault_pick_decision`); only a tap that won posts "Picked: …" in the room, as you, so the room's Uni hears it.
// A tap that lost (the room or another device decided first) shows the stored answer and posts nothing.
// T-226: a card also takes your words. With a tap they go with the pick (`decided_note`, in the same compare-and-set; "Picked: X — …"
// in the room); alone ("Send note", or Shift/Ctrl/Cmd+Enter) they are appended to the decision's `notes` and it stays open ("Note on
// decision (no pick yet): …"). What you typed is kept in the store until it is saved, so a card drawn again or a tap that lost keeps it.

const store = makeDecisionStore((vault, id) => invoke<{ note: unknown }>("vault_note", { vault, noteRef: id }).then((r) => r.note));
/** Forget: the cards' notes go with the identity that could read them. */
export const forgetDecisions = (): void => store.forget();

// Coming back to the app re-reads the open ones (the room or another device may have decided meanwhile) and the ones that couldn't be
// read (offline then), at most every 15 s each.
if (typeof window !== "undefined") window.addEventListener("focus", () => store.refresh(15_000));
// An open decision the shell stops listing was decided (in its sheet, by the room): its cards re-read it.
onDecisionsGone((ids) => store.gone(ids));

function useDecision(id: string, vault: string): Entry | undefined {
  useSyncExternalStore(store.subscribe, store.version, store.version);
  // a card shown again retries a read that failed (offline then)
  useEffect(() => { const e = store.get(id, vault); if (!e || (!e.view && e.error)) void store.load(id, vault); }, [id, vault]);
  return store.get(id, vault);
}

type Props = {
  id: string;
  vault: string;
  /** Posts the room message for a won tap (as you, to the room the card is in), unless `current()` says a Forget came meanwhile. */
  post: (body: string, current: () => boolean) => Promise<void>;
};

export function DecisionCard({ id, vault, post }: Props) {
  const entry = useDecision(id, vault);
  const openNote = useNoteOpener();
  const [phase, setPhase] = useState<"idle" | "saving" | "noting" | "telling" | "told" | "untold">("idle");
  const [error, setError] = useState<string | null>(null);
  const [line, setLine] = useState<string | null>(null);
  const [lost, setLost] = useState(false);
  /** What the last room message was: a pick (with or without words) or words alone. */
  const [sent, setSent] = useState<"pick" | "note">("pick");
  const text = useSyncExternalStore(store.subscribeDrafts, () => store.draft(id, vault), () => store.draft(id, vault));
  const d = entry?.view;
  // a ref to a note that is not a decision (or not read yet) is only its chip; a note that exists but can't be read now says so quietly
  if (!entry) return null;
  if (!d) return entry.error && !/not found/i.test(entry.error) ? <p className="decision-card decision-loading">Couldn't read this note to show its decision: {entry.error}
    <button type="button" className="decision-retry" onClick={() => void store.load(id, vault)}>Try again</button></p> : null;

  const tell = async (body: string) => {
    const gen = store.generation();
    setPhase("telling");
    try { await post(body, () => gen === store.generation()); setPhase("told"); } catch (e) { setError(`Couldn't tell the room: ${msg(e)}`); setPhase("untold"); }
  };
  const pick = async (option: string) => {
    // the words go with the pick only as they stand at the tap; they stay in the field until the pick is saved
    const words = cleanNote(text);
    setError(null); setPhase("saving");
    // a Forget while the tap is out: its answer, the room message and any re-read belong to the identity that is gone
    const gen = store.generation();
    const current = () => gen === store.generation();
    try {
      const r = await invoke<{ outcome: "picked" | "already_decided"; decided: string; decided_by?: string | null; note: unknown }>("vault_pick_decision",
        { vault, id, option, by: activeProfile().me, at: new Date().toISOString(), ifUpdatedAt: d.updatedAt, note: words || null });
      if (!current()) return;
      const now = parseDecisionNote(r.note);
      const won = r.outcome === "picked";
      // the question stays the one read with its content (the write answers without it)
      const view: DecisionView = { ...d, updatedAt: now?.updatedAt ?? d.updatedAt, state: "decided", decided: r.decided, decidedBy: won ? activeProfile().me : r.decided_by ?? now?.decidedBy ?? null,
        decidedNote: won ? words || null : now?.decidedNote ?? null, notes: now?.notes ?? d.notes };
      store.put(id, vault, { view, error: null, read: Date.now() }, gen);
      // a lost tap wrote nothing: its words stay in the field, to send as a note
      if (won && store.draft(id, vault) === text) store.setDraft(id, vault, "");
      decisionDecided();
      if (won) { const body = pickedLine(r.decided, d, words); setLine(body); setSent("pick"); await tell(body); }
      else { setLost(true); setPhase("idle"); }
    } catch (e) {
      if (!current()) return;
      // a question changed since it was shown is never answered blind: the card shows the new one, and you tap again
      setError(/changed since it was shown|modified since|conflict/i.test(msg(e)) ? "The question changed since you saw it. Here it is again; nothing was saved." : `Couldn't save your pick: ${msg(e)}`);
      setPhase("idle");
      void store.load(id, vault);
    }
  };
  /** Words alone: appended to the decision's notes (it stays open), then told to the room. A failed save keeps them in the field. */
  const sendNote = async () => {
    const words = cleanNote(text);
    if (!words || phase === "saving" || phase === "noting") return;
    setError(null); setPhase("noting");
    const gen = store.generation();
    const current = () => gen === store.generation();
    try {
      const n = await invoke<unknown>("vault_note_decision", { vault, id, text: words, by: activeProfile().me, at: new Date().toISOString() });
      if (!current()) return;
      const now = parseDecisionNote(n);
      if (store.draft(id, vault) === text) store.setDraft(id, vault, "");
      // the notes show now; the revision a pick is written against moves only with a full read (the question may have changed too), a
      // new one: a read already under way may predate the note
      store.put(id, vault, { view: { ...d, notes: now?.notes ?? d.notes }, error: null, read: Date.now() }, gen);
      void store.load(id, vault, true);
      const body = noteLine(words, now ?? d); setLine(body); setSent("note"); await tell(body);
    } catch (e) {
      if (!current()) return;
      setError(`Couldn't save your note: ${msg(e)}`);
      setPhase("idle");
    }
  };
  const busy = phase === "saving" || phase === "noting";
  const field = <NoteField text={text} busy={busy} onText={(t) => store.setDraft(id, vault, t)} onSend={() => void sendNote()} />;
  const told = <>
    {phase === "noting" && <p className="decision-note" role="status">Saving your note…</p>}
    {phase === "telling" && <p className="decision-note" role="status">Telling the room…</p>}
    {phase === "told" && <p className="decision-note" role="status">{sent === "note" ? "Note sent to the room." : "Sent to the room."}</p>}
    {phase === "untold" && line && <p className="decision-note warn" role="alert">{error} <button type="button" className="decision-retry" onClick={() => void tell(line)}>Tell the room</button></p>}
  </>;
  const notes = d.notes.length ? <ul className="decision-notes" aria-label="Notes on this decision">
    {d.notes.slice(-3).map((n, i) => <li key={`${n.at}.${i}`}><span className="decision-by">{n.by === activeProfile().me ? "You" : n.by || "Note"}: </span>{n.text}</li>)}
  </ul> : null;
  const context = openNote ? <button type="button" className="decision-context" onClick={() => openNote({ hub: null, vault, ref: id }, null)}>Context ›</button> : null;
  const head = <header className="decision-head"><span className="decision-kind">Decision{d.task ? ` · ${d.task}` : ""}</span>{context}</header>;

  if (d.state !== "open") return <section className="decision-card decided" aria-label={`Decision: ${d.question}`} data-state={d.state}>
    {head}
    <p className="decision-q">{d.question}</p>
    {d.state === "decided"
      ? <p className="decision-result" role="status">Decided: <strong>{d.decided ? optionLabel(d.decided) : "yes"}</strong>{d.decidedBy ? <span className="decision-by"> · by {d.decidedBy === activeProfile().me ? "you" : d.decidedBy}</span> : null}</p>
      : <p className="decision-result" role="status">No longer open.</p>}
    {d.decidedNote && <p className="decision-said">{d.decidedNote}</p>}
    {notes}
    {lost && <p className="decision-note" role="status">Already decided before your tap; nothing was sent.{text.trim() ? " Your note is still here: send it on its own." : ""}</p>}
    {/* words left over (a tap that lost, or typed before it was decided elsewhere) can still go, as a note; after a lost tap the field
        stays even when cleared to be retyped */}
    {(text || lost) && field}
    {phase !== "untold" && error && <p className="decision-note warn" role="alert">{error}</p>}
    {told}
  </section>;

  return <section className="decision-card" aria-label={`Decision: ${d.question}`} data-state="open">
    {head}
    <p className="decision-q">{d.question}</p>
    {d.options.length >= 2
      ? <div className="decision-options" role="group" aria-label={`Pick one: ${d.question}`}>
          {d.options.map((o) => <button key={o} type="button" className={`decision-opt ${o === d.dflt ? "dflt" : ""}`}
            aria-label={o === d.dflt ? `${optionLabel(o)} (default)` : optionLabel(o)} disabled={busy} onClick={() => void pick(o)}>
            <span>{optionLabel(o)}</span>{o === d.dflt && <span className="decision-dflt">default</span>}
          </button>)}
        </div>
      : <p className="decision-note">This decision has no options to tap; answer it in words.</p>}
    {notes}
    {field}
    {phase === "saving" && <p className="decision-note" role="status">Saving your pick…</p>}
    {phase !== "untold" && error && <p className="decision-note warn" role="alert">{error}</p>}
    {told}
  </section>;
}

/**
 * The words field under a decision's options: one line that grows as you type (no animation), up to NOTE_MAX characters with a count
 * near the end. Enter is a new line, never a send: Shift+Enter or Ctrl/Cmd+Enter sends the words alone, as "Send note" does.
 */
function NoteField({ text, busy, onText, onSend }: { text: string; busy: boolean; onText: (t: string) => void; onSend: () => void }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // grow to fit, up to about six lines (then it scrolls); runs on every change, including words restored from the store
  useLayoutEffect(() => { const el = ref.current; if (!el) return; el.style.height = "auto"; el.style.height = `${Math.min(el.scrollHeight + 2, 160)}px`; }, [text]);
  const left = NOTE_MAX - text.length;
  const ready = !!cleanNote(text) && !busy;
  return <div className="decision-say">
    <textarea ref={ref} className="decision-input" rows={1} maxLength={NOTE_MAX} value={text} readOnly={busy} placeholder="Add a note…"
      aria-label="Add a note to this decision" title="Tap an option to send it with your pick, or Send note (Shift+Enter) to send it alone"
      onChange={(e) => onText(e.target.value.length > NOTE_MAX ? e.target.value.slice(0, NOTE_MAX).replace(/[\ud800-\udbff]$/, "") : e.target.value)}
      onKeyDown={(e) => {
        if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
        e.stopPropagation();
        if (e.shiftKey || e.ctrlKey || e.metaKey) { e.preventDefault(); if (ready) onSend(); }
      }} />
    {text.length >= NOTE_WARN && <span className={`decision-count ${left <= 0 ? "full" : ""}`} aria-live="polite">{left <= 0 ? `${NOTE_MAX} characters: the most a note takes` : `${left} characters left`}</span>}
    {text && <button type="button" className="decision-send" disabled={!ready} onClick={onSend}>Send note</button>}
  </div>;
}
