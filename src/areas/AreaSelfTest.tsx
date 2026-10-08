import { useEffect, useMemo, useRef, useState } from "react";
import AreaFrame from "./AreaFrame";
import type { BridgeApi } from "./bridge";
import { platformName, readSelfTest, storeSelfTest, type SelfTestPass } from "./gate";
import { evaluateProbe, PROBE_HTML, type ProbeResult } from "./probe";
import { useAppVersion } from "./useAppVersion";

const TIMEOUT_MS = 8000;
const nothing = () => Promise.reject(new Error("selftest"));
// The probe may only call area.get; every other method fails closed.
const STUB: BridgeApi = {
  areaGet: () => Promise.resolve({ title: "selftest", body: "", metadata: {}, updatedAt: null }),
  notesList: nothing, noteGet: nothing, channelRecent: nothing, channelCompose: nothing, noteOpen: nothing,
};

/** Settings row: run the hostile probe app in the real AreaFrame and store a pass for this platform and version. */
export default function AreaSelfTest() {
  const platform = platformName(typeof navigator === "undefined" ? "" : navigator.userAgent);
  const version = useAppVersion();
  const [stored, setStored] = useState<SelfTestPass | null>(() => readSelfTest());
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [timedOut, setTimedOut] = useState(false);
  const done = useRef(false);

  const finish = (report: unknown) => {
    if (done.current) return;
    done.current = true;
    const r = evaluateProbe(report);
    setResult(r); setRunning(false);
    if (r.pass && version) {
      const pass = { platform, passedAt: new Date().toISOString(), appVersion: version };
      storeSelfTest(pass); setStored(pass);
    }
  };
  useEffect(() => {
    if (!running) return;
    const t = window.setTimeout(() => { if (!done.current) { setTimedOut(true); finish(null); } }, TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [running]);
  const api = useMemo(() => STUB, []);
  const current = !!stored && stored.platform === platform && stored.appVersion === version;

  return <div className="area-selftest">
    <span className="update-version">Area apps</span>
    <p className="selftest-status" role="status">{current ? `Live area apps enabled for ${platform} (self-test passed ${stored!.passedAt.slice(0, 10)}).` : stored ? "Self-test is stale for this app version or platform." : "Live area apps are off until the sandbox self-test passes."}</p>
    <button className="pairing-secondary" disabled={running || !version} onClick={() => { done.current = false; setTimedOut(false); setResult(null); setRunning(true); }}>{running ? "Running…" : "Run sandbox self-test"}</button>
    {running && <div className="selftest-frame" aria-hidden="true"><AreaFrame html={PROBE_HTML} api={api} title="Sandbox self-test" onProbe={finish} /></div>}
    {result && <>
      <p className={`selftest-status ${result.pass ? "pass" : "fail"}`} role="status">{result.pass ? "Passed. Live area apps are now on." : timedOut ? "Failed: the probe did not report back." : "Failed. Live area apps stay off."}</p>
      <ul className="selftest-list" aria-label="Self-test checks">{result.checks.map((c) => <li key={c.id} className={c.ok ? "pass" : "fail"}><span aria-hidden="true">{c.ok ? "✓" : "✗"}</span> {c.label}<span className="sr-only">{c.ok ? " passed" : " failed"}</span></li>)}</ul>
    </>}
  </div>;
}
