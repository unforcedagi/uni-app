// Mail (T-45), pure parts: the shapes the Rust commands return, how a failure
// reads, dates, sender labels, and the sealed document an HTML body renders in.
// Read-only: nothing here sends, flags or deletes.

export type Address = { name: string | null; email: string };
export type Mailbox = { id: string; name: string; role: string | null; parent_id: string | null; total: number; unread: number };
export type MailAccount = { account: string; mailboxes: Mailbox[] };
export type MessageSummary = { id: string; thread_id: string | null; from: Address[]; subject: string; preview: string; received_at: string; unread: boolean; has_attachment: boolean };
export type MessagePage = { account: string; mailbox: string; position: number; total: number | null; messages: MessageSummary[] };
export type MailLink = { url: string; text: string | null };
export type MailAttachment = { blob_id: string; name: string | null; mime: string; size: number; cid: string | null };
export type MailMessage = {
  id: string; thread_id: string | null; from: Address[]; to: Address[]; cc: Address[]; reply_to: Address[];
  subject: string; received_at: string; sent_at: string | null; unread: boolean;
  text: string | null; html: string | null; remote_images: number; links: MailLink[]; truncated: boolean; attachments: MailAttachment[];
};

/** `uni_core::mail::MailError` as it arrives over IPC. */
export type MailError =
  | { kind: "unreachable"; message: string }
  | { kind: "not_allowed"; message: string; pubkey: string }
  | { kind: "refused"; status: number; message: string }
  | { kind: "server"; message: string }
  | { kind: "invalid"; message: string };

/** What the screen says about a failure: a plain sentence, what to do, the technical cause. */
export type MailProblem = { kind: MailError["kind"]; title: string; help: string; detail: string; pubkey: string | null; retry: boolean };

export function mailProblem(e: unknown): MailProblem {
  const err = asMailError(e);
  switch (err.kind) {
    case "unreachable":
      return { kind: err.kind, title: "Mail isn't reachable right now.", help: "The mail bridge runs on the hub's host and answers on the tailnet only. Check that this device is on the tailnet, then retry.", detail: err.message, pubkey: null, retry: true };
    case "not_allowed":
      return { kind: err.kind, title: "This device isn't allowed to read mail yet.", help: "The mail bridge only answers keys on its allowlist. Ask in #mail to add this device's key:", detail: err.message, pubkey: err.pubkey, retry: true };
    case "server":
      return { kind: err.kind, title: "The mail server didn't answer.", help: "The bridge is up but the mail server behind it failed. Retry in a minute.", detail: err.message, pubkey: null, retry: true };
    case "refused":
      // the bridge 404s only an unknown path; a 404 here means something else answers at the bridge's address
      if (err.status === 404) return { kind: err.kind, title: "The mail bridge isn't at its address.", help: "Something else answers on the bridge's tailnet port, so it may have moved. Report it in #mail.", detail: `${err.status}: ${err.message}`, pubkey: null, retry: true };
      return { kind: err.kind, title: "The mail bridge refused this request.", help: err.status === 401 ? "Its signature check failed. If this keeps happening, check this device's clock." : "Retry; if it keeps happening, report it in #mail.", detail: `${err.status}: ${err.message}`, pubkey: null, retry: true };
    case "invalid":
      return { kind: err.kind, title: "Couldn't read mail.", help: "Retry; if it keeps happening, report it in #mail.", detail: err.message, pubkey: null, retry: true };
  }
}

function asMailError(e: unknown): MailError {
  if (e && typeof e === "object" && typeof (e as { kind?: unknown }).kind === "string") {
    const o = e as Record<string, unknown>;
    const message = typeof o.message === "string" ? o.message : "";
    switch (o.kind) {
      case "unreachable": case "server": case "invalid": return { kind: o.kind, message };
      case "not_allowed": return { kind: "not_allowed", message, pubkey: typeof o.pubkey === "string" ? o.pubkey : "" };
      case "refused": return { kind: "refused", status: typeof o.status === "number" ? o.status : 0, message };
    }
  }
  // a plain string (e.g. the IPC itself failed) is not one of the bridge's answers
  return { kind: "invalid", message: e instanceof Error ? e.message : String(e) };
}

/** List date: the time today, the day this week, the month and day this year, else the date. */
export function mailDate(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const days = (now.getTime() - d.getTime()) / 86_400_000;
  if (days >= 0 && days < 6) return d.toLocaleDateString(undefined, { weekday: "short" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Reading-pane date: always the full date and time. */
export function mailDateLong(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

/** A sender as a list shows it: the name, else the address. */
export function senderLabel(from: Address[]): string {
  if (from.length === 0) return "(no sender)";
  const first = from[0].name?.trim() || from[0].email;
  return from.length > 1 ? `${first} +${from.length - 1}` : first;
}

/** An address in full: `Name <email>`, or the email. */
export function addressLine(list: Address[]): string {
  return list.map((a) => (a.name?.trim() ? `${a.name.trim()} <${a.email}>` : a.email)).join(", ");
}

export function subjectLabel(subject: string): string {
  return subject.trim() || "(no subject)";
}

/** Mailbox name; the Inbox is called Inbox whatever the server names it. */
export function mailboxLabel(b: Mailbox): string {
  return b.role === "inbox" ? "Inbox" : b.name || "(unnamed)";
}

/** More of this mailbox to load. */
export function hasMore(page: { total: number | null; loaded: number }): boolean {
  return page.total !== null && page.loaded < page.total;
}

/**
 * The reading frame's policy. The frame is `sandbox=""` (no scripts, no
 * forms, no same-origin, no navigation of the app), and this CSP refuses every
 * load except inline images and inline styles: no remote image, font, style
 * sheet or frame. The HTML was already sanitized in Rust; this is the second wall.
 */
export const MAIL_FRAME_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'";

/** The srcdoc for a sanitized HTML body: the CSP first, then a quiet base style, then the body. Always on white, as
 *  mail clients do: senders style for a light page, and their dark text would vanish on a dark one. */
export function mailSrcdoc(html: string): string {
  const base = "<style>html{color-scheme:light}body{margin:16px;font:15px/1.5 system-ui,sans-serif;color:#1a1913;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}a{color:#2b5d8a}</style>";
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${MAIL_FRAME_CSP}"><meta charset="utf-8">${base}${html}`;
}
