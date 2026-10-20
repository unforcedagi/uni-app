// T-45 Mail, pure parts. Run: node --experimental-strip-types scripts/mail.test.ts (Node >= 22.6)
import assert from "node:assert/strict";
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
