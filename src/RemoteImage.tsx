// T-335: images from content, shown without the content making the webview fetch anything (see noteImages.ts). The app's CSP
// refuses remote images anyway; this is the renderer's half: a vault attachment is read by the app and shown from a `blob:` URL,
// and a remote image is a link with a "Load image" tap that fetches that one image through the app (`remote_image`).
import { createContext, useContext, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { imageBlob, imageLabel, imageSource } from "./noteImages";

/** Bytes → an object URL, revoked when the image goes or changes. `load` null: nothing yet (a remote image before its tap). */
function useBlobImage(load: (() => Promise<ArrayBuffer>) | null, key: string, nameHint: string) {
  const [state, setState] = useState<{ url: string | null; error: string | null }>({ url: null, error: null });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!load) { setState({ url: null, error: null }); return; }
    let live = true;
    let made: string | null = null;
    setState({ url: null, error: null });
    load().then((buf) => {
      if (!live) return;
      made = URL.createObjectURL(imageBlob(buf, nameHint));
      setState({ url: made, error: null });
    }, (e) => { if (live) setState({ url: null, error: String(e) || "couldn't load" }); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
    // `load` is rebuilt each render; `key` names what it loads
  }, [key, attempt, !!load]);
  return { ...state, busy: !!load && !state.url && !state.error, retry: () => setAttempt((n) => n + 1) };
}

/** Inside a link already: an image there shows as words, not a second link. */
export const InLink = createContext(false);

type LinkLike = ComponentType<{ href: string; className?: string; children?: ReactNode }>;

/** A remote image: its words as a link (or plain, inside a link) and a "Load image" tap; once tapped, the image. */
export function RemoteImage({ url, alt, Link }: { url: string; alt: string; Link: LinkLike }) {
  const inLink = useContext(InLink);
  const [asked, setAsked] = useState(false);
  const img = useBlobImage(asked ? () => invoke<ArrayBuffer>("remote_image", { url }) : null, url, url);
  if (img.url) return <img src={img.url} alt={alt} className="note-image" />;
  const label = imageLabel(alt, url);
  const words = alt.trim() || url;
  return <span className="note-image-remote">
    {inLink ? <span className="note-image-words">{words}</span> : <Link href={url} className="note-image-link">{words}</Link>}
    {img.busy ? <span className="note-image-state" role="status">Loading image…</span>
      : <button type="button" className="note-image-load" aria-label={`Load image: ${label}`} title="Loads this one image from its site, which then knows it was opened"
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); if (img.error) img.retry(); else setAsked(true); }}>
          {img.error ? "Couldn't load · Retry" : "Load image"}
        </button>}
  </span>;
}

/** An image attached to the note, read by the app. */
function VaultAttachmentImage({ vault, note, path, alt }: { vault: string; note: string; path: string; alt: string }) {
  const img = useBlobImage(() => invoke<ArrayBuffer>("vault_attachment", { vault, note, path }), `${vault}\n${note}\n${path}`, path);
  const name = alt.trim() || path.split("/").pop() || "image";
  if (img.url) return <img src={img.url} alt={alt} className="note-image" />;
  if (img.error) return <span className="note-image-missing" role="img" aria-label={`${name}: couldn't show this attachment`} title={img.error}>🖼 {name} · couldn't show this attachment</span>;
  return <span className="note-image-loading" aria-busy="true" aria-label={`Loading ${name}`} />;
}

/**
 * The `img` of a rendered note (react-markdown's component), bound to the note it is in. Never renders a remote `src`: see
 * {@link imageSource}.
 */
export function noteImage(o: { vault: string; note: string; hubs: readonly (string | null | undefined)[]; Link: LinkLike }) {
  return function NoteImage({ src, alt }: { src?: unknown; alt?: unknown }) {
    const words = typeof alt === "string" ? alt : "";
    const s = imageSource(src, o.hubs);
    switch (s.kind) {
      case "vault": return <VaultAttachmentImage vault={o.vault} note={o.note} path={s.path} alt={words} />;
      case "inline": return <img src={s.src} alt={words} className="note-image" />;
      case "remote": return <RemoteImage url={s.url} alt={words} Link={o.Link} />;
      default: return words ? <span className="note-image-words">{words}</span> : null;
    }
  };
}

/**
 * A chat message's link to an image (T-335: was a preview the webview fetched on sight). The link is in the message already; this is
 * its "Load image" tap, then the image, which opens full size.
 */
export function ChatLinkImage({ url, onOpen }: { url: string; onOpen: (src: string, alt: string) => void }) {
  const [asked, setAsked] = useState(false);
  const img = useBlobImage(asked ? () => invoke<ArrayBuffer>("remote_image", { url }) : null, url, url);
  if (img.url) return <button className="attachment-image" onClick={() => onOpen(img.url!, url)} aria-label={`Open image ${url}`}><img src={img.url} alt="" /></button>;
  const host = imageLabel("", url);
  return <div className="attachment-remote">
    <span className="attachment-remote-host" title={url}>🖼 {host}</span>
    {img.busy ? <small role="status">Loading image…</small>
      : <button type="button" className="attachment-save attachment-save-pill" aria-label={`Load image from ${host}`} title="Loads this one image from its site, which then knows it was opened"
          onClick={() => { if (img.error) img.retry(); else setAsked(true); }}>{img.error ? "Couldn't load · Retry" : "Load image"}</button>}
  </div>;
}
