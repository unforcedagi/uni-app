// T-278 Messages: the view's decisions that a screen hides when they're wrong. An update or a late answer for one
// room never lands in another's thread; a slower answer doesn't replace newer live rows; day dividers fall at local
// midnight and a sender's run breaks after five minutes; a rejection keeps the door's shape.
// Run: node --experimental-strip-types scripts/messages.test.ts
import assert from "node:assert/strict";
import { draftFor, draftsEpoch, keepDraft, rememberOpen, unsentBack } from "../src/messages/messagesDoor.ts";
import { applyLink, applyOpened, applyTimeline, asMessagesErr, linkHost, mergeLinks, previewLine, qrPath, shownFlows, shownItems, type LinkRow, type MessageRow, type RoomRow, type Thread } from "../src/messages/messagesView.ts";

let n = 0;
const t = (name: string, f: () => void) => { f(); n++; console.log(`ok ${name}`); };

const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m).getTime(); // local time, so any TZ
const msg = (key: string, sender: string, ts: number, over: Partial<MessageRow> = {}): MessageRow => ({
  key, event_id: `$${key}`, sender, sender_name: sender.slice(1, 5), own: false, ts, kind: "text", body: key, state: "remote", encrypted: true, edited: false, ...over,
});
const room = (over: Partial<RoomRow> = {}): RoomRow => ({ id: "!r:example.com", name: "Robin Vale", preview: null, preview_own: false, ts: null, unread: 0, encrypted: true, invited: false, inviter: null, direct: true, ...over });

t("a live update for another room never reaches the open thread", () => {
  const open: Thread = { roomId: "!a:example.com", seq: 1, items: [msg("one", "@robin:example.com", at(23, 9, 0))] };
  assert.equal(applyTimeline(open, "!b:example.com", [msg("intruder", "@mara:example.com", at(23, 9, 1))]), open);
  assert.deepEqual(applyTimeline(open, "!a:example.com", [msg("two", "@robin:example.com", at(23, 9, 2))])?.items?.map((m) => m.key), ["two"]);
  assert.equal(applyTimeline(null, "!a:example.com", []), null);
});

t("opening one room, then another: the first room's late answer is dropped", () => {
  const second: Thread = { roomId: "!b:example.com", seq: 2, items: null };
  assert.equal(applyOpened(second, "!a:example.com", 1, [msg("a1", "@robin:example.com", 1)]), second);
  // the same room opened again (a new seq): the earlier open's answer is stale too
  assert.equal(applyOpened({ roomId: "!a:example.com", seq: 3, items: null }, "!a:example.com", 1, []).items, null);
  assert.deepEqual(applyOpened(second, "!b:example.com", 2, [msg("b1", "@mara:example.com", 1)])?.items?.map((m) => m.key), ["b1"]);
});

t("an answer slower than the live rows doesn't take newer messages away, even at the same length or longer", () => {
  // the live update brought the edit; the answer was read before it
  const live: Thread = { roomId: "!a:example.com", seq: 1, items: [msg("a1", "@robin:example.com", 1, { body: "see you at 6", edited: true })] };
  assert.equal(applyOpened(live, "!a:example.com", 1, [msg("a1", "@robin:example.com", 1, { body: "see you at 5" })]), live);
  // the live update came after a redaction: one row fewer than the answer
  const redacted: Thread = { roomId: "!a:example.com", seq: 1, items: [] };
  assert.equal(applyOpened(redacted, "!a:example.com", 1, [msg("gone", "@robin:example.com", 1)]), redacted);
});

t("day dividers fall at local midnight; a run of one sender breaks after five minutes or on a new sender", () => {
  const now = at(24, 12, 0);
  const rows = [
    msg("late", "@robin:example.com", at(23, 23, 58)),
    msg("after-midnight", "@robin:example.com", at(24, 0, 1)),
    msg("same-run", "@robin:example.com", at(24, 0, 4)),
    msg("six-min-later", "@robin:example.com", at(24, 0, 10)),
    msg("other", "@mara:example.com", at(24, 0, 11)),
  ];
  const shown = shownItems(rows, now);
  assert.deepEqual(shown.map((s) => s.kind === "day" ? `[${s.label}]` : `${s.row.key}${s.first ? "^" : ""}${s.last ? "$" : ""}`),
    ["[Yesterday]", "late^$", "[Today]", "after-midnight^", "same-run$", "six-min-later^$", "other^$"]);
});

t("the list says who spoke last, and an invite says who asked", () => {
  assert.equal(previewLine(room({ preview: "see you at six", preview_own: true })), "You: see you at six");
  assert.equal(previewLine(room({ preview: "see you at six" })), "see you at six");
  assert.equal(previewLine(room({ invited: true, inviter: "Mara Quill" })), "Mara Quill invited you");
  assert.equal(previewLine(room()), "Encrypted conversation");
  assert.equal(previewLine(room({ encrypted: false })), "No messages yet");
});

t("a command's rejection keeps the door's kind; anything else is a server problem", () => {
  assert.deepEqual(asMessagesErr({ kind: "refused", message: "M_FORBIDDEN" }), { kind: "refused", message: "M_FORBIDDEN" });
  assert.equal(asMessagesErr({ kind: "teleport", message: "x" }).kind, "server");
  assert.equal(asMessagesErr("Command messages_status not found").kind, "server");
});

t("a QR is drawn from its 0s and 1s only: runs of dark modules, inside the quiet zone", () => {
  const { size, d } = qrPath(["110", "011", "000"]);
  assert.equal(size, 11);
  assert.equal(d, "M4 4h2v1h-2zM5 5h2v1h-2z");
  // anything but a 1 is light: a row can't carry markup or a path command into the page
  assert.equal(qrPath(['1"/><script>', "x1"]).d, "M4 4h1v1h-1zM5 5h1v1h-1z");
});

t("a card's update replaces only that network's card", () => {
  const row = (network: string, state: LinkRow["state"], rev = 1): LinkRow => ({ network, name: network, state, accounts: [], step: null, note: null, rev });
  const rows = [row("signal", "checking"), row("whatsapp", "checking")];
  assert.deepEqual(applyLink(rows, row("whatsapp", "linked"))?.map((r) => r.state), ["checking", "linked"]);
  assert.deepEqual(applyLink(null, row("signal", "linked")).map((r) => r.state), ["linked"], "an update before the cards is kept");
  assert.deepEqual(applyLink(rows, row("matrix", "linked"))?.map((r) => r.network), ["signal", "whatsapp", "matrix"]);
  // a command's answer older than the update that crossed it doesn't bring the card back
  const after = applyLink([row("signal", "not_linked", 7)], row("signal", "checking", 5));
  assert.equal(after[0].state, "not_linked");
});

t("Telegram's bot-token and raw-session logins aren't offered; every other way in is", () => {
  const flows = ["phone", "qr", "bot", "manual"].map((id) => ({ id, description: id }));
  assert.deepEqual(shownFlows("telegram", flows).map((f) => f.id), ["phone", "qr"]);
  assert.equal(shownFlows("whatsapp", flows).length, 4);
});

t("the answer to opening the screen never overwrites an update that came while it was on its way", () => {
  const row = (network: string, state: LinkRow["state"], rev = 0): LinkRow => ({ network, name: network, state, accounts: [], step: null, note: null, rev });
  // Telegram's bot doesn't exist: its card turns NOT RUNNING before the snapshot (all "checking") arrives
  const early = applyLink(null, row("telegram", "unavailable", 3));
  const merged = mergeLinks([row("signal", "checking"), row("telegram", "checking")], early);
  assert.deepEqual(merged.map((r) => [r.network, r.state]), [["signal", "checking"], ["telegram", "unavailable"]]);
  assert.deepEqual(mergeLinks([row("signal", "checking")], null).map((r) => r.state), ["checking"]);
});

t("a sign-in link is shown only as an https host; anything else, no link and no crash", () => {
  assert.equal(linkHost("https://accounts.example.com/AccountChooser"), "accounts.example.com");
  assert.equal(linkHost("accounts.example.com"), null);
  assert.equal(linkHost("javascript:alert(1)"), null);
  assert.equal(linkHost(""), null);
});

t("review f97fx1ji: a send that fails after sign-out or Forget never puts its words back for the next account", () => {
  rememberOpen(null);
  const sentAt = draftsEpoch();
  // signed in, a send is on its way; it fails while still signed in: the words come back to the room's draft
  assert.equal(unsentBack("!room:example.org", "first words", sentAt), true);
  assert.equal(draftFor("!room:example.org"), "first words");
  // something new being written wins over the failed words
  keepDraft("!room:example.org", "newer");
  unsentBack("!room:example.org", "first words", sentAt);
  assert.equal(draftFor("!room:example.org"), "newer");
  // another send; then sign-out (or Forget) clears the drafts before it fails
  const before = draftsEpoch();
  rememberOpen(null);
  assert.equal(draftFor("!room:example.org"), "");
  assert.equal(unsentBack("!room:example.org", "private words", before), false);
  assert.equal(draftFor("!room:example.org"), "", "the next account opening the same room finds no draft");
});

console.log(`${n} messages view checks passed`);
