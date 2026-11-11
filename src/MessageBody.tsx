import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { openLink as routeLink } from "./openLink.ts";
import { parseMarkdown, type Block, type Inline } from "./markdown";
import { mentionSegments, type Member } from "./mentions";
import { useNoteOpener } from "./noteLinks";
import { splitMarkers } from "./chatMarkers";
import { useNoteTitle } from "./areas/noteRefs";
import { CodeBlock } from "./CodeBlock";
import { refLabel } from "./vaultlinks";

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
/** A cell that is a number (an amount, a count, a share, a measure). */
const NUMBER = /^\s*[-+−]?[$€£]?\s*\d[\d.,\s]*\s*(%|[a-zµ°]{0,3})\s*$/i;
/** A cell's text, for telling numbers apart. */
const plain = (nodes: Inline[]): string => nodes.map((n) => n.t === "text" || n.t === "code" ? n.v : "c" in n ? plain(n.c) : "").join("");
/** T-335 chat feel: a table wider than its column scrolls sideways inside it, with a fade on the cut edge while there is more to see. */
function TableWrap({ children }: { children: ReactNode }) {
  const el = useRef<HTMLDivElement>(null);
  const [cut, setCut] = useState(false);
  useEffect(() => {
    const box = el.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const look = () => setCut(box.scrollWidth - box.clientWidth - box.scrollLeft > 2);
    const ro = new ResizeObserver(look);
    ro.observe(box);
    box.addEventListener("scroll", look, { passive: true });
    look();
    return () => { ro.disconnect(); box.removeEventListener("scroll", look); };
  }, []);
  return <div ref={el} className={`md-table-wrap${cut ? " cut" : ""}`}>{children}</div>;
}
/** A note cited by its bare id (`uni:01M…`) reads as the note's title (r14), never as the id: "a note" when it can't be read (the id stays in
 *  the chip's tooltip). */
function NoteChipLabel({ id, vault }: { id: string; vault: string }) {
  const t = useNoteTitle({ vault, id });
  return <>{t ?? "the linked note"}</>;
}
const bareId = (n: { ref: { ref: string; vault: string }; c: Inline[] }): string | null => {
  const id = n.ref.ref.trim();
  if (!ULID.test(id) || n.c.length !== 1 || n.c[0].t !== "text") return null;
  const label = n.c[0].v.trim();
  return label === id || label === `${n.ref.vault}:${id}` || label === refLabel({ hub: null, vault: n.ref.vault, ref: id }) ? id : null;
};

function openLink(e: React.MouseEvent, href: string) {
  // Never navigate the app's own WebView; hand the link to the system browser.
  e.preventDefault();
  void routeLink(href).catch(() => {});
}

// Memoized: typing in the composer re-renders the room, and re-parsing
// every message's markdown on each keystroke made input lag on the Daylight.
export const Body = memo(function Body({ body, mentions, me, edited }: { body: string; mentions: Member[]; me: string | null; edited?: boolean }) {
  const openNote = useNoteOpener();
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
      case "vaultlink": return <a key={k} href={n.href ?? "#"} className="note-chip" title={`${n.ref.vault}: ${n.ref.ref}`}
        onClick={(e) => {
          if (openNote) { e.preventDefault(); openNote(n.ref, n.href); }
          else if (n.href) openLink(e, n.href);
          else e.preventDefault();
        }}><span className="note-chip-mark" aria-hidden="true">❋</span>{bareId(n) ? <NoteChipLabel id={bareId(n)!} vault={n.ref.vault} /> : inline(n.c, k)}</a>;
    }
  });
  const blocks = (bs: Block[], key: string): React.ReactNode[] => bs.map((b, i) => {
    const k = `${key}.${i}`;
    switch (b.t) {
      case "p": return <p key={k}>{inline(b.c, k)}</p>;
      case "h": return <p key={k} className={`md-h md-h${b.level}`}>{inline(b.c, k)}</p>;
      case "code": return <CodeBlock key={k} lang={b.lang} code={b.v} />;
      case "quote": return <blockquote key={k}>{blocks(b.c, k)}</blockquote>;
      case "hr": return <hr key={k} />;
      case "list": {
        const items = b.items.map((it, j) => <li key={`${k}.${j}`}>{blocks(it, `${k}.${j}`)}</li>);
        return b.ordered ? <ol key={k} start={b.start}>{items}</ol> : <ul key={k}>{items}</ul>;
      }
      case "table": {
        // T-335 chat feel: a column of numbers lines up on the right (unless the table says otherwise)
        const num = b.head.map((_, j) => !b.align[j] && b.rows.length > 0 && b.rows.every((r) => NUMBER.test(plain(r[j] ?? []))));
        const cls = (j: number) => (num[j] ? "num" : undefined);
        return <TableWrap key={k}><table className="md-table">
        <thead><tr>{b.head.map((c, j) => <th key={j} className={cls(j)} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>{inline(c, `${k}.h${j}`)}</th>)}</tr></thead>
        <tbody>{b.rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j} className={cls(j)} style={b.align[j] ? { textAlign: b.align[j]! } : undefined}>{inline(c, `${k}.${ri}.${j}`)}</td>)}</tr>)}</tbody>
      </table></TableWrap>;
      }
    }
  });
  const split = splitMarkers(body);
  const tree = parseMarkdown(split.text);
  // r14: the task-state markers ([done T-123]) are bookkeeping for the rooms, not words for the reader: they are taken out and not shown
  return <div className="md">{blocks(tree, "b")}{edited && <span className="edited" title="Edited by the author">(edited)</span>}</div>;
});
