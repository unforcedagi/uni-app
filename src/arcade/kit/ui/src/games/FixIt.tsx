// Fix It: Uni made something a little off. Slide it right (it re-draws as you go), say why in a few words if you like,
// then see Uni's hunch next to what you did: the gap between the two is the lesson.
import { useEffect, useMemo, useState } from "react";
import type { Artifact, Card, Round } from "../../../engine/src/types.ts";
import { ArtifactView } from "../cards/ArtifactView.tsx";
import { AskLine, BurstEnd, Empty, GameFrame, Loading, SaveNote } from "../kit/frame.tsx";
import { reaction, useArcade, useSaver } from "../kit/hooks.ts";
import { andList, noticed, seedsOf } from "../kit/lesson.ts";
import { Next } from "../kit/icons.tsx";

type Piece = Extract<Round, { game: "fix-it" }>;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** "You went warmer and slower." from what moved, biggest first. */
export function whatYouDid(art: Artifact, nudges: Record<string, number>): string {
  const moved = art.axes
    .map((a) => ({ a, d: nudges[a.key] ?? 0 }))
    .filter((x) => Math.abs(x.d) >= 0.15)
    .sort((x, y) => Math.abs(y.d) - Math.abs(x.d))
    .map((x) => (x.d > 0 ? x.a.high : x.a.low));
  return moved.length ? `You went ${andList(moved)}.` : "You left it as it was. Maybe it wasn't off to you.";
}

function Slider({ axis, value, onChange }: { axis: Artifact["axes"][number]; value: number; onChange: (v: number) => void }) {
  const toward = value >= 0 ? axis.high : axis.low;
  const pct = Math.round(Math.abs(value) * 100);
  return (
    <label className="ta-axis" style={{ ["--v" as string]: (value + 1) / 2 }}>
      <span className="ta-axis-ends" aria-hidden="true"><span>{axis.low}</span><span>{axis.high}</span></span>
      <input type="range" min={-1} max={1} step={0.01} value={value} onChange={(e) => onChange(Number(e.target.value))}
        aria-label={`${axis.low} to ${axis.high}`} aria-valuetext={pct < 5 ? "in the middle" : `${pct}% ${toward}`} />
    </label>
  );
}

export function FixIt() {
  const { host, uni, deal } = useArcade();
  const [phase, setPhase] = useState<"loading" | "fix" | "reveal" | "end" | "empty" | "error">("loading");
  const [pieces, setPieces] = useState<Piece[]>([]);
  const [idx, setIdx] = useState(0);
  const [params, setParams] = useState<Record<string, number>>({});
  const [words, setWords] = useState("");
  const [last, setLast] = useState<{ nudges: Record<string, number>; words: string } | null>(null);
  const [run, setRun] = useState(0);
  const { session, save, retry, clear, failed, busy } = useSaver();

  useEffect(() => {
    let live = true;
    setPhase("loading"); setIdx(0); clear();
    host.rounds("fix-it", 4, deal).then(
      (rs) => { if (!live) return; const g = rs.filter((r): r is Piece => r.game === "fix-it" && !!r.card.artifact); setPieces(g); setPhase(g.length ? "fix" : "empty"); },
      () => { if (live) setPhase("error"); },
    );
    return () => { live = false; };
  }, [host, run, clear, deal]);

  const ask = pieces[idx]?.ask;
  const card: Card | undefined = pieces[idx]?.card;
  const art = card?.artifact;
  useEffect(() => {
    if (art) { setParams({ ...Object.fromEntries(art.axes.map((a) => [a.key, 0])), ...art.params }); setWords(""); }
  }, [card?.id, run]);

  const done = () => {
    if (!card || !art) return;
    const nudges = Object.fromEntries(art.axes.map((a) => [a.key, round2((params[a.key] ?? 0) - (art.params[a.key] ?? 0))]));
    const w = words.trim();
    void save([reaction("fix-it", "nudge", card.id, { nudges, ...(ask ? { dimension: ask.dimension } : {}), ...(w ? { words: w } : {}) })]);
    setLast({ nudges, words: w });
    setPhase("reveal");
  };

  const next = () => {
    if (idx + 1 >= pieces.length) { setPhase("end"); host.distill?.().catch(() => undefined); return; }
    setIdx(idx + 1);
    setPhase("fix");
  };

  const lesson = useMemo(() => (phase === "end" ? noticed(pieces.map((p) => p.card), session) : null), [phase, pieces, session]);
  const who = uni ? `${uni} thought` : "The hunch was";

  return (
    <GameFrame game="fix-it" title="Fix It" corner={pieces.length ? <span className="ta-quiet-count">{Math.min(idx + 1, pieces.length)} of {pieces.length}</span> : null} wide>
      {phase === "loading" && <Loading what="Getting the first piece off the bench…" />}
      {phase === "error" && <Empty title="The bench is out of reach."><p>The arcade couldn't load anything to fix. Try again in a moment.</p></Empty>}
      {phase === "empty" && <Empty title="Nothing to fix yet." screen><p>{uni ?? "The arcade"} hasn't made anything for you to fix. Check back later.</p></Empty>}
      {phase === "fix" && card && art && (
        <div className="ta-fix">
          <div className="ta-fix-bench">
            <ArtifactView card={card} params={params} />
          </div>
          <div className="ta-fix-tools">
            {ask && <AskLine ask={ask} />}
            <p className="ta-fix-what">{card.title}. Something's a little off.</p>
            <div className="ta-axes">
              {art.axes.map((a) => <Slider key={a.key} axis={a} value={params[a.key] ?? 0} onChange={(v) => setParams((p) => ({ ...p, [a.key]: v }))} />)}
            </div>
            <label className="ta-field">
              <span>In your words <small>(optional)</small></span>
              <input type="text" value={words} maxLength={400} placeholder={ask?.dimension === "words" ? "less corporate" : ask?.dimension === "motion" ? "calmer, it fusses" : "more room to breathe"} onChange={(e) => setWords(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") done(); }} />
            </label>
            <div className="ta-fix-go">
              <button type="button" className="ta-btn ta-btn-quiet" onClick={() => setParams({ ...art.params })}>Put it back</button>
              <button type="button" className="ta-btn ta-btn-go" onClick={done}>Done</button>
            </div>
          </div>
        </div>
      )}
      {phase === "reveal" && card && art && last && (
        <div className="ta-fix-reveal" aria-live="polite">
          <div className="ta-fix-pair">
            <figure><ArtifactView card={card} params={art.params} small /><figcaption>{uni ? `${uni}'s` : "Before"}</figcaption></figure>
            <span className="ta-fix-arrow" aria-hidden="true"><Next size={28} /></span>
            <figure><ArtifactView card={card} params={params} small /><figcaption>Yours</figcaption></figure>
          </div>
          <p className="ta-fix-hunch"><span>{who}:</span> {art.hunch.replace(/\.$/, "")}.</p>
          <p className="ta-fix-you">{whatYouDid(art, last.nudges)}</p>
          {last.words && <p className="ta-fix-words">In your words: <q>{last.words}</q></p>}
          <button type="button" className="ta-btn ta-btn-go" onClick={next} autoFocus>
            {idx + 1 >= pieces.length ? "See what it learned" : "Next piece"} <Next size={20} />
          </button>
        </div>
      )}
      {phase === "end" && (
        <BurstEnd title="The bench is clear." line={`${session.length} ${session.length === 1 ? "piece" : "pieces"} fixed. Every nudge says which way, and how far.`}
          seeds={seedsOf(session)} noticed={lesson} again={() => setRun((r) => r + 1)} againLabel="Fix some more" />
      )}
      <SaveNote failed={failed} retry={() => void retry()} busy={busy} />
    </GameFrame>
  );
}
