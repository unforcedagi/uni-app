// T-278 Messages: the view's decisions that a screen hides when they're wrong. An update or a late answer for one
// room never lands in another's thread; a slower answer doesn't replace newer live rows; day dividers fall at local
// midnight and a sender's run breaks after five minutes; a rejection keeps the door's shape.
// Run: node --experimental-strip-types scripts/messages.test.ts
import assert from "node:assert/strict";
import { applyOpened, applyTimeline, asMessagesErr, previewLine, shownItems, type MessageRow, type RoomRow, type Thread } from "../src/messages/messagesView.ts";

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

t("an answer slower than the live rows doesn't take newer messages away", () => {
  const live: Thread = { roomId: "!a:example.com", seq: 1, items: [msg("a1", "@robin:example.com", 1), msg("a2", "@robin:example.com", 2)] };
  assert.equal(applyOpened(live, "!a:example.com", 1, [msg("a1", "@robin:example.com", 1)]), live);
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

console.log(`${n} messages view checks passed`);
