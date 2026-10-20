// Mail (T-45), pure parts: the shapes the Rust commands return, how a failure
// reads, dates, sender labels, which accounts a list reads, and the sealed
// document an HTML body renders in. Read-only: nothing here sends, flags or deletes.

export type Address = { name: string | null; email: string };
export type Mailbox = { id: string; name: string; role: string | null; parent_id: string | null; total: number; unread: number };
export type MailLink = { url: string; text: string | null };
/** `refused`: Rust's name/type check, made without fetching (v1's first gate); shown at once. */
export type MailAttachment = { blob_id: string; part_id?: string | null; name: string | null; mime: string; size: number; cid: string | null; refused?: string | null };
export type MailMessage = {
  id: string; thread_id: string | null; from: Address[]; to: Address[]; cc: Address[]; reply_to: Address[];
  subject: string; received_at: string; sent_at: string | null; unread: boolean; draft: boolean; uni_drafted: boolean; mailbox_ids: string[];
  text: string | null; html: string | null; remote_images: number; links: MailLink[]; truncated: boolean; attachments: MailAttachment[];
};

/** Whose mail (T-45 v2): the key's own account (YOU) or the one shared with it (UNI). Never shown by colour alone. */
export type Who = "owner" | "uni";
export type AccountBoxes = { id: string; name: string; who: Who; mailboxes: Mailbox[] };
/** `multi`: the bridge reads by account; false is a v1 bridge with one account. */
export type Overview = { login: string; multi: boolean; accounts: AccountBoxes[] };
/** One account's part of a list, and where its next page starts. A search reads the whole account less `exclude`. */
export type Source = { account_id: string; mailbox_id: string | null; exclude: string[]; position: number };
export type ThreadSummary = {
  account_id: string; thread_id: string; email_id: string; from: Address[]; to: Address[]; subject: string; preview: string;
  received_at: string; count: number; unread: boolean; has_attachment: boolean; draft: boolean; uni_drafted: boolean;
};
export type ThreadPage = { threads: ThreadSummary[]; next: Source[]; more: boolean; total: number | null };
export type MailThread = { account_id: string; thread_id: string; messages: MailMessage[] };

/** What a list shows: every account's Inbox at once, or one mailbox. */
export type Scope = { kind: "all-inboxes" } | { kind: "mailbox"; accountId: string; mailboxId: string };

export function scopeKey(s: Scope): string {
  return s.kind === "all-inboxes" ? "all" : `${s.accountId}/${s.mailboxId}`;
}

/** The tag on every row, group and header: a word, not a colour. */
export function whoTag(who: Who): string {
  return who === "uni" ? "UNI" : "YOU";
}

/** "Your mail" / "Uni's mail", for labels that are read aloud. */
export function whoMail(who: Who): string {
  return who === "uni" ? "Uni's mail" : "Your mail";
}

function role(a: AccountBoxes, r: string): Mailbox | undefined {
  return a.mailboxes.find((b) => b.role === r);
}

/** The accounts and mailboxes a list reads. A search reads the scope's accounts whole, less Junk and Trash. */
export function sourcesFor(scope: Scope, o: Overview, searching: boolean): Source[] {
  const accounts = scope.kind === "all-inboxes" ? o.accounts : o.accounts.filter((a) => a.id === scope.accountId);
  return accounts.flatMap((a): Source[] => {
    if (searching) return [{ account_id: a.id, mailbox_id: null, exclude: ["junk", "trash"].flatMap((r) => role(a, r)?.id ?? []), position: 0 }];
    const box = scope.kind === "mailbox" ? scope.mailboxId : role(a, "inbox")?.id;
    return box ? [{ account_id: a.id, mailbox_id: box, exclude: [], position: 0 }] : [];
  });
}

/** Unread mail across every account's Inbox. */
export function allInboxesUnread(o: Overview): number {
  return o.accounts.reduce((n, a) => n + (role(a, "inbox")?.unread ?? 0), 0);
}

/** The list's heading. */
export function scopeTitle(scope: Scope, o: Overview, query: string): string {
  const acct = scope.kind === "mailbox" ? o.accounts.find((a) => a.id === scope.accountId) : undefined;
  if (query) return scope.kind === "all-inboxes" ? (o.accounts.length > 1 ? "Search: both mailboxes" : "Search: your mail") : `Search: ${acct?.who === "uni" ? "Uni's mail" : "your mail"}`;
  if (scope.kind === "all-inboxes") return o.accounts.length > 1 ? "All inboxes" : "Inbox";
  const box = acct?.mailboxes.find((b) => b.id === scope.mailboxId);
  return `${acct?.who === "uni" ? "Uni" : "Your"} · ${box ? mailboxLabel(box) : "mailbox"}`;
}

/** The scope still exists in this overview (an account or mailbox can go). */
export function scopeValid(scope: Scope, o: Overview): boolean {
  return scope.kind === "all-inboxes" || o.accounts.some((a) => a.id === scope.accountId && a.mailboxes.some((b) => b.id === scope.mailboxId));
}

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
