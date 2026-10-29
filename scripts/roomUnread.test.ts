// T-335: unread by room and by tree row, folded areas' roll-up, approvals as needs-you per room.
// Run: node --experimental-strip-types scripts/roomUnread.test.ts
import assert from "node:assert/strict";
import { rolledUnread, unreadByPath, unreadByRoom, unreadShort, unreadWords, withApprovalNeeds } from "../src/areas/roomUnread.ts";

let failed = 0;
function check(name: string, fn: () => void) {
  try { fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

const rooms = [
  { id: "r-north", unread: 3, mentions: false }, { id: "r-kiln", unread: 2, mentions: true }, { id: "r-quiet", unread: 0, mentions: false },
  { id: "r-loose", unread: 5, mentions: false }, { id: "r-old" },
];
const owned = new Map([["r-north", { path: "Areas/North" }], ["r-kiln", { path: "Projects/Kiln" }], ["r-quiet", { path: "Areas/Quiet" }]]);
// North holds Kiln (twice: linked to two areas) and a held project with no room; Quiet is empty
const rows = [
  { path: "Areas/North", depth: 1 }, { path: "Projects/Kiln", depth: 2 }, { path: "Projects/Held", depth: 2 }, { path: "Projects/Kiln", depth: 2 },
  { path: "Areas/Quiet", depth: 1 },
];

check("a room with nothing new (or no count from an older cache) is left out", () => {
  assert.deepEqual([...unreadByRoom(rooms).keys()], ["r-north", "r-kiln", "r-loose"]);
});
check("unread lands on the row that owns the room; an unowned room is not on any row", () => {
  const p = unreadByPath(unreadByRoom(rooms), owned);
  assert.deepEqual(p.get("Areas/North"), { n: 3, mention: false });
  assert.deepEqual(p.get("Projects/Kiln"), { n: 2, mention: true });
  assert.equal(p.size, 2);
});
check("a folded area shows its own plus what is inside, a linked project counted once, the mention carried up", () => {
  const p = unreadByPath(unreadByRoom(rooms), owned);
  assert.deepEqual(rolledUnread(rows, p, 0), { n: 5, mention: true });
  assert.deepEqual(rolledUnread(rows, p, 1), { n: 2, mention: true });
  assert.equal(rolledUnread(rows, p, 2), null);
  assert.equal(rolledUnread(rows, p, 4), null);
});
check("reading a room clears it: zero unread is nothing to show", () => {
  const read = rooms.map((r) => (r.id === "r-kiln" ? { ...r, unread: 0, mentions: false } : r));
  const p = unreadByPath(unreadByRoom(read), owned);
  assert.deepEqual(rolledUnread(rows, p, 0), { n: 3, mention: false });
  assert.equal(p.has("Projects/Kiln"), false);
});
check("approval prompts add to the owning row's needs; one in an unowned room counts on that room", () => {
  const { byPath, byRoom } = withApprovalNeeds(new Map([["Areas/North", 1]]), [{ channel: "r-north" }, { channel: "r-kiln" }, { channel: "r-loose" }, { channel: "r-loose" }], owned);
  assert.equal(byPath.get("Areas/North"), 2);
  assert.equal(byPath.get("Projects/Kiln"), 1);
  assert.equal(byRoom.get("r-loose"), 2);
  assert.equal(byRoom.has("r-north"), false);
});
check("before the tree is read, every prompt is by room and the task needs are kept", () => {
  const { byPath, byRoom } = withApprovalNeeds(new Map([["Areas/North", 1]]), [{ channel: "r-north" }], null);
  assert.deepEqual([...byPath], [["Areas/North", 1]]);
  assert.equal(byRoom.get("r-north"), 1);
});
check("words and the short count", () => {
  assert.equal(unreadWords({ n: 1, mention: false }), "1 new");
  assert.equal(unreadWords({ n: 4, mention: true }), "4 new, mentions you");
  assert.equal(unreadShort(7), "7");
  assert.equal(unreadShort(140), "99+");
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
