// Mail (T-45), pure parts: the shapes the Rust commands return, how a failure
// reads, dates, sender labels, which accounts a list reads, and the sealed
// document an HTML body renders in. T-210: which writes the bridge offers where,
// who a message can be sent as, addresses typed in the composer, a reply's
// fields, and the "not verified" rule. Nothing here calls the bridge.

export type Address = { name: string | null; email: string };
export type Mailbox = { id: string; name: string; role: string | null; parent_id: string | null; total: number; unread: number };
export type MailLink = { url: string; text: string | null };
/** `refused`: Rust's name/type check, made without fetching (v1's first gate); shown at once. */
export type MailAttachment = { blob_id: string; part_id?: string | null; name: string | null; mime: string; size: number; cid: string | null; refused?: string | null };
export type MailMessage = {
  id: string; thread_id: string | null; from: Address[]; to: Address[]; cc: Address[]; bcc?: Address[]; reply_to: Address[];
  subject: string; received_at: string; sent_at: string | null; unread: boolean; flagged?: boolean; draft: boolean; uni_drafted: boolean; mailbox_ids: string[];
  /** The DMARC result the receiving side recorded (T-210); null when no hop recorded one (mail delivered inside the server). */
  dmarc?: string | null;
  text: string | null; html: string | null; remote_images: number; links: MailLink[]; truncated: boolean; attachments: MailAttachment[];
};

/** Whose mail (T-45 v2): the key's own account (YOU) or the one shared with it (UNI). Never shown by colour alone. */
export type Who = "owner" | "uni";
/** `operations`: the writes the bridge offers this device on this account (T-210); none on a bridge without them. */
export type AccountBoxes = { id: string; name: string; who: Who; mailboxes: Mailbox[]; operations?: string[] };
/** `multi`: the bridge reads by account; false is a v1 bridge with one account. */
export type Overview = { login: string; multi: boolean; accounts: AccountBoxes[] };
/** One account's part of a list, and where its next page starts. A search reads the whole account less `exclude`. */
export type Source = { account_id: string; mailbox_id: string | null; exclude: string[]; position: number };
export type ThreadSummary = {
  account_id: string; thread_id: string; email_id: string; from: Address[]; to: Address[]; subject: string; preview: string;
  received_at: string; count: number; unread: boolean; has_attachment: boolean; draft: boolean; uni_drafted: boolean; flagged?: boolean;
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

// ── T-210: writes ───────────────────────────────────────────────────────────────────────────────────────────────────

/** The fields the composer sends to Rust (`uni_core::mail::DraftFields`). There is no From: the bridge sets it. */
export type DraftFields = { to: Address[]; cc: Address[]; bcc: Address[]; subject: string; text: string; in_reply_to: string | null };
/** A saved draft as the bridge reports it, for review (`uni_core::mail::Reviewed`). */
export type Reviewed = { account_id: string; draft_id: string; thread_id: string | null; fingerprint: string; discard: string[]; uni_drafted: boolean };
export type SendState = "drafting" | "reserved" | "submitting" | "submitted" | "cleaned" | "refused" | "awaiting-approval" | "failed" | "unknown";
export type SendOutcome = {
  op_id: string; account_id: string; draft_id: string | null; state: SendState; reason: string | null; submission_id: string | null;
  delivery: Record<string, string> | null; note: string | null;
};

/** The bridge offers `op` on this account. */
export function can(a: AccountBoxes | undefined, op: string): boolean {
  return !!a?.operations?.includes(op);
}

/** A message can be sent from this account: the owner's own by save → review → send; Uni's through the deputy path. */
export function canSendFrom(a: AccountBoxes | undefined): boolean {
  if (!a) return false;
  return a.who === "uni" ? can(a, "send_as_uni") : can(a, "draft.save") && can(a, "send");
}

/** Any write is offered anywhere (else the header says read-only). */
export function writesOffered(o: Overview): boolean {
  return o.accounts.some((a) => (a.operations?.length ?? 0) > 0);
}

/** "Send as you" / "Send as Uni": the button names who it sends as. */
export function sendLabel(who: Who): string {
  return who === "uni" ? "Send as Uni" : "Send as you";
}

/**
 * Addresses as typed: separated by commas, semicolons or new lines; each `email` or `Name <email>` (a quoted name may
 * hold a comma). Returns the addresses and what couldn't be read, so a bad one is named, never dropped.
 */
export function parseAddresses(text: string): { list: Address[]; bad: string[] } {
  const parts: string[] = [];
  let cur = "", quoted = false, angle = false;
  for (const ch of text) {
    if (ch === '"' && !angle) quoted = !quoted;
    else if (ch === "<" && !quoted) angle = true;
    else if (ch === ">" && !quoted) angle = false;
    if ((ch === "," || ch === ";" || ch === "\n") && !quoted && !angle) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur);
  const list: Address[] = [], bad: string[] = [];
  for (const raw of parts.map((x) => x.trim()).filter(Boolean)) {
    const m = /^(?:"?([^"<]*?)"?\s*)?<([^<>\s]+)>$/.exec(raw);
    const email = (m ? m[2] : raw).trim();
    const name = m?.[1]?.trim() || null;
    if (validAddress(email) && !/[\r\n]/.test(name ?? "")) list.push({ name, email });
    else bad.push(raw);
  }
  return { list, bad };
}

/** The same check as Rust's `valid_address`: something@domain.tld, no spaces, brackets or line breaks. */
export function validAddress(a: string): boolean {
  return a.length <= 254 && /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(a);
}

/** Addresses back to text for editing: `Name <email>` (quoted when the name has a comma), joined by commas. */
export function formatAddresses(list: Address[]): string {
  return list.map((a) => {
    const n = a.name?.trim();
    if (!n) return a.email;
    return /[,;"<>]/.test(n) ? `"${n.replace(/"/g, "")}" <${a.email}>` : `${n} <${a.email}>`;
  }).join(", ");
}

/** A reply from `acct` to the thread's newest message (not a draft): to its Reply-To, else its sender (or, for a message
 *  this account sent, to whom it went); "Re: " once; in reply to that message. */
export function replyFields(t: MailThread, acct: AccountBoxes): DraftFields {
  const real = t.messages.filter((m) => !m.draft);
  const last = real[real.length - 1] ?? t.messages[t.messages.length - 1];
  const mine = (a: Address) => a.email.toLowerCase() === acct.name.toLowerCase();
  const to = last.from.some(mine) ? last.to : last.reply_to.length > 0 ? last.reply_to : last.from;
  const subject = (real[0] ?? last).subject.trim();
  return { to: to.filter((a) => !mine(a)), cc: [], bcc: [], subject: /^re:/i.test(subject) ? subject : `Re: ${subject}`, text: "", in_reply_to: last.id };
}

/** A draft's own fields, to open it in the composer. */
export function draftFields(m: MailMessage): DraftFields {
  return { to: m.to, cc: m.cc, bcc: m.bcc ?? [], subject: m.subject, text: m.text ?? "", in_reply_to: null };
}

export function sameFields(a: DraftFields, b: DraftFields): boolean {
  const addrs = (l: Address[]) => l.map((x) => `${x.name ?? ""}<${x.email.toLowerCase()}>`).join(",");
  return addrs(a.to) === addrs(b.to) && addrs(a.cc) === addrs(b.cc) && addrs(a.bcc) === addrs(b.bcc) && a.subject.trim() === b.subject.trim() && a.text === b.text;
}

/**
 * #mail's ask: mail that says it is from the owner but failed DMARC reads "not verified". It is mail that came in from
 * outside (the receiving hop recorded a DMARC result) with the owner's address in From, and the result is not "pass".
 * Mail delivered inside the server records no result and gets no badge.
 */
export function notVerified(m: MailMessage, o: Overview): boolean {
  const owner = o.accounts.find((a) => a.who === "owner")?.name.toLowerCase();
  if (!owner || m.draft || m.dmarc == null) return false;
  return m.from.some((a) => a.email.toLowerCase() === owner) && m.dmarc.toLowerCase() !== "pass";
}

/** What a send's outcome says, in a sentence; `done`: nothing more will happen to it; `blocked`: no Send button. */
export function sendOutcomeText(out: SendOutcome, who: Who): { text: string; done: boolean; blocked: boolean } {
  const as = who === "uni" ? "as Uni" : "as you";
  switch (out.state) {
    case "cleaned": case "submitted":
      return { text: `Sent ${as}.${out.reason ? ` (${out.reason})` : ""}`, done: true, blocked: false };
    case "awaiting-approval":
      return { text: `Not sent yet: ${out.reason ?? "Uni's outbound rules want your approval"}. It waits in Uni's Drafts.`, done: true, blocked: true };
    case "refused":
      return { text: `Not sent: ${out.reason ?? "the bridge refused it"}.`, done: false, blocked: false };
    case "failed":
      return { text: `Not sent: ${out.reason ?? "the mail server refused it"}.`, done: true, blocked: true };
    case "unknown": case "submitting": case "reserved": case "drafting":
      return { text: "Outcome unknown, checking. It won't be sent twice.", done: false, blocked: true };
  }
}

/** One operation id per review: a retry of that review is the same send, never a second one. */
export function newOpId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `op-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
