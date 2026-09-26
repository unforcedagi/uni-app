import { memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { parseMarkdown, type Block, type Inline } from "./markdown";
import { mentionSegments, type Member } from "./mentions";

function openLink(e: React.MouseEvent, href: string) {
  // Never navigate the app's own WebView; hand the link to the system browser.
  e.preventDefault();
  void invoke("open_link", { url: href }).catch(() => {});
}

// Memoized: typing in the composer re-renders the room, and re-parsing
// every message's markdown on each keystroke made input lag on the Daylight.
export const Body = memo(function Body({ body, mentions, me, edited }: { body: string; mentions: Member[]; me: string | null; edited?: boolean }) {
  const text = (v: string, key: string) => mentionSegments(v, mentions).map((seg, i) => seg.mention
    ? <span key={`${key}.${i}`} className={`mention ${seg.mention === me ? "mention-me" : ""}`} title={seg.mention}>{seg.text}</span>
    : <span key={`${key}.${i}`}>{seg.text}</span>);
  const inline = (nodes: Inline[], key: string): React.ReactNode[] => nodes.map((n, i) => {
    const k = `${key}.${i}`;
    switch (n.t) {
      case "text": return text(n.v, k);
      case "br": return <br key={k} />;
      case "code": return <code key={k}>{n.v}</code>;
      case "strong": return <strong key={k}>{inline(n.c, k)}</strong>;
      case "em": return <em key={k}>{inline(n.c, k)}</em>;
      case "del": return <del key={k}>{inline(n.c, k)}</del>;
      case "link": return <a key={k} href={n.href} onClick={(e) => openLink(e, n.href)} rel="noreferrer noopener">{inline(n.c, k)}</a>;
    }
  });
  const blocks = (bs: Block[], key: string): React.ReactNode[] => bs.map((b, i) => {
    const k = `${key}.${i}`;
    switch (b.t) {
      case "p": return <p key={k}>{inline(b.c, k)}</p>;
      case "h": return <p key={k} className={`md-h md-h${b.level}`}>{inline(b.c, k)}</p>;
      case "code": return <pre key={k} className="md-pre"><code>{b.v}</code></pre>;
      case "quote": return <blockquote key={k}>{blocks(b.c, k)}</blockquote>;
      case "hr": return <hr key={k} />;
      case "list": {
        const items = b.items.map((it, j) => <li key={`${k}.${j}`}>{blocks(it, `${k}.${j}`)}</li>);
        return b.ordered ? <ol key={k} start={b.start}>{items}</ol> : <ul key={k}>{items}</ul>;
      }
    }
  });
  const tree = parseMarkdown(body);
  return <div className="md">{blocks(tree, "b")}{edited && <span className="edited" title="Edited by the author">(edited)</span>}</div>;
});
