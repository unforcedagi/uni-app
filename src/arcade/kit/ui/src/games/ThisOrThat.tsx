// This or That: two things, tap one. A minute-long burst under a sun that crosses the sky; the chosen side blooms, the
// other folds away, a soft tick, a seed. Keys: ← or A for the first, → or L for the second, ↓ or S to skip.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Card, Round } from "../../../engine/src/types.ts";
import { CardView } from "../cards/CardView.tsx";
import { AskLine, BurstEnd, Empty, GameFrame, Loading, SaveNote, SeedCount } from "../kit/frame.tsx";
import { reaction, tick, useArcade, useKeys, useSaver } from "../kit/hooks.ts";
import { noticed, seedsOf } from "../kit/lesson.ts";
import { SoundOff, SoundOn } from "../kit/icons.tsx";

type Pair = Extract<Round, { game: "this-or-that" }>;
type Phase = "loading" | "play" | "end" | "empty" | "error";

const BATCH = 24;
const pairKey = (r: Pair) => [r.a.id, r.b.id].sort().join("|");

function Horizon({ left, total }: { left: number; total: number }) {
  const p = Math.max(0, Math.min(1, 1 - left / total));
  const th = Math.PI * (1 - p);
  const x = 50 + 46 * Math.cos(th);
  const y = 30 - 24 * Math.sin(th);
  const secs = Math.ceil(left / 1000);
  const words = secs > 45 ? "Most of a minute left" : secs > 20 ? "About half left" : secs > 5 ? "Nearly done" : "Last few seconds";
  return (
    <div className="ta-horizon" role="timer" aria-label={total >= 50_000 ? words : `${secs} ${secs === 1 ? "second" : "seconds"} left`} aria-live="off">
      <svg viewBox="0 0 100 32" preserveAspectRatio="none" aria-hidden="true">
        <path className="ta-horizon-sky" d="M4 30 A46 24 0 0 1 96 30" />
        <line className="ta-horizon-ground" x1="0" y1="30" x2="100" y2="30" />
      </svg>
      <i className="ta-horizon-sun" style={{ left: `${x}%`, top: `${(y / 32) * 100}%` }} aria-hidden="true" />
    </div>
  );
}

function Side({ side, card, state, onPick, long }: { side: "a" | "b"; card: Card; state: "" | "is-chosen" | "is-folded"; onPick: () => void; long: boolean }) {
  const key = side === "a" ? "A" : "L";
  return (
    <div className={`ta-side ${state}`} data-side={side}>
      <button type="button" className="ta-side-hit" onClick={onPick} disabled={state !== ""}
        aria-label={`This one: ${card.title}`} aria-keyshortcuts={side === "a" ? "ArrowLeft A" : "ArrowRight L"} />
      <CardView card={card} bare long={long} />
      <span className="ta-side-key" aria-hidden="true">{side === "a" ? "←" : "→"} {key}</span>
    </div>
  );
}

export function ThisOrThat() {
  const { host, calm, burstSeconds, grey, setGrey, deal } = useArcade();
  const total = burstSeconds * 1000;
  const [phase, setPhase] = useState<Phase>("loading");
  const [rounds, setRounds] = useState<Pair[]>([]);
  const [idx, setIdx] = useState(0);
  const [picked, setPicked] = useState<"a" | "b" | null>(null);
  const [left, setLeft] = useState(total);
  const [sound, setSound] = useState(() => { try { return localStorage.getItem("ta-tick") !== "off"; } catch { return true; } });
  const [said, setSaid] = useState("");
  const [run, setRun] = useState(0);
  const { session, save, retry, clear, failed, busy } = useSaver();
  const seen = useRef(new Map<string, Card>());
  // a refill in flight never blocks a fresh burst: each burst has its own generation, and late answers are dropped
  const gen = useRef(0);
  const refilling = useRef(false);
  const idxRef = useRef(0);
  const ending = useRef(false);


  const fetchMore = useCallback(async (reset: boolean) => {
    if (!reset && refilling.current) return;
    if (reset) refilling.current = false; // a refill from the last burst no longer counts
    const mine = reset ? ++gen.current : gen.current;
    if (!reset) refilling.current = true;
    try {
      const got = (await host.rounds("this-or-that", BATCH, deal)).filter((r): r is Pair => r.game === "this-or-that");
      if (mine !== gen.current) return;
      if (reset) { setRounds(got); setPhase(got.length ? "play" : "empty"); return; }
      // the host doesn't know what's queued here: skip pairs still waiting or just played
      setRounds((rs) => {
        const near = new Set(rs.slice(Math.max(0, idxRef.current - 6)).map(pairKey));
        const fresh = got.filter((r) => !near.has(pairKey(r)));
        // a small deck has nothing new to give: repeats then beat ending with the sun still up
        return [...rs, ...(fresh.length ? fresh : got)];
      });
    } catch {
      if (reset && mine === gen.current) setPhase("error");
    } finally {
      if (!reset && mine === gen.current) refilling.current = false;
    }
  }, [host, deal]);

  useEffect(() => {
    setPhase("loading"); setIdx(0); setPicked(null); setLeft(total); ending.current = false; clear();
    void fetchMore(true);
  }, [run, fetchMore, total, clear]);

  // the sun: runs only while playing and while the page is in view
  useEffect(() => {
    if (phase !== "play") return;
    let last = performance.now();
    const t = setInterval(() => {
      const now = performance.now();
      const dt = document.hidden ? 0 : now - last;
      last = now;
      setLeft((l) => Math.max(0, l - dt));
    }, 200);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => {
    if (phase === "play" && left <= 0 && !picked) end();
  }, [left, phase, picked]);

  const end = () => {
    if (ending.current) return;
    ending.current = true;
    setPhase("end");
    host.distill?.().catch(() => undefined);
  };

  const round = rounds[idx];
  const long = !!round && [round.a, round.b].some((c) => (c.text ?? "").length > 140);
  idxRef.current = idx;
  const count = useRef(0);
  count.current = rounds.length;
  useEffect(() => { if (round) { seen.current.set(round.a.id, round.a); seen.current.set(round.b.id, round.b); } }, [round]);
  // scrolled down to the note below the game? each new pair brings its question back
  const askEl = useRef<HTMLDivElement>(null);
  useEffect(() => { askEl.current?.scrollIntoView?.({ block: "nearest" }); }, [idx]);

  const advance = () => {
    setPicked(null);
    const next = idx + 1;
    if (next >= count.current - 3) void fetchMore(false);
    if (next >= count.current) { end(); return; }
    setIdx(next);
  };

  const choose = (side: "a" | "b") => {
    if (phase !== "play" || picked || !round) return;
    const win = side === "a" ? round.a : round.b;
    const lose = side === "a" ? round.b : round.a;
    void save([reaction("this-or-that", "pick", win.id, { other: lose.id, dimension: round.ask.dimension })]);
    setPicked(side);
    setSaid(`Picked ${win.title}.`);
    if (sound) tick(side === "a" ? 1 : 1.12);
    setTimeout(advance, calm ? 160 : 460);
  };

  const skip = () => {
    if (phase !== "play" || picked) return;
    setSaid("Skipped.");
    advance();
  };

  useKeys((e) => {
    if (phase !== "play") return;
    const k = e.key.toLowerCase();
    if (k === "arrowleft" || k === "a") { e.preventDefault(); choose("a"); }
    else if (k === "arrowright" || k === "l") { e.preventDefault(); choose("b"); }
    else if (k === "arrowdown" || k === "s") { e.preventDefault(); skip(); }
  });

  const toggleSound = () => {
    setSound((s) => { try { localStorage.setItem("ta-tick", s ? "off" : "on"); } catch { /* fine */ } return !s; });
  };

  const seeds = seedsOf(session);
  const picks = session.length;
  const lesson = useMemo(() => (phase === "end" ? noticed(seen.current.values(), session) : null), [phase, session]);

  const corner = (
    <>
      <SeedCount n={seeds} />
      <button type="button" className="ta-iconbtn" onClick={toggleSound} aria-pressed={sound} aria-label={sound ? "Tick sound on" : "Tick sound off"}>
        {sound ? <SoundOn size={20} /> : <SoundOff size={20} />}
      </button>
    </>
  );

  return (
    <GameFrame game="this-or-that" title="This or That" corner={corner} wide>
      {phase === "loading" && <Loading what="Laying out the first pair…" />}
      {phase === "error" && <Empty title="The pairs didn't load."><p>The arcade couldn't reach where your cards are kept. Try again in a moment.</p></Empty>}
      {phase === "empty" && <Empty title="Nothing to compare yet."><p>This or That needs at least two things of a kind. Add some cards and come back.</p></Empty>}
      {phase === "play" && round && (
        <>
          <Horizon left={left} total={total} />
          <div ref={askEl} className="ta-ask-wrap"><AskLine ask={round.ask} /></div>
          <div className="ta-tot" data-picked={picked ?? ""} data-kind={round.a.kind} data-dimension={round.ask.dimension}>
            <Side key={`a-${idx}`} side="a" card={round.a} state={picked === "a" ? "is-chosen" : picked === "b" ? "is-folded" : ""} onPick={() => choose("a")} long={long} />
            <span className="ta-tot-or" aria-hidden="true">or</span>
            <Side key={`b-${idx}`} side="b" card={round.b} state={picked === "b" ? "is-chosen" : picked === "a" ? "is-folded" : ""} onPick={() => choose("b")} long={long} />
          </div>
          <div className="ta-tot-foot">
            <button type="button" className="ta-btn ta-btn-quiet" onClick={skip} disabled={!!picked} aria-keyshortcuts="ArrowDown S">Neither, skip</button>
            {round.ask.dimension === "colour" && !grey && <button type="button" className="ta-btn ta-btn-quiet" onClick={() => setGrey(true)}>No colour here? Switch to greyscale</button>}
          </div>
          <p className="ta-sr" aria-live="polite">{said}</p>
        </>
      )}
      {phase === "end" && (
        <BurstEnd
          title={left <= 0 ? "That's a minute." : "That's every pair for now."}
          line={picks ? `${picks} ${picks === 1 ? "pick" : "picks"}. Each one teaches a little.` : "No picks this time. That's fine too."}
          seeds={seeds} noticed={lesson} again={() => setRun((r) => r + 1)} againLabel="Another minute" />
      )}
      <SaveNote failed={failed} retry={() => void retry()} busy={busy} />
    </GameFrame>
  );
}
