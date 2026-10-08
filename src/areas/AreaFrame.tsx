import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AreaBridge, type BridgeApi } from "./bridge";
import { buildSrcdoc, type ThemeData } from "./areasCore";
import { FRAME_FONT_CSS } from "./frameFonts";
import { gestureFresh, LoadTripwire, STOPPED_MESSAGE } from "./frameGuard";

const VARS: [keyof ThemeData, string][] = [["text", "--text"], ["muted", "--muted"], ["accent", "--accent"], ["surface", "--surface"], ["line", "--line"], ["sans", "--sans"], ["serif", "--serif"], ["mono", "--mono"]];
function readTheme(): ThemeData {
  const css = getComputedStyle(document.documentElement);
  return Object.fromEntries(VARS.map(([key, v]) => [key, css.getPropertyValue(v).trim()])) as ThemeData;
}

/** The sealed srcdoc for an app: CSP first, WebRTC removed, host fonts, then the app. */
export const frameSrcDoc = (html: string) => buildSrcdoc(html, FRAME_FONT_CSS);

/**
 * The sealed-frame host, shared by the real frame and the self-test's
 * frame. It owns the bridge (only messages from this iframe's own window are
 * read), the theme events, the user-gesture signal and the load tripwire: the
 * frame loads once per srcdoc, and a second load closes the bridge and flags
 * the frame so the caller unmounts it.
 */
export function useSealedFrame(srcDoc: string, api: BridgeApi, onTrip?: (loads: number) => void) {
  const frame = useRef<HTMLIFrameElement>(null);
  const bridge = useRef<AreaBridge | null>(null);
  const tripwire = useRef(new LoadTripwire());
  const apiRef = useRef(api);
  apiRef.current = api;
  const tripRef = useRef(onTrip);
  tripRef.current = onTrip;
  const [tripped, setTripped] = useState(false);

  useEffect(() => {
    tripwire.current.reset(); setTripped(false);
    let focusedAt: number | null = null;
    const proxy: BridgeApi = {
      areaGet: () => apiRef.current.areaGet(), notesList: (l) => apiRef.current.notesList(l), noteGet: (p) => apiRef.current.noteGet(p),
      channelRecent: (l) => apiRef.current.channelRecent(l), channelCompose: (t) => apiRef.current.channelCompose(t), noteOpen: (r) => apiRef.current.noteOpen(r),
    };
    const gesture = () => gestureFresh({
      iframeFocused: !!frame.current && document.activeElement === frame.current,
      userActive: typeof navigator !== "undefined" && navigator.userActivation ? navigator.userActivation.isActive : null,
      focusedAt, now: Date.now(),
    });
    // targetOrigin must be "*": a sandboxed srcdoc frame's origin is opaque.
    const b = new AreaBridge((m) => frame.current?.contentWindow?.postMessage(m, "*"), proxy, Date.now, { gesture });
    bridge.current = b;
    const onMessage = (e: MessageEvent) => { if (e.source === null || e.source !== frame.current?.contentWindow) return; b.handle(e.data); };
    const onBlur = () => { if (frame.current && document.activeElement === frame.current) focusedAt = Date.now(); };
    window.addEventListener("message", onMessage);
    window.addEventListener("blur", onBlur);
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const retheme = () => b.sendTheme(readTheme());
    mq?.addEventListener?.("change", retheme);
    return () => { b.close(); window.removeEventListener("message", onMessage); window.removeEventListener("blur", onBlur); mq?.removeEventListener?.("change", retheme); bridge.current = null; };
  }, [srcDoc]);

  const onLoad = useCallback(() => {
    if (tripwire.current.load()) { bridge.current?.close(); setTripped(true); tripRef.current?.(tripwire.current.count); return; }
    bridge.current?.sendTheme(readTheme());
  }, []);
  return { frame, tripped, onLoad };
}

/**
 * Area HTML runs in `sandbox="allow-scripts"` (never allow-same-origin, so it
 * has an opaque origin, no storage, no Tauri) under a CSP that forbids all
 * network, inside a host whose own CSP allows only `frame-src about:`. Its
 * only door is the postMessage bridge.
 */
export default function AreaFrame({ html, api, title }: { html: string; api: BridgeApi; title: string }) {
  const srcDoc = useMemo(() => frameSrcDoc(html), [html]);
  const { frame, tripped, onLoad } = useSealedFrame(srcDoc, api);
  if (tripped) return <p className="area-stopped" role="alert">{STOPPED_MESSAGE}</p>;
  return <iframe ref={frame} className="area-frame" title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} onLoad={onLoad} />;
}
