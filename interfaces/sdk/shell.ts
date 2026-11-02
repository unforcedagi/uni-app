// T-305 interface platform spike: the shell's capability API as an interface bundle sees it.
//
// Any agent can build its own interface on this: a bundle of HTML, JS and CSS, signed with the agent's key, that
// talks to the person's shell only through these calls. The shell grants each interface capabilities by name
// (`rooms.read`, `rooms.send`, ...); a call outside the grants is refused by the shell, not by this file.
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** The shell command API this bundle was built against. A shell with another one is refused at boot. */
export const SHELL_API = 1;

export type Room = { id: string; name: string; last_message: string | null; last_ts: number | null; mentions: boolean; unread: number; dm?: boolean | null };
export type Letter = { ref: string; channel: string; author: string; author_name: string; ts: number; body: string; mentions_me: boolean; root: string | null };
export type Live = { kind: "message" | "edit" | "delete" | "rooms" | "profiles" | "status" | "typing"; channel: string | null; status: string | null; author: string | null };
export type Interface = { id: string; name: string; active: boolean; grants: string[] };
type Status = { shell_api: number; iface?: string; active: { version: string; api: number } | null };

/** Shell calls the person hasn't granted come back as an error that names the capability. */
export class NotGranted extends Error {}

async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    const msg = typeof e === "string" ? e : e instanceof Error ? e.message : JSON.stringify(e);
    if (msg.startsWith("not granted")) throw new NotGranted(msg);
    throw new Error(msg);
  }
}

export const shell = {
  /** Before the first render. False when this bundle doesn't fit the shell: the shell drops it and reloads Uni. */
  async handshake(): Promise<boolean> {
    const s = await call<Status>("ota_status");
    if (s.shell_api === SHELL_API) return true;
    await call("ota_reject", { reason: `built for shell API ${SHELL_API}, shell has ${s.shell_api}` }).catch(() => {});
    return false;
  },
  /** After the first render: the bundle on trial is kept. Then the shell looks for a newer one for next launch. */
  ready(): void {
    void call("ota_ready").catch(() => {});
    window.setTimeout(() => void call("ota_check").catch(() => {}), 3000);
  },
  rooms: {
    /** Ask the relay for what's new; the lists below read the device's copy. */
    sync: () => call<unknown>("refresh"),
    list: () => call<Room[]>("get_rooms"),
    letters: (channel: string, limit = 40) => call<Letter[]>("get_messages", { channel, root: null, limit }),
    send: (channel: string, body: string) => call<Letter>("post_message", { channel, body, replyTo: null, recipients: [] }),
    markRead: (channel: string) => call<void>("mark_read", { channel }),
    /** New messages, edits and room changes as they happen. The payload says where, not what: re-read the room. */
    async watch(on: (p: Live) => void): Promise<UnlistenFn> {
      await call("live_start").catch(() => {});
      return listen<Live>("uni://live", (e) => on(e.payload));
    },
  },
  interfaces: {
    list: () => call<Interface[]>("iface_list"),
    /** Switch the shell to another interface the person installed. The page reloads into it. */
    use: (id: string) => call<void>("iface_use", { id }),
  },
};
