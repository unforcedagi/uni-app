// Who Said It: one line, set big. Yours, or Uni writing as you? Guess, see the answer and its tell, say what gave it
// away if you know. Keys: ← or 1 for the first answer, → or 2 for the second, Enter for the next line.
import { useEffect, useRef, useState } from "react";
import type { Round } from "../../../engine/src/types.ts";
import { BurstEnd, Empty, GameFrame, Loading, SaveNote } from "../kit/frame.tsx";
import { reaction, useArcade, useKeys, useSaver } from "../kit/hooks.ts";
import { seedsOf } from "../kit/lesson.ts";
import { Next, Pen, Spark } from "../kit/icons.tsx";

type Line = Extract<Round, { game: "who-said-it" }>;
type Said = "owner" | "uni";

export function WhoSaidIt() {
  const { host, uni } = useArcade();
  const cloud = host.owner.you;
  const labels: Record<Said, string> = cloud ? { owner: "The writer", uni: "The machine" } : { owner: "I wrote that", uni: `${uni ?? "Uni"} wrote it` };
  const [phase, setPhase] = useState<"loading" | "guess" | "reveal" | "end" | "empty" | "error">("loading");
  const [lines, setLines] = useState<Line[]>([]);
  const [idx, setIdx] = useState(0);
  const [said, setSaid] = useState<Said | null>(null);
  const [words, setWords] = useState("");
  const [score, setScore] = useState({ right: 0, total: 0, fooled: 0 });
  const [run, setRun] = useState(0);
  const { session, save, retry, clear, failed, busy } = useSaver();
  const pending = useRef<{ card: string; said: Said; right: boolean; words: string } | null>(null);
  const nextBtn = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let live = true;
    setPhase("loading"); setIdx(0); setScore({ right: 0, total: 0, fooled: 0 }); clear();
    host.rounds("who-said-it", 10).then(
      (rs) => { if (!live) return; const g = rs.filter((r): r is Line => r.game === "who-said-it" && !!r.card.voice); setLines(g); setPhase(g.length ? "guess" : "empty"); },
      () => { if (live) setPhase("error"); },
    );
    return () => { live = false; };
  }, [host, run, clear]);

  const commit = () => {
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    void save([reaction("who-said-it", "guess", p.card, { guess: { said: p.said, right: p.right }, ...(p.words.trim() ? { words: p.words.trim() } : {}) })]);
  };
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => commitRef.current(), []);

  const line = lines[idx];
  const by = line?.card.voice?.by;

  const guess = (s: Said) => {
    if (phase !== "guess" || !line || !by) return;
    const right = s === by;
    pending.current = { card: line.card.id, said: s, right, words: "" };
    setSaid(s);
    setWords("");
    setScore((x) => ({ right: x.right + (right ? 1 : 0), total: x.total + 1, fooled: x.fooled + (!right && by === "uni" ? 1 : 0) }));
    setPhase("reveal");
  };
  useEffect(() => { if (phase === "reveal") nextBtn.current?.focus({ preventScroll: true }); }, [phase]);

  const next = () => {
    commit();
    if (idx + 1 >= lines.length) { setPhase("end"); host.distill?.().catch(() => undefined); return; }
    setIdx(idx + 1);
    setSaid(null);
    setPhase("guess");
  };

  useKeys((e) => {
    const k = e.key.toLowerCase();
    if (phase === "guess") {
      if (k === "arrowleft" || k === "1") { e.preventDefault(); guess("owner"); }
      else if (k === "arrowright" || k === "2") { e.preventDefault(); guess("uni"); }
    } else if (phase === "reveal" && k === "enter" && document.activeElement !== nextBtn.current) {
      e.preventDefault(); next();
    }
  });

  const right = said !== null && said === by;
  const whose = by === "owner" ? (cloud ? "The writer wrote this." : "You wrote this.") : cloud ? "The machine wrote this." : `${uni ?? "Uni"} wrote this, as you.`;
  const corner = <span className="ta-quiet-count" aria-live="polite">{score.right} of {score.total} right</span>;

  return (
    <GameFrame game="who-said-it" title="Who Said It" corner={corner}>
      {phase === "loading" && <Loading what="Shuffling the lines…" />}
      {phase === "error" && <Empty title="The lines didn't load."><p>The arcade couldn't reach where the lines are kept.</p></Empty>}
      {phase === "empty" && <Empty title="No lines yet."><p>Who Said It needs some lines to guess at. There aren't any yet.</p></Empty>}
      {(phase === "guess" || phase === "reveal") && line && (
        <div className={`ta-who${phase === "reveal" ? (right ? " is-right" : " is-wrong") : ""}`} data-by={phase === "reveal" ? by : undefined}>
          <figure className="ta-who-line" key={line.card.id}>
            <blockquote>{line.card.text ?? line.card.title}</blockquote>
            {phase === "reveal" && <span className="ta-who-stamp" aria-hidden="true">{by === "owner" ? <Pen size={22} /> : <Spark size={22} />}</span>}
          </figure>
          {phase === "guess" && (
            <div className="ta-who-answers" role="group" aria-label="Who wrote it?">
              <button type="button" className="ta-who-a" data-said="owner" onClick={() => guess("owner")} aria-keyshortcuts="ArrowLeft 1">
                <Pen size={24} /><span>{labels.owner}</span>
              </button>
              <button type="button" className="ta-who-a" data-said="uni" onClick={() => guess("uni")} aria-keyshortcuts="ArrowRight 2">
                <Spark size={24} /><span>{labels.uni}</span>
              </button>
            </div>
          )}
          {phase === "reveal" && (
            <div className="ta-who-reveal" aria-live="polite">
              <p className="ta-who-verdict"><b>{right ? "Right." : "Not this time."}</b> {whose}</p>
              {by === "owner" && line.card.voice?.origin && <p className="ta-who-why">From {line.card.voice.origin}.</p>}
              {by === "uni" && line.card.voice?.tell && <p className="ta-who-why">The tell: {line.card.voice.tell}</p>}
              <label className="ta-field">
                <span>What gave it away? <small>(optional)</small></span>
                <input type="text" value={words} maxLength={400} placeholder={by === "uni" ? "too tidy at the end" : "that's how I talk"}
                  onChange={(e) => { setWords(e.target.value); if (pending.current) pending.current.words = e.target.value; }}
                  onKeyDown={(e) => { if (e.key === "Enter") next(); }} />
              </label>
              <button ref={nextBtn} type="button" className="ta-btn ta-btn-go" onClick={next}>
                {idx + 1 >= lines.length ? "That's the stack" : "Next line"} <Next size={20} />
              </button>
            </div>
          )}
        </div>
      )}
      {phase === "end" && (
        <BurstEnd title="That's the stack." line={`You knew ${score.right} of ${score.total}.`} seeds={seedsOf(session)} noticed={null}
          again={() => setRun((r) => r + 1)} againLabel="Another stack">
          <p className="ta-end-note">
            {score.fooled
              ? `${cloud ? "The machine" : uni ?? "Uni"} fooled you ${score.fooled === 1 ? "once" : `${score.fooled} times`}. Those lines teach it the most about how you sound.`
              : `${cloud ? "The machine" : uni ?? "Uni"} didn't fool you once. It'll study the lines you caught.`}
          </p>
        </BurstEnd>
      )}
      <SaveNote failed={failed} retry={() => void retry()} busy={busy} />
    </GameFrame>
  );
}
