// T-77b P3-1: on Linux the app deletes webkit's `ipc` script message handler so sealed frames cannot post to it
// (src-tauri `close_ipc_handler`). If one `ipc://` fetch ever fails, Tauri falls back to that handler and throws
// this TypeError, and invokes stay dead until restart. Say so instead of failing silently.
export const IPC_LOST_MESSAGE = "Uni lost its connection to the app core. Restart Uni.";

export function isLostIpcError(e: unknown): boolean {
  const text = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  return /messageHandlers/.test(text) && /\bipc\b/.test(text) && /\b(undefined|null)\b/.test(text);
}

/** Linux only. Calls `onLost` once on the first such unhandled error or rejection. Returns an unsubscribe. */
export function watchLostIpc(onLost: (message: string) => void): () => void {
  let told = false;
  const tell = (e: unknown) => { if (!told && isLostIpcError(e)) { told = true; onLost(IPC_LOST_MESSAGE); } };
  const onError = (ev: ErrorEvent) => tell(ev.error ?? ev.message);
  const onRejection = (ev: PromiseRejectionEvent) => tell(ev.reason);
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);
  return () => { window.removeEventListener("error", onError); window.removeEventListener("unhandledrejection", onRejection); };
}
