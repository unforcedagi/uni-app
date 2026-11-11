// T-335 an applet's screen: the head (back to the drawer, its name, search), the kind line that says where its data
// lives and who holds the keys, then the applet itself filling the rest. The body is a flex child with min-height 0,
// so an existing full-height place (Mail, Calendar, Messages ...) scrolls inside itself.
import type { ReactNode } from "react";
import { SearchIcon } from "../Icons";
import type { AppletManifest } from "../interface/applets.ts";
import "./applets.css";

/** The kind line's words. A door's own note replaces the general line when the general one isn't true for it. */
export function kindWords(a: AppletManifest): string {
  return a.kind === "door"
    ? `Door · ${a.note ?? "the bridge holds the keys; each call is signed by you"}`
    : `Vault applet · ${a.note ?? "data lives in your vault"}`;
}

export function AppletFrame({ applet, onBack, onSearch, onAccess, children }: {
  applet: AppletManifest;
  onBack: () => void;
  onSearch: () => void;
  /** A built-in on contract 2: opens its grant card (what it may reach, and Revoke access). */
  onAccess?: () => void;
  children: ReactNode;
}) {
  return <section className="sh-ap-frame" aria-labelledby={`sh-ap-h-${applet.id}`}>
    <header className="sh-ap-top">
      <button type="button" className="sh-ap-icon" aria-label="Back to applets" onClick={onBack}>‹</button>
      <h1 id={`sh-ap-h-${applet.id}`}>{applet.name}</h1>
      <button type="button" className="sh-ap-icon" aria-label={`Search ${applet.name}`} onClick={onSearch}><SearchIcon /></button>
    </header>
    <p className="sh-ap-kindline"><i className={`sh-ap-mark small ${applet.kind}`} aria-hidden="true" /><span className="sh-ap-kindwords">{kindWords(applet)}</span>
      {onAccess && <button type="button" className="sh-ap-access" onClick={onAccess}>Access</button>}</p>
    <div className="sh-ap-body">{children}</div>
  </section>;
}
