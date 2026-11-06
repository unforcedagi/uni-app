// Ripple: one question about how a system should work. Answer out loud (rings spread while it listens) or in writing.
// No timer; the seconds only count up so you know it's listening.
import { useEffect, useRef, useState } from "react";
import type { Round } from "../../../engine/src/types.ts";
import { AskLine, BurstEnd, Empty, GameFrame, Loading, SaveNote } from "../kit/frame.tsx";
import { reaction, useArcade, useSaver } from "../kit/hooks.ts";
import { seedsOf } from "../kit/lesson.ts";
import { Keyboard, Mic, Next } from "../kit/icons.tsx";

type Q = Extract<Round, { game: "ripple" }>;
type Phase = "loading" | "ask" | "listening" | "saving" | "kept" | "end" | "empty" | "error";

function clock(s: number): string {
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
}

export function Ripple() {
  const { host, calm, deal } = useArcade();
  const voice = host.voice;
  const [phase, setPhase] = useState<Phase>("loading");
  const [qs, setQs] = useState<Q[]>([]);
  const [idx, setIdx] = useState(0);
  const [typing, setTyping] = useState(!voice);
  const [text, setText] = useState("");
  const [secs, setSecs] = useState(0);
  const [note, setNote] = useState("");
  const [run, setRun] = useState(0);
  const { session, save, retry, clear, failed, busy } = useSaver();
  const rings = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let live = true;
    setPhase("loading"); setIdx(0); clear();
    host.rounds("ripple", 5, deal).then(
      (rs) => { if (!live) return; const g = rs.filter((r): r is Q => r.game === "ripple"); setQs(g); setPhase(g.length ? "ask" : "empty"); },
      () => { if (live) setPhase("error"); },
    );
    return () => { live = false; };
  }, [host, run, clear, deal]);

  // while listening: the seconds, and the rings following the voice's level
  useEffect(() => {
    if (phase !== "listening") return;
    const t0 = performance.now();
    const t = setInterval(() => setSecs((performance.now() - t0) / 1000), 250);
    let raf = 0;
    const loop = () => {
      const lv = voice?.level?.() ?? 0.35;
      rings.current?.style.setProperty("--lvl", String(Math.max(0, Math.min(1, lv)).toFixed(3)));
      raf = requestAnimationFrame(loop);
    };
    if (!calm) raf = requestAnimationFrame(loop);
    return () => { clearInterval(t); cancelAnimationFrame(raf); };
  }, [phase, voice, calm]);

  // leaving mid-recording, or while the mic is still opening, throws it away rather than leaving the mic open
  const listening = useRef(false);
  listening.current = phase === "listening";
  const starting = useRef(false);
  const [opening, setOpening] = useState(false);
  useEffect(() => () => { if (listening.current || starting.current) voice?.cancel(); }, [voice]);

  const q = qs[idx];
  // in the app a recording, or a typed answer the host keeps, lands in the journal; otherwise it only joins the taste
  const inJournal = (how: "voice" | "typed") => !host.owner.you && (how === "voice" || !!host.saveAnswer);
  const keptLine = (how: "voice" | "typed", ok: boolean) => ok
    ? (inJournal(how) ? "In your journal. Uni will fold it into Systems." : "Kept with your taste.")
    : (inJournal(how) ? "In your journal, but not in your taste yet: the arcade couldn't reach it. Try again below." : "Not saved yet: the arcade couldn't reach where your taste is kept. Try again below.");
  const kept = keptLine(typing ? "typed" : "voice", true);

  const start = async () => {
    if (!voice || starting.current) return; // a second tap while the mic opens is the same tap
    starting.current = true;
    setOpening(true);
    setNote("");
    try {
      await voice.start();
      setSecs(0);
      setPhase("listening");
    } catch (e) {
      setNote(`${e instanceof Error && e.message ? e.message : "The microphone isn't available."} You can write the answer instead.`);
      setTyping(true);
    } finally {
      starting.current = false;
      setOpening(false);
    }
  };

  const stop = async () => {
    if (!voice || !q) return;
    setPhase("saving");
    try {
      const got = await voice.stop();
      if (!got) { setNote("Nothing was kept. Try again, or write it."); setPhase("ask"); return; }
      const ok = await save([reaction("ripple", "voice", q.card.id, { dimension: "systems", voice: { ref: got.ref, seconds: Math.round(got.seconds) }, ...(got.transcript?.trim() ? { words: got.transcript.trim() } : {}) })]);
      setNote(keptLine("voice", ok));
      setPhase("kept");
    } catch (e) {
      setNote(`The recording didn't save${e instanceof Error && e.message ? `: ${e.message}` : ""}. Try again, or write it.`);
      setPhase("ask");
    }
  };

  const cancel = () => { voice?.cancel(); setPhase("ask"); setNote("Thrown away. Nothing was kept."); };

  const keepText = async () => {
    const t = text.trim();
    if (!t || !q) { area.current?.focus(); setNote("Write a few words first."); return; }
    setPhase("saving");
    try {
      await host.saveAnswer?.(q.card, t);
    } catch (e) {
      setNote(`That didn't save${e instanceof Error && e.message ? `: ${e.message}` : ""}. Your words are still here; try again.`);
      setPhase("ask");
      return;
    }
    const ok = await save([reaction("ripple", "words", q.card.id, { dimension: "systems", words: t })]);
    setNote(keptLine("typed", ok));
    setText("");
    setPhase("kept");
  };

  const next = () => {
    setNote("");
    if (idx + 1 >= qs.length) { setPhase("end"); host.distill?.().catch(() => undefined); return; }
    setIdx(idx + 1);
    setTyping(!voice);
    setPhase("ask");
  };

  return (
    <GameFrame game="ripple" title="Ripple" corner={qs.length ? <span className="ta-quiet-count">{Math.min(idx + 1, qs.length)} of {qs.length}</span> : null}>
      <div className="ta-water" aria-hidden="true"><i /><i /><i /></div>
      {phase === "loading" && <Loading what="Finding a question…" />}
      {phase === "error" && <Empty title="The questions didn't load."><p>The arcade couldn't reach where the questions are kept.</p></Empty>}
      {phase === "empty" && <Empty title="No questions yet."><p>Ripple asks how things should work. There aren't any questions yet.</p></Empty>}
      {q && (phase === "ask" || phase === "listening" || phase === "saving" || phase === "kept") && (
        <div className={`ta-rip${phase === "listening" ? " is-listening" : ""}`}>
          <AskLine ask={q.ask} />
          <p className="ta-rip-q">{q.card.text ?? q.card.title}</p>
          {phase === "kept" ? (
            <div className="ta-rip-kept" role="status">
              <span className="ta-rip-stone" aria-hidden="true" />
              <p>{note || kept}</p>
              <button type="button" className="ta-btn ta-btn-go" onClick={next} autoFocus>
                {idx + 1 >= qs.length ? "That's all for now" : "Next question"} <Next size={20} />
              </button>
            </div>
          ) : !typing ? (
            <div className="ta-rip-voice">
              <div className="ta-rip-rings" ref={rings} aria-hidden="true"><i /><i /><i /></div>
              {phase === "listening" ? (
                <button type="button" className="ta-rip-mic is-on" onClick={() => void stop()} aria-label="Keep it: stop and save the answer">
                  <span className="ta-rip-stop" aria-hidden="true" />
                </button>
              ) : (
                <button type="button" className="ta-rip-mic" onClick={() => void start()} disabled={phase === "saving" || opening} aria-label="Answer out loud">
                  <Mic size={34} />
                </button>
              )}
              <p className="ta-rip-hint" aria-live="polite">
                {phase === "listening" ? <>Listening <span className="ta-rip-clock">{clock(secs)}</span>. Tap to keep it.</> : phase === "saving" ? "Keeping it…" : "Tap and say it however it comes."}
              </p>
              <div className="ta-rip-alt">
                {phase === "listening"
                  ? <button type="button" className="ta-btn ta-btn-quiet" onClick={cancel}>Throw it away</button>
                  : <button type="button" className="ta-btn ta-btn-quiet" disabled={opening} onClick={() => { setTyping(true); setNote(""); }}><Keyboard size={20} /> Write it instead</button>}
              </div>
            </div>
          ) : (
            <div className="ta-rip-write">
              <label className="ta-field">
                <span>Your answer</span>
                <textarea ref={area} value={text} rows={5} maxLength={4000} onChange={(e) => setText(e.target.value)} placeholder="However it comes. A sentence is plenty." />
              </label>
              <div className="ta-rip-go">
                {voice && <button type="button" className="ta-btn ta-btn-quiet" onClick={() => { setTyping(false); setNote(""); }}><Mic size={20} /> Say it instead</button>}
                <button type="button" className="ta-btn ta-btn-go" onClick={() => void keepText()} disabled={phase === "saving"}>{phase === "saving" ? "Keeping…" : "Keep it"}</button>
              </div>
            </div>
          )}
          {note && phase !== "kept" && <p className="ta-rip-note" role="status">{note}</p>}
        </div>
      )}
      {phase === "end" && (
        <BurstEnd title="The water's still again." line={`${session.length} ${session.length === 1 ? "answer" : "answers"}, in your own words.`} seeds={seedsOf(session)} noticed={null}
          again={() => setRun((r) => r + 1)} againLabel="More questions">
          {session.length > 0 && <p className="ta-end-note">{host.owner.you ? "They're kept with your taste, under Systems." : "Uni folds them into the Systems part of your taste."}</p>}
        </BurstEnd>
      )}
      <SaveNote failed={failed} retry={() => void retry()} busy={busy} />
    </GameFrame>
  );
}
