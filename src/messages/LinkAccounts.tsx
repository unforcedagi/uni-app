// T-282 Messages: "Link an account". One card per network (Telegram, Signal, WhatsApp, Google Messages, Messenger,
// Instagram): linked, not linked, or needs attention, and when you link one, its bridge's own login, step by step: the
// ways in, a field, a QR to scan with your phone, a code to compare, a cookie paste. The Rust core talks to each
// bridge's bot in an encrypted DM and reads its replies as steps (crates/uni-messages link.rs); nothing here holds a
// token. Nothing completes by itself: every value is typed here, and every QR is scanned on your phone.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { linkCancel, linkCheck, links as readLinks, linkSend, linkStart } from "./messagesDoor.ts";
import { asMessagesErr, linking, linkWords, NETWORK_INFO, problemText, qrPath, type LinkRow, type LinkStep, type MessagesErr } from "./messagesView.ts";

function Qr({ modules, label }: { modules: string[]; label: string }) {
  const { size, d } = qrPath(modules);
  // dark on light whatever the theme: phone cameras read it that way
  return <svg className="msgs-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
    <rect width={size} height={size} fill="#fff" />
    <path d={d} fill="#000" />
  </svg>;
}

function Field({ step, onSend, busy }: { step: Extract<LinkStep, { kind: "input" }>; onSend: (v: string) => void; busy: boolean }) {
  const [value, setValue] = useState("");
  const phone = /phone/i.test(step.name);
  const submit = (e: FormEvent) => { e.preventDefault(); if (value.trim()) { onSend(value.trim()); setValue(""); } };
  return <form className="msgs-link-form" onSubmit={submit}>
    <label><span>{step.name}</span>
      {step.options.length > 0
        ? <select value={value} onChange={(e) => setValue(e.target.value)} required={!step.optional}><option value="">Choose…</option>{step.options.map((o) => <option key={o}>{o}</option>)}</select>
        : <input value={value} onChange={(e) => setValue(e.target.value)} type={step.secret ? "password" : phone ? "tel" : "text"} inputMode={phone ? "tel" : undefined}
            autoComplete={step.secret ? "current-password" : phone ? "tel" : "off"} autoCapitalize="none" spellCheck={false} required={!step.optional} />}
    </label>
    {step.description && <p className="msgs-link-hint">{step.description}</p>}
    <div className="msgs-link-actions">
      <button className="send" disabled={busy || !value.trim()}>Send</button>
      {step.optional && <button type="button" className="note-quiet" disabled={busy} onClick={() => onSend("skip")}>Skip</button>}
    </div>
  </form>;
}

function Cookies({ url, onSend, busy }: { url: string; onSend: (v: string) => void; busy: boolean }) {
  const [value, setValue] = useState("");
  return <form className="msgs-link-form" onSubmit={(e) => { e.preventDefault(); if (value.trim()) { onSend(value.trim()); setValue(""); } }}>
    <ol className="msgs-link-steps">
      <li>In a browser, sign in at <a href={url} target="_blank" rel="noreferrer">{new URL(url).host}</a>. A computer's browser is easiest.</li>
      <li>Open its developer tools, Network tab. Reload, right-click the first request, and copy it as cURL.</li>
      <li>Paste it here. Only the sign-in cookies are kept, by the bridge on your box.</li>
    </ol>
    <label><span>cURL command or cookies (JSON)</span><textarea value={value} onChange={(e) => setValue(e.target.value)} rows={4} spellCheck={false} autoCapitalize="none" required /></label>
    <div className="msgs-link-actions"><button className="send" disabled={busy || !value.trim()}>Send</button></div>
  </form>;
}

function Step({ row, busy, act }: { row: LinkRow; busy: boolean; act: (f: () => Promise<unknown>) => void }) {
  const step = row.step!;
  const n = row.network;
  switch (step.kind) {
    case "flows": return <div className="msgs-link-flows" role="group" aria-label={`Ways to link ${row.name}`}>
      {step.flows.map((f) => <button key={f.id} type="button" className="msgs-link-flow" disabled={busy} onClick={() => act(() => linkStart(n, f.id))}>
        <strong>{f.description}</strong>
      </button>)}
    </div>;
    case "input": return <Field step={step} busy={busy} onSend={(v) => act(() => linkSend(n, v))} />;
    case "qr": return <div className="msgs-link-qr">
      <Qr modules={step.modules} label={`QR code to link ${row.name}`} />
      <p className="msgs-link-hint" role="status">Waiting for your phone to scan it.</p>
    </div>;
    case "code": return <div className="msgs-link-code">
      <p className="msgs-code" aria-label={`Code: ${step.code}`}>{step.code}</p>
      <p className="msgs-link-hint" role="status">Waiting for your phone.</p>
    </div>;
    case "cookies": return <Cookies url={step.url} busy={busy} onSend={(v) => act(() => linkSend(n, v))} />;
    case "waiting": return <p className="msgs-link-hint" role="status">Waiting for the {row.name} bridge…</p>;
    case "done": return <p className="msgs-link-done" role="status">{step.text}</p>;
    case "failed": return <p className="msgs-problem" role="alert">{step.text}</p>;
  }
}

function Card({ row, onProblem }: { row: LinkRow; onProblem: (p: MessagesErr | null) => void }) {
  const [busy, setBusy] = useState(false);
  const info = NETWORK_INFO[row.network];
  const act = (f: () => Promise<unknown>) => {
    setBusy(true);
    f().then(() => onProblem(null), (e) => onProblem(asMessagesErr(e))).finally(() => setBusy(false));
  };
  const attention = row.accounts.find((a) => a.attention);
  const going = linking(row);
  return <li className={`msgs-card st-${row.state}`} data-network={row.network} aria-label={row.name}>
    <div className="msgs-card-head">
      <h3>{row.name}</h3>
      <span className={`msgs-tag msgs-link-tag st-${row.state}`} role="status">{linkWords(row.state)}</span>
    </div>
    {info && <p className="msgs-card-how">{info.how}</p>}
    {row.accounts.length > 0 && <ul className="msgs-card-accounts">{row.accounts.map((a) => <li key={a.id}>{a.name} <small>{a.attention ? "can't connect" : a.state === "CONNECTED" ? "connected" : a.state.toLowerCase().replace(/_/g, " ")}</small></li>)}</ul>}
    {row.state === "unavailable" && <p className="msgs-link-hint">{row.network === "telegram" ? "The Telegram bridge isn't running yet: it needs a key you make at my.telegram.org first." : `The ${row.name} bridge isn't running on the box.`}</p>}
    {row.note && going && <p className="msgs-card-note">{row.note}</p>}
    {row.note && !going && row.state !== "unavailable" && row.step?.kind !== "done" && <p className="msgs-card-note">{row.note}</p>}
    {row.step && <Step row={row} busy={busy} act={act} />}
    <div className="msgs-link-actions">
      {going ? <button type="button" className="note-action" disabled={busy} onClick={() => act(() => linkCancel(row.network))}>Cancel</button>
        : row.state === "unavailable" || row.state === "checking" ? <button type="button" className="note-action" disabled={busy} onClick={() => act(() => linkCheck(row.network))}>Check again</button>
        : attention ? <button type="button" className="send" disabled={busy} onClick={() => act(() => linkStart(row.network, undefined, attention.id))}>Link again</button>
        : <button type="button" className={row.state === "linked" ? "note-action" : "send"} disabled={busy} onClick={() => act(() => linkStart(row.network))}>{row.state === "linked" ? "Link another" : "Link"}</button>}
    </div>
    {info && <p className="msgs-card-keep">{info.keep}</p>}
  </li>;
}

export default function LinkAccounts({ rows, setRows, onBack }: { rows: LinkRow[] | null; setRows: (r: LinkRow[]) => void; onBack: () => void }) {
  const [problem, setProblem] = useState<MessagesErr | null>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    readLinks().then(setRows, (e) => setProblem(asMessagesErr(e)));
  }, [setRows]);
  return <section className="msgs-link" aria-label="Link an account">
    <div className="msgs-thread-bar msgs-link-bar">
      <button type="button" className="note-action" onClick={onBack}>← Conversations</button>
      <h2 className="msgs-thread-name">Link an account</h2>
    </div>
    <div className="msgs-scroll">
      <p className="msgs-note msgs-link-lead">Bring your chats from other apps into Messages. Each link runs through a bridge on your own box. A bridge has to read a message to pass it on, so for linked apps, end-to-end protection ends at your box.</p>
      {problem && <p className="msgs-problem" role="alert">{problemText(problem)} <button type="button" className="note-quiet" onClick={() => setProblem(null)}>Dismiss</button></p>}
      {!rows ? <p className="msgs-loading" role="status">Asking the bridges…</p>
        : <ul className="msgs-cards">{rows.map((r) => <Card key={r.network} row={r} onProblem={setProblem} />)}</ul>}
    </div>
  </section>;
}
