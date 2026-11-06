// The frame every game sits in (a way back, its name, its own corner), and the end of a burst.
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import type { GameId } from "../../../engine/src/types.ts";
import { useArcade } from "./hooks.ts";
import { Back, Seed } from "./icons.tsx";

export function GameFrame({ game, title, corner, children, wide }: { game: GameId; title: string; corner?: ReactNode; children: ReactNode; wide?: boolean }) {
  const { home } = useArcade();
  const h = useRef<HTMLHeadingElement>(null);
  useEffect(() => { h.current?.focus({ preventScroll: true }); }, []);
  return (
    <section className={`ta-game${wide ? " ta-game-wide" : ""}`} data-game={game} aria-labelledby={`ta-h-${game}`}>
      <header className="ta-bar">
        <button type="button" className="ta-back" onClick={home}>
          <Back /> <span>Arcade</span>
        </button>
        <h1 id={`ta-h-${game}`} ref={h} tabIndex={-1} className="ta-bar-title">{title}</h1>
        <div className="ta-bar-corner">{corner}</div>
      </header>
      <div className="ta-game-body">{children}</div>
    </section>
  );
}

/** A small seed count that hops when it grows. */
export function SeedCount({ n, label = "seeds" }: { n: number; label?: string }) {
  return (
    <span className="ta-seedcount" key={n} data-n={n}>
      <Seed size={18} /> <b>{n}</b> <span>{label}</span>
    </span>
  );
}

export function SaveNote({ failed, retry, busy }: { failed: number; retry: () => void; busy: boolean }) {
  return (
    <div className="ta-savenote" role="status" aria-live="polite">
      {failed > 0 && (
        <>
          <span>{failed === 1 ? "One reaction isn't saved yet." : `${failed} reactions aren't saved yet.`} The arcade couldn't reach where your taste is kept.</span>
          <button type="button" className="ta-btn ta-btn-quiet" onClick={retry} disabled={busy}>{busy ? "Saving…" : "Try again"}</button>
        </>
      )}
    </div>
  );
}

/** The end of a burst: what was planted, what Uni noticed, and where to go next. No scores to beat. */
export function BurstEnd({ title, line, seeds, noticed, children, again, againLabel }: {
  title: string; line?: ReactNode; seeds: number; noticed: string[] | null; children?: ReactNode; again?: () => void; againLabel?: string;
}) {
  const { home, uni } = useArcade();
  const h = useRef<HTMLHeadingElement>(null);
  useEffect(() => { h.current?.focus({ preventScroll: true }); }, []);
  const shown = Math.min(seeds, 24);
  return (
    <div className="ta-end" role="region" aria-labelledby="ta-end-h">
      <h2 id="ta-end-h" ref={h} tabIndex={-1} className="ta-end-title">{title}</h2>
      {line && <p className="ta-end-line">{line}</p>}
      <div className="ta-end-seeds" aria-label={`${seeds} ${seeds === 1 ? "seed" : "seeds"} planted`}>
        <div className="ta-end-row" aria-hidden="true">
          {Array.from({ length: shown }, (_, i) => <i key={i} style={{ ["--i" as string]: i }} />)}
        </div>
        <p><b>+{seeds}</b> {seeds === 1 ? "seed" : "seeds"} for the Garden</p>
      </div>
      {noticed && (
        <div className="ta-noticed" aria-live="polite">
          <h3>{uni ? `${uni} noticed…` : "Noticed…"}</h3>
          {noticed.length
            ? <ul>{noticed.map((t) => <li key={t}>{t}</li>)}</ul>
            : <p>Nothing stands out yet. A few more rounds and a pattern starts to show.</p>}
        </div>
      )}
      {children}
      <div className="ta-end-go">
        {again && <button type="button" className="ta-btn ta-btn-go" onClick={again}>{againLabel ?? "Play again"}</button>}
        <button type="button" className="ta-btn" onClick={home}>Back to the arcade</button>
      </div>
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return <div className="ta-loading" role="status"><span className="ta-loading-dot" aria-hidden="true" />{what}</div>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  const { home } = useArcade();
  return (
    <div className="ta-empty">
      <h2>{title}</h2>
      {children}
      <button type="button" className="ta-btn" onClick={home}>Back to the arcade</button>
    </div>
  );
}
