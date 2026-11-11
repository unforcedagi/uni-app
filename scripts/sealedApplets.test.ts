// T-335 sealed applets: an interface note tagged `applet` joins the drawer (src/interface/sealedApplet.ts, applets.ts). What is shown, what
// is refused when it opens (a drawer applet has no area and no room: every scope must be explicit), and the grant's key.
// Run: node --experimental-strip-types scripts/sealedApplets.test.ts
import assert from "node:assert/strict";
import { appletHostNeeds, describeAppletNeeds, discoverApplets } from "../src/interface/sealedApplet.ts";
import { BUILT_IN, joinApplets } from "../src/interface/applets.ts";
import { grantKey } from "../src/interface/manifest.ts";
import { restoreTabs, sameTarget, serializeTabs } from "../src/tabs.ts";

const applet = (over: Record<string, unknown> = {}) => ({ contract: 1, id: "seed-list", name: "Seed list", kind: "vault", where: "Seeds folder, in your vault", searches: ["seeds"], ...over });
const iface = (...needs: Record<string, string>[]) => ({ contract: 1, needs });
const note = (id: string, path: string, metadata: unknown, tags: unknown = ["applet"]) => ({ id, path, metadata, ...(tags === null ? {} : { tags }) });
const ROOMS = ["ch-uni", "ch-garden"];

// ── discovery: what the drawer shows ──
{
  const { entries, skipped } = discoverApplets([
    note("n1", "Applets/Seed list", { applet: applet(), interface: iface({ "vault.read": "Seeds/" }, { "vault.read": "Garden/Beds/" }) }),
    note("n2", "Applets/Door", { applet: applet({ id: "mailish", kind: "door" }) }),
    note("n3", "Applets/Fake arcade", { applet: applet({ id: "arcade", name: "Arcade" }) }),
    note("n4", "Applets/Seed list 2", { applet: applet({ name: "Seed list again" }) }),
    note("n5", "Applets/Extra key", { applet: applet({ id: "extra", sneaky: true }) }),
    note("n6", "Applets/Untagged", { applet: applet({ id: "untagged" }) }, ["note"]),
    note("n7", "Applets/No manifest", { interface: iface({ "vault.read": "Seeds/" }) }),
    note("n8", "Applets/Area one", { applet: applet({ id: "area-one", name: "Area one" }), interface: iface({ "vault.read": "area" }) }),
    note("n9", "Applets/No tags", { applet: applet({ id: "no-tags" }) }, null),
  ]);
  assert.deepEqual(entries.map((e) => e.manifest.id), ["area-one", "seed-list"], "valid applet manifests only, by path; an `area` interface is listed (and refused when it opens)");
  assert.equal(skipped, 7, "a door, a built-in's id, a repeated id, an unknown key, an untagged note (or one whose tags didn't come), and a note with no applet manifest are skipped and counted");
  const seed = entries.find((e) => e.manifest.id === "seed-list")!;
  assert.equal(seed.manifest.host, "sealed");
  assert.equal(seed.noteId, "n1");
  assert.deepEqual(seed.prefixes, ["Seeds/", "Garden/Beds/"], "the folders it declares: where search looks while it is open");
  assert.deepEqual(entries.find((e) => e.manifest.id === "area-one")!.prefixes, [], "the symbolic area scope is no folder");
}

// ── the drawer's list: a sealed `recipes` takes the placeholder's slot; the rest follow the built-ins ──
{
  const { entries } = discoverApplets([
    note("r1", "Applets/Recipes", { applet: applet({ id: "recipes", name: "Recipes", glyph: "❀" }), interface: iface({ "vault.read": "Recipes/" }) }),
    note("s1", "Applets/Seed list", { applet: applet(), interface: iface({ "vault.read": "Seeds/" }) }),
  ]);
  const list = joinApplets(BUILT_IN, entries.map((e) => e.manifest));
  const at = BUILT_IN.findIndex((a) => a.id === "recipes");
  assert.equal(list[at].id, "recipes");
  assert.equal(list[at].host, "sealed", "the sealed note replaced the placeholder, in its slot");
  assert.equal(list[at].placeholder, undefined);
  assert.equal(list.filter((a) => a.id === "recipes").length, 1);
  assert.equal(list[list.length - 1].id, "seed-list", "a new applet comes after the built-ins");
  assert.equal(list.length, BUILT_IN.length + 1);
}

// ── opening: what a drawer applet may ask for ──
{
  const ok = appletHostNeeds({ applet: applet(), interface: iface({ "vault.read": "Seeds/" }, { "chat.read": "ch-garden" }, { "chat.draft": "ch-garden" }) }, ROOMS);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.deepEqual(ok.resolved, { "vault.read": ["Seeds/"], "chat.read": ["ch-garden"], "chat.draft": ["ch-garden"] });
    assert.deepEqual(ok.prefixes, ["Seeds/"]);
  }
  const refused = (meta: unknown, why: RegExp, rooms = ROOMS) => {
    const r = appletHostNeeds(meta, rooms);
    assert.equal(r.ok, false, JSON.stringify(meta));
    if (!r.ok) assert.match(r.error, why);
  };
  refused({ applet: applet(), interface: iface({ "vault.read": "area" }) }, /has no area/);
  refused({ applet: applet(), interface: iface({ "vault.read": "Seeds/" }, { "chat.read": "area" }) }, /has no area/);
  refused({ applet: applet(), interface: iface({ "chat.draft": "area" }) }, /has no area/);
  refused({ applet: applet() }, /declares no needs/, ROOMS); // the default needs are all `area`
  refused({ applet: applet(), interface: iface({ "chat.read": "ch-elsewhere" }) }, /room this device doesn't have/);
  refused({ applet: applet(), interface: iface({ "chat.draft": "ch-elsewhere" }) }, /room this device doesn't have/);
  refused({ applet: applet(), interface: iface({ "chat.read": "ch-garden" }) }, /room this device doesn't have/, []);
  refused({ applet: applet({ kind: "door" }), interface: iface({ "vault.read": "Seeds/" }) }, /can't be a door/);
  refused({ applet: applet({ id: "mail" }), interface: iface({ "vault.read": "Seeds/" }) }, /built-in/);
  refused({ interface: iface({ "vault.read": "Seeds/" }) }, /applet manifest is invalid/);
  refused({ applet: applet(), interface: iface({ "vault.read": "Seeds/../Private/" }) }, /bad scope for vault.read/);
  refused({ applet: applet(), interface: iface({ "vault.read": "/" }) }, /bad scope for vault.read/);
  refused({ applet: applet(), interface: { contract: 2, needs: [] } }, /unsupported contract/);
}

// ── the grant: keyed by what the needs resolve to and the note's path ──
{
  const r = (prefix: string) => ({ "vault.read": [prefix] });
  const k = await grantKey(r("Seeds/"), "Applets/Seed list.html");
  assert.equal(k, await grantKey(r("Seeds/"), "Applets/Seed list"), "the extension is not the note");
  assert.notEqual(k, await grantKey(r("Seeds/"), "Applets/Moved seed list"), "a moved note asks again");
  assert.notEqual(k, await grantKey(r("Garden/"), "Applets/Seed list"), "another folder asks again");
}

// ── the prompt's words: a folder at or under its note's own is plain; any other folder, and every room, is stressed ──
{
  const room = (id: string) => (id === "ch-garden" ? "Garden co-op site" : id);
  const needs = [{ cap: "vault.read", scope: "Seeds/" }, { cap: "vault.read", scope: "Seeds/Old/" }, { cap: "vault.read", scope: "Journal/" }, { cap: "chat.read", scope: "ch-garden" }, { cap: "chat.draft", scope: "ch-garden" }] as const;
  const lines = describeAppletNeeds(needs, room, "Seeds/Seed list.html");
  assert.deepEqual(lines.map((l) => l.outside), [false, false, true, true, true]);
  assert.equal(lines[0].text, "Read notes in Seeds/");
  assert.equal(lines[2].text, "Read notes outside this applet's folder, in Journal/");
  assert.equal(lines[3].text, "Read recent messages in #Garden co-op site");
  assert.match(lines[4].text, /^Suggest drafts for #Garden co-op site .*nothing is sent/);
  assert.deepEqual(describeAppletNeeds([needs[0]], room, "Seed list").map((l) => l.outside), [true], "a note at the vault's top owns no folder");
  assert.deepEqual(describeAppletNeeds([needs[0]], room, "Seedsy/App").map((l) => l.outside), [true], "a folder that merely starts the same is not its own");
}

// ── its tab: kept across a restart by id; anything else is dropped ──
{
  const s = { tabs: [{ id: "t1", kind: "applet" as const, applet: "seed-list", title: "Seed list" }], active: "t1", recent: ["t1"] };
  const back = restoreTabs(serializeTabs(s), []);
  assert.equal(back.tabs[0]?.kind, "applet");
  assert.equal(back.tabs[0]?.applet, "seed-list");
  const bad = restoreTabs(serializeTabs({ ...s, tabs: [{ ...s.tabs[0], applet: "../x" }] }), []);
  assert.equal(bad.tabs.length, 0, "an applet tab whose id isn't an applet id is not restored");
  assert.equal(sameTarget({ kind: "applet", applet: "a", title: "A" }, { kind: "applet", applet: "b", title: "A" }), false, "two applets are two places");
}

console.log("sealedApplets: all passed");
