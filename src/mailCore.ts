// Mail (T-45), pure parts: the shapes the Rust commands return, how a failure
// reads, dates, sender labels, which accounts a list reads, and the sealed
// document an HTML body renders in. T-210: which writes the bridge offers where,
// who a message can be sent as, addresses typed in the composer, a reply's
// fields, and the "not verified" rule. T-213: Uni's sends held for you, and what deciding one did. Nothing here calls
// the bridge.

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
/** One account's part of a list, and where its next page starts. A search reads the whole account less `exclude`.
 *  T-335 Mail v2: `flagged` true lists only Later mail (the `$flagged` keyword), false leaves it out; `with_files` lists
 *  only mail with attachments. The server filters, so paging stays its own. */
export type Source = { account_id: string; mailbox_id: string | null; exclude: string[]; position: number; flagged?: boolean | null; with_files?: boolean };
export type ThreadSummary = {
  account_id: string; thread_id: string; email_id: string; from: Address[]; to: Address[]; subject: string; preview: string;
  received_at: string; count: number; unread: boolean; has_attachment: boolean; draft: boolean; uni_drafted: boolean; flagged?: boolean;
  /** T-335: the thread holds a draft Uni wrote (it lives in Drafts, so it isn't the row's own message in the Inbox). */
  uni_draft?: boolean;
  /** T-335: something new on the thread: an unread message that isn't put off for Later (what brings a Later thread
   *  back to the Inbox; the server's Inbox list decides that, and Mail reads it when you open one). */
  fresh?: boolean;
};

/** The drafts at the foot of a thread of yours: Uni's (the reply Uni prepared) and your own, each oldest first. Uni's
 *  account's own drafts stay in its conversation, so it has none here. */
export function footDrafts(t: MailThread, acct: Pick<AccountBoxes, "who"> & Partial<Pick<AccountBoxes, "mailboxes">>): { uni: MailMessage[]; own: MailMessage[] } {
  if (acct.who !== "owner") return { uni: [], own: [] };
  // a draft thrown away (only in Junk or Trash) isn't waiting for you
  const binned = new Set((acct.mailboxes ?? []).filter((b) => b.role === "junk" || b.role === "trash").map((b) => b.id));
  const drafts = t.messages.filter((m) => m.draft && !(m.mailbox_ids.length > 0 && m.mailbox_ids.every((id) => binned.has(id))));
  return { uni: drafts.filter((m) => m.uni_drafted), own: drafts.filter((m) => !m.uni_drafted) };
}

/** The draft Reply opens: Uni's newest when this app can show it whole, else your own newest, else none (a blank reply). */
export function replyDraft(t: MailThread, acct: Pick<AccountBoxes, "who"> & Partial<Pick<AccountBoxes, "mailboxes">>): MailMessage | null {
  const { uni, own } = footDrafts(t, acct);
  for (const list of [uni, own]) { const d = list[list.length - 1]; if (d && draftEditable(d)) return d; }
  return null;
}
export type ThreadPage = { threads: ThreadSummary[]; next: Source[]; more: boolean; total: number | null };
export type MailThread = { account_id: string; thread_id: string; messages: MailMessage[] };

// ── T-335 Mail v2: places, not folder trees ─────────────────────────────────────────────────────────────────────────

/** Where Mail looks, as tabs like Messages': your Inbox, what you put off (Later), Uni's sends held for you (Waiting),
 *  your Drafts, Sent, Archive and Junk, and Uni's own Inbox, one tab away. */
export type Place = "inbox" | "later" | "waiting" | "drafts" | "sent" | "archive" | "junk" | "uni";
export const PLACES: Place[] = ["inbox", "later", "waiting", "drafts", "sent", "archive", "junk", "uni"];
export type PlaceTab = { id: Place; label: string; count: number; name: string };

/** The tag on the few places an account matters (the composer, held sends): a word, not a colour. */
export function whoTag(who: Who): string {
  return who === "uni" ? "Uni" : "You";
}

/** "Your mail" / "Uni's mail", for labels that are read aloud. */
export function whoMail(who: Who): string {
  return who === "uni" ? "Uni's mail" : "Your mail";
}

function role(a: AccountBoxes | undefined, r: string): Mailbox | undefined {
  return a?.mailboxes.find((b) => b.role === r);
}

/** Your account: the key's own (a one-account bridge's only one). */
export function ownAccount(o: Overview): AccountBoxes | undefined {
  return o.accounts.find((a) => a.who === "owner") ?? (o.accounts.length === 1 ? o.accounts[0] : undefined);
}

/** Uni's account, shared with yours (never your own: a one-account bridge's only account is yours). */
export function uniAccount(o: Overview): AccountBoxes | undefined {
  const own = ownAccount(o);
  return o.accounts.find((a) => a.who === "uni" && a !== own);
}

/** Whose mail a place reads: Uni's for Uni's tab and the held sends, yours for the rest. */
export function placeAccount(p: Place, o: Overview): AccountBoxes | undefined {
  return p === "uni" || p === "waiting" ? uniAccount(o) : ownAccount(o);
}

const BOX: Partial<Record<Place, string>> = { inbox: "inbox", drafts: "drafts", sent: "sent", archive: "archive", junk: "junk", uni: "inbox" };

/** The tabs this overview has: a place shows when its account and mailbox exist (Waiting where you decide Uni's held
 *  sends). Counts: unread in Inbox and Junk, drafts in Drafts, `later` and `waiting` as given; Uni's mail has none
 *  (reading it is Uni's job). */
export function mailTabs(o: Overview, counts: { later: number; waiting: number }): PlaceTab[] {
  const own = ownAccount(o), uni = uniAccount(o);
  const label: Record<Place, string> = { inbox: "Inbox", later: "Later", waiting: "Waiting", drafts: "Drafts", sent: "Sent", archive: "Archive", junk: "Junk", uni: "Uni's mail" };
  return PLACES.flatMap((id): PlaceTab[] => {
    if (id === "waiting" && !approvalOffered(uni)) return [];
    if (id === "later" && !own) return [];
    const r = BOX[id];
    const box = r ? role(placeAccount(id, o), r) : undefined;
    if (r && !box) return [];
    const count = id === "later" ? counts.later : id === "waiting" ? counts.waiting : id === "drafts" ? box?.total ?? 0 : id === "inbox" || id === "junk" ? box?.unread ?? 0 : 0;
    const what = id === "waiting" ? "waiting" : id === "drafts" ? (count === 1 ? "draft" : "drafts") : id === "later" ? "put off" : "unread";
    return [{ id, label: label[id], count, name: count > 0 ? `${label[id]} (${count} ${what})` : label[id] }];
  });
}

/** What a place's list reads. `text`: a search, which reads the place's account whole, less Junk and Trash (Later's
 *  search stays in Later). `files`: only mail with attachments. Waiting lists held sends, not threads (but a search
 *  from there searches Uni's mail). */
export function placeSources(p: Place, o: Overview, opts: { text?: string; files?: boolean } = {}): Source[] {
  const a = placeAccount(p, o);
  if (!a) return [];
  if (p === "waiting" && !opts.text) return [];
  const files = opts.files ? { with_files: true } : {};
  if (opts.text || p === "later") {
    // a search from Junk searches Junk too; Later lists mail, not your unsent drafts (they sit at its threads' foot)
    const exclude = (p === "junk" ? ["trash"] : p === "later" && !opts.text ? ["junk", "trash", "drafts"] : ["junk", "trash"]).flatMap((r) => role(a, r)?.id ?? []);
    return [{ account_id: a.id, mailbox_id: null, exclude, position: 0, ...(p === "later" ? { flagged: true } : {}), ...files }];
  }
  const box = role(a, BOX[p]!);
  if (!box) return [];
  // the Inbox leaves out what you put off: it is in Later until you bring it back (or new mail arrives on it)
  return [{ account_id: a.id, mailbox_id: box.id, exclude: [], position: 0, ...(p === "inbox" ? { flagged: false } : {}), ...files }];
}

/** The list's name, read aloud and shown when a search or Files narrows it. */
export function placeTitle(p: Place, o: Overview, text: string, files: boolean): string {
  const tab = mailTabs(o, { later: 0, waiting: 0 }).find((t) => t.id === p)?.label ?? "Mail";
  const whose = placeAccount(p, o)?.who === "uni" ? "Uni's mail" : "your mail";
  if (text) return `Search in ${p === "later" ? "Later" : whose}${files ? ", with files" : ""}`;
  return files ? `${tab}, with files` : tab;
}

/** The place still exists in this overview (an account or mailbox can go). */
export function placeValid(p: Place, o: Overview): boolean {
  return mailTabs(o, { later: 0, waiting: 0 }).some((t) => t.id === p);
}

/** Unread mail in your own Inbox (T-208): what the rail's badge shows. Uni's mail is Uni's to read; Junk and Trash
 *  aren't mail you'd read. */
export function yourInboxUnread(o: Overview): number {
  return o.accounts.filter((a) => a.who === "owner").reduce((n, a) => n + (role(a, "inbox")?.unread ?? 0), 0);
}

/** A plain-text body and the quoted history under it, so a reply reads as what it says: an "On … wrote:" line (or a
 *  closing run of `>` lines) with nothing but quote after it, or an "Original Message" line and what follows. A
 *  forward's content is what it says, so a "Forwarded message" line folds nothing.
 *  An answer written between quoted lines keeps the whole body open, and nothing folds when nothing is above the quote.
 *  One pass from the end: bodies can be a megabyte. */
export function splitQuoted(text: string): { body: string; quoted: string | null } {
  const lines = text.split("\n");
  const quote = (l: string) => /^\s*>/.test(l);
  // the closing run of quoted (or blank) lines starts at `tail`
  let tail = lines.length;
  while (tail > 0 && (quote(lines[tail - 1]) || !lines[tail - 1].trim())) tail--;
  // quoted lines with answers between them (an inline reply) stay whole, whatever they end on
  if (lines.slice(0, tail).some(quote)) return { body: text, quoted: null };
  let at = -1;
  const marker = lines.findIndex((l) => /^-{2,}\s*Original Message\s*-{2,}\s*$/i.test(l));
  if (marker > 0) at = marker;
  else {
    const wrote = tail - 1;
    if (wrote > 0 && /^\s*On\b.{0,200}\bwrote:\s*$/.test(lines[wrote]) && lines.slice(wrote + 1).some(quote)) at = wrote;
    else {
      const first = lines.findIndex((l, i) => i >= tail && quote(l));
      if (first > 0) at = first;
    }
  }
  if (at <= 0) return { body: text, quoted: null };
  const body = lines.slice(0, at).join("\n").replace(/\s+$/, "");
  if (!body.trim()) return { body: text, quoted: null };
  return { body, quoted: lines.slice(at).join("\n").replace(/\s+$/, "") };
}

/** Who a message went to, from where you stand: "you", or the first names. */
export function toWords(m: Pick<MailMessage, "to" | "cc">, acct: Pick<AccountBoxes, "name" | "who">): string {
  const mine = (a: Address) => a.email.toLowerCase() === acct.name.toLowerCase();
  const all = [...m.to, ...m.cc];
  const others = all.filter((a) => !mine(a)).map((a) => a.name?.trim() || a.email);
  const you = all.some(mine) ? [acct.who === "uni" ? "Uni" : "you"] : [];
  const names = [...you, ...others];
  if (names.length === 0) return "";
  return names.length > 3 ? `${names.slice(0, 2).join(", ")} and ${names.length - 2} more` : names.join(", ");
}

/** The people in a thread, for the line under its subject: senders in order of first appearance, "you" for you. */
export function threadPeople(t: MailThread, acct: Pick<AccountBoxes, "name" | "who">): string {
  const seen: string[] = [];
  for (const m of t.messages) for (const a of m.from) {
    const w = a.email.toLowerCase() === acct.name.toLowerCase() ? (acct.who === "uni" ? "Uni" : "you") : a.name?.trim() || a.email;
    if (!seen.includes(w)) seen.push(w);
  }
  return seen.length > 3 ? `${seen.slice(0, 3).join(", ")} and ${seen.length - 3} more` : seen.join(", ");
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
      return { kind: err.kind, title: "This device isn't allowed to read mail yet.", help: "The mail bridge only answers keys on its allowlist. Ask in #systems to add this device's key:", detail: err.message, pubkey: err.pubkey, retry: true };
    case "server":
      return { kind: err.kind, title: "The mail server didn't answer.", help: "The bridge is up but the mail server behind it failed. Retry in a minute.", detail: err.message, pubkey: null, retry: true };
    case "refused":
      // the bridge 404s only an unknown path; a 404 here means something else answers at the bridge's address
      if (err.status === 404) return { kind: err.kind, title: "The mail bridge isn't at its address.", help: "Something else answers on the bridge's tailnet port, so it may have moved. Report it in #systems.", detail: `${err.status}: ${err.message}`, pubkey: null, retry: true };
      return { kind: err.kind, title: "The mail bridge refused this request.", help: err.status === 401 ? "Its signature check failed. If this keeps happening, check this device's clock." : "Retry; if it keeps happening, report it in #systems.", detail: `${err.status}: ${err.message}`, pubkey: null, retry: true };
    case "invalid":
      return { kind: err.kind, title: "Couldn't read mail.", help: "Retry; if it keeps happening, report it in #systems.", detail: err.message, pubkey: null, retry: true };
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
/** `fields` and `plain` (draft.review only): what the draft holds, read by the bridge from the same bytes as `fingerprint`. */
export type Reviewed = { account_id: string; draft_id: string; thread_id: string | null; fingerprint: string; discard: string[]; uni_drafted: boolean;
  fields?: DraftFields | null; plain?: boolean | null };
export type SendState = "drafting" | "reserved" | "submitting" | "submitted" | "cleaned" | "refused" | "awaiting-approval" | "failed" | "unknown" | "declined";
export type SendOutcome = {
  op_id: string; account_id: string; draft_id: string | null; state: SendState; reason: string | null; submission_id: string | null;
  delivery: Record<string, string> | null; note: string | null;
};

/** The bridge offers `op` on this account. */
export function can(a: AccountBoxes | undefined, op: string): boolean {
  return !!a?.operations?.includes(op);
}

/** Every operation sending from this account uses: yours is save → review → send (and check an unknown outcome);
 *  Uni's goes through the deputy path. The composer opens only when the bridge offers all of them. */
export function sendOps(who: Who): string[] {
  return who === "uni" ? ["send_as_uni", "send.check"] : ["draft.save", "draft.review", "send", "send.check"];
}

/** A message can be sent from this account (every operation of `sendOps` is offered). */
export function canSendFrom(a: AccountBoxes | undefined): boolean {
  return !!a && sendOps(a.who).every((op) => can(a, op));
}

/** A stored draft this app can edit and review in full: plain text only, no attachments, not cut short. Anything else
 *  would be sent with parts the review can't show, or lose them when saved again. */
export function draftEditable(m: MailMessage): boolean {
  return m.html == null && m.attachments.length === 0 && !m.truncated;
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

/** A send whose outcome the app doesn't know yet: kept (on the device) until the bridge says what happened to it. */
export type PendingSend = { account_id: string; op_id: string; who: Who; at: string };
const PENDING_KEY = "uni.mail.pending.v1";

/** States a send can't leave by itself: the outcome is known. */
export function settled(state: SendState): boolean {
  return ["cleaned", "submitted", "refused", "failed", "awaiting-approval", "declined"].includes(state);
}

export function readPending(store: Pick<Storage, "getItem"> | null): PendingSend[] {
  try {
    const v = JSON.parse(store?.getItem(PENDING_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((p) => p && typeof p.op_id === "string" && typeof p.account_id === "string" && (p.who === "owner" || p.who === "uni")) : [];
  } catch { return []; }
}

export function writePending(store: Pick<Storage, "setItem"> | null, list: PendingSend[]): void {
  try { store?.setItem(PENDING_KEY, JSON.stringify(list)); } catch { /* storage full or off: the composer still shows it */ }
}

/** The list with `p` added (once), or with `opId` taken out. */
export function withPending(list: PendingSend[], p: PendingSend): PendingSend[] {
  return [...list.filter((x) => x.op_id !== p.op_id), p];
}
export function withoutPending(list: PendingSend[], opId: string): PendingSend[] {
  return list.filter((x) => x.op_id !== opId);
}

/** Whether a failed send call leaves the outcome unknown: the bridge may have taken it (no answer, a cut-off or unreadable
 *  answer, a failure behind it). A refusal (4xx) is a definite no: nothing was sent. */
export function uncertain(e: unknown): boolean {
  const p = mailProblem(e);
  return p.kind !== "refused" && p.kind !== "not_allowed";
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
    case "declined":
      return { text: "Not sent: you declined it.", done: true, blocked: true };
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

// ── T-213: Uni's sends held for you ──────────────────────────────────────────────────────────────────────────────────

/** A send from Uni's account that its outbound rules hold for you (`uni_core::mail::Parked`). `fields` and `fingerprint`
 *  are of the same bytes of the held draft: Send it sends exactly what is shown, or nothing. */
export type Parked = {
  op_id: string; draft_id: string | null; reason: string | null; sent_by: string | null; parked_at: string | null; recipients: string[];
  fingerprint: string | null; changed: boolean; fields: DraftFields | null; plain: boolean | null; problem: string | null;
  /** T-335: the files it sends, in order, when it is text plus files and nothing else (`plain` is then false). */
  files?: HeldFile[];
};
/** One file of a held send (`uni_core::mail::HeldFile`), from the same bytes as the fingerprint. `refused`: why Uni won't
 *  open it (its name or type); it is sent either way. */
export type HeldFile = { name: string; mime: string; size: number; sha256: string; refused?: string | null };

/** The held sends of this account are yours to decide: Uni's account, where the bridge offers approving or declining. */
export function approvalOffered(a: AccountBoxes | undefined): boolean {
  return !!a && a.who === "uni" && (can(a, "send.approve") || can(a, "send.decline"));
}

/** Everything the held send carries is shown: plain text and nothing else, or (T-335) text plus the files the bridge
 *  listed, each with its name, type and size. Anything else (formatting, a file the bridge couldn't list) would be sent
 *  unseen. */
export function heldShownWhole(p: Parked): boolean {
  const files = p.files?.length ?? 0;
  return p.plain === true ? files === 0 : p.plain === false && files > 0;
}

/** Send it is offered for this held send: the bridge offers it, and it shows the whole draft as it is now. */
export function canApprove(a: AccountBoxes | undefined, p: Parked): boolean {
  // a listed file this app won't open still counts as shown: its name, type and size stay on screen, and its bytes are
  // bound to the fingerprint the approval sends (the bridge checks a file's type only when draft.save attaches it)
  return can(a, "send.approve") && !!p.fingerprint && !!p.fields && !p.changed && !p.problem && heldShownWhole(p);
}

/** A file's kind in a word: its extension, or (a name without one) a plain word for the type it declares. */
export function fileKind(name: string, mime: string): string {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1];
  if (ext) return ext.toUpperCase();
  const type = mime.split(";")[0].trim().toLowerCase();
  return type === "application/pdf" ? "PDF" : type.startsWith("image/") ? "Image" : type.startsWith("text/") ? "Text" : "File";
}

/** What deciding a held send did. `sent` and `declined` are final; `failed` says why and to ask #systems. */
export type HeldOutcome = { kind: "sent" | "declined" | "failed"; text: string };

export function approveOutcome(out: SendOutcome, uniAddress: string): HeldOutcome {
  switch (out.state) {
    case "cleaned": case "submitted":
      return { kind: "sent", text: `Sent from Uni's address (${uniAddress}).` };
    case "declined":
      return { kind: "declined", text: "Declined earlier. Nothing was sent." };
    case "unknown": case "submitting": case "reserved": case "drafting":
      return { kind: "failed", text: "Couldn't confirm it was sent: ask #systems. It won't be sent twice." };
    case "awaiting-approval":
      return { kind: "failed", text: "Not sent: it is still waiting. Ask #systems." };
    default:
      return { kind: "failed", text: `Couldn't send: ${out.reason ?? "the bridge refused it"}. Ask #systems.` };
  }
}

export function declineOutcome(out: SendOutcome): HeldOutcome {
  return out.state === "declined" ? { kind: "declined", text: "Declined. Nothing was sent from Uni's address." }
    : { kind: "failed", text: `Couldn't decline it: it is ${out.state}. Ask #systems.` };
}

/** A call that failed: what the screen says. A 409 is the bridge's own sentence (the draft changed, already decided). */
export function heldFailure(e: unknown, approving: boolean): HeldOutcome {
  const p = mailProblem(e);
  // a 404 or 409 here is the bridge's own sentence about this send (no such send, already decided, changed)
  const said = p.kind === "refused" && /^40[49]:/.test(p.detail) ? p.detail.replace(/^40[49]:\s*/, "") : p.title.replace(/\.$/, "");
  const why = said.charAt(0).toLowerCase() + said.slice(1);
  return { kind: "failed", text: `${approving ? "Couldn't send" : "Couldn't decline it"}: ${why}. Ask #systems.` };
}
