import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DoneCard, PendingCard, QuietCard } from "./CompactCard";
import {
  SEALED_CHANGED, childToken, jobFingerprint, payloadEntries, payloadField, plainError, releasesLine, shortText, span, windowText,
  type SealedCardView, type SealedRow,
} from "./sealedCardCore";

// T-234: Uni's approval card (one request) and morning card (one row per routine credential), CARD.md §4. Rust checks the
// card from its signed event and returns the view (`sealed_card`); a card that failed a check shows its reason and
// nothing to tap. Approve and Deny go to `sealed_answer` with the request ids only: Rust opens the data key, wraps it to
// the request's one-time key and sends it; the webview never sees a key. A powerful credential is approved by holding the
// button for about a second (letting go early cancels and sends nothing); a routine one by a tap. Each request is
// answered once (Rust refuses a second answer); a failed send keeps the decision and offers Try again.

export const HOLD_MS = 1000;

const clock = (ts: number) => new Date(ts * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function useNow(until: number | null): number {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => {
    if (until === null || now >= until) return;
    const t = window.setTimeout(() => setNow(Date.now() / 1000), Math.min(2 ** 31 - 1, (until - now) * 1000 + 50));
    return () => window.clearTimeout(t);
  }, [until, now]);
  return now;
}

/** Press and hold to approve. A click alone does nothing; letting go, leaving the button or Escape cancels. */
function HoldButton({ label, disabled, onDone, onCancel }: { label: string; disabled: boolean; onDone: () => void; onCancel: () => void }) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const begin = () => {
    if (disabled || timer.current !== undefined) return;
    setHolding(true);
    timer.current = window.setTimeout(() => { timer.current = undefined; setHolding(false); onDone(); }, HOLD_MS);
  };
  const end = () => {
    if (timer.current === undefined) return;
    window.clearTimeout(timer.current);
    timer.current = undefined;
    setHolding(false);
    onCancel();
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return <button type="button" className={`sealed-approve sealed-hold ${holding ? "holding" : ""}`} disabled={disabled}
    aria-label={`${label}: press and hold`} aria-pressed={holding}
    onPointerDown={(e) => { e.preventDefault(); begin(); }} onPointerUp={end} onPointerLeave={end} onPointerCancel={end}
    onKeyDown={(e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); begin(); } else if (e.key === "Escape") end(); }}
    onKeyUp={(e) => { if (e.key === " " || e.key === "Enter") end(); }} onBlur={end}
    onContextMenu={(e) => e.preventDefault()}>
    <span className="sealed-hold-fill" aria-hidden="true" />
    <span className="sealed-hold-label">{holding ? "Keep holding…" : label}</span>
  </button>;
}

function Payload({ payload }: { payload: unknown }) {
  const [open, setOpen] = useState(false);
  const entries = payloadEntries(payload);
  if (!entries.length) return <span className="sealed-none">none</span>;
  const anyLong = entries.some((e) => e.long);
  return <div className="sealed-payload">
    <ul>{entries.map((e) => <li key={e.key}>{e.key && <code className="sealed-key">{e.key}</code>} <span className="sealed-val">{e.long && !open ? shortText(e.text) : e.text}</span></li>)}</ul>
    {anyLong && <button type="button" className="sealed-more" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{open ? "less" : "▸ more"}</button>}
    {open && <pre className="sealed-pretty">{JSON.stringify(payload, null, 2)}</pre>}
  </div>;
}

function answerLine(r: SealedRow): string | null {
  const a = r.answer;
  if (!a) return null;
  if (a.decision === "deny") return a.sent ? "Denied" : "Denied · not sent yet";
  return a.sent ? `Approved · open until ${clock(a.until ?? a.at)}` : "Approved · not sent yet";
}

function Badge({ cls }: { cls: SealedRow["class"] }) {
  return <span className={`sealed-badge ${cls}`}>{cls === "powerful" ? "POWERFUL" : "ROUTINE"}</span>;
}

export function SealedCard({ channel, reference }: { channel: string; reference: string }) {
  const [view, setView] = useState<SealedCardView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [off, setOff] = useState<Set<string>>(new Set());
  const sending = useRef(false);
  // an answer on any card can change this one (the same request on another card is then a replay): read it again
  const [again, setAgain] = useState(0);
  useEffect(() => {
    const bump = () => setAgain((n) => n + 1);
    window.addEventListener(SEALED_CHANGED, bump);
    return () => window.removeEventListener(SEALED_CHANGED, bump);
  }, []);

  useEffect(() => {
    let live = true;
    invoke<SealedCardView>("sealed_card", { channel, reference })
      .then((v) => { if (!live) return; if (!v || !Array.isArray(v.rows)) { setLoadError("no answer from the app"); return; } setView(v); setLoadError(null); })
      .catch((e) => { if (live) setLoadError(plainError(e)); });
    return () => { live = false; };
  }, [channel, reference, again]);

  const expires = view?.rows.length ? Math.min(...view.rows.map((r) => r.expires)) : null;
  const now = useNow(expires);

  const answer = useCallback(async (decision: "approve" | "deny", rids: string[]) => {
    if (sending.current || !rids.length) return;
    sending.current = true;
    setBusy(true);
    setSendError(null);
    setNote(null);
    try {
      const v = await invoke<SealedCardView>("sealed_answer", { channel, reference, decision, rids });
      if (v && Array.isArray(v.rows)) setView(v);
    } catch (e) {
      setSendError(plainError(e));
      // the decision may be kept and not sent: read the card again so it shows what Rust holds
      invoke<SealedCardView>("sealed_card", { channel, reference }).then((v) => { if (v && Array.isArray(v.rows)) setView(v); }, () => {});
    } finally {
      sending.current = false;
      setBusy(false);
      window.dispatchEvent(new Event(SEALED_CHANGED));
    }
  }, [channel, reference]);

  const morning = view?.kind === "morning";
  const title = morning ? "Uni's morning card" : "Approve use of a credential";
  if (!view || view.refused || !view.rows.length) {
    const why = loadError ?? view?.refused ?? null;
    return <QuietCard className="sealed-card sealed-greyed" label={`${title} (${why ? "can't be approved" : "checking"})`} icon="🔑" title={title}
      status={why ?? "Checking this card…"} warn={!!why} />;
  }

  const rows = view.rows;
  const answered = rows.some((r) => r.answer);
  const unsent = rows.filter((r) => r.answer && !r.answer.sent);
  const pastAnswerBy = expires !== null && now >= expires;
  // an answer that never reached Uni can't be sent once the card has expired: no Try again then
  const expired = pastAnswerBy && (!answered || unsent.length > 0);
  const retry = unsent.length > 0 && !expired
    ? <button type="button" className="pairing-secondary" disabled={busy} onClick={() => void answer(unsent[0].answer!.decision, unsent.map((r) => r.rid))}>Try again</button>
    : null;
  const failure = sendError && <p className="secret-status warn" role="alert">Not sent: {sendError}</p>;

  if (!morning) {
    const r = rows[0];
    const child = childToken(r);
    const purpose = payloadField(r, "purpose"), destination = payloadField(r, "destination");
    const releases = releasesLine(r);
    // T-335: what it's for, in the card's own checked words: a mint's purpose, else its scope
    const what = purpose ?? r.scope;
    const warn = child?.permanent && <p className="sealed-warn" role="note"><span aria-hidden="true">⚠️</span> This makes a <strong>permanent token</strong>. It keeps working until someone revokes it.</p>;
    const facts = <>
      <dl className="secret-facts sealed-facts">
        <dt>Credential</dt><dd><code>{r.credential}</code></dd>
        <dt>Action</dt><dd><code>{r.action}</code></dd>
        <dt>Scope</dt><dd className="sealed-scope">{r.scope}</dd>
        {purpose && <><dt>Purpose</dt><dd>{purpose}</dd></>}
        {destination && <><dt>Destination</dt><dd><code>{destination}</code></dd></>}
        {child && <><dt>Child token</dt><dd>{child.permanent ? "permanent" : `expires after ${span(child.ttl ?? 0)}`}</dd></>}
        <dt>Window</dt><dd>{windowText(r.ttl_s, r.uses)}</dd>
        <dt>Payload</dt><dd><Payload payload={r.payload} /></dd>
        <dt>Exact job</dt><dd><code>{jobFingerprint(r.request_digest)}</code> (fingerprint)</dd>
        <dt>Answer by</dt><dd>{clock(r.expires)}</dd>
        {r.answer?.decision === "approve" && r.answer.sent && <><dt>Open until</dt><dd>{clock(r.answer.until ?? r.answer.at)}</dd></>}
      </dl>
      {r.answer && releases && <p className="sealed-releases">{releases}</p>}
    </>;
    const label = `Approve use of ${r.credential}`;
    const cls = `sealed-card ${r.class}`;
    if (answered || expired) {
      const a = r.answer;
      const status = expired ? "Expired" : `${a?.decision === "deny" ? "Denied" : "Approved"}${a?.sent ? "" : " · not sent yet"}`;
      return <DoneCard className={`${cls} ${expired ? "sealed-greyed" : ""}`} label={label} mark={expired ? "⌛" : a?.decision === "deny" ? "✕" : "✓"}
        status={status} what={what} when={expired ? clock(r.expires) : a ? clock(a.at) : null} details={facts}
        after={<>{failure}{retry}</>} />;
    }
    return <PendingCard className={cls} label={label} icon="🔑" what={what}
      meta={<><span className="cc-where">{r.credential}</span> · {span(r.ttl_s)}{r.class === "powerful" && <> · <Badge cls="powerful" /></>} · </>}
      actions={<div className="sealed-actions">
        <button type="button" className="pairing-secondary sealed-deny" disabled={busy} onClick={() => void answer("deny", [r.rid])}>Deny</button>
        {r.class === "powerful"
          ? <HoldButton label="Hold to approve" disabled={busy} onDone={() => void answer("approve", [r.rid])} onCancel={() => setNote("Cancelled: nothing was sent. Hold for a second to approve.")} />
          : <button type="button" className="sealed-approve" disabled={busy} onClick={() => void answer("approve", [r.rid])}>Approve</button>}
      </div>}
      below={<>{warn}{releases && <p className="sealed-releases">{releases}</p>}{note && <p className="secret-status" role="status">{note}</p>}{failure}</>}
      details={facts} />;
  }

  const chosen = rows.filter((r) => !off.has(r.rid));
  const names = rows.map((r) => r.credential).join(", ");
  const list = (live: boolean) => <ul className="sealed-rows">{rows.map((r) => {
    const status = answerLine(r) ?? (answered ? "Left out" : null);
    return <li key={r.rid} className={off.has(r.rid) && !answered ? "sealed-row-off" : ""}>
      {live && <input type="checkbox" role="switch" className="sealed-switch" checked={!off.has(r.rid)} disabled={busy}
        aria-label={`Grant ${r.credential} for ${r.action}`}
        onChange={(e) => setOff((s) => { const n = new Set(s); if (e.target.checked) n.delete(r.rid); else n.add(r.rid); return n; })} />}
      <div className="sealed-row-text">
        <span><code>{r.credential}</code> · <code>{r.action}</code></span>
        <span className="sealed-scope">{r.scope}</span>
        <small>Window {windowText(r.ttl_s, r.uses)} · Exact job <code>{jobFingerprint(r.request_digest)}</code></small>
        {r.payload !== null && <Payload payload={r.payload} />}
        {status && <small className="sealed-row-status">{status}</small>}
      </div>
    </li>;
  })}</ul>;
  if (answered || expired) {
    const approved = rows.filter((r) => r.answer?.decision === "approve").length;
    const status = expired ? "Expired" : unsent.length ? `${approved ? "Approved" : "Denied"} · not sent yet` : approved ? `Approved ${approved} of ${rows.length}` : "Denied";
    const at = Math.max(...rows.map((r) => r.answer?.at ?? 0));
    return <DoneCard className={`sealed-card sealed-morning routine ${expired ? "sealed-greyed" : ""}`} label={title} mark={expired ? "⌛" : approved ? "✓" : "✕"}
      status={status} what="Morning card" when={expired ? clock(expires ?? 0) : at ? clock(at) : null}
      details={<>{list(false)}<p className="approvals-note">Answer by {clock(expires ?? 0)}</p></>} after={<>{failure}{retry}</>} />;
  }
  return <PendingCard className="sealed-card sealed-morning routine" label={title} icon="🔑" what={`Morning card: ${names}`}
    meta={<>{rows.length} routine · answer by {clock(expires ?? 0)} · </>}
    actions={<div className="sealed-actions">
      <button type="button" className="pairing-secondary sealed-deny" disabled={busy} onClick={() => void answer("deny", rows.map((r) => r.rid))}>Deny all</button>
      <button type="button" className="sealed-approve" disabled={busy || !chosen.length} onClick={() => void answer("approve", chosen.map((r) => r.rid))}>
        {chosen.length ? `Approve ${chosen.length} of ${rows.length}` : "Nothing chosen"}</button>
    </div>}
    below={failure}
    details={<><p className="approvals-note">Each row is its own grant, open for its window from your tap. Switch off any you don't want today.</p>{list(true)}</>} />;
}
