// Desktop mention notifications and the dock/taskbar unread badge.
// Android is skipped: the live socket stops when the app is backgrounded, so
// there is nothing to notify from there yet.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { markdownToText } from "./markdown";

const desktop = !/Android/i.test(navigator.userAgent);
let permission: Promise<boolean> | null = null;

function allowed(): Promise<boolean> {
  if (!desktop) return Promise.resolve(false);
  permission ??= isPermissionGranted()
    .then((ok) => ok || requestPermission().then((p) => p === "granted"))
    .catch(() => false);
  return permission;
}

/** Notify when a mention arrives and the user isn't already looking at it. */
export async function notifyMention(opts: { author: string; room: string; preview: string; looking: boolean }) {
  await notifyPlain({ ...opts, preview: markdownToText(opts.preview), fallback: "Mentioned you" });
}
/** T-161: the same notification, its text shown as written (a shell command is not markdown). */
export async function notifyPlain(opts: { author: string; room: string; preview: string; looking: boolean; fallback?: string }) {
  if (opts.looking || !(await allowed())) return;
  const body = opts.preview.replace(/\s+/g, " ").trim().slice(0, 140);
  sendNotification({ title: `${opts.author} in #${opts.room.replace(/^#/, "")}`, body: body || opts.fallback || "" });
}

/** Dock badge = unread count (macOS; a no-op elsewhere). */
export function setUnreadBadge(n: number) {
  if (!desktop) return;
  void getCurrentWindow().setBadgeCount(n > 0 ? n : undefined).catch(() => {});
}
