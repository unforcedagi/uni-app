// Run: node --experimental-strip-types scripts/mentions.test.ts (Node >= 22.6)
import assert from "node:assert/strict";
import { activeQuery, filterMembers, insertMention, memberLabels, mentionSegments, pruneBindings, resolveRecipients, type Member } from "../src/mentions.ts";

const k = (c: string) => c.repeat(64);
const uni: Member = { pubkey: k("a"), name: "Uni", named: true };
const uniBot: Member = { pubkey: k("b"), name: "Uni Bot", named: true };
const aaron: Member = { pubkey: k("c"), name: "Aaron", named: true };
const aaron2: Member = { pubkey: k("d"), name: "Aaron", named: true };
const members = [uni, uniBot, aaron];

// Caret-scoped query detection.
assert.deepEqual(activeQuery("hey @Un", 7), { start: 4, query: "Un" });
assert.equal(activeQuery("mail a@b", 8), null);
assert.deepEqual(activeQuery("@", 1), { start: 0, query: "" });
assert.equal(activeQuery("@Uni\nhi", 7), null);

// Filtering: prefix first.
assert.deepEqual(filterMembers(members, "un").map((m) => m.name), ["Uni", "Uni Bot"]);
assert.deepEqual(filterMembers(members, "bot").map((m) => m.name), ["Uni Bot"]);
assert.deepEqual(filterMembers(members, "", k("a")).map((m) => m.name), ["Uni Bot", "Aaron"]);

// Insert full label plus separator.
assert.deepEqual(insertMention("hi @Un", 3, 6, "Uni"), { text: "hi @Uni ", caret: 8 });

// Picker binding wins; longest label wins.
const bound = new Map([["Uni Bot", k("b")]]);
assert.deepEqual(resolveRecipients("@Uni Bot please", bound, members), { recipients: [k("b")] });
// Typed unique name binds.
assert.deepEqual(resolveRecipients("hey @uni, ok", new Map(), members), { recipients: [k("a")] });
// Unknown names are plain text.
assert.deepEqual(resolveRecipients("@nobody hi", new Map(), members), { recipients: [] });
// Ambiguous typed name fails visibly.
const dup = [uni, aaron, aaron2];
const r = resolveRecipients("@Aaron hi", new Map(), dup);
assert.ok("error" in r && r.error.includes("@Aaron"));
// ...but a picker-bound qualified label for one of them works.
const labels = memberLabels(dup);
const qual = labels.get(k("d"))!;
assert.equal(qual, `Aaron (${k("d").slice(0, 8)})`);
assert.deepEqual(resolveRecipients(`@${qual} hi`, new Map([[qual, k("d")]]), dup), { recipients: [k("d")] });

// Deleting the label drops its binding.
assert.equal(pruneBindings("hi there", bound).size, 0);
assert.equal(pruneBindings("@Uni Bot x", bound).size, 1);

// Rendering highlights only tagged recipients.
assert.deepEqual(mentionSegments("ask @Uni and @Aaron", [uni]), [
  { text: "ask " }, { text: "@Uni", mention: k("a") }, { text: " and @Aaron" },
]);
assert.deepEqual(mentionSegments("email x@Uni", [uni]), [{ text: "email x@Uni" }]);

console.log("mentions.test: all assertions passed");
