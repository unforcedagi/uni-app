// T-335 the shape: one run as one line. On a home row (`where="row"`): a soft dot and the live line (moving), or a filled ◆ and "Waits on
// you" with what it waits for. In the room's strip (`where="strip"`): "Moving <line> ›" / "Waits on you <line> ›". Each is its own button.
// Ink-safe: moving is a ring plus words, waiting a filled ◆ plus words; no colour carries anything alone.
import type { RoomRun } from "./types";
import "./runs.css";

export function RunLine({ run, onOpen, where }: { run: RoomRun; onOpen: (run: RoomRun) => void; where: "row" | "strip" }) {
  const moving = run.state === "moving";
  const word = moving ? "Moving" : "Waits on you";
  // the row's moving line has no word on screen (the dot and the line say it, as the prototype's row does); a screen reader hears it
  const showWord = where === "strip" || !moving;
  return <button type="button" className="sh-run" data-run={run.state} data-where={where} data-note={run.id}
    aria-label={`${word}: ${run.line}. ${moving ? "Open its story" : "Open"}`} onClick={() => onOpen(run)}>
    {moving ? <i className="sh-run-dot" aria-hidden="true" /> : <i className="sh-run-needs" aria-hidden="true">◆</i>}
    {showWord && <b className="sh-run-word">{word}</b>}
    <span className="sh-run-text">{run.line}</span>
    {where === "strip" && <span className="sh-run-chev" aria-hidden="true">›</span>}
  </button>;
}
