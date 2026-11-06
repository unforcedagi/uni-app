// The Arcade: a home of six toys, and the games behind them. Owns navigation (home <-> a game, with an obvious way back
// and Escape), calm mode (reduced motion or the ink screen), and the little numbers on the toys.
import "./arcade.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { GameId, Profile, Stats } from "../../engine/src/types.ts";
import { GAMES } from "../../engine/src/types.ts";
import type { ArcadeHost, PlayGame } from "./host.ts";
import { Ctx, useInk, useKeys, useReducedMotion } from "./kit/hooks.ts";
import { useGreyscale } from "./kit/screen.ts";
import type { ArcadeCtx } from "./kit/hooks.ts";
import { Back, Seed } from "./kit/icons.tsx";
import { ThisOrThat } from "./games/ThisOrThat.tsx";
import { Gallery } from "./games/Gallery.tsx";
import { FixIt } from "./games/FixIt.tsx";
import { WhoSaidIt } from "./games/WhoSaidIt.tsx";
import { Ripple } from "./games/Ripple.tsx";
import { Garden } from "./games/Garden.tsx";
import { ToyFixIt, ToyGallery, ToyGarden, ToyRipple, ToyThisOrThat, ToyWho } from "./toys/Toys.tsx";

export interface ArcadeProps {
  host: ArcadeHost;
  /** leave the Arcade (the app's own way back); without it the home has no exit */
  onExit?: () => void;
  /** This or That's burst, in seconds (default 60) */
  burstSeconds?: number;
  /** open straight into a game */
  start?: GameId;
}

const FOUND: Record<string, string> = {
  ink: "On because this is an ink screen.",
  monochrome: "On because this screen reports no colour.",
  model: "On because we found a greyscale tablet.",
};

const NAMES: Record<GameId, string> = {
  "this-or-that": "This or That", gallery: "The Gallery", "fix-it": "Fix It", "who-said-it": "Who Said It", ripple: "Ripple", garden: "Garden",
};

function feel(g: GameId, host: ArcadeHost, uni: string | null): string {
  switch (g) {
    case "this-or-that": return "A minute of quick taps. Pick one, then the next.";
    case "gallery": return "A slow wander. Pin whatever pulls.";
    case "fix-it": return `${uni ?? "The arcade"} made something a little off. Nudge it right.`;
    case "who-said-it": return host.owner.you ? "The writer or the machine? Guess." : `Your line, or ${uni ?? "Uni"} writing as you?`;
    case "ripple": return host.voice ? "One question about how things should work. Say it out loud." : "One question about how things should work, in your words.";
    case "garden": return "See what's growing. Prune what isn't you.";
  }
}

interface Home { stats: Stats | null; profile: Profile | null; fresh: Partial<Record<PlayGame, number>>; exact: boolean; error: boolean }

export function Arcade({ host, onExit, burstSeconds = 60, start }: ArcadeProps) {
  const ink = useInk();
  const reduce = useReducedMotion();
  const calm = ink || reduce;
  const { grey, found, locked, set: setGrey } = useGreyscale(ink);
  const deal = useMemo(() => ({ ...(grey ? { grey: true } : {}), ...(calm ? { still: true } : {}) }), [grey, calm]);
  const [view, setView] = useState<GameId | "home">(start ?? "home");
  const [home, setHome] = useState<Home>({ stats: null, profile: null, fresh: {}, exact: true, error: false });
  const lastToy = useRef<GameId | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const uni = host.owner.you ? null : "Uni";
  const games = useMemo(() => GAMES.filter((g) => host.games.includes(g)), [host]);

  const homeAsk = useRef(0);
  const loadHome = useCallback(async () => {
    const mine = ++homeAsk.current; // the switch can flip while an answer is on its way: only the latest counts
    const play = games.filter((g): g is PlayGame => g !== "garden");
    const fresh = host.fresh
      ? host.fresh(deal).then((f) => ({ f, exact: true }))
      : Promise.all(play.map((g) => host.rounds(g, 12, deal).then((r) => [g, r.length] as const))).then((xs) => ({ f: Object.fromEntries(xs) as Partial<Record<PlayGame, number>>, exact: false }));
    const [s, p, f] = await Promise.allSettled([host.stats(), host.profile(), fresh]);
    if (mine !== homeAsk.current) return;
    setHome({
      stats: s.status === "fulfilled" ? s.value : null,
      profile: p.status === "fulfilled" ? p.value : null,
      fresh: f.status === "fulfilled" ? f.value.f : {},
      exact: f.status === "fulfilled" ? f.value.exact : true,
      error: s.status === "rejected" && p.status === "rejected",
    });
  }, [host, games, deal]);

  useEffect(() => { if (view === "home") void loadHome(); }, [view, loadHome]);

  const goHome = useCallback(() => setView("home"), []);
  const open = (g: GameId) => { lastToy.current = g; setView(g); root.current?.scrollTo?.({ top: 0 }); };

  // back on the home, focus returns to the toy that was opened
  useEffect(() => {
    if (view !== "home" || !lastToy.current) return;
    root.current?.querySelector<HTMLButtonElement>(`[data-toy="${lastToy.current}"]`)?.focus({ preventScroll: false });
  }, [view]);

  useKeys((e) => { if (e.key === "Escape" && view !== "home") { e.preventDefault(); goHome(); } }, view !== "home");

  const ctx: ArcadeCtx = useMemo(() => ({ host, calm, ink, home: goHome, uni, burstSeconds, grey, setGrey, deal }), [host, calm, ink, goHome, uni, burstSeconds, grey, setGrey, deal]);

  const seeds = home.stats?.seeds ?? 0;
  const claims = home.profile?.claims ?? [];
  const growing = claims.filter((c) => c.status === "live").length;

  const count = (g: GameId): string => {
    if (g === "garden") return growing ? `${growing} growing` : "Bare soil, for now";
    const n = home.fresh[g];
    if (n === undefined) return home.stats ? "" : "…";
    if (!home.exact) return n ? `${n >= 12 ? "12+" : n} ready` : "Nothing yet";
    return n ? `${n} fresh` : grey ? "Nothing fresh for this screen" : "All played. Replays welcome";
  };

  const art: Record<GameId, ReactNode> = {
    "this-or-that": <ToyThisOrThat />, gallery: <ToyGallery />, "fix-it": <ToyFixIt />, "who-said-it": <ToyWho />, ripple: <ToyRipple />,
    garden: <ToyGarden claims={claims} seeds={seeds} />,
  };

  let body: ReactNode;
  switch (view) {
    case "this-or-that": body = <ThisOrThat />; break;
    case "gallery": body = <Gallery />; break;
    case "fix-it": body = <FixIt />; break;
    case "who-said-it": body = <WhoSaidIt />; break;
    case "ripple": body = <Ripple />; break;
    case "garden": body = <Garden />; break;
    default:
      body = (
        <div className="ta-home">
          <header className="ta-home-head">
            {onExit && <button type="button" className="ta-back" onClick={onExit}><Back /> <span>Back</span></button>}
            <h1 className="ta-home-title">Arcade</h1>
            <p className="ta-home-lede">{uni ? `Small games that teach ${uni} your taste. Play whichever fits the moment.` : "Small games that learn your taste. What they learn stays yours."}</p>
            <p className="ta-home-seeds" aria-label={`${seeds} seeds planted`}>
              <Seed size={22} /> <b>{seeds}</b> <span>{seeds === 1 ? "seed" : "seeds"} planted</span>
            </p>
          </header>
          <div className="ta-grey-row">
            <button type="button" role="switch" aria-checked={grey} disabled={locked} className={`ta-grey-switch${grey ? " is-on" : ""}`} onClick={() => setGrey(!grey)}>
              <span className="ta-grey-knob" aria-hidden="true" />
              <span>Greyscale screen</span>
              <b aria-hidden="true">{grey ? "On" : "Off"}</b>
            </button>
            <p className={grey && found ? "ta-grey-why" : "ta-grey-hint"}>
              {grey && found ? FOUND[found] : grey ? "Colour turns into light and dark, and nothing here teaches colour." : "No colour on this screen? Turn this on."}
            </p>
          </div>
          {home.error && <p className="ta-home-error" role="status">The arcade can't reach where your taste is kept right now. The toys will fill in when it's back. <button type="button" className="ta-btn ta-btn-quiet" onClick={() => void loadHome()}>Try again</button></p>}
          <div className="ta-toys" data-count={games.length}>
            {games.map((g) => (
              <button key={g} type="button" className="ta-toy" data-toy={g} onClick={() => open(g)}>
                <span className="ta-toy-art">{art[g]}</span>
                <span className="ta-toy-text">
                  <span className="ta-toy-name">{NAMES[g]}</span>
                  <span className="ta-toy-feel">{feel(g, host, uni)}</span>
                  <span className="ta-toy-fresh">{count(g)}</span>
                </span>
              </button>
            ))}
          </div>
        </div>
      );
  }

  return (
    <Ctx.Provider value={ctx}>
      <div className={`ta-arcade${calm ? " ta-calm" : ""}${ink || grey ? " ta-ink" : ""}${grey ? " ta-grey" : ""}`} ref={root} data-view={view}>
        {body}
      </div>
    </Ctx.Provider>
  );
}
