// T-278 Messages: what the surface decides, without React or Tauri (scripts/messages.test.ts runs it in node).
// The rows come from the Rust side (crates/uni-messages): the webview never holds a Matrix token or key.

export type Status = { state: "signed_out" | "connecting" | "live" | "offline" | "error"; user_id: string | null; homeserver: string | null; error: string | null };
export type RoomRow = { id: string; name: string; preview: string | null; preview_own: boolean; ts: number | null; unread: number; encrypted: boolean; invited: boolean; inviter: string | null; direct: boolean };
export type MessageKind = "text" | "notice" | "emote" | "media" | "undecryptable";
export type SendState = "remote" | "sending" | "sent" | "failed";
export type MessageRow = { key: string; event_id: string | null; sender: string; sender_name: string; own: boolean; ts: number; kind: MessageKind; body: string; state: SendState; encrypted: boolean; edited: boolean };
export type Update = { kind: "status"; status: Status } | { kind: "rooms"; rooms: RoomRow[] } | { kind: "timeline"; room_id: string; items: MessageRow[] } | { kind: "link"; link: LinkRow };
export type MessagesErr = { kind: "signed_out" | "unreachable" | "refused" | "invalid" | "server"; message: string };

export const SEEN_KEY = "uni.messages.seen.v1";
export const OPEN_KEY = "uni.messages.open.v1";

/** A rejection from a `messages_*` command, in the door's shape (a missing command or a broken IPC is "server"). */
export function asMessagesErr(e: unknown): MessagesErr {
  if (e && typeof e === "object" && "kind" in e && "message" in e) {
    const x = e as { kind: unknown; message: unknown };
    const kinds = ["signed_out", "unreachable", "refused", "invalid", "server"];
    if (typeof x.kind === "string" && kinds.includes(x.kind)) return { kind: x.kind as MessagesErr["kind"], message: String(x.message) };
  }
  return { kind: "server", message: typeof e === "string" ? e : e instanceof Error ? e.message : "Messages didn't answer." };
}

export function problemText(p: MessagesErr): string {
  switch (p.kind) {
    case "signed_out": return "Messages isn't signed in on this device.";
    case "unreachable": return "The homeserver isn't answering. What this device last synced is shown.";
    case "refused": return "The homeserver refused that. Check the username and password.";
    case "invalid": return p.message;
    case "server": return `Something went wrong: ${p.message}`;
  }
}

/** What the open thread shows, kept apart per room so a late answer for one room never lands in another. */
export type Thread = { roomId: string; seq: number; items: MessageRow[] | null };

/** A timeline update counts only for the open room; anything else is ignored (its room isn't on screen). */
export function applyTimeline(t: Thread | null, roomId: string, items: MessageRow[]): Thread | null {
  if (!t || t.roomId !== roomId) return t;
  return { ...t, items };
}

/** The answer to opening a room counts only if that room is still the one open, at the same open, and no live
 * update has landed since: each update carries the room's whole window, newer than the answer (an edit, a late
 * decryption or a redaction can leave it the same length or shorter). */
export function applyOpened(t: Thread | null, roomId: string, seq: number, items: MessageRow[]): Thread | null {
  if (!t || t.roomId !== roomId || t.seq !== seq || t.items !== null) return t;
  return { ...t, items };
}

const startOfDay = (ms: number) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** "Today", "Yesterday", a weekday this week, or a date. */
export function dayLabel(ts: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const d = new Date(ts);
  if (days < 7) return d.toLocaleDateString(undefined, { weekday: "long" });
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { weekday: "short", day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}

export const timeLabel = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** The room list's time: the time today, the weekday this week, else the date. */
export function rowTime(ts: number | null, now: number): string {
  if (ts == null) return "";
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86_400_000);
  if (days <= 0) return timeLabel(ts);
  if (days < 7) return new Date(ts).toLocaleDateString(undefined, { weekday: "short" });
  return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

export function previewLine(r: RoomRow): string {
  if (r.invited) return r.inviter ? `${r.inviter} invited you` : "You're invited";
  if (!r.preview) return r.encrypted ? "Encrypted conversation" : "No messages yet";
  return r.preview_own ? `You: ${r.preview}` : r.preview;
}

/** Up to two letters for the monochrome avatar. */
export function initials(name: string): string {
  const words = name.replace(/^[@#!]/, "").split(/[\s:._-]+/).filter(Boolean);
  const pick = words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? "?").slice(0, 2);
  return pick.toUpperCase();
}

export type Shown =
  | { kind: "day"; key: string; label: string }
  | { kind: "message"; key: string; row: MessageRow; first: boolean; last: boolean };

const GROUP_MS = 5 * 60_000;

/** Messages with day dividers; consecutive messages from one sender within five minutes share one name line. */
export function shownItems(rows: MessageRow[], now: number): Shown[] {
  const out: Shown[] = [];
  let prev: MessageRow | null = null;
  let day = "";
  for (const row of rows) {
    const label = dayLabel(row.ts, now);
    if (label !== day) { out.push({ kind: "day", key: `day:${startOfDay(row.ts)}`, label }); day = label; prev = null; }
    const first = !prev || prev.sender !== row.sender || row.ts - prev.ts > GROUP_MS;
    if (first && out.length) { const last = out[out.length - 1]; if (last.kind === "message") last.last = true; }
    out.push({ kind: "message", key: row.key, row, first, last: false });
    prev = row;
  }
  for (let i = out.length - 1; i >= 0; i--) { const x = out[i]; if (x.kind === "message") { x.last = true; break; } }
  for (let i = 0; i < out.length - 1; i++) { const x = out[i], y = out[i + 1]; if (x.kind === "message" && y.kind === "day") x.last = true; }
  return out;
}

/** Your latest message's state, said in words under it (never colour alone). */
export function sendWords(s: SendState): string | null {
  return s === "sending" ? "Sending…" : s === "failed" ? "Didn't send" : s === "sent" ? "Sent" : null;
}

export function statusWords(s: Status | null): string {
  if (!s) return "";
  switch (s.state) {
    case "live": return "LIVE";
    case "connecting": return "CONNECTING";
    case "offline": return "OFFLINE";
    case "error": return "NOT SYNCING";
    case "signed_out": return "SIGNED OUT";
  }
}

// ── Linking accounts (T-282): one card per network, read from its bridge bot by the Rust core (link.rs) ─────────────

export type LinkState = "checking" | "linked" | "not_linked" | "needs_attention" | "unavailable";
export type LinkedAccount = { id: string; name: string; state: string; attention: boolean };
export type Flow = { id: string; description: string };
export type LinkStep =
  | { kind: "flows"; flows: Flow[] }
  | { kind: "input"; name: string; description: string | null; options: string[]; optional: boolean; secret: boolean }
  | { kind: "qr"; modules: string[] }
  | { kind: "code"; code: string }
  | { kind: "cookies"; url: string }
  | { kind: "waiting" }
  | { kind: "done"; text: string }
  | { kind: "failed"; text: string };
export type LinkRow = { network: string; name: string; state: LinkState; accounts: LinkedAccount[]; step: LinkStep | null; note: string | null };

/** What each card says about its network: how you link it, and what keeps it linked. Plain words, no promises. */
export const NETWORK_INFO: Record<string, { how: string; keep: string }> = {
  telegram: { how: "Your phone number, then the code Telegram sends to your Telegram app.", keep: "Steady once linked. Secret chats don't come across." },
  signal: { how: "Scan a QR code with Signal on your phone: Settings, Linked devices.", keep: "Open Signal on your phone at least every 30 days, or the link ends." },
  whatsapp: { how: "Scan a QR code with WhatsApp on your phone: Linked devices. Or pair with a code.", keep: "Your phone must come online every couple of weeks." },
  gmessages: { how: "Sign in to Google in a browser and paste its cookies here, then tap the matching emoji on your phone.", keep: "Your phone stays the hub: it must be on and online for texts to flow." },
  messenger: { how: "Your Facebook username and password, or cookies from messenger.com.", keep: "Fragile: Meta can flag a new login and ask for a check. Two-factor sign-in helps." },
  instagram: { how: "Your Instagram username and password, or cookies from instagram.com.", keep: "Fragile: Meta can flag a new login and ask for a check." },
};

export function linkWords(s: LinkState): string {
  switch (s) {
    case "checking": return "CHECKING";
    case "linked": return "LINKED";
    case "not_linked": return "NOT LINKED";
    case "needs_attention": return "NEEDS ATTENTION";
    case "unavailable": return "NOT RUNNING";
  }
}

/** A card's update replaces that network's card only; an unknown network is added at the end. */
export function applyLink(rows: LinkRow[] | null, row: LinkRow): LinkRow[] | null {
  if (!rows) return rows;
  return rows.some((r) => r.network === row.network) ? rows.map((r) => (r.network === row.network ? row : r)) : [...rows, row];
}

/** A login is under way: the card shows its step and a way to stop. */
export const linking = (r: LinkRow) => !!r.step && r.step.kind !== "done" && r.step.kind !== "failed";

/** The QR's dark modules as one SVG path, in module units, inside a 4-module quiet zone. Only 0 and 1 are read, so
 * nothing from the bridge reaches the page as markup. */
export function qrPath(modules: string[]): { size: number; d: string } {
  const n = modules.length;
  let d = "";
  modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] !== "1") continue;
      let run = 1;
      while (row[x + run] === "1") run++;
      d += `M${x + 4} ${y + 4}h${run}v1h-${run}z`;
      x += run - 1;
    }
  });
  return { size: n + 8, d };
}
