// T-335: the To post queue's pure rules. Run: node --experimental-strip-types scripts/post.test.ts
import assert from "node:assert/strict";
import { blocked, editMode, parsePost, parsePosts, queue, reviewCount, scheduleAt, voice, waitingLine, where } from "../src/post/postCore.ts";

const note = (id: string, meta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id, path: `Posts/${id}`, updatedAt: `2026-10-29T10:00:0${id.length % 10}.000Z`, tags: ["post"],
  metadata: { state: "proposed", account: "uni", platform: "bluesky", provenance: "uni", piece: "", body: "A made-up build log line.", media: [], ...meta }, ...extra,
});

// only post notes with a known account and state are cards
assert.equal(parsePost({ ...note("a", {}), tags: ["task"] }), null);
assert.equal(parsePost(note("a", { account: "someone" })), null);
assert.equal(parsePost(note("a", { state: "maybe" })), null);
assert.equal(parsePosts([note("a", {}), note("b", { account: "aaron", provenance: "aaron-typed" })]).length, 2);

// the badge says whose words in a word
assert.equal(voice(parsePost(note("a", {}))!), "Uni's voice");
assert.equal(voice(parsePost(note("a", { account: "aaron", provenance: "aaron-typed" }))!), "Your voice");

// the voice rule blocks Approve before Rust and the poster refuse it too
assert.match(blocked(parsePost(note("a", { account: "aaron", provenance: "uni" }))!)!, /never go out under your name/);
assert.match(blocked(parsePost(note("a", { account: "uni", provenance: "aaron-typed" }))!)!, /never go out under Uni's name/);
assert.equal(blocked(parsePost(note("a", {}))!), null);
assert.match(blocked(parsePost(note("a", { body: "x".repeat(301) }))!)!, /301 characters; Bluesky allows 300/);
assert.equal(blocked(parsePost(note("a", { body: "é".repeat(300) }))!), null); // code points, not bytes
assert.match(blocked(parsePost(note("a", { media: ["att1"] }))!)!, /can't go out yet/);
assert.match(blocked(parsePost(note("a", { account: "aaron", provenance: "aaron-excerpt" }))!)!, /link the piece/);

// a Bluesky post with its X copy: the card names both, and the text must fit both
assert.equal(where(parsePost(note("a", { crosspost: ["x"] }))!), "Bluesky + X · Uni's account");
assert.equal(where(parsePost(note("a", {}))!), "Bluesky · Uni's account");
assert.match(blocked(parsePost(note("a", { crosspost: ["x"], body: "x".repeat(281) }))!)!, /281 characters; Bluesky \+ X allows 280/);
assert.equal(blocked(parsePost(note("a", { crosspost: ["x"], body: "x".repeat(280) }))!), null);
for (const [cp, platform] of [[["bluesky"], "x"], [["mastodon"], "bluesky"], [["x", "x"], "bluesky"], ["x", "bluesky"]] as const) {
  assert.match(blocked(parsePost(note("a", { crosspost: cp, platform }))!)!, /only to X/, `${cp} on ${platform}`);
}
assert.equal(parsePost(note("a", { state: "posted", crosspost: ["x"], crosspost_x_failed: "X 503" }))!.crosspostFailed, "X 503");

// the queue: review, waiting, done; dropped ones leave; one area's posts only
const posts = parsePosts([
  note("p1", { node: "Areas/Garden" }), note("p2", { node: "Areas/Kitchen" }),
  note("a1", { state: "approved", scheduled_for: "2026-11-01T09:00:00Z", node: "Areas/Garden/Seeds" }),
  note("x1", { state: "posted", posted_at: "2026-10-28T10:00:00Z" }), note("x2", { state: "failed" }), note("d1", { state: "dropped" }),
]);
const q = queue(posts);
assert.deepEqual(q.review.map((p) => p.id), ["p1", "p2"]);
assert.deepEqual(q.waiting.map((p) => p.id), ["a1"]);
assert.deepEqual(q.done.map((p) => p.id).sort(), ["x1", "x2"]);
assert.equal(reviewCount(posts), 2);
assert.equal(reviewCount(posts, "Areas/Garden"), 1);
assert.deepEqual(queue(posts, "Areas/Garden").waiting.map((p) => p.id), ["a1"]); // a project under the area counts

// a post the poster has claimed is going out: in Going out, with no Not this
const claimed = parsePosts([note("c1", { state: "posting" })]);
assert.deepEqual(queue(claimed).waiting.map((p) => p.id), ["c1"]);
assert.equal(waitingLine(claimed[0]), "Going out now");

// schedule: a future local time only
const now = new Date("2026-10-29T12:00:00");
assert.equal(scheduleAt("", now), null);
assert.equal(scheduleAt("2026-10-29T11:00", now), null);
assert.equal(scheduleAt("2026-10-29T12:00", now), null);
assert.equal(scheduleAt("2026-10-30T09:00", now), Math.floor(new Date("2026-10-30T09:00").getTime() / 1000));
assert.match(waitingLine(posts.find((p) => p.id === "a1")!, now), /^Goes out /);
assert.equal(waitingLine(parsePost(note("a", { state: "approved" }))!, now), "Approved · goes out within a minute");

// Edit: Aaron's own words on his account; a note to Uni on Uni's
assert.equal(editMode(parsePost(note("a", { account: "aaron", provenance: "aaron-typed" }))!), "words");
assert.equal(editMode(parsePost(note("a", {}))!), "note");

console.log("post: ok");
