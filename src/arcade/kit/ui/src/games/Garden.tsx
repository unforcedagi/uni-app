// Garden: the taste profile as five beds. Each claim is a plant, taller the surer it is, with a bloom for each
// reaction behind it (up to six); what pulls grows round flowers, what you steer away from grows thistles. Ripple
// answers lie as stones in Systems. Tap a plant to water it ("That's me"), prune it, or push it back ("Not me").
import { useEffect, useMemo, useRef, useState } from "react";
import type { Answer, Claim, ClaimVerdict, Domain, Profile, Stats } from "../../../engine/src/types.ts";
import { DOMAINS, DOMAIN_NAMES } from "../../../engine/src/types.ts";
import { applyVerdicts } from "../../../engine/src/distill.ts";
import { Empty, GameFrame, Loading, SaveNote, SeedCount } from "../kit/frame.tsx";
import { hash, reaction, rng, useArcade, useSaver } from "../kit/hooks.ts";
import { Can, Download, Hand, Note, Shears, Undo } from "../kit/icons.tsx";

export function strengthWord(w: number): string {
  return w >= 0.75 ? "strong" : w >= 0.45 ? "clear" : "faint";
}

const isAgainst = (c: Claim) => c.id.endsWith("-");

/** One plant, drawn: a stem that leans a little, leaves by weight, a head per reaction behind it. */
export function PlantArt({ claim, scale = 1 }: { claim: Claim; scale?: number }) {
  const r = rng(hash(claim.id));
  const w = Math.max(0.12, Math.min(1, claim.weight));
  const h = (54 + w * 104) * scale;
  const lean = (r() - 0.5) * 14;
  const heads = Math.max(1, Math.min(6, claim.evidence));
  const leaves = 1 + Math.round(w * 3);
  const W = 64;
  const top = { x: W / 2 + lean, y: 14 };
  const stem = `M${W / 2} ${h} C${W / 2 - lean * 0.4} ${h * 0.62} ${top.x + lean * 0.3} ${h * 0.34} ${top.x} ${top.y}`;
  const against = isAgainst(claim);
  return (
    <svg className="ta-plant-art" width={W} height={h} viewBox={`0 0 ${W} ${h}`} aria-hidden="true">
      <path className="ta-plant-stem" d={stem} />
      {Array.from({ length: leaves }, (_, i) => {
        const t = 0.35 + (i / leaves) * 0.5;
        const y = h - (h - top.y) * t;
        const x = W / 2 + lean * t * 0.8;
        const side = i % 2 ? 1 : -1;
        return <path key={i} className="ta-plant-leaf" d={`M${x} ${y} q${side * 14} ${-10} ${side * 20} ${-2} q${-side * 8} ${8} ${-side * 20} ${2}Z`} />;
      })}
      {Array.from({ length: heads }, (_, i) => {
        const a = (i / heads) * Math.PI * 2 + r();
        const d = i === 0 ? 0 : 8 + r() * 5;
        const x = top.x + Math.cos(a) * d;
        const y = top.y + 2 + Math.sin(a) * d * 0.7;
        const s = i === 0 ? 7.5 : 4.5;
        if (against) {
          const pts = Array.from({ length: 14 }, (_, k) => {
            const ang = (k / 14) * Math.PI * 2;
            const rad = k % 2 ? s * 0.45 : s * 1.15;
            return `${(x + Math.cos(ang) * rad).toFixed(1)},${(y + Math.sin(ang) * rad).toFixed(1)}`;
          }).join(" ");
          return <polygon key={i} className="ta-plant-thistle" points={pts} />;
        }
        return (
          <g key={i} className="ta-plant-bloom">
            {[0, 1, 2, 3, 4].map((k) => <circle key={k} cx={x + Math.cos((k / 5) * Math.PI * 2) * s * 0.62} cy={y + Math.sin((k / 5) * Math.PI * 2) * s * 0.62} r={s * 0.55} />)}
            <circle className="ta-plant-eye" cx={x} cy={y} r={s * 0.34} />
          </g>
        );
      })}
    </svg>
  );
}

type Pick = { kind: "claim"; id: string } | { kind: "answer"; at: string };

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/markdown;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // ours to revoke: we made it
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function Garden() {
  const { host, uni } = useArcade();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [pick, setPick] = useState<Pick | null>(null);
  const [words, setWords] = useState("");
  const [said, setSaid] = useState("");
  const [moved, setMoved] = useState<string | null>(null);
  const [resetAsk, setResetAsk] = useState(false);
  const { save, retry, failed, busy } = useSaver();
  const panel = useRef<HTMLDivElement>(null);

  const load = () => Promise.all([host.profile(), host.stats()]).then(([p, s]) => { setProfile(p); setStats(s); setPhase("ready"); }, () => setPhase("error"));
  useEffect(() => { void load(); }, [host]);

  const claims = profile?.claims ?? [];
  const live = useMemo(() => claims.filter((c) => c.status === "live"), [claims]);
  const notMe = claims.filter((c) => c.status === "not-me");
  const letGo = claims.filter((c) => c.status === "pruned");
  const chosen = pick?.kind === "claim" ? claims.find((c) => c.id === pick.id && c.status === "live") ?? null : null;
  const stone = pick?.kind === "answer" ? profile?.answers.find((a) => a.at === pick.at) ?? null : null;

  useEffect(() => { if (pick) panel.current?.focus({ preventScroll: false }); }, [pick]);

  /** `undo`: putting back a claim from Not me or Let go. To the engine that is a "that's me" (what lifts a block), so
   *  it comes back a little stronger, as the engine's own rules say. */
  const verdict = async (c: Claim, v: ClaimVerdict, text = "", undo = false) => {
    const w = text.trim();
    const r = reaction("garden", "claim", c.id, { dimension: "claim", claim: { id: c.id, verdict: v }, ...(w ? { words: w } : {}) });
    setProfile((p) => (p ? applyVerdicts(p, [r]) : p));
    setPick(null);
    setWords("");
    setMoved(c.id);
    setSaid(undo ? `Put back: ${c.text}` : v === "me" ? `Watered: ${c.text}` : v === "prune" ? `Pruned: ${c.text} It comes back only if the evidence grows.` : `Moved to Not me: ${c.text} ${uni ?? "The arcade"} will steer away from it.`);
    const ok = await save([r]);
    if (ok) host.profile().then((p) => setProfile(p), () => undefined);
  };

  const exportIt = async () => {
    if (!host.exportMarkdown) return;
    try { download("my-taste.md", await host.exportMarkdown()); setSaid("Your taste, as one markdown file, is downloading."); }
    catch { setSaid("The export didn't work. Try again in a moment."); }
  };

  const doReset = async () => {
    if (!host.reset) return;
    setResetAsk(false);
    try {
      await host.reset();
    } catch {
      setSaid("Nothing was forgotten: the arcade couldn't reach where your taste is kept. Try again in a moment.");
      return;
    }
    setPick(null);
    setPhase("loading");
    void load();
    setSaid("Everything's forgotten. A fresh garden.");
  };

  const seedDots = Math.min(stats?.seeds ?? 0, 90);

  return (
    <GameFrame game="garden" title="Garden" corner={stats ? <SeedCount n={stats.seeds} label="seeds planted" /> : null} wide>
      {phase === "loading" && <Loading what="Walking out to the garden…" />}
      {phase === "error" && <Empty title="The garden's out of reach."><p>The arcade couldn't load your taste. Try again in a moment.</p></Empty>}
      {phase === "ready" && profile && (
        <div className="ta-gdn">
          <p className="ta-gdn-summary">{profile.summary}</p>
          <p className="ta-gdn-said" aria-live="polite">{said}</p>
          <p className="ta-gdn-legend">
            <span><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7" r="5" className="ta-leg-bloom" /></svg> flowers: what pulls you</span>
            <span><svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><polygon points="7,0 8.5,5 14,7 8.5,9 7,14 5.5,9 0,7 5.5,5" className="ta-leg-thistle" /></svg> thistles: what you steer away from</span>
            <span>Taller is surer.</span>
          </p>
          <div className="ta-gdn-main">
            <div className="ta-beds">
              {DOMAINS.map((d, bi) => {
                const plants = live.filter((c) => c.domain === d);
                const stones = d === "systems" ? profile.answers : [];
                const dots = Math.round(seedDots / DOMAINS.length);
                return (
                  <section key={d} className="ta-bed" data-domain={d} aria-labelledby={`ta-bed-${d}`}>
                    <h2 id={`ta-bed-${d}`} className="ta-bed-name">{DOMAIN_NAMES[d]} <small>{plants.length ? `${plants.length} growing` : stones.length ? `${stones.length} ${stones.length === 1 ? "stone" : "stones"}` : "bare"}</small></h2>
                    <div className="ta-bed-plot">
                      {plants.map((c, i) => (
                        <button key={c.id} type="button" className={`ta-plant${pick?.kind === "claim" && pick.id === c.id ? " is-picked" : ""}${moved === c.id ? " is-watered" : ""}`}
                          style={{ ["--i" as string]: i + bi * 2 }} data-claim={c.id} data-against={isAgainst(c) || undefined}
                          onClick={() => { setPick({ kind: "claim", id: c.id }); setWords(""); }} aria-pressed={pick?.kind === "claim" && pick.id === c.id}
                          aria-label={`${c.text} ${strengthWord(c.weight)}, ${c.evidence} ${c.evidence === 1 ? "reaction" : "reactions"}`}>
                          <PlantArt claim={c} />
                        </button>
                      ))}
                      {stones.map((a: Answer) => (
                        <button key={a.at + a.words.slice(0, 12)} type="button" className={`ta-stone${pick?.kind === "answer" && pick.at === a.at ? " is-picked" : ""}`}
                          onClick={() => setPick({ kind: "answer", at: a.at })} aria-label={`Your answer: ${a.question || "a Ripple"}`}>
                          <span aria-hidden="true" />
                        </button>
                      ))}
                      {!plants.length && !stones.length && <p className="ta-bed-empty">Nothing's come up here yet.</p>}
                      <div className="ta-soil" aria-hidden="true">{Array.from({ length: dots }, (_, k) => <i key={k} style={{ left: `${(hash(d + k) % 1000) / 10}%`, top: `${30 + (hash(k + d) % 50)}%` }} />)}</div>
                    </div>
                  </section>
                );
              })}
            </div>
            <aside className="ta-gdn-side">
              <div className="ta-gdn-panel" ref={panel} tabIndex={-1} role="region" aria-label={chosen ? "The plant you picked" : stone ? "The answer you picked" : "Pick a plant"}>
                {chosen ? (
                  <>
                    <div className="ta-ask" data-dimension="claim"><h2>Is this you?</h2></div>
                    <p className="ta-gdn-claim">{chosen.text}</p>
                    <p className="ta-gdn-meta">{DOMAIN_NAMES[chosen.domain as Domain]}: a {strengthWord(chosen.weight)} {isAgainst(chosen) ? "push away" : "pull"}, from {chosen.evidence} {chosen.evidence === 1 ? "reaction" : "reactions"}.</p>
                    {chosen.quotes.length > 0 && <div className="ta-gdn-quotes">{chosen.quotes.map((q) => <blockquote key={q}>{q}</blockquote>)}</div>}
                    <label className="ta-field">
                      <span>In your words <small>(optional)</small></span>
                      <input type="text" value={words} maxLength={400} onChange={(e) => setWords(e.target.value)} placeholder="only for screens, not paper" />
                    </label>
                    <div className="ta-gdn-acts">
                      <button type="button" className="ta-btn ta-v-me" onClick={() => void verdict(chosen, "me", words)}><Can size={20} /> That's me</button>
                      <button type="button" className="ta-btn ta-v-prune" onClick={() => void verdict(chosen, "prune", words)}><Shears size={20} /> Prune</button>
                      <button type="button" className="ta-btn ta-v-not" onClick={() => void verdict(chosen, "not-me", words)}><Hand size={20} /> Not me</button>
                    </div>
                  </>
                ) : stone ? (
                  <>
                    <p className="ta-gdn-meta">{stone.question || "A Ripple answer"}</p>
                    <blockquote className="ta-gdn-answer">{stone.words}</blockquote>
                    {stone.ref && <p className="ta-gdn-meta">{host.owner.you ? "Kept with your taste." : "In your journal."}</p>}
                  </>
                ) : (
                  <p className="ta-gdn-hint">{live.length ? "Tap a plant to see what it says about you, and to keep it, prune it or push it back." : "Nothing's grown yet. Play a few rounds and the first shoots come up here."}</p>
                )}
              </div>
              <div className="ta-patch" aria-labelledby="ta-patch-h">
                <h3 id="ta-patch-h">Not me</h3>
                {notMe.length ? (
                  <ul>
                    {notMe.map((c) => (
                      <li key={c.id}>
                        <button type="button" className="ta-patch-item" data-claim={c.id} onClick={() => void verdict(c, "me", "", true)} aria-label={`Put back: ${c.text}`}>
                          <s>{c.text}</s> <Undo size={18} />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : <p className="ta-patch-empty">Nothing pushed back. Anything that isn't you goes here, and {uni ?? "the arcade"} steers clear of it.</p>}
                {letGo.length > 0 && (
                  <>
                    <h3>Let go</h3>
                    <ul>
                      {letGo.map((c) => (
                        <li key={c.id}>
                          <button type="button" className="ta-patch-item is-compost" onClick={() => void verdict(c, "me", "", true)} aria-label={`Bring back: ${c.text}`}>
                            <span>{c.text}</span> <Undo size={18} />
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
              {(host.openProfile || host.exportMarkdown || host.reset) && (
                <div className="ta-gdn-out">
                  {host.openProfile && <button type="button" className="ta-btn" onClick={() => host.openProfile?.()}><Note size={20} /> Open the note</button>}
                  {host.exportMarkdown && <button type="button" className="ta-btn" onClick={() => void exportIt()}><Download size={20} /> Take it with you</button>}
                  {host.reset && (resetAsk
                    ? <span className="ta-reset-ask">Forget every reaction? <button type="button" className="ta-btn ta-btn-danger" onClick={() => void doReset()}>Yes, forget it all</button> <button type="button" className="ta-btn ta-btn-quiet" onClick={() => setResetAsk(false)}>Keep it</button></span>
                    : <button type="button" className="ta-btn ta-btn-quiet" onClick={() => setResetAsk(true)}>Start over</button>)}
                </div>
              )}
            </aside>
          </div>
        </div>
      )}
      <SaveNote failed={failed} retry={() => void retry()} busy={busy} />
    </GameFrame>
  );
}
