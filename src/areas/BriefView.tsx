import { invoke } from "@tauri-apps/api/core";
import { Body } from "../MessageBody";
import type { ReactNode } from "react";
import { askDraft, briefMissingDraft, refreshDraft, updatedLabel, type AskKind, type Brief, type BriefItem, type Inline } from "./briefCore";
import type { Area } from "./areasCore";
import type { AreaBrief } from "./useAreas";
import { safeHref } from "../markdown";

/** One line of a brief: wikilinks open the note in the app's vault view, web links open outside, the rest is text. */
export function InlineText({ tokens, onNote }: { tokens: Inline[]; onNote: (ref: string) => void }) {
  return <>{tokens.map((t, i) => {
    if (t.t === "text") return <span key={i}>{t.text}</span>;
    if (t.t === "bold") return <strong key={i}>{t.text}</strong>;
    if (t.t === "link") return <button key={i} type="button" className="brief-link" onClick={() => onNote(t.target)}>{t.label}</button>;
    const safe = safeHref(t.href);
    return safe ? <a key={i} className="brief-link" href={safe} rel="noreferrer noopener" onClick={(e) => { e.preventDefault(); void invoke("open_link", { url: safe }).catch(() => {}); }}>{t.label}</a> : <span key={i}>{t.label}</span>;
  })}</>;
}

const SECTIONS: { key: Exclude<keyof Brief, "now" | "nowTokens" | "present">; title: string; ask?: AskKind }[] = [
  { key: "needsYou", title: "Needs you", ask: "needsYou" },
  { key: "moving", title: "Moving", ask: "moving" },
  { key: "people", title: "People" },
  { key: "recent", title: "Recent" },
  { key: "quiet", title: "Quiet" },
  { key: "suggested", title: "Suggested next", ask: "suggested" },
];

/**
 * A node's page (the Uni root, an area or a project — one component): breadcrumb, title, freshness with Refresh, then the
 * Brief (or, for Uni, `lead`: Today), then `kids`, the next level down.
 */
export default function BriefView({ area, entry, now, canAsk, onNote, onAsk, crumbs, stage, slot, lead, kids, freshAt, projectError, projectLoading }: {
  projectError?: string | null;
  projectLoading?: boolean;
  area: Area; entry: AreaBrief | null; now: number; canAsk: boolean;
  onNote: (ref: string) => void;
  /** Put text in the node room's composer; never sends. */
  onAsk: (text: string) => void;
  crumbs?: ReactNode;
  /** The node's map (its title is the page's h1): drawn after the breadcrumb, then the area slot, then the detail below. */
  stage?: ReactNode; slot?: ReactNode;
  /** Replaces the Brief (the Uni root shows Today here). */
  lead?: ReactNode;
  kids?: ReactNode;
  /** When the page's source note was written (`generated_at`, else its update time); the Brief's own for a node. */
  freshAt?: string | null;
}) {
  const brief = entry?.brief;
  const fresh = updatedLabel(freshAt !== undefined ? freshAt : entry ? entry.generatedAt ?? entry.updatedAt : null, now);
  const root = area.path === "";
  return <div className="area-scroll"><article className={`area-default area-brief ${stage ? "node-view" : ""}`}>
    {crumbs}
    {stage ?? <h1 className="note-title">{area.title}</h1>}
    {slot}
    <p className="brief-fresh">{fresh && <span>{fresh}</span>}{canAsk && <button type="button" className="pairing-secondary brief-refresh" onClick={() => onAsk(refreshDraft(area.name, root ? "" : area.path))}>Refresh</button>}</p>
    {area.kind === "project" && <section aria-label="Project purpose">
      {area.purpose && <p className="brief-purpose">{area.purpose}</p>}
      {area.body ? <Body body={area.body} mentions={[]} me={null} /> : projectError ? <p role="status">Couldn't load project: {projectError}</p> : <p className="area-quiet">{projectLoading ? "Opening project…" : "No project content yet."}</p>}
    </section>}
    {lead ?? (!brief || !brief.present.length ? <section className="brief-missing" aria-label="No brief yet">
      <p>Uni hasn't written this area's brief yet.</p>
      {area.kind !== "project" && area.purpose && <p className="brief-purpose">{area.purpose}</p>}
      {canAsk ? <button type="button" className="suggestion-go brief-write" onClick={() => onAsk(briefMissingDraft(area.name, area.path))}>Ask Uni to write it</button>
        : <p className="area-quiet">This area has no room yet, so there is nowhere to ask.</p>}
    </section> : <>
      {brief.present.includes("now") && <section className="brief-section" aria-label="Now"><h2>Now</h2><p className="brief-now"><InlineText tokens={brief.nowTokens} onNote={onNote} /></p></section>}
      {SECTIONS.filter((s) => brief.present.includes(s.key)).map((s) => <section key={s.key} className={`brief-section brief-${s.key}`} aria-label={s.title}>
        <h2>{s.title}{s.ask === "needsYou" && brief.needsYou.length > 0 && <span className="brief-count">{brief.needsYou.length}</span>}</h2>
        {brief[s.key].length === 0 ? <p className="area-quiet">Nothing recent.</p> : <ul>{brief[s.key].map((it: BriefItem, i: number) => <li key={i}>
          <span className="brief-item"><InlineText tokens={it.tokens} onNote={onNote} /></span>
          {s.ask && canAsk && <button type="button" className="pairing-secondary brief-ask" aria-label={`Ask Uni about: ${it.text}`} onClick={() => onAsk(askDraft(s.ask!, area.name, it))}>Ask Uni</button>}
        </li>)}</ul>}
      </section>)}
    </>)}
    {kids}
  </article></div>;
}
