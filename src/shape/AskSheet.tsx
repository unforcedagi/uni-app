// T-335 fixes (11-11): an ask opened to its whole context, as a bottom sheet over home or the room (the run story's sheet: one system).
// Aaron: "There are some things at the top that say Waits on me, but when I open it, there isn't much context and there's no action to take".
// Its head says what kind of ask it is and where; then its next action, why now and the default; then its note's body as tasks.py wrote it
// (## Why, ## Steps, ## Links, ## Time, ## Already answered), rendered, links live (`uni:<id>` opens the note); then its buttons, by kind,
// and Archive. An ask with no body and no next action is a data fault: what there is, and the buttons all the same.
// A modal dialog by the app's one contract (src/areas/focusTrap.ts): focus in, Tab kept inside, Escape or the scrim closes.
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { openDialog } from "../areas/focusTrap";
import { Body } from "../MessageBody";
import { NoteOpener, useNoteOpener } from "../noteLinks";
import { askBody, askButtons, askFault, buttonDoes, KIND_WORD, type AskButton } from "./asksCore.ts";
import { AskButtons, CardLine } from "./AskMessage";
import { useAskCard } from "./useAskCard";
import { SealedCard } from "../SealedCard";
import { ago } from "./homeCore";
import type { Ask } from "./types.ts";
import "./runs.css";
import "./asks.css";

type Read = { body: string | null; error: string | null; loading: boolean };

export function AskSheet({ vault, ask, roomName, busy, error, onAct, onClose }: {
  vault: string; ask: Ask; roomName: string; busy: boolean; error: string | null | undefined;
  onAct: (ask: Ask, b: AskButton) => void; onClose: () => void;
}) {
  const [read, setRead] = useState<Read>({ body: null, error: null, loading: true });
  const box = useRef<HTMLDivElement>(null), layer = useRef<HTMLDivElement>(null);
  const outer = useNoteOpener();

  const load = useCallback(() => {
    let gone = false;
    setRead((r) => ({ ...r, error: null, loading: true }));
    invoke<{ note: { content?: string | null } }>("vault_note", { vault, noteRef: ask.id })
      .then((d) => { if (!gone) setRead({ body: askBody(d.note?.content), error: null, loading: false }); })
      .catch((e) => { if (!gone) setRead((r) => ({ ...r, error: String(e), loading: false })); });
    return () => { gone = true; };
  }, [vault, ask.id]);
  useEffect(load, [load]);
  useEffect(() => {
    if (!box.current) return;
    // (the bar stays live beside it: it shows everywhere, and a place on it closes the sheet)
    return openDialog(box.current, onClose, { root: layer.current, keep: [document.querySelector(".sh-bar")], initial: box.current.querySelector<HTMLButtonElement>(".sh-ask-btn[data-primary]") });
  }, [onClose]);

  // a note linked from its context opens over the place, with the sheet out of its way
  const openNote = useCallback<NonNullable<typeof outer>>((ref, href) => { onClose(); outer?.(ref, href); }, [onClose, outer]);
  const fault = !read.loading && !read.error && askFault(ask, read.body);
  const card = useAskCard(ask);
  // T-335 asks in tune: every button says what it does, beside it (a choose ask's options share one line)
  const legend = askButtons(ask, { archive: true }).filter((b, i, all) => b.act !== "answer" || all.findIndex((x) => x.act === "answer") === i)
    .map((b) => ({ act: b.act, label: b.act === "answer" ? (ask.options.length + (ask.fallback ? 1 : 0) > 1 ? "An option" : b.label) : b.label, does: buttonDoes(ask, b, roomName) }));
  const fallback = ask.fallback ? `If you do nothing: ${ask.fallback.label}` : ask.kind === "choose" || ask.kind === "do" ? "No default: it waits for you" : null;

  return <div className="sh-story-layer sh-ask-layer" ref={layer}>
    <div className="sh-story-scrim" onClick={onClose} />
    <div className="sh-story sh-ask-sheet" role="dialog" aria-modal="true" aria-labelledby="sh-ask-title" ref={box} data-id={ask.id} data-kind={ask.kind} aria-busy={busy || undefined}>
      <div className="sh-story-grab" aria-hidden="true" />
      <p className="sh-ask-sheet-kind"><i className="sh-run-needs" aria-hidden="true">◆</i><b>Waits on you</b><span> · {KIND_WORD[ask.kind]}{ask.tid ? ` · ${ask.tid}` : ""}{roomName ? ` · in ${roomName}` : ""}</span></p>
      <h2 id="sh-ask-title">{ask.what}</h2>
      <dl className="sh-ask-facts">
        <dt>Asked by</dt><dd>{roomName ? `#${roomName}` : "Uni"}{ask.updatedAt ? ` · ${((a) => (a === "now" ? "just now" : /^\d/.test(a) ? `${a} ago` : a))(ago(ask.updatedAt, Date.now() / 1000))}` : ""}</dd>
        {ask.next && <><dt>Next</dt><dd className="sh-ask-next">{ask.next}</dd></>}
        {ask.why && <><dt>Why now</dt><dd>{ask.why}</dd></>}
        {fallback && <><dt>Default</dt><dd>{fallback}</dd></>}
        {ask.link && <><dt>Link</dt><dd><a href={ask.link} onClick={(e) => { e.preventDefault(); onAct(ask, { act: "open", value: ask.link!, label: "Open", primary: false }); }}>{ask.link}</a></dd></>}
      </dl>
      {ask.sealedCard && <CardLine ask={ask} state={card}>{(c) => <SealedCard channel={c.channel} reference={c.ref} />}</CardLine>}
      {read.loading && read.body === null && <p className="sh-story-quiet" role="status">Reading its context…</p>}
      {read.error && <p className="sh-story-error" role="alert">Couldn't read its context just now. <button type="button" className="sh-story-retry" onClick={load}>Retry</button></p>}
      {read.body && <div className="sh-ask-context"><NoteOpener.Provider value={openNote}><Body body={read.body} mentions={[]} me={null} /></NoteOpener.Provider></div>}
      {fault && <p className="sh-story-quiet sh-ask-fault" role="note">This ask came without its context. You can still answer it or archive it.</p>}
      <AskButtons ask={ask} busy={busy} onAct={onAct} archive room={roomName} />
      <dl className="sh-ask-does" aria-label="What each button does">
        {legend.map((l) => <div key={l.act} data-act={l.act}><dt>{l.label}</dt><dd>{l.does}</dd></div>)}
      </dl>
      <p className="sh-ask-nochat">No button here starts a new chat. {roomName ? `Your words go to #${roomName}'s own chat.` : "Your words go to its room's own chat."}</p>
      {error && <p className="sh-ask-error" role="alert">{error}</p>}
      <div className="sh-story-acts"><button type="button" className="sh-story-btn" onClick={onClose}>Close</button></div>
    </div>
  </div>;
}
