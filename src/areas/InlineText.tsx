import { invoke } from "@tauri-apps/api/core";
import type { Inline } from "./briefCore";
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
