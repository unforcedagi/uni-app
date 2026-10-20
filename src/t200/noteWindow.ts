import { useEffect, useState } from "react";
import type { VaultRef } from "../vaultlinks";
import { WIDE } from "./mode";

/** The main window and its note windows talk over this channel (same origin, so it reaches every window of the app). */
export const NOTE_CHANNEL = "uni.t200.notes";

/** Tauri is behind this page (not the browser preview, whose stand-in backend marks itself `browser`). */
const inTauri = () => "__TAURI_INTERNALS__" in window && !(window as { __t200?: { browser?: boolean } }).__t200?.browser;

const touchOnly = () => /Android|iPhone|iPad/i.test(navigator.userAgent);

/** `wide`: room for the note beside the chat. `desktop`: also room for a second window (wide, and not a phone or tablet). */
export function useWidth(): { wide: boolean; desktop: boolean } {
  const [wide, setWide] = useState(() => window.matchMedia(WIDE).matches);
  useEffect(() => {
    const q = window.matchMedia(WIDE);
    const sync = () => setWide(q.matches);
    q.addEventListener("change", sync);
    return () => q.removeEventListener("change", sync);
  }, []);
  return { wide, desktop: wide && !touchOnly() };
}

/** The note window's address: the same app, told to show one note and which room its quotes go to. */
export function noteWindowUrl(target: VaultRef, room: string): string {
  const q = new URLSearchParams(location.search);
  q.set("noteWindow", "1"); q.set("vault", target.vault); q.set("ref", target.ref); q.set("room", room);
  return `${location.pathname}?${q}`;
}

/** C: open (or bring forward) the note in its own window. One window per note. */
export async function openNoteWindow(target: VaultRef, room: string) {
  const url = noteWindowUrl(target, room);
  const label = `note-${Array.from(`${target.vault}:${target.ref}`).reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7).toString(36)}`;
  // The browser preview has no Tauri behind it: a plain popup window shows the same page.
  if (!inTauri()) {
    window.open(url, label, "popup,width=560,height=820");
    return;
  }
  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const open = await WebviewWindow.getByLabel(label);
  if (open) { await open.setFocus(); return; }
  new WebviewWindow(label, { url, title: "Note", width: 560, height: 820 });
}

/** A note window closing itself (a WebView ignores window.close() on a window it did not open from script). */
export async function closeSelf() {
  if (!inTauri()) { window.close(); return; }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().close();
}

/** The main window coming forward when a quote arrives from a note window. */
export async function focusSelf() {
  if (!inTauri()) { window.focus(); return; }
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().setFocus().catch(() => {});
}

/** In a note window: which note, and the room it was opened from. */
export function noteWindowParams(): { target: VaultRef; room: string } | null {
  const q = new URLSearchParams(location.search);
  if (q.get("noteWindow") !== "1") return null;
  const vault = q.get("vault"), ref = q.get("ref"), room = q.get("room");
  return vault && ref && room ? { target: { hub: null, vault, ref }, room } : null;
}
