// T-335 the shape: "Forget this device key" still wipes what the old home kept on this device (an older version's areas, task list, asks,
// titles and layout), now that the code that wrote it is gone from the app; and the one reader's memory and the rooms registry, which the new
// shell reads. Each pattern names a key family the old home wrote (src/areas/areasCache.ts, savedTasks.ts, vaultTasks.ts, noteRefs.tsx,
// homeLayout.ts) or this shell writes (useShape.ts: the registry).
import { reader } from "../vault/reader.ts";
import { clearProjectBodies } from "../areas/projectBody.ts";
import { sweepOldKeys } from "./shapeCore.ts";

export function forgetOldHome(): void {
  reader.forget();
  clearProjectBodies();
  try { sweepOldKeys(localStorage); } catch { /* unavailable storage */ }
}
