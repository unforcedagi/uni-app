import { useEffect, useMemo, useRef } from "react";
import { AreaBridge, type BridgeApi } from "./bridge";
import { buildSrcdoc, type ThemeData } from "./areasCore";

const VARS: [keyof ThemeData, string][] = [["text", "--text"], ["muted", "--muted"], ["accent", "--accent"], ["surface", "--surface"], ["line", "--line"], ["sans", "--sans"], ["serif", "--serif"], ["mono", "--mono"]];
function readTheme(): ThemeData {
  const css = getComputedStyle(document.documentElement);
  return Object.fromEntries(VARS.map(([key, v]) => [key, css.getPropertyValue(v).trim()])) as ThemeData;
}

/**
 * The sealed host: area HTML runs in `sandbox="allow-scripts"` (never
 * allow-same-origin, so it has an opaque origin, no storage, no Tauri) under a
 * CSP that forbids all network. Its only door is the postMessage bridge, and
 * only messages from this iframe's own window are read.
 */
export default function AreaFrame({ html, api, title }: { html: string; api: BridgeApi; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<AreaBridge | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  const srcDoc = useMemo(() => buildSrcdoc(html), [html]);

  useEffect(() => {
    const proxy: BridgeApi = {
      areaGet: () => apiRef.current.areaGet(), notesList: (l) => apiRef.current.notesList(l), noteGet: (p) => apiRef.current.noteGet(p),
      channelRecent: (l) => apiRef.current.channelRecent(l), channelCompose: (t) => apiRef.current.channelCompose(t), noteOpen: (r) => apiRef.current.noteOpen(r),
    };
    // targetOrigin must be "*": a sandboxed srcdoc frame's origin is opaque.
    const b = new AreaBridge((m) => frame.current?.contentWindow?.postMessage(m, "*"), proxy);
    bridge.current = b;
    const onMessage = (e: MessageEvent) => { if (e.source === frame.current?.contentWindow) b.handle(e.data); };
    window.addEventListener("message", onMessage);
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const retheme = () => b.sendTheme(readTheme());
    mq?.addEventListener?.("change", retheme);
    return () => { window.removeEventListener("message", onMessage); mq?.removeEventListener?.("change", retheme); bridge.current = null; };
  }, [srcDoc]);

  return <iframe ref={frame} className="area-frame" title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc}
    onLoad={() => { bridge.current?.sendTheme(readTheme()); }} />;
}
