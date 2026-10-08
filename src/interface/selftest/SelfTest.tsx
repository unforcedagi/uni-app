import { useEffect, useRef, useState } from "react";
import { createRouter } from "../router";
import { createThemeModule } from "../modules/theme";
import { clearSelfTest, currentUserAgent, liveAreaApps, platformName, storeSelfTest } from "./gate";
import { evaluateProbe, navProbeHtml, navVerdict, NAV_STAGES, PROBE_HTML, type ProbeResult } from "./probe";
import ProbeFrame, { type ProbeOutcome } from "./ProbeFrame";
import { useAppVersion } from "./useAppVersion";
import { useStoredSelfTest } from "./useSelfTest";

const TIMEOUT_MS = 20000;
// The probe may only call theme.get; every other namespace fails closed (unknown).
const STUB_ROUTER = createRouter([createThemeModule({ theme: () => ({ text: "", muted: "", accent: "selftest", surface: "", line: "", sans: "", serif: "", mono: "" }) })]);

// One stage per frame: the main probe, then one navigation vector each (a navigating frame is gone afterwards).
const STAGES = [{ id: "main", html: PROBE_HTML, nav: false }, ...NAV_STAGES.map((s) => ({ id: s.id, html: navProbeHtml(s.vector), nav: true }))];

/** Settings row: run the hostile probe in sealed frames and store a pass for this platform, app version and webview. */
export default function SelfTest() {
  const userAgent = currentUserAgent();
  const platform = platformName(userAgent);
  const version = useAppVersion();
  const stored = useStoredSelfTest();
  const [stage, setStage] = useState<number | null>(null);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const report = useRef<Record<string, unknown>>({});
  const run = useRef(0);

  const finish = (r: Record<string, unknown> | null) => {
    run.current++;
    const res = evaluateProbe(r);
    setResult(res); setStage(null);
    // A pass is recorded; anything else revokes an earlier one (a webview or sandbox regression).
    if (res.pass && version) storeSelfTest({ platform, passedAt: new Date().toISOString(), appVersion: version, userAgent });
    else clearSelfTest();
  };
  const onStage = (i: number, o: ProbeOutcome) => {
    const s = STAGES[i];
    if (s.nav) report.current[s.id] = navVerdict(o);
    else if (o.report && typeof o.report === "object") Object.assign(report.current, o.report as Record<string, unknown>);
    if (i + 1 < STAGES.length) setStage(i + 1); else finish(report.current);
  };
  useEffect(() => {
    if (stage === null) return;
    const id = run.current;
    const t = window.setTimeout(() => { if (run.current === id) { setTimedOut(true); finish(report.current); } }, TIMEOUT_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage === null]);
  const running = stage !== null;
  const current = liveAreaApps(platform, version, stored, userAgent);

  return <div className="area-selftest">
    <span className="update-version">Area apps</span>
    <p className="selftest-status" role="status">{current ? `Live area apps enabled for ${platform} (self-test passed ${stored!.passedAt.slice(0, 10)}).` : stored ? "Self-test is stale for this app version, webview or platform." : "Live area apps are off until the sandbox self-test passes."}</p>
    <button className="pairing-secondary" disabled={running || !version} onClick={() => { report.current = {}; setTimedOut(false); setResult(null); setStage(0); }}>{running ? "Running…" : "Run sandbox self-test"}</button>
    {running && <div className="selftest-frame" aria-hidden="true"><ProbeFrame key={STAGES[stage].id} html={STAGES[stage].html} nav={STAGES[stage].nav} router={STUB_ROUTER} onDone={(o) => onStage(stage, o)} /></div>}
    {result && <>
      <p className={`selftest-status ${result.pass ? "pass" : "fail"}`} role="status">{result.pass ? "Passed. Live area apps are now on." : timedOut ? "Failed: the probe did not finish. Live area apps are off." : "Failed. Live area apps are off."}</p>
      <ul className="selftest-list" aria-label="Self-test checks">{result.checks.map((c) => <li key={c.id} className={c.ok ? "pass" : "fail"}><span aria-hidden="true">{c.ok ? "✓" : "✗"}</span> {c.label}<span className="sr-only">{c.ok ? " passed" : " failed"}</span></li>)}</ul>
    </>}
  </div>;
}
