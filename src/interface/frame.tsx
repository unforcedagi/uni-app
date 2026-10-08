import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import vaultClientSource from "virtual:uni-vault-client";
import { buildSrcdoc } from "./srcdoc";
import { buildKitSource } from "./kits";
import { FRAME_FONT_CSS } from "./frameFonts";
import { createSession, type Session } from "./session";
import { readHostTheme } from "./modules/theme";
import type { Router } from "./router";
import type { Resolved } from "./manifest";

/** Shown in place of a frame whose navigation the host CSP had to block. */
export const STOPPED_MESSAGE = "This app tried to leave its sandbox and was stopped.";
const KIT_SOURCE = buildKitSource({ vaultClientSource });

/** The sealed srcdoc for an app: CSP first, WebRTC removed, kits, host fonts, then the app. */
export const frameSrcDoc = (html: string) => buildSrcdoc(html, { kitSource: KIT_SOURCE, headExtra: FRAME_FONT_CSS });

/**
 * The sealed-frame host, shared by the real frame and the self-test's frame.
 * It owns the session (only messages from this iframe's own window are read),
 * the `ready`/`theme` events, and a host-side listener for `frame-src`
 * violations: the host CSP is what stops a navigation, and a violation is the
 * evidence that something tried one. The real frame stops on a violation.
 */
export function useSealedFrame(opts: { srcDoc: string; router: Router; grant: Resolved; ready?: unknown; stopOnViolation?: boolean; onViolation?: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const session = useRef<Session | null>(null);
  const readyRef = useRef(opts.ready);
  readyRef.current = opts.ready;
  const onViolationRef = useRef(opts.onViolation);
  onViolationRef.current = opts.onViolation;
  const [stopped, setStopped] = useState(false);
  const { srcDoc, router, grant, stopOnViolation } = opts;

  useEffect(() => {
    setStopped(false);
    // targetOrigin must be "*": a sandboxed srcdoc frame's origin is opaque.
    const s = createSession({ post: (m) => frame.current?.contentWindow?.postMessage(m, "*"), router, grant });
    session.current = s;
    const onMessage = (e: MessageEvent) => { if (e.source === null || e.source !== frame.current?.contentWindow) return; s.handle(e.data); };
    const onViolation = (e: SecurityPolicyViolationEvent) => {
      if (!(e.effectiveDirective || e.violatedDirective || "").startsWith("frame-src")) return;
      onViolationRef.current?.();
      if (stopOnViolation) { s.close(); setStopped(true); }
    };
    window.addEventListener("message", onMessage);
    document.addEventListener("securitypolicyviolation", onViolation);
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const retheme = () => s.sendEvent("theme", readHostTheme());
    mq?.addEventListener?.("change", retheme);
    return () => { s.close(); window.removeEventListener("message", onMessage); document.removeEventListener("securitypolicyviolation", onViolation); mq?.removeEventListener?.("change", retheme); session.current = null; };
  }, [srcDoc, router, grant, stopOnViolation]);

  const onLoad = useCallback(() => { session.current?.sendEvent("ready", { contract: 1, ...(readyRef.current as object), theme: readHostTheme() }); }, []);
  return { frame, stopped, onLoad };
}

/**
 * App HTML runs in `sandbox="allow-scripts"` (never allow-same-origin, so it
 * has an opaque origin, no storage, no Tauri) under a CSP that forbids all
 * network, inside a host whose own CSP allows only `frame-src about:`. Its
 * only door is the contract session.
 */
export default function InterfaceFrame({ html, title, router, grant, ready }: { html: string; title: string; router: Router; grant: Resolved; ready: unknown }) {
  const srcDoc = useMemo(() => frameSrcDoc(html), [html]);
  const { frame, stopped, onLoad } = useSealedFrame({ srcDoc, router, grant, ready, stopOnViolation: true });
  if (stopped) return <p className="area-stopped" role="alert">{STOPPED_MESSAGE}</p>;
  return <iframe ref={frame} className="area-frame" title={title} sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} onLoad={onLoad} />;
}
