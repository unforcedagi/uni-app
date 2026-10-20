// T-45 Mail, pure parts. Run: node --experimental-strip-types scripts/mail.test.ts (Node >= 22.6)
import assert from "node:assert/strict";
import {
  can, canSendFrom, draftFields, formatAddresses, newOpId, notVerified, parseAddresses, replyFields, sameFields, sendLabel, sendOutcomeText, validAddress, writesOffered,
  type AccountBoxes, type MailMessage, type MailThread, type SendOutcome,
} from "../src/mailCore.ts";
import {
  addressLine, allInboxesUnread, mailboxLabel, mailDate, MAIL_FRAME_CSP, mailProblem, mailSrcdoc, scopeTitle, scopeValid, senderLabel, sourcesFor, subjectLabel, whoTag,
  type Overview,
} from "../src/mailCore.ts";
import { restoreTabs, sameTarget, serializeTabs } from "../src/tabs.ts";

// Every failure the bridge can give reads as a plain sentence, with what to do.
const unreachable = mailProblem({ kind: "unreachable", message: "https://hub.example.ts.net:8452 is not answering" });
assert.equal(unreachable.title, "Mail isn't reachable right now.");
assert.match(unreachable.help, /tailnet/);
assert.equal(unreachable.retry, true);
const key = "ab".repeat(32);
const notAllowed = mailProblem({ kind: "not_allowed", message: "pubkey not allowed", pubkey: key });
assert.equal(notAllowed.pubkey, key, "the device key is shown, so #mail can allowlist it");
assert.match(notAllowed.help, /#mail/);
assert.match(mailProblem({ kind: "server", message: "mail server: URLError" }).title, /mail server/);
assert.match(mailProblem({ kind: "refused", status: 401, message: "stale authorization" }).help, /clock/);
assert.equal(mailProblem({ kind: "refused", status: 400, message: "x" }).detail, "400: x");
assert.equal(mailProblem({ kind: "refused", status: 404, message: "404 page not found" }).title, "The mail bridge isn't at its address.");
// not one of the bridge's answers (the IPC failed): still a sentence, the cause under Details
const ipc = mailProblem("IPC custom protocol failed");
assert.equal(ipc.kind, "invalid");
assert.equal(ipc.detail, "IPC custom protocol failed");
assert.equal(mailProblem(new Error("boom")).detail, "boom");

// Senders, subjects, mailboxes
assert.equal(senderLabel([{ name: "Ada", email: "ada@x" }]), "Ada");
assert.equal(senderLabel([{ name: " ", email: "ada@x" }]), "ada@x");
assert.equal(senderLabel([{ name: null, email: "a@x" }, { name: "B", email: "b@x" }]), "a@x +1");
assert.equal(senderLabel([]), "(no sender)");
assert.equal(addressLine([{ name: "Ada", email: "ada@x" }, { name: null, email: "b@x" }]), "Ada <ada@x>, b@x");
assert.equal(subjectLabel("  "), "(no subject)");
assert.equal(mailboxLabel({ id: "1", name: "INBOX", role: "inbox", parent_id: null, total: 0, unread: 0 }), "Inbox");
assert.equal(mailboxLabel({ id: "2", name: "Junk Mail", role: "junk", parent_id: null, total: 0, unread: 0 }), "Junk Mail");

// T-45 v2: which accounts and mailboxes a list reads
const box = (id: string, role: string, unread = 0) => ({ id, name: role, role, parent_id: null, total: unread, unread });
const two: Overview = { login: "robin@example.com", multi: true, accounts: [
  { id: "A", name: "robin@example.com", who: "owner", mailboxes: [box("A-in", "inbox", 2), box("A-dr", "drafts"), box("A-junk", "junk", 4), box("A-trash", "trash")] },
  { id: "U", name: "uni@example.com", who: "uni", mailboxes: [box("U-in", "inbox", 1), box("U-sent", "sent")] },
] };
assert.deepEqual(sourcesFor({ kind: "all-inboxes" }, two, false), [
  { account_id: "A", mailbox_id: "A-in", exclude: [], position: 0 },
  { account_id: "U", mailbox_id: "U-in", exclude: [], position: 0 },
], "the combined view: each account's Inbox");
assert.deepEqual(sourcesFor({ kind: "mailbox", accountId: "U", mailboxId: "U-sent" }, two, false), [{ account_id: "U", mailbox_id: "U-sent", exclude: [], position: 0 }]);
assert.deepEqual(sourcesFor({ kind: "all-inboxes" }, two, true), [
  { account_id: "A", mailbox_id: null, exclude: ["A-junk", "A-trash"], position: 0 },
  { account_id: "U", mailbox_id: null, exclude: [], position: 0 },
], "a search reads each account whole, less Junk and Trash");
assert.deepEqual(sourcesFor({ kind: "mailbox", accountId: "A", mailboxId: "A-dr" }, two, true).map((s) => s.account_id), ["A"], "searching from a mailbox reads its account");
assert.equal(allInboxesUnread(two), 3, "Junk's unread doesn't count");
assert.equal(scopeTitle({ kind: "all-inboxes" }, two, ""), "All inboxes");
assert.equal(scopeTitle({ kind: "all-inboxes" }, two, "jars"), "Search: both mailboxes");
assert.equal(scopeTitle({ kind: "mailbox", accountId: "U", mailboxId: "U-sent" }, two, ""), "Uni · sent");
assert.equal(scopeTitle({ kind: "mailbox", accountId: "U", mailboxId: "U-sent" }, two, "x"), "Search: Uni's mail");
const one: Overview = { login: "test@example.com", multi: false, accounts: [two.accounts[0]] };
assert.equal(scopeTitle({ kind: "all-inboxes" }, one, ""), "Inbox", "one account: no 'All inboxes'");
assert.equal(scopeValid({ kind: "mailbox", accountId: "U", mailboxId: "U-in" }, one), false, "a scope in an account that went is dropped");
assert.equal(scopeValid({ kind: "mailbox", accountId: "A", mailboxId: "A-in" }, one), true);
assert.equal(whoTag("owner"), "YOU");
assert.equal(whoTag("uni"), "UNI");

// Dates: today shows a time, this week a day, this year a month and day, older the year too
const now = new Date("2026-10-18T15:00:00");
assert.match(mailDate("2026-10-18T09:05:00", now), /9:05/);
assert.doesNotMatch(mailDate("2026-10-16T09:05:00", now), /2026|9:05/);
assert.doesNotMatch(mailDate("2026-03-02T09:05:00", now), /2026/);
assert.match(mailDate("2025-03-02T09:05:00", now), /2025/);
assert.equal(mailDate("not a date", now), "");

// The reading frame: the CSP comes first and refuses every remote load
const doc = mailSrcdoc("<p>Hi</p>");
assert.ok(doc.indexOf("Content-Security-Policy") < doc.indexOf("<p>Hi</p>"));
assert.ok(doc.startsWith(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${MAIL_FRAME_CSP}">`));
for (const d of ["default-src 'none'", "img-src data:", "connect-src 'none'", "frame-src 'none'", "form-action 'none'"]) assert.ok(MAIL_FRAME_CSP.includes(d), d);
assert.ok(!/script-src|https?:/.test(MAIL_FRAME_CSP), "no script and no remote origin is ever allowed");

// Mail is a place: one tab, kept across a restart
assert.ok(sameTarget({ kind: "mail", title: "Mail" }, { kind: "mail", title: "x" }));
const saved = serializeTabs({ tabs: [{ id: "m", kind: "mail", title: "Mail" }], active: "m", recent: ["m"] });
assert.deepEqual(restoreTabs(saved, []).tabs, [{ id: "m", kind: "mail", title: "Mail" }]);

console.log("ok   mail: problems, labels, sources and scopes, dates, sealed frame, tab");

// ── T-210: writes ──
// What the bridge offers decides what the app enables; nothing is offered by a bridge without the write patch.
const own: AccountBoxes = { id: "A", name: "robin@example.com", who: "owner", mailboxes: [], operations: ["mark_seen", "flag", "archive", "draft.save", "draft.review", "draft.discard", "send", "send.check"] };
const unis: AccountBoxes = { id: "U", name: "uni@example.com", who: "uni", mailboxes: [], operations: ["mark_seen", "flag", "send_as_uni", "send.check"] };
const bare: AccountBoxes = { id: "A", name: "robin@example.com", who: "owner", mailboxes: [] };
assert.equal(can(own, "archive"), true);
assert.equal(can(unis, "archive"), false, "the owner never moves Uni's mail");
assert.equal(can(bare, "mark_seen"), false);
assert.equal(canSendFrom(own), true);
assert.equal(canSendFrom(unis), true, "as Uni, through the deputy path");
assert.equal(canSendFrom({ ...unis, operations: ["mark_seen"] }), false);
assert.equal(canSendFrom({ ...own, operations: ["draft.save"] }), false, "saving alone isn't sending");
assert.equal(canSendFrom(bare), false);
assert.equal(writesOffered({ login: "x", multi: true, accounts: [bare, { ...unis, operations: [] }] }), false);
assert.equal(writesOffered({ login: "x", multi: true, accounts: [bare, unis] }), true);
assert.equal(sendLabel("owner"), "Send as you");
assert.equal(sendLabel("uni"), "Send as Uni");

// Addresses as typed: a bad one is named, never dropped; a quoted name may hold a comma; nothing smuggles a header.
assert.deepEqual(parseAddresses("mara@example.org, Theo Brandt <theo@example.net>;\n\"Vale, Robin\" <robin@example.com>"), {
  list: [{ name: null, email: "mara@example.org" }, { name: "Theo Brandt", email: "theo@example.net" }, { name: "Vale, Robin", email: "robin@example.com" }], bad: [] });
assert.deepEqual(parseAddresses("mara@example.org, nobody, a@b").bad, ["nobody", "a@b"]);
assert.deepEqual(parseAddresses("x@example.org\r\nBcc: spy@example.net"), { list: [{ name: null, email: "x@example.org" }], bad: ["Bcc: spy@example.net"] },
  "a new line separates addresses; what follows it is named as not an address");
assert.deepEqual(parseAddresses("  ,, "), { list: [], bad: [] });
assert.equal(validAddress("robin@example.com"), true);
for (const bad of ["robin", "robin@example", "a b@example.com", "<a@example.com>", "a@example.com\n"]) assert.equal(validAddress(bad), false, bad);
const typed = "Theo Brandt <theo@example.net>, \"Vale, Robin\" <robin@example.com>, mara@example.org";
assert.equal(formatAddresses(parseAddresses(typed).list), typed, "addresses round-trip through the editor");

// A reply goes from the thread's mailbox to the newest message's Reply-To, else its sender; to the recipients when we sent it.
const msg = (o: Partial<MailMessage>): MailMessage => ({ id: "m", thread_id: "t", from: [], to: [], cc: [], reply_to: [], subject: "Plans", received_at: "", sent_at: null,
  unread: false, draft: false, uni_drafted: false, mailbox_ids: [], text: null, html: null, remote_images: 0, links: [], truncated: false, attachments: [], ...o });
const mara = { name: "Mara Quill", email: "mara@example.org" }, robin = { name: "Robin Vale", email: "robin@example.com" };
const thread = (messages: MailMessage[]): MailThread => ({ account_id: "A", thread_id: "t", messages });
let r = replyFields(thread([msg({ id: "m1", from: [mara], subject: "Planning" }), msg({ id: "m2", from: [mara], subject: "Re: Planning", reply_to: [{ name: null, email: "list@example.org" }] }),
  msg({ id: "d", draft: true, from: [robin] })]), own);
assert.deepEqual([r.to, r.subject, r.in_reply_to], [[{ name: null, email: "list@example.org" }], "Re: Planning", "m2"]);
r = replyFields(thread([msg({ id: "m1", from: [mara], subject: "Re: plans" }), msg({ id: "m2", from: [robin], to: [mara, robin] })]), own);
assert.deepEqual([r.to, r.subject, r.in_reply_to], [[mara], "Re: plans", "m2"], "replying after our own message goes to whom it went to");
const d = msg({ draft: true, to: [mara], cc: [robin], bcc: [], subject: "Re: x", text: "Monday." });
assert.equal(sameFields(draftFields(d), { ...draftFields(d) }), true);
assert.equal(sameFields(draftFields(d), { ...draftFields(d), text: "Tuesday." }), false);

// #mail's ask: "not verified" on mail from the owner's address that came in and failed DMARC; nothing else.
const ov = { login: "robin@example.com", multi: true, accounts: [own, unis] };
assert.equal(notVerified(msg({ from: [robin], dmarc: "fail" }), ov), true);
assert.equal(notVerified(msg({ from: [{ name: null, email: "ROBIN@example.com" }], dmarc: "none" }), ov), true);
assert.equal(notVerified(msg({ from: [robin], dmarc: "pass" }), ov), false);
assert.equal(notVerified(msg({ from: [robin], dmarc: null }), ov), false, "delivered inside the server: no result, no badge");
assert.equal(notVerified(msg({ from: [mara], dmarc: "fail" }), ov), false, "someone else's mail isn't about the owner");
assert.equal(notVerified(msg({ from: [robin], dmarc: "fail", draft: true }), ov), false);

// A send's outcome in words; an unknown one has no Send button, and a refusal can be edited and tried again.
const out = (state: SendOutcome["state"], reason: string | null = null): SendOutcome => ({ op_id: "op", account_id: "A", draft_id: "d", state, reason, submission_id: null, delivery: null, note: null });
assert.equal(sendOutcomeText(out("cleaned"), "owner").text, "Sent as you.");
assert.equal(sendOutcomeText(out("cleaned"), "uni").text, "Sent as Uni.");
assert.deepEqual(sendOutcomeText(out("unknown"), "owner"), { text: "Outcome unknown, checking. It won't be sent twice.", done: false, blocked: true });
assert.deepEqual(sendOutcomeText(out("refused", "the draft changed since it was reviewed"), "owner"), { text: "Not sent: the draft changed since it was reviewed.", done: false, blocked: false });
assert.match(sendOutcomeText(out("awaiting-approval", "Uni's outbound rules want Aaron to approve mail to ada@example.org"), "uni").text, /waits in Uni's Drafts/);
const op1 = newOpId(), op2 = newOpId();
assert.match(op1, /^op-[0-9a-f]{32}$/);
assert.notEqual(op1, op2);
console.log("ok   mail (T-210): what is offered, addresses, replies, not verified, send outcomes");
