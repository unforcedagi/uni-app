import { useEffect, useMemo, useRef } from "react";
import { AreaBridge, type BridgeApi } from "./bridge";
import { buildSrcdoc, type ThemeData } from "./areasCore";
import { FRAME_FONT_CSS } from "./frameFonts";

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
export default function AreaFrame({ html, api, title, onProbe }: { html: string; api: BridgeApi; title: string; onProbe?: (report: unknown) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<AreaBridge | null>(null);
  const apiRef = useRef(api);
  apiRef.current = api;
  const probeRef = useRef(onProbe);
  probeRef.current = onProbe;
  const srcDoc = useMemo(() => buildSrcdoc(html, FRAME_FONT_CSS), [html]);

  useEffect(() => {
    const proxy: BridgeApi = {
      areaGet: () => apiRef.current.areaGet(), notesList: (l) => apiRef.current.notesList(l), noteGet: (p) => apiRef.current.noteGet(p),
      channelRecent: (l) => apiRef.current.channelRecent(l), channelCompose: (t) => apiRef.current.channelCompose(t), noteOpen: (r) => apiRef.current.noteOpen(r),
    };
    // targetOrigin must be "*": a sandboxed srcdoc frame's origin is opaque.
    const b = new AreaBridge((m) => frame.current?.contentWindow?.postMessage(m, "*"), proxy);
    bridge.current = b;
    const onMessage = (e: MessageEvent) => { if (e.source !== frame.current?.contentWindow) return;
      const d = e.data as { probe?: unknown; results?: unknown } | null;
      if (probeRef.current && d && typeof d === "object" && d.probe === 1) probeRef.current(d.results); else b.handle(e.data);
    };
    window.addEventListener("message", onMessage);
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const retheme = () => b.sendTheme(readTheme());
    mq?.addEventListener?.("change", retheme);
    return () => { window.removeEventListener("message", onMessage); mq?.removeEventListener?.("change", retheme); bridge.current = null; };
  }, [srcDoc]);

  return <iframe ref={frame} className="area-frame" title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc}
    onLoad={() => { bridge.current?.sendTheme(readTheme()); }} />;
}
