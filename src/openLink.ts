// Open a link from the app: a room's "look here" link for the Arcade opens the Arcade on that card, in the app; every
// other link goes to the system browser (Rust's open_link refuses anything but http(s) and mailto).
import { invoke } from "@tauri-apps/api/core";
import { LOOK_EVENT, lookCard } from "./arcade/arcadeCore.ts";

export function openLink(url: string): Promise<void> {
  const card = lookCard(url);
  if (card) {
    window.dispatchEvent(new CustomEvent(LOOK_EVENT, { detail: card }));
    return Promise.resolve();
  }
  return invoke("open_link", { url });
}
