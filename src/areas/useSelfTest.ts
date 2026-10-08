import { useMemo, useSyncExternalStore } from "react";
import { parseSelfTest, readSelfTestRaw, subscribeSelfTest, type SelfTestPass } from "./gate";

/** The stored self-test pass, live: a pass or a clear updates every mounted reader. */
export function useStoredSelfTest(): SelfTestPass | null {
  const raw = useSyncExternalStore(subscribeSelfTest, readSelfTestRaw, () => null);
  return useMemo(() => parseSelfTest(raw), [raw]);
}
