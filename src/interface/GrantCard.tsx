// The grant card: the one place the owner allows an applet anything, drawn by the shell outside any frame. It names
// exactly what is granted, row by row (grant2.ts `grantLines`): what isn't on the card is refused at runtime. The same
// card asks (Allow / Not now) and, once allowed, shows what was granted and takes it back (Revoke access).
// Every sentence is the shell's. The only text that can come from a note is a sealed applet's name, shown quoted and
// marked as unverified. Nothing runs until Allow, and only a real tap counts (`isTrusted`).
import type { MouseEvent } from "react";
import type { CardLine } from "./grant2.ts";
import "./grantCard.css";

/** Host-rendered line for approved-code mode when the applet's HTML changed since it was allowed. */
export const CODE_CHANGED_LINE = "This applet's code changed since you allowed it. On this device applets can reach the network through WebRTC, so only code you've approved runs.";
/** Host-rendered replacement for the sealed / no-internet sentences when WebRTC is present. */
export const APPROVED_CODE_LINE = "On this device applets can reach the network through WebRTC, so this applet is only as safe as its code. Allow it only if you trust it.";

/** How the applet's code runs: compiled into the app, in the sealed frame, or in the frame where WebRTC can't be sealed. */
export type Runs = "built-in" | "sealed" | "approved-code";

const day = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const dayOf = (iso: string | Date | null | undefined): string | null => {
  const d = iso instanceof Date ? iso : iso ? new Date(iso) : null;
  return d && !isNaN(d.getTime()) ? day.format(d) : null;
};

export default function GrantCard({ name, glyph, runs, lines, state, fingerprint, expires, grantedAt, codeChanged, changes, copies, onAllow, onNotNow, onRevoke, onDone }: {
  name: string;
  glyph?: string;
  runs: Runs;
  lines: CardLine[];
  /** `ask`: nothing is allowed yet. `granted`: what was allowed, with the way to take it back. */
  state: "ask" | "granted";
  /** Tells two cards apart, and changes whenever what is granted does. */
  fingerprint?: string | null;
  /** When the grant ends (asked: when it would). */
  expires?: Date | string | null;
  grantedAt?: string | null;
  codeChanged?: boolean;
  /** A sealed applet whose rows add or change notes: the closing line then says it changes nothing anywhere else. */
  changes?: boolean;
  /** It also reads a room: what it reads there it can write into the notes it changes, and the card says so. */
  copies?: boolean;
  onAllow?: () => void;
  onNotNow?: () => void;
  onRevoke?: () => void;
  onDone?: () => void;
}) {
  const builtIn = runs === "built-in";
  const asking = state === "ask";
  const tap = (f?: () => void) => (e: MouseEvent) => { if (e.isTrusted) f?.(); };
  const who = builtIn ? <strong className="grant-name">{name}</strong>
    : <>The applet <q data-untrusted="true" className="grant-name">{name}</q> (a name taken from its note, not verified)</>;
  const until = dayOf(expires), since = dayOf(grantedAt);
  return <section className={`grant-card grant-prompt ${state}`} role="region" aria-label={asking ? `${name} is asking for access` : `What ${name} may reach`}>
    <header className="grant-head">
      <span className="grant-glyph" aria-hidden="true">{glyph ?? "◇"}</span>
      <h2>{asking ? (builtIn ? `${name} asks for access` : "An applet asks for access") : `What ${name} may reach`}</h2>
    </header>
    {codeChanged && <p className="grant-say grant-changed" role="status"><strong>{CODE_CHANGED_LINE}</strong></p>}
    <p className="grant-say">{who} {builtIn ? "is built into Uni." : runs === "sealed" ? (asking ? "would run in a sealed frame." : "runs in a sealed frame.") : (asking ? "would run inside Uni." : "runs inside Uni.")} {asking ? "It would be able to:" : "It can:"}</p>
    {lines.length
      ? <dl className="grant-lines">{lines.map((l, i) => <div key={i} className="grant-line">
          <dt>{l.where}</dt>
          <dd className={l.stress ? "grant-outside" : undefined}>{l.text}</dd>
        </div>)}</dl>
      : <p className="grant-say grant-none">Nothing outside itself.</p>}
    {builtIn
      ? <p className="grant-say grant-rest"><strong>Nothing else.</strong> A call to any other door, vault or folder is refused.</p>
      : runs === "approved-code"
        ? <p className="grant-say grant-rest grant-network" role="status"><strong>{APPROVED_CODE_LINE}</strong> {changes ? "It can't send chat messages, delete notes, or change notes anywhere else." : "It can't send chat messages or change notes."} It runs inside Uni, so a faulty applet can freeze it; you can stop or revoke it from the bar above it.</p>
        : <p className="grant-say grant-rest"><strong>Nothing else.</strong> {changes ? "It can't send messages, delete notes, change notes anywhere else or reach the internet." : "It can't send messages, change notes or reach the internet."} It runs inside Uni, so a faulty applet can freeze it; you can stop or revoke it from the bar above it.</p>}
    {copies && <p className="grant-say grant-copies"><strong>What it reads in a room it can write into those notes,</strong> where anyone who reads that vault can see it.</p>}
    <p className="grant-meta">
      {asking ? (until ? `Lasts until ${until}, or until you revoke it` : "Lasts until you revoke it") : [since ? `Allowed ${since}` : "Allowed", until ? `until ${until}` : "until you revoke it"].join(" · ")}
      {fingerprint ? <> · Grant <code>{fingerprint}</code></> : null}
    </p>
    <div className="grant-actions area-actions">
      {asking ? <>
        <button type="button" className="grant-quiet pairing-secondary" onClick={tap(onNotNow)}>Not now</button>
        <button type="button" className="grant-go suggestion-go" onClick={tap(onAllow)}>{codeChanged ? "Allow this version" : "Allow"}</button>
      </> : <>
        <button type="button" className="grant-quiet grant-revoke area-revoke" onClick={tap(onRevoke)}>Revoke access</button>
        <button type="button" className="grant-go" onClick={tap(onDone)}>Done</button>
      </>}
    </div>
  </section>;
}
