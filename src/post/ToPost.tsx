// T-335: the To post queue. Uni proposes posts as `post` notes in the vault, in two voices: Aaron's (only his own words:
// typed by him, or exact quotes of a piece he published) and Uni's (signed as Uni, openly a machine). Each card shows
// the post as it will look, whose voice it is in a word and a shape, and Approve, Schedule, Edit, Not this.
// Approve and Schedule go to Rust, which re-reads the note, checks it, asks this device to confirm, and signs Aaron's
// approval over exactly that post; uni-post on uni posts it only on that signature. Nothing here posts anything.
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { splitLinks } from "../areas/linkText";
import { blocked, editMode, LIMIT, parsePosts, PLATFORM_LABEL, queue, scheduleAt, voice, waitingLine, where, type PostCard } from "./postCore";
import "./ToPost.css";

const PAGE = 200;

/** Every post note in the vault (metadata only), all pages. */
export async function loadPosts(vault: string): Promise<PostCard[]> {
  const rows: unknown[] = [];
  for (let offset = 0; offset < PAGE * 20; offset += PAGE) {
    const page = await invoke<unknown[]>("vault_query", { vault, tag: "post", includeContent: false, limit: PAGE, ...(offset ? { offset } : {}) });
    rows.push(...page);
    if (page.length < PAGE) break;
  }
  return parsePosts(rows as never[]);
}

function openLink(url: string) {
  void invoke("open_link", { url }).catch(() => {});
}

function Text({ text }: { text: string }) {
  return <>{splitLinks(text).map((p, i) => "url" in p
    ? <a key={i} href={p.url} onClick={(e) => { e.preventDefault(); openLink(p.url); }}>{p.url.replace(/^https?:\/\//, "")}</a>
    : <span key={i}>{p.text}</span>)}</>;
}

/** The post as it will look on the platform: who, the text with its links, and the count against the limit. */
function Preview({ p }: { p: PostCard }) {
  const n = [...p.body].length, limit = LIMIT[p.platform];
  return <div className={`tp-preview tp-on-${p.platform}`}>
    <div className="tp-who"><span className="tp-avatar" aria-hidden="true">{p.account === "aaron" ? "A" : "U"}</span>
      <span><strong>{p.account === "aaron" ? "You" : "Uni"}</strong><small> · {PLATFORM_LABEL[p.platform] ?? p.platform}</small></span></div>
    <p className="tp-body"><Text text={p.body} /></p>
    {limit && limit < 10_000 && <small className={`tp-count ${n > limit ? "over" : ""}`}>{n}/{limit}</small>}
  </div>;
}

function Badge({ p }: { p: PostCard }) {
  // a shape and a word, never colour alone (the Daylight is grayscale)
  return <span className={`tp-badge tp-badge-${p.account}`}><span aria-hidden="true">{p.account === "aaron" ? "●" : "◆"}</span> {voice(p)}</span>;
}

type Busy = { id: string; what: string } | null;

function Card({ p, vault, busy, setBusy, onDone }: { p: PostCard; vault: string; busy: Busy; setBusy: (b: Busy) => void; onDone: (msg: string) => void }) {
  const [mode, setMode] = useState<"none" | "schedule" | "edit">("none");
  const [when, setWhen] = useState("");
  const [text, setText] = useState(p.account === "aaron" ? p.body : "");
  const [err, setErr] = useState<string | null>(null);
  const why = blocked(p);
  const mine = busy?.id === p.id;
  const act = async (what: string, cmd: string, args: Record<string, unknown>, done: string) => {
    setErr(null); setBusy({ id: p.id, what });
    try {
      await invoke(cmd, { vault, id: p.id, ifUpdatedAt: p.updatedAt, ...args });
      setMode("none"); onDone(done);
    } catch (e) { setErr(String(e).replace(/^(invalid|conflict|vault): /, "")); } finally { setBusy(null); }
  };
  const at = scheduleAt(when);
  return <article className={`tp-card tp-${p.state}`} aria-label={`${voice(p)}, ${where(p)}`}>
    <div className="tp-meta"><Badge p={p} /><span className="tp-where">{where(p)}</span></div>
    <Preview p={p} />
    {p.why && <p className="tp-why">{p.why}</p>}
    {p.piece && <p className="tp-piece">From <a href={p.piece} onClick={(e) => { e.preventDefault(); openLink(p.piece); }}>{p.piece.replace(/^https?:\/\//, "")}</a></p>}
    {p.state === "proposed" && <>
      {why && <p className="tp-blocked" role="note">{why}</p>}
      {mode === "none" && <div className="tp-actions">
        <button className="primary" disabled={!!why || !!busy} onClick={() => void act("approve", "post_approve", {}, "Approved. It goes out within a minute.")}>{mine && busy?.what === "approve" ? "Approving…" : "Approve"}</button>
        <button disabled={!!why || !!busy} onClick={() => setMode("schedule")}>Schedule</button>
        <button disabled={!!busy} onClick={() => setMode("edit")}>Edit</button>
        <button disabled={!!busy} onClick={() => void act("drop", "post_drop", {}, "Dropped. It won't go out.")}>Not this</button>
      </div>}
      {mode === "schedule" && <div className="tp-form">
        <label>Goes out at <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} /></label>
        <div className="tp-actions">
          <button className="primary" disabled={!at || !!busy} onClick={() => void act("approve", "post_approve", { scheduledFor: at }, "Scheduled.")}>Approve for then</button>
          <button onClick={() => setMode("none")}>Cancel</button>
        </div>
        {when && !at && <small>Pick a time from a minute from now.</small>}
      </div>}
      {mode === "edit" && <div className="tp-form">
        <label>{editMode(p) === "words" ? "Your words. They go out exactly as you write them, and need your approval again." : "A note to Uni. Uni rewrites the post and it comes back as a new one; your words never go out under Uni's name."}
          <textarea rows={editMode(p) === "words" ? 5 : 3} value={text} onChange={(e) => setText(e.target.value)} /></label>
        <div className="tp-actions">
          <button className="primary" disabled={!text.trim() || !!busy} onClick={() => void act("edit", "post_edit", { text }, editMode(p) === "words" ? "Saved as your words. Approve it when ready." : "Sent to Uni.")}>{editMode(p) === "words" ? "Save" : "Send to Uni"}</button>
          <button onClick={() => setMode("none")}>Cancel</button>
        </div>
      </div>}
    </>}
    {p.state === "approved" && <div className="tp-actions"><span className="tp-status">{waitingLine(p)}</span>
      <button disabled={!!busy} onClick={() => void act("drop", "post_drop", {}, "Stopped. It won't go out.")}>Not this</button></div>}
    {p.state === "posting" && <p className="tp-status">{waitingLine(p)}</p>}
    {p.state === "posted" && <p className="tp-status">Posted{p.postedUrl && <> · <a href={p.postedUrl} onClick={(e) => { e.preventDefault(); openLink(p.postedUrl!); }}>open</a></>}</p>}
    {p.state === "taken-down" && <p className="tp-status">Taken down</p>}
    {p.state === "failed" && <p className="tp-status tp-failed">Didn't post: {p.failedReason ?? "no reason given"}</p>}
    {err && <p className="tp-error" role="alert">{err}</p>}
  </article>;
}

export default function ToPost({ vault, node, backTo, onBack }: { vault: string; node?: string | null; backTo: string; onBack: () => void }) {
  const [posts, setPosts] = useState<PostCard[] | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [said, setSaid] = useState<string | null>(null);
  const load = useCallback(async () => {
    try { setPosts(await loadPosts(vault)); setProblem(null); } catch (e) { setProblem(String(e)); }
  }, [vault]);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 60_000);
    const onFocus = () => void load();
    window.addEventListener("focus", onFocus);
    return () => { window.clearInterval(t); window.removeEventListener("focus", onFocus); };
  }, [load]);
  const q = posts ? queue(posts, node ?? null) : null;
  const card = (p: PostCard) => <Card key={p.id} p={p} vault={vault} busy={busy} setBusy={setBusy} onDone={(m) => { setSaid(m); void load(); }} />;
  return <section className="tp-page" aria-label="To post">
    <header className="note-bar tp-bar">
      <button className="note-action" onClick={onBack}>← {backTo}</button>
      <span className="tp-title"><strong>To post</strong>{node && <small> · {node.split("/").pop()}</small>}</span>
      <button className="note-action" onClick={() => void load()}>Refresh</button>
    </header>
    {said && <p className="tp-said" role="status">{said}</p>}
    {problem && <p className="note-error" role="alert">Couldn't read the posts: {problem}</p>}
    {!q && !problem && <p className="tp-empty">Reading…</p>}
    {q && <>
      <h2 className="tp-h">To review{q.review.length ? ` · ${q.review.length}` : ""}</h2>
      {q.review.length ? q.review.map(card) : <p className="tp-empty">Nothing to review.</p>}
      {q.waiting.length > 0 && <><h2 className="tp-h">Going out · {q.waiting.length}</h2>{q.waiting.map(card)}</>}
      {q.done.length > 0 && <><h2 className="tp-h">Lately</h2>{q.done.map(card)}</>}
    </>}
  </section>;
}

/** One quiet line where it is wanted (the front door, an area's work): "To post · 3". Nothing when nothing waits. */
export function ToPostLine({ vault, node, onOpen }: { vault: string; node?: string | null; onOpen: () => void }) {
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const read = () => void loadPosts(vault).then((ps) => { if (live) setN(queue(ps, node ?? null).review.length); }).catch(() => {});
    read();
    const t = window.setInterval(read, 5 * 60_000);
    return () => { live = false; window.clearInterval(t); };
  }, [vault, node]);
  if (!n) return null;
  return <button type="button" className="tp-line" onClick={onOpen}>To post · {n}</button>;
}
