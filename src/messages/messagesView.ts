// T-278 Messages: what the surface decides, without React or Tauri (scripts/messages.test.ts runs it in node).
// The rows come from the Rust side (crates/uni-messages): the webview never holds a Matrix token or key.

export type Status = { state: "signed_out" | "connecting" | "live" | "offline" | "error"; user_id: string | null; homeserver: string | null; error: string | null };
export type RoomRow = { id: string; name: string; preview: string | null; preview_own: boolean; ts: number | null; unread: number; encrypted: boolean; invited: boolean; inviter: string | null; direct: boolean; network?: string };
export type MessageKind = "text" | "notice" | "emote" | "media" | "undecryptable";
export type SendState = "remote" | "sending" | "sent" | "failed";
/** T-313: what a media message carries (the bytes come from `messages_media`, by its event). `mime` is the type the core lets
 * the webview give the bytes: an SVG or anything unknown comes as `application/octet-stream`, shown as a file. */
export type MediaKind = "image" | "video" | "audio" | "voice" | "file";
export type Media = { kind: MediaKind; name: string; mime: string; size: number | null; duration_ms: number | null; width: number | null; height: number | null; caption: string | null };
export type Reply = { event_id: string; sender_name: string | null; text: string | null; unavailable?: boolean };
export type Reaction = { key: string; count: number; own: boolean };
export type Transcript = { text: string };
export type MessageRow = { key: string; event_id: string | null; sender: string; sender_name: string; own: boolean; ts: number; kind: MessageKind; body: string; state: SendState; encrypted: boolean; edited: boolean;
  media?: Media | null; reply?: Reply | null; reactions?: Reaction[] };
export type Update = { kind: "status"; status: Status } | { kind: "rooms"; rooms: RoomRow[] } | { kind: "timeline"; room_id: string; items: MessageRow[] } | { kind: "link"; link: LinkRow };
export type MessagesErr = { kind: "signed_out" | "unreachable" | "refused" | "invalid" | "server"; message: string };

export const SEEN_KEY = "uni.messages.seen.v1";
export const OPEN_KEY = "uni.messages.open.v1";
/** T-294: whether a phone was showing that conversation ("thread") or the list, so coming back shows the same. */
export const PANE_KEY = "uni.messages.pane.v1";
/** T-310: the tab this device was on. */
export const TAB_KEY = "uni.messages.tab.v1";

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

// ── Tabs (T-310): All, then one per network ─────────────────────────────────────────────────────────────────────────

/** The networks, in the order their tabs stand: the Link screen's order, then plain Matrix, then what can't be told.
 * `mark` is the word a row carries in All, so you can tell where someone wrote from without colour. */
export const NETWORK_TABS = [
  { id: "signal", label: "Signal", mark: "SIG" },
  { id: "telegram", label: "Telegram", mark: "TG" },
  { id: "whatsapp", label: "WhatsApp", mark: "WA" },
  { id: "gmessages", label: "SMS", mark: "SMS" },
  { id: "messenger", label: "Messenger", mark: "FB" },
  { id: "instagram", label: "Instagram", mark: "IG" },
  { id: "matrix", label: "Matrix", mark: "MX" },
  { id: "other", label: "Other", mark: "" },
] as const;
export type NetworkId = (typeof NETWORK_TABS)[number]["id"];
export type TabId = "all" | NetworkId;
/** `count`: its conversations. `waiting`: how many of them have something unread, or are an invite. `attention`: its
 * link needs doing again. */
export type Tab = { id: TabId; label: string; count: number; waiting: number; attention: boolean };

const NETWORK_IDS: readonly string[] = NETWORK_TABS.map((n) => n.id);
/** The network a conversation came through; one the core couldn't tell (or didn't say) is Other. */
export const networkOf = (r: RoomRow): NetworkId => (r.network && NETWORK_IDS.includes(r.network) ? r.network as NetworkId : "other");
export const networkInfo = (id: NetworkId) => NETWORK_TABS.find((n) => n.id === id)!;
/** Something there for you: an unread message, or an invite. */
export const waiting = (r: RoomRow) => r.unread > 0 || r.invited;

/** Newest first; a conversation with no time yet goes last. Ties keep the order the core sent. */
export function newestFirst(rows: RoomRow[]): RoomRow[] {
  return [...rows].sort((a, b) => (a.ts === b.ts ? 0 : a.ts == null ? 1 : b.ts == null ? -1 : b.ts - a.ts));
}

/** All, then a tab for each network that has a conversation here or that its Link card says is linked (or needs linking
 * again), in NETWORK_TABS' order. A network with nothing linked has no tab. Only one network and nothing wrong with it:
 * All alone, since its tab would be the same list. */
export function messageTabs(rows: RoomRow[], links: LinkRow[] | null): Tab[] {
  const nets: Tab[] = [];
  for (const n of NETWORK_TABS) {
    const mine = rows.filter((r) => networkOf(r) === n.id);
    const card = links?.find((l) => l.network === n.id);
    const attention = card?.state === "needs_attention";
    if (!mine.length && card?.state !== "linked" && !attention) continue;
    nets.push({ id: n.id, label: n.label, count: mine.length, waiting: mine.filter(waiting).length, attention });
  }
  const all: Tab = { id: "all", label: "All", count: rows.length, waiting: rows.filter(waiting).length, attention: false };
  return nets.length === 1 && !nets[0].attention ? [all] : [all, ...nets];
}

/** A tab's conversations, newest first. */
export function tabRows(rows: RoomRow[], tab: TabId): RoomRow[] {
  return newestFirst(tab === "all" ? rows : rows.filter((r) => networkOf(r) === tab));
}

/** The tab to show: the one this device was on, if it is still there; else All. */
export function shownTab(stored: string | null, tabs: Tab[]): TabId {
  return tabs.find((t) => t.id === stored)?.id ?? "all";
}

/** A tab's name for a screen reader: "Signal, 2 new" (unread, or an invite). */
export function tabName(t: Tab): string {
  return [t.label, t.waiting ? `${t.waiting} new` : "", t.attention ? "needs linking again" : ""].filter(Boolean).join(", ");
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
export type LinkRow = { network: string; name: string; state: LinkState; accounts: LinkedAccount[]; step: LinkStep | null; note: string | null; rev: number };

/** What each card says about its network: how you link it, and what keeps it linked. Plain words, no promises. */
export const NETWORK_INFO: Record<string, { how: string; keep: string }> = {
  telegram: { how: "Your phone number, then the code Telegram sends to your Telegram app.", keep: "Steady once linked. Secret chats don't come across." },
  signal: { how: "Scan a QR code with Signal on your phone: Settings, Linked devices.", keep: "Open Signal on your phone at least every 30 days, or the link ends." },
  whatsapp: { how: "Scan a QR code with WhatsApp on your phone: Linked devices. Or pair with a code.", keep: "Your phone must come online every couple of weeks." },
  gmessages: { how: "Sign in to Google in a browser and paste its cookies here, then tap the matching emoji on your phone.", keep: "Your phone stays the hub: it must be on and online for texts to flow." },
  messenger: { how: "Your Facebook username and password, or cookies from messenger.com.", keep: "Fragile: Meta can flag a new login and ask for a check. Two-factor sign-in helps." },
  instagram: { how: "Your Instagram username and password, or cookies from instagram.com.", keep: "Fragile: Meta can flag a new login and ask for a check." },
};

/** Ways in a bridge offers that aren't for a person linking their own account: Telegram's bot-token login and its
 * raw-session one ("advanced, do not use"). */
const HIDDEN_FLOWS: Record<string, string[]> = { telegram: ["bot", "manual"] };
export const shownFlows = (network: string, flows: Flow[]) => flows.filter((f) => !(HIDDEN_FLOWS[network] ?? []).includes(f.id));

export function linkWords(s: LinkState): string {
  switch (s) {
    case "checking": return "CHECKING";
    case "linked": return "LINKED";
    case "not_linked": return "NOT LINKED";
    case "needs_attention": return "NEEDS ATTENTION";
    case "unavailable": return "NOT RUNNING";
  }
}

/** A card's update replaces that network's card only, unless the card shown is newer (a command's answer and an
 * update can cross: each carries the core's revision); an unknown network is added at the end. One that arrives
 * before the screen has its cards is kept. */
export function applyLink(rows: LinkRow[] | null, row: LinkRow): LinkRow[] {
  if (!rows) return [row];
  return rows.some((r) => r.network === row.network) ? rows.map((r) => (r.network === row.network && row.rev >= r.rev ? row : r)) : [...rows, row];
}

/** The answer to opening the screen (every card, as the core knew them when asked), merged with the updates that came
 * while it was on its way: the newer of each pair is kept. In the answer's order. */
export function mergeLinks(snapshot: LinkRow[], newer: LinkRow[] | null): LinkRow[] {
  return (newer ?? []).reduce((rows, r) => applyLink(rows, r), snapshot);
}

/** The host of a sign-in link, or null if it isn't one. */
export function linkHost(url: string): string | null {
  try { const u = new URL(url); return u.protocol === "https:" ? u.host : null; } catch { return null; }
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

// ── T-313: what a message shows besides its words ──────────────────────────────────────────────────────────────────

export type TextPart = { t: "text"; v: string } | { t: "link"; v: string; href: string };

/** Longest link made from a message's text, after its `https://` or `www.`; past it the rest is words. */
export const LINK_MAX = 2048;
/** A link's start: `http://`, `https://` or `www.` at the start of a word, then what a URL can hold. One pass, each start tried
 * once in O(1) and each match bounded by LINK_MAX, so a long message is linear (no backtracking regex, no rescan per start). */
const LINK_RE = new RegExp(`\\b(?:https?://|www\\.)[^\\s<>"'\`\\u0000-\\u001f\\u007f]{1,${LINK_MAX}}`, "giu");
const TRAILING = new Set([".", ",", ";", ":", "!", "?", "*", "_", "~", "'", '"', "…", "”", "’", "»"]);

/** Where a found link ends: trailing punctuation belongs to the sentence, and a closing bracket only if the link opened one.
 * One backward pass, with the brackets counted once first. */
function trimLink(raw: string): string {
  let open = 0, close = 0, sqOpen = 0, sqClose = 0;
  for (const c of raw) { if (c === "(") open++; else if (c === ")") close++; else if (c === "[") sqOpen++; else if (c === "]") sqClose++; }
  let end = raw.length;
  while (end > 0) {
    const c = raw[end - 1];
    if (TRAILING.has(c)) { end--; continue; }
    if (c === ")" && close > open) { close--; end--; continue; }
    if (c === "]" && sqClose > sqOpen) { sqClose--; end--; continue; }
    break;
  }
  return raw.slice(0, end);
}

/** The link a found address opens: http(s) only, with a host, else none. `www.` is taken as https. */
export function linkHref(found: string): string | null {
  const www = /^www\./i.test(found);
  // "www." needs a name and an ending after it: www.example.com
  if (www && !/^www\.[^./?#]+\.[^./?#]/i.test(found)) return null;
  const url = www ? `https://${found}` : found;
  try {
    const u = new URL(url);
    if ((u.protocol !== "https:" && u.protocol !== "http:") || !u.hostname || u.username || u.password) return null;
    return u.href;
  } catch { return null; }
}

/** A message's text, its web links made tappable (T-313). Only http and https open; the words shown are exactly the words sent
 * (the parts join back to the text). Bridged chats send plain text, so nothing else (markdown, HTML) is read into it. */
export function linkify(text: string): TextPart[] {
  const out: TextPart[] = [];
  let at = 0;
  LINK_RE.lastIndex = 0;
  for (let m = LINK_RE.exec(text); m; m = LINK_RE.exec(text)) {
    const found = trimLink(m[0]);
    const href = linkHref(found);
    if (!href) continue;
    if (m.index > at) out.push({ t: "text", v: text.slice(at, m.index) });
    out.push({ t: "link", v: found, href });
    at = m.index + found.length;
    LINK_RE.lastIndex = at;
  }
  if (at < text.length) out.push({ t: "text", v: text.slice(at) });
  return out;
}

/** A long message shows its start and "Read more": past FOLD_CHARS characters or FOLD_LINES lines. */
export const FOLD_CHARS = 1200;
export const FOLD_LINES = 18;
const FOLD_TO_CHARS = 700, FOLD_TO_LINES = 10;

/** The start a long message shows folded (cut at a space where one is near), or null when it is short enough to show whole. */
export function foldedStart(text: string): string | null {
  let lines = 1, tenth = -1;
  for (let i = 0; i < text.length && lines <= FOLD_LINES; i++) if (text.charCodeAt(i) === 10) { lines++; if (lines === FOLD_TO_LINES + 1) tenth = i; }
  if (text.length <= FOLD_CHARS && lines <= FOLD_LINES) return null;
  if (tenth >= 0 && tenth < FOLD_TO_CHARS) return text.slice(0, tenth).trimEnd();
  let end = Math.min(text.length, FOLD_TO_CHARS);
  // a space near the cut, looked for only that near (the scan is bounded)
  const space = text.lastIndexOf(" ", end);
  if (space > end - 80 && space > 0) end = space;
  return text.slice(0, end).trimEnd();
}

/** "0:07", "12:30", "1:02:03". */
export function clock(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}` : `${m}:${String(r).padStart(2, "0")}`;
}

/** "3.4 MB", "820 KB", "512 B". */
export function sizeWords(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** How a media message shows: a picture inline, a player, a video, or a file card. A picture or sound whose type the core
 * didn't pass (SVG, unknown) is a file: the webview never renders bytes it can't be sure of. */
export function mediaShape(m: Media): "image" | "voice" | "audio" | "video" | "file" {
  if (m.kind === "image" && m.mime.startsWith("image/")) return "image";
  if ((m.kind === "voice" || m.kind === "audio") && m.mime.startsWith("audio/")) return m.kind;
  if (m.kind === "video" && m.mime.startsWith("video/")) return "video";
  return "file";
}

/** A picture's box before it loads: its shape as sent, at most `maxW` × `maxH` css px. */
export function pictureBox(m: Pick<Media, "width" | "height">, maxW = 320, maxH = 360): { width: number; height: number } {
  const w = m.width ?? 0, h = m.height ?? 0;
  if (!(w > 0 && h > 0)) return { width: maxW, height: Math.round(maxW * 0.75) };
  const k = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(48, Math.round(w * k)), height: Math.max(48, Math.round(h * k)) };
}

/** The size a picture is shown at: the event's, unless the picture itself (`own`, once loaded) says it's missing or wrong
 * (a different shape), when the picture's own is used. */
export function pictureSize(m: Pick<Media, "width" | "height">, own: { width: number; height: number } | null): Pick<Media, "width" | "height"> {
  if (!own) return m;
  const w = m.width ?? 0, h = m.height ?? 0;
  if (w > 0 && h > 0 && Math.abs(w / h - own.width / own.height) <= 0.02 * (own.width / own.height)) return m;
  return own;
}

/** A reaction for a screen reader: "🌱, 2 people, you too". */
export function reactionName(r: Reaction): string {
  const who = r.count === 1 ? (r.own ? "you" : "1 person") : `${r.count} people${r.own ? ", you too" : ""}`;
  return `${r.key}, ${who}`;
}

/** A file card's second line: "PDF · 3.4 MB". */
export function fileLine(m: Media): string {
  const ext = /\.([a-z0-9]{1,8})$/i.exec(m.name)?.[1]?.toUpperCase() ?? "";
  return [ext, sizeWords(m.size)].filter(Boolean).join(" · ");
}
