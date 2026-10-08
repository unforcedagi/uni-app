import { useEffect, useMemo, useRef } from "react";
import { frameSrcDoc, useSealedFrame } from "../frame";
import { CSP_META } from "../srcdoc";
import type { Router } from "../router";

/** What a probe stage observed. `report` is the in-frame probe's own result (the main probe only). */
export type ProbeOutcome = { report: unknown; violation: boolean };

// Test seam, compiled in only when the build sets VITE_AREAS_TESTHOOKS=1 (the Playwright build):
// lets a test strip the CSP meta to prove the self-test fails without it. Production builds fold this to false.
const TEST_HOOKS = import.meta.env.VITE_AREAS_TESTHOOKS === "1";
const withoutCsp = (doc: string) => doc.replace(CSP_META, "");
const NO_GRANT = {};

/**
 * The self-test's frame: the same sealed host and srcdoc builder as the real
 * frame, plus the probe's report channel. `nav` stages are judged only on what
 * the host observes: a `frame-src` violation of the host's own CSP.
 */
export default function ProbeFrame({ html, router, nav, onDone }: { html: string; router: Router; nav: boolean; onDone: (o: ProbeOutcome) => void }) {
  const srcDoc = useMemo(() => {
    const doc = frameSrcDoc(html);
    return TEST_HOOKS && (window as unknown as { __areasTest?: { stripCsp?: boolean } }).__areasTest?.stripCsp ? withoutCsp(doc) : doc;
  }, [html]);
  const violation = useRef(false);
  const done = useRef(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const finish = (report: unknown) => { if (done.current) return; done.current = true; doneRef.current({ report, violation: violation.current }); };
  const { frame, onLoad } = useSealedFrame({ srcDoc, router, grant: NO_GRANT, onViolation: () => { violation.current = true; } });

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (nav || e.source === null || e.source !== frame.current?.contentWindow) return;
      const d = e.data as { probe?: unknown; results?: unknown } | null;
      if (d && typeof d === "object" && d.probe === 1) finish(d.results);
    };
    window.addEventListener("message", onMessage);
    // A nav stage has nothing to report: after a short wait the host judges what it observed.
    const t = nav ? window.setTimeout(() => finish(null), 2000) : 0;
    return () => { window.removeEventListener("message", onMessage); window.clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nav]);

  return <iframe ref={frame} className="area-frame" title="Sandbox self-test" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={srcDoc} onLoad={onLoad} />;
}
