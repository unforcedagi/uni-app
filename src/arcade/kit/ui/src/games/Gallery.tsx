// The Gallery: a slow wander, one thing at a time with the next one waiting at the edge. Sounds play softly when they
// come into focus, clips loop quietly. Pin what pulls, with a few words if they come. No timer; leave any time.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Round } from "../../../engine/src/types.ts";
import { CardView } from "../cards/CardView.tsx";
import { BurstEnd, Empty, GameFrame, Loading, SaveNote } from "../kit/frame.tsx";
import { reaction, useArcade, useKeys, useSaver } from "../kit/hooks.ts";
import { noticed, seedsOf } from "../kit/lesson.ts";
import { Back, Next, Pin } from "../kit/icons.tsx";

type Item = Extract<Round, { game: "gallery" }>;

export function Gallery() {
  const { host } = useArcade();
  const [phase, setPhase] = useState<"loading" | "wander" | "end" | "empty" | "error">("loading");
  const [items, setItems] = useState<Item[]>([]);
  const [idx, setIdx] = useState(0);
  const [pinned, setPinned] = useState(false);
  const [words, setWords] = useState("");
  const [pins, setPins] = useState(0);
  const [said, setSaid] = useState("");
  const [run, setRun] = useState(0);
  const { session, save, retry, clear, failed, busy } = useSaver();
  // what to commit when the card is left: a pin waits for its words until then
  const pending = useRef<{ card: string; words: string } | null>(null);
  const doneIds = useRef(new Set<string>());

  useEffect(() => {
    let live = true;
    setPhase("loading"); setIdx(0); setPins(0); clear();
    host.rounds("gallery", 14).then(
      (rs) => { if (!live) return; const g = rs.filter((r): r is Item => r.game === "gallery"); setItems(g); setPhase(g.length ? "wander" : "empty"); },
      () => { if (live) setPhase("error"); },
    );
    return () => { live = false; };
  }, [host, run, clear]);

  const commit = () => {
    const p = pending.current;
    pending.current = null;
    if (!p || doneIds.current.has(p.card)) return;
    doneIds.current.add(p.card);
    void save([reaction("gallery", "pin", p.card, p.words.trim() ? { words: p.words.trim() } : {})]);
  };

  // leaving the Gallery mid-wander still keeps the pin
  const commitRef = useRef(commit);
  commitRef.current = commit;
  useEffect(() => () => commitRef.current(), []);

  const item = items[idx];
  const kept = !!item && doneIds.current.has(item.card.id);
  useEffect(() => { setPinned(!!items[idx] && doneIds.current.has(items[idx].card.id)); setWords(""); }, [idx, run, items]);

  const togglePin = () => {
    if (!item || kept) return;
    if (pinned) { pending.current = null; setPinned(false); setPins((n) => n - 1); setSaid("Unpinned."); return; }
    pending.current = { card: item.card.id, words };
    setPinned(true);
    setPins((n) => n + 1);
    setSaid(`Pinned ${item.card.title}.`);
  };

  const go = (d: 1 | -1) => {
    const next = idx + d;
    if (next < 0) return;
    commit();
    if (next >= items.length) { setPhase("end"); host.distill?.().catch(() => undefined); return; }
    setIdx(next);
  };

  useKeys((e) => {
    if (phase !== "wander") return;
    const k = e.key.toLowerCase();
    if (k === "arrowright" || k === " ") { e.preventDefault(); go(1); }
    else if (k === "arrowleft") { e.preventDefault(); go(-1); }
    else if (k === "p") { e.preventDefault(); togglePin(); }
  });

  const lesson = useMemo(() => (phase === "end" ? noticed(items.map((i) => i.card), session) : null), [phase, items, session]);
  const ahead = items[idx + 1];

  return (
    <GameFrame game="gallery" title="The Gallery" corner={<span className="ta-quiet-count">{pins} pinned</span>} wide>
      {phase === "loading" && <Loading what="Opening the doors…" />}
      {phase === "error" && <Empty title="The Gallery didn't open."><p>The arcade couldn't reach where your pictures and sounds are kept.</p></Empty>}
      {phase === "empty" && <Empty title="Nothing hanging yet."><p>The Gallery shows pictures, sounds and clips. There aren't any yet.</p></Empty>}
      {phase === "wander" && item && (
        <div className="ta-gal">
          <div className="ta-gal-room">
            <div className="ta-gal-piece" key={item.card.id} data-pinned={pinned}>
              <CardView card={item.card} focused autoPlay />
              {pinned && <span className="ta-gal-pinmark" aria-hidden="true"><Pin size={20} /></span>}
            </div>
            {ahead && (
              <button type="button" className="ta-gal-ahead" onClick={() => go(1)} aria-label={`Drift on to ${ahead.card.title}`} tabIndex={-1}>
                <span aria-hidden="true">{ahead.card.title}</span>
              </button>
            )}
          </div>
          <div className="ta-gal-tray">
            <p className="ta-gal-title">
              <span>{item.card.title}</span>
              {item.card.blurb && <small>{item.card.blurb}</small>}
            </p>
            <div className="ta-gal-acts">
              <button type="button" className={`ta-btn ta-pin${pinned ? " is-on" : ""}`} onClick={togglePin} aria-pressed={pinned} disabled={kept} aria-keyshortcuts="P">
                <Pin size={20} /> {pinned ? "Pinned" : "Pin it"}
              </button>
              {pinned && !kept && (
                <label className="ta-field ta-gal-words">
                  <span>What pulls you? <small>(optional)</small></span>
                  <input type="text" value={words} maxLength={400} placeholder="the light on the left"
                    onChange={(e) => { setWords(e.target.value); if (pending.current) pending.current.words = e.target.value; }}
                    onKeyDown={(e) => { if (e.key === "Enter") go(1); }} />
                </label>
              )}
            </div>
            <div className="ta-gal-nav">
              <button type="button" className="ta-btn ta-btn-quiet" onClick={() => go(-1)} disabled={idx === 0} aria-label="Back one">
                <Back size={20} />
              </button>
              <span className="ta-gal-where">{idx + 1} of {items.length}</span>
              <button type="button" className="ta-btn ta-btn-go" onClick={() => go(1)}>
                {ahead ? "Drift on" : "Finish the wander"} <Next size={20} />
              </button>
            </div>
          </div>
          <p className="ta-sr" aria-live="polite">{said}</p>
        </div>
      )}
      {phase === "end" && (
        <BurstEnd title="End of the wander." line={pins ? `You pinned ${pins}. Pins weigh more than taps.` : "Nothing pinned this time. Wandering counts too."}
          seeds={seedsOf(session)} noticed={lesson} again={() => { doneIds.current.clear(); setRun((r) => r + 1); }} againLabel="Wander again" />
      )}
      <SaveNote failed={failed} retry={() => void retry()} busy={busy} />
    </GameFrame>
  );
}
