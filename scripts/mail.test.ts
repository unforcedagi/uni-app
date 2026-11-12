// T-45 Mail, pure parts. Run: node --experimental-strip-types scripts/mail.test.ts (Node >= 22.6)
import assert from "node:assert/strict";
import {
  can, canSendFrom, draftEditable, draftFields, formatAddresses, newOpId, notVerified, parseAddresses, readPending, replyFields, sameFields, sendLabel, sendOutcomeText, settled,
  uncertain, validAddress, withoutPending, withPending, writePending, writesOffered,
  type AccountBoxes, type MailMessage, type MailThread, type SendOutcome,
} from "../src/mailCore.ts";
import {
  addressLine, footDrafts, mailboxLabel, mailDate, mailTabs, replyDraft, MAIL_FRAME_CSP, mailProblem, mailSrcdoc, placeSources, placeTitle, placeValid, senderLabel, splitQuoted, subjectLabel, threadPeople, toWords, whoTag,
  type AccountBoxes as Acct, type Overview,
} from "../src/mailCore.ts";
import { restoreTabs, sameTarget, serializeTabs } from "../src/tabs.ts";

// Every failure the bridge can give reads as a plain sentence, with what to do.
const unreachable = mailProblem({ kind: "unreachable", message: "https://hub.example.ts.net:8452 is not answering" });
assert.equal(unreachable.title, "Mail isn't reachable right now.");
assert.match(unreachable.help, /tailnet/);
assert.equal(unreachable.retry, true);
const key = "ab".repeat(32);
const notAllowed = mailProblem({ kind: "not_allowed", message: "pubkey not allowed", pubkey: key });
assert.equal(notAllowed.pubkey, key, "the device key is shown, so #systems can allowlist it");
assert.match(notAllowed.help, /#systems/);
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
// T-335 Mail v2: places as tabs. Your Inbox first; Uni's own mail one tab away; Waiting only where you decide Uni's sends
const tabs = (o: Overview, later = 0, waiting = 0) => mailTabs(o, { later, waiting }).map((t) => `${t.id}:${t.count}`);
assert.deepEqual(tabs(two, 2), ["inbox:2", "later:2", "drafts:0", "junk:4", "uni:0"], "a tab per place that exists; Junk counts unread; Uni's mail has no count");
const deciding: Overview = { ...two, accounts: [two.accounts[0], { ...two.accounts[1], operations: ["send.parked", "send.approve", "send.decline"] }] };
assert.deepEqual(tabs(deciding, 0, 3).slice(0, 3), ["inbox:2", "later:0", "waiting:3"], "Waiting shows where you decide Uni's held sends");
assert.equal(mailTabs(deciding, { later: 1, waiting: 3 }).find((t) => t.id === "waiting")?.name, "Waiting (3 waiting)");
assert.deepEqual(placeSources("inbox", two), [{ account_id: "A", mailbox_id: "A-in", exclude: [], position: 0, flagged: false }], "the Inbox leaves Later mail out");
assert.deepEqual(placeSources("later", two), [{ account_id: "A", mailbox_id: null, exclude: ["A-junk", "A-trash", "A-dr"], position: 0, flagged: true }], "Later: threads put off, shown by their mail (not Junk, Trash or an unsent draft)");
assert.deepEqual(placeSources("uni", two), [{ account_id: "U", mailbox_id: "U-in", exclude: [], position: 0 }], "Uni's mail is Uni's Inbox");
assert.deepEqual(placeSources("inbox", two, { text: "jars" }), [{ account_id: "A", mailbox_id: null, exclude: ["A-junk", "A-trash"], position: 0 }], "a search reads your whole account, less Junk and Trash");
assert.deepEqual(placeSources("uni", two, { text: "x" }).map((s) => s.account_id), ["U"], "searching from Uni's tab reads Uni's mail");
assert.equal(placeSources("drafts", two, { files: true })[0].with_files, true, "Files narrows any list");
assert.deepEqual(placeSources("waiting", deciding), [], "held sends aren't threads");
assert.deepEqual(placeSources("sent", two), [], "no Sent mailbox: nothing to read");
assert.equal(placeTitle("inbox", two, "jars", false), "Search in your mail");
assert.equal(placeTitle("uni", two, "x", true), "Search in Uni's mail, with files");
assert.equal(placeTitle("drafts", two, "", true), "Drafts, with files");
const one: Overview = { login: "test@example.com", multi: false, accounts: [two.accounts[0]] };
assert.equal(placeValid("uni", one), false, "a place in an account that went is dropped");
assert.equal(placeValid("inbox", one), true);
assert.deepEqual(tabs({ ...one, accounts: [{ ...one.accounts[0], who: "uni" }] }), ["inbox:2", "later:0", "drafts:0", "junk:4"], "a one-account bridge's account is yours, whatever it is called, and has no second tab");

// T-335: quoted history folds under what a reply says
assert.deepEqual(splitQuoted("Monday.\n\nOn Sun, Oct 18, Mara Quill wrote:\n> Which day?\n> M"), { body: "Monday.", quoted: "On Sun, Oct 18, Mara Quill wrote:\n> Which day?\n> M" });
assert.deepEqual(splitQuoted("Yes.\n\n> earlier\n>\n> more\n"), { body: "Yes.", quoted: "> earlier\n>\n> more" }, "a closing run of > lines");
assert.equal(splitQuoted("Hi,\n> which day?\nMonday.\n> and the jars?\nYes.").quoted, null, "an answer written between quoted lines stays whole");
assert.equal(splitQuoted("> only a quote").quoted, null, "nothing above the quote: nothing folds");
assert.equal(splitQuoted("Plain text, no quote.").quoted, null);
assert.equal(splitQuoted("Hi\n-----Original Message-----\nFrom: x").body, "Hi");
assert.equal(splitQuoted("Hi Robin,\n\nOn Sun, Oct 18, Robin wrote:\n> Which day?\nMonday.\n> And the jars?\nYes, two.").quoted, null, "answers between the quotes under an On … wrote: line stay open");
assert.deepEqual(splitQuoted("Yes.\n\nOn Sun, Robin wrote:\n\n> a\n>\n> b\n"), { body: "Yes.", quoted: "On Sun, Robin wrote:\n\n> a\n>\n> b" }, "a blank line after On … wrote:");
{ const big = "Short answer.\n\nOn Mon, X wrote:\n" + "> line of an old chain\n".repeat(40000); const t0 = Date.now(); assert.equal(splitQuoted(big).body, "Short answer."); assert.ok(Date.now() - t0 < 500, "a long chain splits in one pass"); }

// T-335: one-line headers and the thread's people, from where you stand
const me: Pick<Acct, "name" | "who"> = { name: "robin@example.com", who: "owner" };
assert.equal(toWords({ to: [{ name: "Robin Vale", email: "Robin@example.com" }], cc: [] }, me), "you");
assert.equal(toWords({ to: [{ name: "Mara Quill", email: "mara@example.org" }], cc: [{ name: null, email: "robin@example.com" }] }, me), "you, Mara Quill");
assert.equal(toWords({ to: ["a", "b", "c", "d"].map((x) => ({ name: x.toUpperCase(), email: `${x}@example.org` })), cc: [] }, me), "A, B and 2 more");
const sender = (from: string, name: string | null) => ({ from: [{ name, email: from }] }) as never;
assert.equal(threadPeople({ account_id: "A", thread_id: "T", messages: [sender("mara@example.org", "Mara Quill"), sender("robin@example.com", "Robin"), sender("mara@example.org", "Mara Quill")] }, me), "Mara Quill, you");
assert.equal(whoTag("owner"), "You");
assert.equal(whoTag("uni"), "Uni");

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
// Codex review 1: sending needs every operation its workflow uses, not just save and send
assert.equal(canSendFrom({ ...own, operations: ["draft.save", "send", "send.check"] }), false, "no review: an opened draft couldn't be sent");
assert.equal(canSendFrom({ ...unis, operations: ["send_as_uni"] }), false, "no check: an unknown outcome could never be resolved");

// a draft is edited and reviewed here only when the review can show all of it
assert.equal(draftEditable(msg({ draft: true, text: "x" })), true);
assert.equal(draftEditable(msg({ draft: true, text: "x", html: "<p>x</p>" })), false);
assert.equal(draftEditable(msg({ draft: true, text: "x", truncated: true })), false);
assert.equal(draftEditable(msg({ draft: true, text: "x", attachments: [{ blob_id: "b", name: "a.pdf", mime: "application/pdf", size: 1, cid: null }] })), false);

// a send call that failed without a refusal may have gone: its outcome is unknown, never "not sent"
assert.equal(uncertain({ kind: "unreachable", message: "timeout" }), true);
assert.equal(uncertain({ kind: "server", message: "mail server: URLError" }), true);
assert.equal(uncertain({ kind: "invalid", message: "bad bridge answer" }), true);
assert.equal(uncertain("IPC failed"), true);
assert.equal(uncertain({ kind: "refused", status: 409, message: "this opId was used for a different request" }), false);
assert.equal(uncertain({ kind: "refused", status: 403, message: "not offered" }), false);
assert.deepEqual(["cleaned", "submitted", "refused", "failed", "awaiting-approval"].map((x) => settled(x as SendOutcome["state"])), [true, true, true, true, true]);
assert.deepEqual(["unknown", "submitting", "reserved", "drafting"].map((x) => settled(x as SendOutcome["state"])), [false, false, false, false]);

// the pending list survives a restart and holds each send once
const mem = new Map<string, string>();
const fake = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
const p1 = { account_id: "A", op_id: "op-1", who: "owner" as const, at: "2026-10-20T10:00:00Z" };
writePending(fake, withPending(withPending(readPending(fake), p1), p1));
assert.deepEqual(readPending(fake), [p1]);
writePending(fake, withoutPending(readPending(fake), "op-1"));
assert.deepEqual(readPending(fake), []);
mem.set("uni.mail.pending.v1", "{not json");
assert.deepEqual(readPending(fake), [], "a broken list reads as empty, not an error");
mem.set("uni.mail.pending.v1", JSON.stringify([{ op_id: 7 }, { ...p1, who: "someone" }, p1]));
assert.deepEqual(readPending(fake), [p1]);
console.log("ok   mail (T-210): what is offered, addresses, replies, not verified, send outcomes, pending sends");

// T-335 review: Later is per thread, and both your draft and Uni's sit at the foot
const dm = (id: string, o: Partial<MailMessage> = {}): MailMessage => ({ id, thread_id: "t", from: [], to: [], cc: [], reply_to: [], subject: "s", received_at: "", sent_at: null, unread: false, draft: false, uni_drafted: false, mailbox_ids: [], text: "x", html: null, remote_images: 0, links: [], truncated: false, attachments: [], ...o });
const both: MailThread = { account_id: "A", thread_id: "t", messages: [dm("m1"), dm("own", { draft: true }), dm("u1", { draft: true, uni_drafted: true }), dm("u2", { draft: true, uni_drafted: true })] };
assert.deepEqual(footDrafts(both, { who: "owner" }), { uni: [both.messages[2], both.messages[3]], own: [both.messages[1]] }, "your draft isn't lost beside Uni's");
assert.deepEqual(footDrafts(both, { who: "uni" }), { uni: [], own: [] }, "Uni's mail keeps its drafts in the conversation");
assert.equal(replyDraft(both, { who: "owner" })?.id, "u2", "Reply opens Uni's newest draft");
assert.equal(replyDraft({ ...both, messages: [dm("m1"), dm("own", { draft: true }), dm("u1", { draft: true, uni_drafted: true, html: "<b>x</b>" })] }, { who: "owner" })?.id, "own", "Uni's can't be shown whole: your own");
assert.equal(replyDraft({ ...both, messages: [dm("m1")] }, { who: "owner" }), null, "no draft: a blank reply");
assert.equal(splitQuoted("See below.\n\n---------- Forwarded message ---------\nFrom: Billing\nInvoice 2291").quoted, null, "a forward's content is not quoted history");
assert.deepEqual(placeSources("junk", two, { text: "acme" })[0].exclude, ["A-trash"], "a search from Junk searches Junk");
assert.equal(splitQuoted("Hi Robin,\n\nOn Sun, Robin wrote:\n> Which day?\nMonday.\n> And the jars?").quoted, null, "an inline reply that ends on a quote stays whole");
const binned: MailThread = { account_id: "A", thread_id: "t", messages: [dm("m1"), dm("u1", { draft: true, uni_drafted: true, mailbox_ids: ["A-trash"] })] };
assert.deepEqual(footDrafts(binned, { who: "owner", mailboxes: two.accounts[0].mailboxes }), { uni: [], own: [] }, "a draft thrown in the Trash isn't waiting");
assert.equal(replyDraft(binned, { who: "owner", mailboxes: two.accounts[0].mailboxes }), null);
console.log("ok   mail (T-335 review): the drafts at the foot, forwards, Junk's search, inline replies");
