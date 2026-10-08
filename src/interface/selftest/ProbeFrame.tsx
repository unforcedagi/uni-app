import { useEffect, useMemo, useRef } from "react";
import { frameSrcDoc, useSealedFrame } from "./AreaFrame";
import type { BridgeApi } from "./bridge";

/** What a probe stage observed. `report` is the in-frame probe's own result (the main probe only). */
export type ProbeOutcome = { report: unknown; loads: number; violation: boolean };

// Test seam, compiled in only when the build sets VITE_AREAS_TESTHOOKS=1 (the Playwright areas build):
// lets a test strip the CSP meta to prove the self-test fails without it. Production builds fold this to false.
const TEST_HOOKS = import.meta.env.VITE_AREAS_TESTHOOKS === "1";
const withoutCsp = (doc: string) => doc.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "");

/**
 * The self-test's frame: the same sealed host and srcdoc builder as AreaFrame,
 * plus the probe's report channel and a `frame-src` violation listener, kept
 * out of the production frame. `nav` stages are judged on what the host sees:
 * loads of the iframe and a violation of the host's `frame-src`.
 */
export default function ProbeFrame({ html, api, nav, onDone }: { html: string; api: BridgeApi; nav: boolean; onDone: (o: ProbeOutcome) => void }) {
  const srcDoc = useMemo(() => {
    const doc = frameSrcDoc(html);
    return TEST_HOOKS && (window as unknown as { __areasTest?: { stripCsp?: boolean } }).__areasTest?.stripCsp ? withoutCsp(doc) : doc;
  }, [html]);
  const loads = useRef(0);
  const violation = useRef(false);
  const done = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const finish = (report: unknown) => { if (done.current) return; done.current = true; doneRef.current({ report, loads: loads.current, violation: violation.current }); };
  // A second load trips the real frame's wire; here it is the evidence a nav stage looks for.
  const { frame, tripped, onLoad } = useSealedFrame(srcDoc, api, (n) => { loads.current = n; finish(null); });

  useEffect(() => {
    const onViolation = (e: SecurityPolicyViolationEvent) => { if ((e.effectiveDirective || e.violatedDirective || "").startsWith("frame-src")) violation.current = true; };
    const onMessage = (e: MessageEvent) => {
      if (nav || e.source === null || e.source !== frame.current?.contentWindow) return;
      const d = e.data as { probe?: unknown; results?: unknown } | null;
      if (d && typeof d === "object" && d.probe === 1) finish(d.results);
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    window.addEventListener("message", onMessage);
    // A nav stage has nothing to report: after a short wait the host judges what it observed.
    const t = nav ? window.setTimeout(() => finish(null), 2500) : 0;
    return () => { document.removeEventListener("securitypolicyviolation", onViolation); window.removeEventListener("message", onMessage); window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav]);

  if (tripped) return null;
  return <iframe ref={frame} className="area-frame" title="Sandbox self-test" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc}
    onLoad={() => { loads.current = Math.max(loads.current, 1); onLoad(); }} />;
}
