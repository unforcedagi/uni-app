// T-335 applet contract 2: the manifest, the grant it resolves to, the card's rows, and the applet port that holds a
// built-in applet to its grant at runtime. The point of these: a call the grant doesn't name never reaches the shell.
// Run: node --experimental-strip-types scripts/appletV2.test.ts
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parseManifest2, screenOf } from "../src/interface/manifest2.ts";
import { allowsNote, allowsQuery, fingerprint, grantEvents, grantExpiry, grantKey, grantLines, resolveGrant, type Grant, type Place } from "../src/interface/grant2.ts";
import { createAppletPort, type PortBackends, type Refusal } from "../src/interface/port.ts";
import { BUILTIN_CODE, builtinSubject, createGrantStore } from "../src/interface/grants.ts";
import { BUILT_IN } from "../src/interface/applets.ts";
import { DOORS } from "../src/interface/doors.ts";
import { ARCADE_MANIFEST } from "../src/arcade/manifest.ts";
import { CALENDAR_MANIFEST, PLANNED, TOPOST_MANIFEST } from "../src/interface/planned2.ts";

let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try { await fn(); console.log(`ok   ${name}`); } catch (e) { failed++; console.log(`FAIL ${name}\n     ${(e as Error).message.split("\n")[0]}`); }
}

const PLACE: Place = { home: "plot", here: null, rooms: [{ id: "ch-garden", name: "Garden co-op" }], author: "shell" };
const parsed = (raw: unknown, host: "native" | "sealed" = "native") => { const r = parseManifest2(raw, host); assert.ok(r.ok, r.ok ? "" : r.error); return r.ok ? r.manifest : (null as never); };
const grantOf = (raw: unknown, place: Place = PLACE): Grant => { const r = resolveGrant(parsed(raw), place); assert.ok(r.ok, r.ok ? "" : r.error); return r.ok ? r.grant : (null as never); };
const refused = (raw: unknown, why: RegExp, host: "native" | "sealed" = "native") => {
  const r = parseManifest2(raw, host);
  assert.equal(r.ok, false, `accepted ${JSON.stringify(raw)}`);
  if (!r.ok) assert.match(r.error, why);
};
const base = { contract: 2, id: "seed-list", name: "Seed list" };

/** A shell that records what reached it. Notes: three in the plot vault, one of them a journal entry, one a post. */
function shell() {
  const calls: { what: string; args: unknown[] }[] = [];
  const notes = [
    { id: "n1", path: "Taste/Profile", tags: ["taste-profile"] },
    { id: "n2", path: "Journal/2026/11-11/09-00 Private", tags: ["journal"] },
    { id: "n3", path: "Posts/First", tags: ["post"] },
    { id: "n4", path: "Posts/Draft", tags: ["post/draft"] },
    { id: "n5", path: "Elsewhere/Tagged post", tags: ["post"] },
  ];
  const be: PortBackends = {
    command: async (...args) => { calls.push({ what: "command", args }); return { ok: true }; },
    query: async (...args) => { calls.push({ what: "query", args }); return notes; },
    note: async (...args) => { calls.push({ what: "note", args }); return notes.find((n) => n.id === args[1] || n.path === args[1]) ?? null; },
    create: async (...args) => { calls.push({ what: "create", args }); return { sent: ["x"] }; },
    open: (...args) => { calls.push({ what: "open", args }); },
  };
  return { calls, be };
}
const code = async (p: Promise<unknown> | (() => unknown)): Promise<string> => {
  try { await (typeof p === "function" ? p() : p); } catch (e) { return String((e as { code?: string }).code ?? e); }
  return "allowed";
};

// ── the manifest ──

await check("Arcade's manifest is valid, and the registry lists Arcade from it", () => {
  const m = parsed(ARCADE_MANIFEST);
  assert.deepEqual(m.doors, [{ door: "arcade", ops: ["home", "rounds", "profile", "media", "react", "distill"] }]);
  const arcade = BUILT_IN.find((a) => a.id === "arcade")!;
  assert.equal(arcade.contract, 2);
  assert.equal(arcade.host, "native");
  assert.equal(arcade.kind, "vault");
  assert.equal(arcade.where, "arcade door, on the box", "where it lives is made from its access");
  assert.deepEqual(arcade.searches, ["games"]);
  assert.equal(screenOf(m, "look").id, "look");
  assert.equal(screenOf(m, "settings").id, "home", "an undeclared screen opens the first one");
});

await check("Calendar and To Post have valid manifests, and nothing runs on them yet", () => {
  for (const raw of PLANNED) parsed(raw);
  for (const id of ["calendar", "topost"]) assert.equal(BUILT_IN.find((a) => a.id === id)!.contract, 1, `${id} is still on contract 1`);
  const cal = grantLines(grantOf(CALENDAR_MANIFEST), (id) => id);
  assert.deepEqual(cal.map((l) => [l.where, l.stress]), [["Calendar door, on the box", false], ["Calendar door, on the box", true], ["plot vault", false]]);
  assert.equal(cal[0].text, "See what this device may do · list events · read one event · list conflicts");
  assert.equal(cal[1].text, "Ask the door to change an event (it checks each change)");
  assert.equal(cal[2].text, "Read event notes");
  const post = grantLines(grantOf(TOPOST_MANIFEST), (id) => id);
  assert.deepEqual(post, [{ where: "plot vault", text: "Read and change post notes", stress: true }]);
});

await check("every door op names one shell command, and no two ops share one", () => {
  const cmds = Object.values(DOORS).flatMap((d) => Object.values(d.ops).map((o) => o.cmd));
  assert.equal(new Set(cmds).size, cmds.length);
  for (const c of cmds) assert.match(c, /^(arcade|cal)_[a-z_]+$/);
});

await check("refused: an unknown key, contract, door, op or verb", () => {
  refused({ ...base, sneaky: true }, /key/);
  refused({ ...base, contract: 3 }, /contract/);
  refused({ ...base, access: [{ door: "mail", ops: ["send"] }] }, /unknown door/);
  refused({ ...base, access: [{ door: "arcade", ops: ["home", "wipe"] }] }, /no op wipe/);
  refused({ ...base, access: [{ door: "arcade", ops: [] }] }, /ops/);
  refused({ ...base, access: [{ door: "arcade", ops: ["constructor"] }] }, /no op/);
  refused({ ...base, access: [{ door: "__proto__", ops: ["home"] }] }, /unknown door/);
  refused({ ...base, access: [{ vault: "plot", allow: [{ path: "Seeds/", verbs: ["read", "share"] }] }] }, /verbs/);
  refused({ ...base, access: [{ vault: "plot", allow: [{ path: "Seeds/", verbs: [] }] }] }, /verbs/);
  refused({ ...base, access: [{ vault: "plot", allow: [{ path: "Seeds/", verbs: ["read"], all: true }] }] }, /rule/);
});

await check("refused: a rule that names no type and no folder (nothing reads a whole vault)", () => {
  refused({ ...base, access: [{ vault: "plot", allow: [{ verbs: ["read"] }] }] }, /whole vault/);
  refused({ ...base, access: [{ vault: "plot", allow: [] }] }, /rules/);
});

await check("refused: a folder that climbs, hides characters or doesn't end in /", () => {
  for (const path of ["Seeds", "../Journal/", "Seeds/../Journal/", "/Seeds/", "Seeds//", "Seeds/%2e%2e/", "Seeds\\x/", "Se​eds/", ""]) {
    refused({ ...base, access: [{ vault: "plot", allow: [{ path, verbs: ["read"] }] }] }, /path/);
  }
  refused({ ...base, access: [{ vault: "Plot Vault", allow: [{ path: "Seeds/", verbs: ["read"] }] }] }, /vault/);
  refused({ ...base, access: [{ vault: "plot", allow: [{ type: "Post Notes", verbs: ["read"] }] }] }, /type/);
});

await check("refused: the same vault, door or room twice; too many of anything", () => {
  const rule = { path: "Seeds/", verbs: ["read"] };
  refused({ ...base, access: [{ vault: "plot", allow: [rule] }, { vault: "plot", allow: [rule] }] }, /twice/);
  refused({ ...base, access: [{ door: "arcade", ops: ["home"] }, { door: "arcade", ops: ["react"] }] }, /twice/);
  refused({ ...base, reach: [{ room: "r", verbs: ["read"] }, { room: "r", verbs: ["draft"] }] }, /twice/);
  refused({ ...base, access: Array.from({ length: 9 }, (_, i) => ({ vault: `v${i}`, allow: [rule] })) }, /short list/);
});

await check("refused: a search offer over notes the applet can't read", () => {
  const access = [{ vault: "plot", allow: [{ type: "post", verbs: ["read"] }, { path: "Seeds/", verbs: ["read"] }, { path: "Mine/", verbs: ["read"], own: true }] }];
  parsed({ ...base, access, search: [{ what: "posts", vault: "plot", type: "post" }, { what: "seeds", vault: "plot", path: "Seeds/Old/" }, { what: "words" }] });
  refused({ ...base, access, search: [{ what: "journal", vault: "plot", path: "Journal/" }] }, /can't read/);
  refused({ ...base, access, search: [{ what: "events", vault: "plot", type: "event" }] }, /can't read/);
  refused({ ...base, access, search: [{ what: "posts", vault: "other", type: "post" }] }, /can't read/);
  refused({ ...base, access, search: [{ what: "mine", vault: "plot", path: "Mine/" }] }, /can't read/);
  refused({ ...base, access, search: [{ what: "all", vault: "plot" }] }, /type or a folder/);
});

await check("a sealed applet's manifest is held to what the frame can do", () => {
  parsed({ ...base, access: [{ vault: "here", allow: [{ path: "Seeds/", verbs: ["read"] }] }], reach: [{ room: "ch-garden", verbs: ["read"] }] }, "sealed");
  refused({ ...base, access: [{ door: "arcade", ops: ["home"] }] }, /door/, "sealed");
  refused({ ...base, access: [{ vault: "home", allow: [{ path: "Journal/", verbs: ["read"] }] }] }, /here/, "sealed");
  refused({ ...base, access: [{ vault: "here", allow: [{ path: "Seeds/", verbs: ["create"] }] }] }, /only read/, "sealed");
  refused({ ...base, access: [{ vault: "here", allow: [{ type: "post", verbs: ["read"] }] }] }, /by folder/, "sealed");
  refused({ ...base, reach: ["voice"] }, /record/, "sealed");
  refused({ ...base, access: [{ vault: "here", allow: [{ path: "Seeds/", verbs: ["read"] }] }] }, /lives in no vault/, "native");
});

// ── the grant and the card ──

await check("the card names exactly what Arcade is granted, in the shell's words", () => {
  const lines = grantLines(grantOf(ARCADE_MANIFEST), (id) => id);
  assert.deepEqual(lines, [
    { where: "Arcade door, on the box", text: "See what's new and your counts · deal rounds · read your taste profile · show a card's picture, sound or clip", stress: false },
    { where: "Arcade door, on the box", text: "Save your reactions · ask for a fresh taste profile", stress: true },
    { where: "plot vault", text: "Add notes in Journal/ (only the ones it made)", stress: true },
    { where: "plot vault", text: "Read notes in Taste/", stress: false },
    { where: "This device", text: "Record your voice when you ask it to", stress: false },
  ]);
});

await check("a grant can't be made for a home vault or a room this device doesn't have", () => {
  const noHome = resolveGrant(parsed(ARCADE_MANIFEST), { ...PLACE, home: null });
  assert.equal(noHome.ok, false);
  const noRoom = resolveGrant(parsed({ ...base, reach: [{ room: "ch-elsewhere", verbs: ["read"] }] }), PLACE);
  assert.equal(noRoom.ok, false);
});

await check("the grant's key: the same access is the same key; any change of access, vault or author is another", async () => {
  const k = await grantKey(grantOf(ARCADE_MANIFEST));
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.match(fingerprint(k), /^[0-9a-f]{4} [0-9a-f]{4}$/);
  const shuffled = { ...ARCADE_MANIFEST, access: [ARCADE_MANIFEST.access[1], { door: "arcade", ops: ["distill", "react", "media", "profile", "rounds", "home"] }] };
  assert.equal(await grantKey(grantOf(shuffled)), k, "order doesn't matter");
  assert.equal(await grantKey(grantOf({ ...ARCADE_MANIFEST, name: "Arcade!" })), k, "a rename alone asks for nothing new");
  const fewer = { ...ARCADE_MANIFEST, access: [{ door: "arcade", ops: ["home", "rounds"] }, ARCADE_MANIFEST.access[1]] };
  const more = { ...ARCADE_MANIFEST, access: [ARCADE_MANIFEST.access[0], { vault: "home", allow: [{ path: "Journal/", verbs: ["create", "read"], own: true }, { path: "Taste/", verbs: ["read"] }] }] };
  const keys = new Set([k, await grantKey(grantOf(fewer)), await grantKey(grantOf(more)), await grantKey(grantOf({ ...ARCADE_MANIFEST, reach: [] })),
    await grantKey(grantOf(ARCADE_MANIFEST, { ...PLACE, home: "other" })), await grantKey(grantOf(ARCADE_MANIFEST, { ...PLACE, author: "someone" })), await grantKey(grantOf(ARCADE_MANIFEST), "Applets/Arcade")]);
  assert.equal(keys.size, 7, "each of those is a different grant: the card comes back");
});

await check("the grant lasts a year, and an expired or unreadable one is no grant", () => {
  let now = Date.parse("2026-11-11T12:00:00Z");
  const mem = new Map<string, string>();
  const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => { mem.set(k, v); }, removeItem: (k: string) => { mem.delete(k); } };
  const store = createGrantStore(storage, () => now);
  const subject = builtinSubject("arcade");
  assert.equal(store.status(subject, "k1", BUILTIN_CODE), "none");
  store.grant(subject, "k1", BUILTIN_CODE, "sealed", grantExpiry);
  assert.equal(store.status(subject, "k1", BUILTIN_CODE), "ok");
  assert.equal(store.status(subject, "k2", BUILTIN_CODE), "none", "another grant key is not this grant");
  assert.equal(store.record(subject)!.expires, "2027-11-11T12:00:00.000Z");
  now = Date.parse("2027-11-11T11:59:59Z");
  assert.equal(createGrantStore(storage, () => now).status(subject, "k1", BUILTIN_CODE), "ok", "kept across a restart, to its last second");
  now = Date.parse("2027-11-11T12:00:00Z");
  assert.equal(store.status(subject, "k1", BUILTIN_CODE), "none", "past its date the card comes back");
  mem.set([...mem.keys()][0], JSON.stringify({ [subject]: { scope: "k1", html: BUILTIN_CODE, grantedAt: "x", expires: "never" } }));
  assert.equal(createGrantStore(storage, () => 0).status(subject, "k1", BUILTIN_CODE), "none", "an expiry that can't be read has passed");
  store.revoke(subject);
  assert.equal(store.status(subject, "k1", BUILTIN_CODE), "none");
});

await check("the 1.0 grant shape: one per vault, allow by type and verb; folder rules stay with the shell", () => {
  const g = grantOf({ ...base, access: [{ vault: "home", allow: [{ type: "reaction", verbs: ["create", "read"], own: true }, { path: "Journal/", verbs: ["create"] }] }, { vault: "arcade", allow: [{ type: "taste-card", verbs: ["read"] }] }] });
  const ev = grantEvents(g, new Date("2027-11-11T12:00:00Z"));
  assert.equal(ev.length, 2);
  assert.equal(ev[0].kind, null, "no event kind is fixed yet: nothing is signed");
  assert.deepEqual(ev[0].tags, [["d", "applet:seed-list:plot"], ["vault", "plot"], ["expiration", "1825934400"]]);
  assert.deepEqual(ev[0].content, { v: 1, grantee: { kind: "applet", id: "seed-list", author: "shell" }, allow: [{ type: "reaction", verbs: ["read", "create"], own: true }], deny_markers: [] });
  assert.deepEqual(ev[0].shellOnly, [{ path: "Journal/", verbs: ["create"], own: false }]);
  assert.deepEqual(ev[1].content.allow, [{ type: "taste-card", verbs: ["read"] }]);
});

// ── the runtime: what the grant doesn't name is refused ──

const arcadePort = (opts: { live?: () => boolean } = {}) => {
  const { calls, be } = shell();
  const refusals: Refusal[] = [];
  const port = createAppletPort(grantOf(ARCADE_MANIFEST), be, { home: "plot", onRefused: (r) => refusals.push(r), ...opts });
  return { port, calls, refusals };
};

await check("a door op in the grant reaches its one command; any other op or door is refused before the shell hears of it", async () => {
  const { port, calls, refusals } = arcadePort();
  assert.deepEqual(await port.door("arcade", "rounds", { game: "gallery", n: 2 }), { ok: true });
  assert.deepEqual(calls, [{ what: "command", args: ["arcade_rounds", { game: "gallery", n: 2 }] }]);
  assert.equal(await code(port.door("calendar", "events", {})), "not_granted", "a door the grant doesn't name");
  assert.equal(await code(port.door("arcade", "wipe")), "out_of_scope", "an op the door doesn't have");
  assert.equal(await code(port.door("arcade", "constructor")), "out_of_scope");
  assert.equal(await code(port.door("mail", "send")), "not_granted", "a door the shell doesn't know");
  const narrow = createAppletPort(grantOf({ ...ARCADE_MANIFEST, access: [{ door: "arcade", ops: ["home", "rounds"] }] }), shell().be, { home: "plot" });
  assert.equal(await code(narrow.door("arcade", "react", { reactions: [] })), "out_of_scope", "an op the grant doesn't name");
  assert.equal(calls.length, 1, "none of the refused calls reached the shell");
  assert.equal(refusals.length, 4);
});

await check("reading outside the grant is refused: a note outside reads as absent, a list outside is refused", async () => {
  const { port, calls } = arcadePort();
  assert.equal((await port.vault.note("home", "n1"))?.path, "Taste/Profile", "a note in Taste/ is its to read");
  assert.equal(await port.vault.note("home", "n2"), null, "a journal entry it didn't make is not: it reads as absent");
  assert.equal(await port.vault.note("home", "Journal/2026/11-11/09-00 Private"), null, "by path too: judged on the note that comes back");
  assert.equal(await port.vault.note("home", "n3"), null);
  assert.equal(await port.vault.note("home", "nope"), null, "an absent note looks the same as a refused one");
  assert.equal(await code(port.vault.note("other", "n1")), "not_granted", "a vault the grant doesn't name");
  assert.equal(await code(port.vault.query("home", { pathPrefix: "Journal/" })), "out_of_scope", "it may add to the journal, not list it");
  assert.equal(await code(port.vault.query("home", { type: "post" })), "out_of_scope");
  assert.equal(await code(port.vault.query("home", {})), "out_of_scope", "never the whole vault");
  assert.equal(await code(port.vault.query("home", { pathPrefix: "Taste/../Journal/" })), "out_of_scope");
  assert.deepEqual((await port.vault.query("home", { pathPrefix: "Taste/" })).map((n) => n.path), ["Taste/Profile"], "and what a list brings back from outside is dropped");
  assert.deepEqual(calls.filter((c) => c.what === "query").length, 1, "only the one allowed list reached the vault");
});

await check("a type rule covers that type and those beneath it, wherever the note is; a folder rule only that folder", async () => {
  const { be } = shell();
  const post = createAppletPort(grantOf(TOPOST_MANIFEST), be, { home: "plot" });
  assert.deepEqual((await post.vault.query("home", { type: "post" })).map((n) => n.id), ["n3", "n4", "n5"]);
  assert.equal(await code(post.vault.query("home", { type: "journal" })), "out_of_scope");
  assert.equal(await post.vault.note("home", "n2"), null);
  const both = grantOf({ ...base, access: [{ vault: "plot", allow: [{ type: "post", path: "Posts/", verbs: ["read"] }] }] });
  assert.equal(allowsNote(both, "plot", "read", { path: "Posts/First", tags: ["post"] }), true);
  assert.equal(allowsNote(both, "plot", "read", { path: "Elsewhere/Tagged post", tags: ["post"] }), false, "type and folder together: both must hold");
  assert.equal(allowsNote(both, "plot", "read", { path: "Posts/First", tags: null }), false, "a note whose tags didn't come is not of the type");
  assert.equal(allowsNote(both, "plot", "read", { path: "Posts/First", tags: ["postscript"] }), false);
  assert.equal(allowsNote(both, "plot", "update", { path: "Posts/First", tags: ["post"] }), false, "a verb it wasn't given");
  assert.equal(allowsNote(both, "other", "read", { path: "Posts/First", tags: ["post"] }), false);
  assert.equal(allowsQuery(both, "plot", { type: "post" }), false, "a list by type alone would reach past the folder");
  assert.equal(allowsQuery(both, "plot", { type: "post", pathPrefix: "Posts/" }), true);
  assert.equal(allowsQuery(both, "plot", { type: "post", pathPrefix: "Postscripts/" }), false, "a folder that merely starts the same");
});

await check("writing outside the grant is refused: only a journal entry, and every path it could land on must be inside", async () => {
  const { port, calls } = arcadePort();
  const draft = { path: "Journal/2026/11-11/10-00 Answer", alternates: ["Journal/2026/11-11/10-00-05 Answer"], content: "made-up words" };
  assert.deepEqual(await port.vault.create("home", draft, undefined, { saveAnother: true }), { sent: ["x"] });
  assert.deepEqual(calls[0], { what: "create", args: ["plot", draft, undefined, { saveAnother: true }] });
  assert.equal(await code(port.vault.create("home", { path: "Taste/Profile", content: "rewritten" })), "out_of_scope", "it may read Taste/, not write there");
  assert.equal(await code(port.vault.create("home", { path: "Tasks/Do this", content: "x" })), "out_of_scope");
  assert.equal(await code(port.vault.create("home", { path: "Journal/ok", alternates: ["Tasks/sneaky"], content: "x" })), "out_of_scope", "an alternate path outside");
  assert.equal(await code(port.vault.create("home", { path: "Journal/../Tasks/x", content: "x" })), "out_of_scope");
  assert.equal(await code(port.vault.create("other", draft)), "not_granted");
  assert.equal(calls.length, 1, "none of the refused writes reached the shell");
});

await check("own is not fooled by alternates, and a note is judged and written from one copy", async () => {
  const { be, calls } = shell();
  const g = grantOf({ ...base, access: [{ vault: "home", allow: [{ path: "Journal/", verbs: ["create", "read"], own: true }] }] });
  const port = createAppletPort(g, { ...be, note: async (_v, ref) => ({ id: ref, path: ref, tags: [] }) }, { home: "plot" });
  await port.vault.create("home", { path: "Journal/new", alternates: ["Journal/2026/11-11/09-00 Private"], content: "x" });
  assert.equal(await port.vault.note("home", "Journal/2026/11-11/09-00 Private"), null, "naming someone else's entry as an alternate doesn't make it its own");
  assert.equal(await port.vault.note("home", "Journal/new"), null, "where it landed isn't known, so nothing is claimed");
  // a path that reads one way to the check and another to the writer
  let reads = 0;
  const shifty = { get path() { return reads++ ? "Tasks/stolen" : "Journal/ok"; }, content: "x" };
  await port.vault.create("home", shifty);
  assert.equal((calls.filter((c) => c.what === "create").pop()!.args[1] as { path: string }).path, "Journal/ok", "the writer gets the path that was checked");
  assert.equal(await code(port.vault.create("home", { path: "Journal/%2e%2e/Tasks/x", content: "x" })), "out_of_scope", "an encoded segment is never judged as a name");
  const arcade = arcadePort();
  assert.equal(await code(() => arcade.port.open("plot", "Taste/%2e%2e/Journal/x")), "out_of_scope");
});

await check("own: it can read back only the notes it made", async () => {
  const { be } = shell();
  const g = grantOf({ ...base, access: [{ vault: "home", allow: [{ path: "Journal/", verbs: ["create", "read"], own: true }] }] });
  const port = createAppletPort(g, { ...be, note: async (_v, ref) => ({ id: ref, path: ref, tags: [] }) }, { home: "plot" });
  assert.equal(await port.vault.note("home", "Journal/2026/11-11/09-00 Private"), null, "someone else's entry");
  await port.vault.create("home", { path: "Journal/2026/11-11/10-00 Mine", content: "x" });
  assert.equal((await port.vault.note("home", "Journal/2026/11-11/10-00 Mine"))?.path, "Journal/2026/11-11/10-00 Mine");
});

await check("showing a note, and the microphone, need the grant too", async () => {
  const { port, calls } = arcadePort();
  port.open("plot", "Taste/Profile");
  assert.deepEqual(calls, [{ what: "open", args: ["plot", "Taste/Profile"] }]);
  assert.equal(await code(() => port.open("plot", "Journal/2026/11-11/09-00 Private")), "out_of_scope", "it may add journal entries, not open them");
  assert.equal(await code(() => port.open("plot", "Taste/../Journal/x")), "out_of_scope");
  assert.equal(await code(() => port.open("work", "Taste/Profile")), "not_granted");
  port.need("voice");
  const mute = createAppletPort(grantOf({ ...ARCADE_MANIFEST, reach: [] }), shell().be, { home: "plot" });
  assert.equal(await code(() => mute.need("voice")), "not_granted");
  assert.equal(calls.length, 1);
});

await check("a grant that has ended refuses everything, in-flight work included", async () => {
  let live = true;
  const { port, calls } = arcadePort({ live: () => live });
  await port.door("arcade", "home");
  live = false; // revoked, expired, or its screen is gone
  assert.equal(await code(port.door("arcade", "home")), "not_granted");
  assert.equal(await code(port.vault.note("home", "n1")), "not_granted");
  assert.equal(await code(port.vault.create("home", { path: "Journal/x", content: "x" })), "not_granted");
  assert.equal(await code(() => port.open("plot", "Taste/Profile")), "not_granted");
  assert.equal(await code(() => port.need("voice")), "not_granted");
  live = true;
  port.close();
  assert.equal(await code(port.door("arcade", "home")), "not_granted", "closed is for good");
  assert.equal(calls.length, 1);
});

// ── the boundary: a contract 2 applet's own code holds no other way out ──

await check("the Arcade's folder has no way out but the port: no Tauri, no shell command, no network, no microphone, no grant store", () => {
  const root = new URL("../src/arcade/", import.meta.url).pathname;
  const files: string[] = [];
  const walk = (dir: string) => { for (const f of readdirSync(dir)) { const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) files.push(p); } };
  walk(root);
  assert.ok(files.length > 10, "the folder was read");
  const cmds = [...Object.values(DOORS).flatMap((d) => Object.values(d.ops).map((o) => o.cmd)), "journal_save_text", "journal_save_voice", "vault_note", "vault_query"];
  const direct = /@tauri-apps|__TAURI|\binvoke\s*[<(]/;
  // The shell modules the Arcade may import, each for a reason. Anything else that leaves the folder fails here.
  const SHELL = new Map([
    ["src/interface/port.ts", "its port (types only)"],
    ["src/recorderSession.ts", "the shell's recorder: it opens the microphone, after port.need(\"voice\")"],
    ["src/journalCore.ts", "pure: how a journal entry's draft and paths are made"],
  ]);
  const src = new URL("../src/", import.meta.url).pathname;
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const name = f.slice(root.length);
    assert.doesNotMatch(text, direct, `${name} reaches Tauri directly`);
    for (const c of cmds) assert.ok(!text.includes(`"${c}"`) && !text.includes(`'${c}'`), `${name} names the shell command ${c}`);
    assert.doesNotMatch(text, /\bfetch\s*\(|XMLHttpRequest|WebSocket\s*\(|sendBeacon/, `${name} reaches the network directly`);
    assert.doesNotMatch(text, /getUserMedia|MediaRecorder/, `${name} opens the microphone itself`);
    assert.doesNotMatch(text, /uni\.interface\.grants|deviceGrants|createGrantStore/, `${name} touches the grant store`);
    // every form: `from "x"`, a bare `import "x"`, `import("x")`, `require("x")`
    for (const m of text.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*["']([^"']+)["']/g)) {
      const spec = m[1];
      if (!spec.startsWith(".")) continue;
      const target = join(f, "..", spec);
      if (target.startsWith(root)) continue;
      const rel = `src/${target.slice(src.length)}`;
      assert.ok(SHELL.has(rel), `${name} imports ${rel}, which is outside the Arcade and not on the list`);
    }
  }
  // and what it may import holds no command of its own, one import deep (recorderSession's own imports are checked too)
  for (const rel of ["src/recorderSession.ts", "src/journalCore.ts"]) {
    const file = new URL(`../${rel}`, import.meta.url).pathname;
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, direct, `${rel} reaches Tauri: the Arcade must not import it`);
    for (const m of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) assert.doesNotMatch(readFileSync(join(file, "..", m[1]), "utf8"), direct, `${rel} imports ${m[1]}, which reaches Tauri`);
  }
});

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
