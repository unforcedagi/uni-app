// T-301/T-302: the work model's rules. A project lives in exactly one area and has a folder; a project holds any number of sessions, and
// any number of them may be live; stop and finish change only the session they name; archiving is for projects, and an archived project
// has no live sessions. Then the same rules on the vault's own shapes (workFrom), and the words the room is sent.
import assert from "node:assert/strict";
import { parseArea, parseProject } from "../src/areas/areasCore.ts";
import { buildTree } from "../src/areas/treeCore.ts";
import { privateRunIds } from "../src/areas/treeRooms.ts";
import { ModelError, UNFILED, ago, whyWords, archivePlan, archiveProject, cannotStart, isLive, liveInArea, liveSessions, makeProject, problems, restoreProject, sessionsOf, span, startSession, stateWords, stepSession, stopSession, finishSession, timeline, timelineWindow, type Area, type Work } from "../src/projects/model.ts";
import { HEARD_MS, freshen, plainTitle, plainWords, resultWords, sessionState, workFrom } from "../src/projects/live.ts";
import { actionMessage } from "../src/projects/actions.ts";
import { DASHES, FOLD, HIDDEN, LABEL, PHRASES, REDACT_RULES, answerDraft, askOf, endWords, feedPages, HELD_MAX, labelOk, leftItems, parseFeed, partBefore, redactRaw, safeStep, withHead, withPart, type FeedItem } from "../src/projects/sessionWords.ts";
import { existsSync, readFileSync } from "node:fs";
import { parseRuns } from "../src/areas/steerCore.ts";
import { buildTaskTree, parseNodes } from "../src/areas/taskCore.ts";
import { homedir } from "node:os";
import { join } from "node:path";
import { endWhy } from "../src/projects/live.ts";
import { DEMO_AREAS, demoVault } from "./browser/projectsWorld.ts";
let failed = 0;
const check = (n: string, f: () => void) => { try { f(); console.log("ok  ", n); } catch (e) { failed++; console.log("FAIL", n, e); } };
const NOW = 1_800_000_000_000;
const MIN = 60_000;
const areas: Area[] = [{ id: "a1", name: "Larder", path: "Areas/Larder", room: "r1" }, { id: "a2", name: "Loft", path: "Areas/Loft", room: "r2" }];
const empty = (): Work => ({ areas, projects: [makeProject({ id: "p", area: "a1", name: "Jam labels", folder: "~/jam/labels" }, areas)], sessions: [] });

check("a project lives in exactly one area: a list of areas is refused, even a list of one", () => {
  assert.throws(() => makeProject({ id: "p", area: ["a1", "a2"], name: "Both", folder: "/srv/both" }, areas), ModelError);
  assert.throws(() => makeProject({ id: "p", area: ["a1"], name: "One in a list", folder: "/srv/one" }, areas), /exactly one area/);
});
check("a project's area must exist", () => assert.throws(() => makeProject({ id: "p", area: "nowhere", name: "Lost", folder: "/srv/lost" }, areas), /no area/));
check("a project has a folder: none, empty or relative is refused; absolute or ~/ is kept", () => {
  for (const folder of [undefined, null, "", "   ", "jam/labels", "./labels"]) assert.throws(() => makeProject({ id: "p", area: "a1", name: "Jam", folder }, areas), /needs a folder/, String(folder));
  assert.equal(makeProject({ id: "p", area: "a1", name: "Jam", folder: "/srv/jam" }, areas).folder, "/srv/jam");
  assert.equal(makeProject({ id: "p", area: "a1", name: "Jam", folder: " ~/jam " }, areas).folder, "~/jam");
});
check("the whole model's rules: a project in two areas, in no area or with no folder is named", () => {
  const w = empty();
  const bad: Work = { ...w, projects: [...w.projects, { ...w.projects[0], id: "q", name: "Twice", area: ["a1", "a2"] as unknown as string }, { ...w.projects[0], id: "r", name: "Homeless", area: "gone" }, { ...w.projects[0], id: "s", name: "Floating", folder: "" }] };
  assert.deepEqual(problems(bad), ["Twice lives in more than one area", "Homeless is in no known area", "Floating has no folder"]);
  assert.deepEqual(problems(w), []);
});
check("two areas can't share a room (one area, one room)", () => assert.deepEqual(problems({ ...empty(), areas: [areas[0], { ...areas[1], room: "r1" }] }), ["Loft and Larder share a room"]));
check("many sessions per project, any number live at once; starting one leaves the others as they were", () => {
  let w = startSession(empty(), "p", "Print the labels", NOW, "s1");
  w = finishSession(w, "s1", NOW + MIN, "Printed.");
  w = startSession(w, "p", "Try a second font", NOW + 2 * MIN, "s2");
  w = startSession(w, "p", "Try a third font", NOW + 3 * MIN, "s3");
  w = startSession(w, "p", "And a fourth", NOW + 4 * MIN, "s4");
  assert.deepEqual(liveSessions(w, "p").map((s) => s.id), ["s2", "s3", "s4"]);
  assert.equal(w.sessions.find((s) => s.id === "s1")!.state, "finished");
  assert.equal(liveInArea(w, "a1").length, 3);
  assert.equal(liveInArea(w, "a2").length, 0);
  assert.deepEqual(problems(w), []);
});
check("a session needs a project that exists, something to do, and a project that isn't archived", () => {
  assert.throws(() => startSession(empty(), "nope", "x", NOW, "s"), /no project/);
  assert.throws(() => startSession(empty(), "p", "  ", NOW, "s"), /something to do/);
  const archived = { ...empty(), projects: [{ ...empty().projects[0], status: "archived" as const }] };
  assert.throws(() => startSession(archived, "p", "x", NOW, "s"), /archived/);
  assert.match(cannotStart(archived.projects[0]) ?? "", /bring it back/);
  assert.equal(cannotStart(empty().projects[0]), null);
});
check("stop changes only the session it names, and only a live one", () => {
  let w = startSession(startSession(empty(), "p", "One", NOW, "s1"), "p", "Two", NOW, "s2");
  w = stopSession(w, "s1", NOW + MIN);
  assert.equal(w.sessions[0].state, "stopped"); assert.equal(w.sessions[0].endedAt, NOW + MIN);
  assert.ok(isLive(w.sessions[1]));
  const again = stopSession(w, "s1", NOW + 9 * MIN);
  assert.equal(again.sessions[0].endedAt, NOW + MIN);
  assert.throws(() => stopSession(w, "ghost", NOW), /no session/);
});
check("archive is for projects: refused while sessions are live (stop them first), then kept with its folder and history, and can come back", () => {
  let w = startSession(startSession(empty(), "p", "One", NOW, "s1"), "p", "Two", NOW + MIN, "s2");
  assert.deepEqual(archivePlan(w, "p").stopFirst.map((s) => s.id), ["s1", "s2"]);
  assert.throws(() => archiveProject(w, "p"), /stop its 2 live sessions first/);
  w = stopSession(stopSession(w, "s1", NOW + 2 * MIN), "s2", NOW + 2 * MIN);
  const a = archiveProject(w, "p");
  assert.equal(a.projects[0].status, "archived"); assert.equal(a.projects[0].folder, "~/jam/labels");
  assert.deepEqual(sessionsOf(a, "p").map((s) => s.id).sort(), ["s1", "s2"], "the history stays");
  assert.deepEqual(problems(a), []);
  assert.deepEqual(problems({ ...a, sessions: [...a.sessions, { ...a.sessions[0], id: "s3", state: "running", endedAt: null }] }), ["Jam labels is archived but has live sessions"]);
  assert.equal(restoreProject(a, "p").projects[0].status, "active");
});
check("a project's sessions read live first (newest first), then the rest by when they ended", () => {
  let w = startSession(empty(), "p", "Old", NOW, "old");
  w = finishSession(w, "old", NOW + MIN, "ok");
  w = startSession(w, "p", "Stopped", NOW + 2 * MIN, "stp");
  w = stopSession(w, "stp", NOW + 3 * MIN);
  w = startSession(w, "p", "Live A", NOW + 4 * MIN, "la");
  w = startSession(w, "p", "Live B", NOW + 5 * MIN, "lb");
  assert.deepEqual(sessionsOf(w, "p").map((s) => s.id), ["lb", "la", "stp", "old"]);
});
check("a live session's step changes its one line and counts; a stopped one takes no step", () => {
  let w = startSession(empty(), "p", "Go", NOW, "s");
  w = stepSession(w, "s", "Reading the folder.", NOW + MIN);
  assert.equal(w.sessions[0].now, "Reading the folder."); assert.equal(w.sessions[0].steps, 1);
  w = stopSession(w, "s", NOW + 2 * MIN);
  const after = stepSession(w, "s", "Sneaking on.", NOW + 3 * MIN);
  assert.equal(after.sessions[0].now, "Reading the folder."); assert.equal(after.sessions[0].steps, 1);
});
check("states are said in words, never ids", () => {
  let w = startSession(empty(), "p", "Go", NOW, "s");
  assert.equal(stateWords(w.sessions[0], NOW + 49 * MIN), "Working · 49 min");
  w = finishSession(w, "s", NOW + 50 * MIN, "Done.");
  assert.equal(stateWords(w.sessions[0], NOW + 50 * MIN + 3 * 86_400_000), "Finished 3 days ago");
  assert.equal(stateWords({ ...w.sessions[0], state: "waiting" }, NOW + 60 * MIN), "Needs you · ended 10 min ago");
  assert.equal(ago(10_000), "just now"); assert.equal(ago(5 * MIN), "5 min ago");
  assert.equal(span(70 * MIN), "1 h 10 min"); assert.equal(span(5 * 60 * MIN + 10 * MIN), "5 h"); assert.equal(span(23 * 60 * MIN + 40 * MIN), "1 day"); assert.equal(span(20_000), "just now");
});
check("the timeline places runs and talk inside its window, and clips what falls outside", () => {
  let w = startSession(empty(), "p", "Go", NOW - 60 * MIN, "s");
  w = startSession(w, "p", "Long ago", NOW - 9 * 86_400_000, "old");
  w = finishSession(w, "old", NOW - 9 * 86_400_000 + MIN, "ok");
  const win = timelineWindow(w.sessions, NOW);
  assert.equal(win.from, NOW - 8 * 60 * MIN, "a session ran in the last 8 hours: the window is those hours");
  const t = timeline(w.sessions, [NOW - 30 * MIN, NOW - 20 * 86_400_000], win.from, win.to);
  assert.deepEqual(t.runs.map((r) => r.id), ["s"]);
  assert.ok(Math.abs(t.runs[0].x - 7 / 8) < 1e-9 && Math.abs(t.runs[0].x + t.runs[0].w - 1) < 1e-9 && t.runs[0].live);
  assert.equal(t.talk.length, 1);
  const busy = startSession(startSession(w, "p", "Beside it", NOW - 30 * MIN, "b"), "p", "After", NOW - 5 * MIN, "c");
  const both = timeline(stopSession(busy, "b", NOW - 10 * MIN).sessions, [], win.from, win.to).runs;
  assert.deepEqual(both.map((r) => [r.id, r.lane]), [["s", 0], ["b", 1], ["c", 1]], "runs at the same time get lanes; a lane is reused once free");
  const quiet = timelineWindow([w.sessions[1]], NOW);
  assert.equal(quiet.from, NOW - 96 * 60 * MIN, "nothing recent: back to the latest session, at most 4 days");
});
// ------------------------------------------------------------------------------------------ the vault's own shapes (T-302)
const vault = demoVault(NOW);
const live = workFrom({ nodes: vault.nodes, runs: vault.runs, tasks: vault.tasks }, NOW);
const P = (name: string) => live.projects.find((p) => p.name === name)!;
const S = (id: string) => live.sessions.find((s) => s.id === id)!;
check("the made-up world holds every rule: seven areas, seven rooms, live sessions in more than one area", () => {
  assert.deepEqual(problems(live), []);
  assert.equal(live.areas.length, 7); assert.equal(new Set(live.areas.map((a) => a.room)).size, 7);
  assert.equal(DEMO_AREAS.length, 7);
  assert.ok(live.areas.filter((a) => liveInArea(live, a.id).length > 0).length >= 2);
});
check("from the vault: a project's one area is up its parent chain; a link to another area doesn't put it there too", () => {
  assert.equal(P("Riverbend co-op site").area, "area-workshop");
  assert.equal(P("Co-op kiosk").area, "area-workshop", "a project under a project lives in its parent's area");
  assert.equal(projectsInArea("area-town").includes("Riverbend co-op site"), false);
  const moved = workFrom({ nodes: vault.nodes.map((n) => (n.id === "p-coop" ? { ...n, metadata: { ...n.metadata, parent: "nowhere" } } : n)), runs: [], tasks: [] }, NOW);
  assert.ok(!moved.projects.some((p) => p.id === "p-coop") && moved.gaps.some((g) => g.name === "Riverbend co-op site" && g.why === "no area"), "no area: a gap, not a project");
});
function projectsInArea(area: string) { return live.projects.filter((p) => p.area === area).map((p) => p.name); }
check("from the vault: a project without a folder is a gap, named, never a project (an archived one isn't a gap)", () => {
  assert.ok(!live.projects.some((p) => p.name === "Shop signs"));
  assert.deepEqual(live.gaps, [{ name: "Shop signs", area: "area-workshop", areaPath: "Areas/Workshop", why: "no folder" }]);
  assert.equal(P("Nightly backups").folder, "~/ops/backups", "the repo field stands in for a folder");
  const relative = workFrom({ nodes: vault.nodes.map((n) => (n.id === "p-seeds" ? { ...n, metadata: { ...n.metadata, folder: "seed-library" } } : n)), runs: [], tasks: [] }, NOW);
  assert.ok(relative.gaps.some((g) => g.name === "Seed library catalogue"), "a relative folder is no folder");
  assert.equal(P("Old zine archive").status, "archived"); assert.equal(P("Co-op kiosk").status, "resting");
});
check("from the vault: many sessions on one project, any number live; a run finds its project by node, task or folder", () => {
  assert.deepEqual(liveSessions(live, "p-coop").map((s) => s.id).sort(), ["run-donate", "run-events"]);
  assert.equal(S("run-mail").project, "p-mail", "filed on the area, run in the project's folder");
  assert.equal(S("run-restore").project, "p-backups", "through its task's node");
  const loose = live.sessions.find((s) => s.id === "run-loose");
  assert.ok(loose, "on an area, in no project's folder: still a session");
  assert.equal(live.projects.find((p) => p.id === loose.project)?.kind, "home", "not under a project: under its area's home");
  const twoFolders = workFrom({ nodes: [...vault.nodes, { ...vault.nodes.find((n) => n.id === "p-mail")!, id: "p-mail2", path: "Projects/Mail again" }], runs: vault.runs, tasks: vault.tasks }, NOW);
  const shared = twoFolders.sessions.find((s) => s.id === "run-mail")!;
  assert.equal(shared.project, "home:area-engine", "a folder two projects share names neither: the session waits in their area's home");
});
check("from the vault: a session says what it is doing in words, its steps, and what it left; never a task number or a run id", () => {
  const ev = S("run-events");
  assert.equal(ev.ask, "Make the events page read like a noticeboard", "a run titled only by its task takes the task's words");
  assert.equal(ev.now, "Running npx"); assert.equal(ev.steps, 31); assert.equal(ev.endedAt, null);
  assert.equal(S("run-about").result, "Left ABOUT.md."); assert.equal(S("run-about").video, "https://example.com/walkthrough/about-page");
  assert.equal(S("run-restore").result, "Left a commit.");
  assert.equal(S("run-handbook").result, "Says it finished; nothing it left could be checked yet.");
  assert.equal(S("run-donate-old").state, "stopped", "stopped by hand: stopped, not failed"); assert.equal(S("run-donate-old").ask, "Try a donate button");
  assert.equal(S("run-catalogue").state, "waiting"); assert.equal(S("run-catalogue").result, null);
  const words = live.sessions.flatMap((s) => [s.ask, s.now ?? "", s.result ?? "", stateWords(s, NOW)]).join("\n");
  assert.doesNotMatch(words, /\bT-\d+|\bmts\b|\b[a-z]{4}[a-z0-9]{4}\b:|run-|\bresume\b/);
  assert.equal(plainTitle("T-302 (2)"), ""); assert.equal(plainTitle("T-288 (resume hsb0mug1)"), ""); assert.equal(plainTitle("LVB week 9 page + homework"), "LVB week 9 page + homework");
  assert.equal(resultWords("mts abcd1234: failed", "failed"), null);
  assert.equal(resultWords("closed by T-302 tidy: unit gone", "failed"), "Its worker was gone; closed when the old runs were tidied.");
  assert.equal(sessionState("lost"), "failed", "a run closed because its worker was gone didn't finish");
});
check("no run is ever invisible: its project, else its area (node, task's node, room id, room name), else Unfiled", () => {
  const at = new Date(NOW - 30 * MIN).toISOString();
  const r = (id: string, md: Record<string, unknown>) => ({ id, path: `Runs/2026-10-20 ${id}`, tags: ["run"], createdAt: at, updatedAt: at, metadata: { state: "running", started_at: at, doing_at: at, ...md } });
  const tasks = [...vault.tasks, { id: "t-area", path: "Tasks/T-950 An umbrella on the area", tags: ["task"], metadata: { node: "area-guild" } }];
  const runs = [
    r("on-project", { node: "p-mail", channel: "demo-guild" }),
    r("on-area", { node: "area-guild" }),
    r("via-task", { node: "gone", task: "T-950" }),
    r("via-channel", { node: "gone", channel: "demo-town" }),
    r("via-starter", { node: "gone", starter_channel: "demo-desk" }),
    r("via-room", { node: "gone", room: "engine-room" }),
    r("via-hash-room", { node: "gone", room: "#town-hall" }),
    r("via-root", { node: "node-uni", room: "guild" }),
    r("nowhere", { node: "gone", room: "long-gone" }),
    r("bare", {}),
  ];
  const w = workFrom({ nodes: vault.nodes, runs, tasks }, NOW);
  assert.deepEqual(w.sessions.map((s) => s.id).sort(), runs.map((x) => x.id).sort(), "every run note is a session");
  assert.deepEqual(problems(w), []);
  const home = (id: string) => w.projects.find((p) => p.id === w.sessions.find((s) => s.id === id)!.project)!;
  assert.equal(home("on-project").name, "Mail move", "a project wins");
  assert.equal(home("on-project").kind ?? "project", "project");
  for (const [id, area] of [["on-area", "area-guild"], ["via-task", "area-guild"], ["via-channel", "area-town"], ["via-starter", "area-desk"], ["via-room", "area-engine"], ["via-hash-room", "area-town"], ["via-root", "area-guild"]] as const) {
    assert.equal(home(id).kind, "home", id);
    assert.equal(home(id).area, area, id);
  }
  for (const id of ["nowhere", "bare"]) assert.equal(home(id).id, UNFILED, id);
  assert.equal(liveInArea(w, "area-guild").length, 3, "the home's working mark counts them");
  assert.deepEqual(liveSessions(w, UNFILED).map((s) => s.id).sort(), ["bare", "nowhere"]);
  assert.deepEqual(w.projects.filter((p) => p.kind !== "home").map((p) => p.id), workFrom({ nodes: vault.nodes, runs: [], tasks: [] }, NOW).projects.map((p) => p.id), "a home is made only for sessions, and makes no project");
});
{
  // every shape a private run can take, each from the independent review of this change: the private clue wins over any public one
  const at = new Date(NOW - 30 * MIN).toISOString();
  const note = (id: string, path: string, tags: string[], metadata: Record<string, unknown>) => ({ id, path, tags, metadata, createdAt: at, updatedAt: at });
  const privateNodes = [
    // its room's name is an ordinary word, as a real one is: only the area's name says private
    note("area-sanctum", "Areas/Sanctum", ["node", "area"], { channel: "demo-sanctum", room: "stillwater", rooms: "stillwater, stillwater-letters", room_was: "old-stillwater", parent: "node-uni" }),
    note("p-vow", "Projects/Quiet vow", ["node", "project"], { parent: "area-sanctum", folder: "~/quiet/vow", channel: "demo-vow", room: "quiet-vow", room_was: "older-vow" }),
    note("p-linked", "Projects/Linked letter", ["node", "project"], { links: ["area-sanctum"], folder: "~/quiet/letter" }),
    note("n-child", "Areas/Sanctum/A note beneath", ["node"], { parent: "area-sanctum" }),
    note("p-shared-a", "Projects/Shared public", ["node", "project"], { parent: "area-guild", folder: "~/both/here" }),
    note("p-shared-b", "Projects/Shared private", ["node", "project"], { parent: "area-sanctum", folder: "~/both/here" }),
  ];
  const nodes = [...vault.nodes, ...privateNodes];
  const tasks = [...vault.tasks, note("t-private", "Tasks/T-960 A private ask", ["task"], { node: "n-child" }), note("t-public", "Tasks/T-961 A public ask", ["task"], { node: "area-guild" })];
  const run = (id: string, md: Record<string, unknown>) => note(id, "Runs/2026-10-20 Words of a session", ["run"], { state: "running", started_at: at, doing_at: at, doing_now: "Reading the secret letter", feed: "feed-secret", ...md });
  const SHAPES: [string, Record<string, unknown>][] = [
    ["public channel, private room", { node: "node-uni", room: "sanctum", channel: "demo-guild" }],
    ["public area node, private room", { node: "area-guild", room: "sanctum" }],
    ["public area node, private channel", { node: "area-guild", channel: "demo-sanctum" }],
    ["public task, private starter room", { node: "gone", task: "T-961", starter_room: "sanctum" }],
    ["public area node, private starter channel", { node: "area-guild", starter_channel: "demo-sanctum" }],
    ["slash room", { node: "gone", room: "sanctum/build" }],
    ["comma room, private first", { node: "gone", room: "sanctum, guild" }],
    ["comma room, private last", { node: "gone", room: "other, sanctum" }],
    ["list room", { node: "gone", room: ["sanctum"] }],
    ["list channel", { node: "gone", channel: ["demo-sanctum"] }],
    ["hash room", { node: "gone", room: "#Sanctum" }],
    ["the private room by its ordinary name", { node: "area-guild", room: "stillwater" }],
    ["its sub-room, on a public node", { node: "area-guild", room: "stillwater/build" }],
    ["its sub-room, on the root", { node: "node-uni", room: "stillwater/build" }],
    ["its name with a note after it", { node: "area-guild", room: "stillwater (old)" }],
    ["another of its rooms", { node: "area-guild", room: "stillwater-letters" }],
    ["its old name", { node: "area-guild", room: "old-stillwater" }],
    ["a private project's old room, on a public node", { node: "area-guild", room: "older-vow" }],
    ["a private project's old room, on the root", { node: "node-uni", room: "older-vow" }],
    ["a task on the private area, a public node and room", { node: "area-guild", task: "T-960", room: "guild", channel: "demo-guild" }],
    ["a private project named, on the root", { node: "node-uni", project: "p-vow" }],
    ["a hand-written reference under the private area", { node: "[[Areas/Sanctum/Gone|x]]" }],
    ["a folder of a private project, on the root", { node: "node-uni", folder: "~/quiet/vow" }],
    ["child node of the private area", { node: "n-child" }],
    ["task on a child of the private area", { node: "gone", task: "T-960" }],
    ["a room a private project owns", { node: "gone", channel: "demo-vow" }],
    ["a room a private project owns, by name", { node: "gone", room: "quiet-vow" }],
    ["project linked to the private area", { node: "p-linked" }],
    ["a folder shared with a private project", { node: "gone", folder: "~/both/here" }],
  ];
  for (const [what, md] of SHAPES) check(`a private run stays in its place: ${what}`, () => {
    const r = run("r-private", md);
    const w = workFrom({ nodes, runs: [r], tasks }, NOW);
    const s = w.sessions.find((x) => x.id === "r-private")!;
    assert.equal(w.projects.find((p) => p.id === s.project)!.area, "area-sanctum", "in the private area, never a public place");
    assert.equal(s.ask, "Words of a session", "and its words are shown there, inside the place");
  });
  // with no private area to go to (only the clues that name it can be read): counted in Unfiled, none of its words
  for (const [what, md] of SHAPES.filter(([, m]) => /sanctum/i.test(String(m.room)))) check(`a private run with no private area keeps its words to itself: ${what}`, () => {
    const summary = { summary: "mts abcd1234: completed, evidence: file ~/quiet/letter-to-someone.md", video: "https://example.com/secret" };
    const s = workFrom({ nodes: vault.nodes, runs: [run("r-private", { ...md, ...summary })], tasks }, NOW).sessions.find((x) => x.id === "r-private")!;
    assert.equal(s.project, UNFILED);
    assert.equal(s.ask, "A session in a private place");
    assert.deepEqual([s.now, s.result, s.feed, s.video, s.end], [null, null, null, null, null]);
  });
  check("a private project keeps its own run, and a public run with no private clue is untouched", () => {
    const w = workFrom({ nodes, runs: [run("r-vow", { node: "p-vow", room: "sanctum" }), run("r-pub", { node: "p-mail", room: "guild", channel: "demo-guild" })], tasks }, NOW);
    assert.equal(w.sessions.find((s) => s.id === "r-vow")!.project, "p-vow");
    assert.equal(w.sessions.find((s) => s.id === "r-pub")!.project, "p-mail");
  });
  check("a public project's run launched from a private room goes with the room, not the project", () => {
    const s = workFrom({ nodes, runs: [run("r-from", { node: "p-mail", room: "sanctum" })], tasks }, NOW).sessions[0];
    assert.equal(s.project, "home:area-sanctum");
  });
  check("an archived area has no door, so no home goes under it: its sessions show in Unfiled", () => {
    const shut = nodes.map((n) => (n.id === "area-guild" ? { ...n, metadata: { ...n.metadata, status: "archived" } } : n));
    const s = workFrom({ nodes: shut, runs: [run("r-shut", { node: "area-guild" })], tasks }, NOW).sessions[0];
    assert.equal(s.project, UNFILED);
  });
  check("the one rule: the lists and the sessions agree, and before the areas are read any run naming a room waits", () => {
    const list = nodes.flatMap((n) => { const a = parseArea(n as never) ?? parseProject(n as never); return a ? [a] : []; });
    const t = buildTree(list);
    const shaped = (id: string, node: string, m: Record<string, unknown>) => ({ id, node, task: (m.task as string) ?? null, rooms: [m.room].filter(Boolean), project: (m.project as string) ?? null, folder: (m.folder as string) ?? null });
    const rows = [shaped("sub", "Areas/Guild", { room: "stillwater/build" }), shaped("task", "Areas/Guild", { task: "T-960", room: "guild" }), shaped("done", "Projects/Quiet vow", {}), shaped("named", "", { project: "p-vow" }), shaped("pub", "Areas/Guild", { room: "guild" })];
    assert.deepEqual([...privateRunIds(t, rows, new Map([["T-960", "Areas/Sanctum/A note beneath"]]), [], null)].sort(), ["done", "named", "sub", "task"], "the public one stays listed");
    assert.deepEqual([...privateRunIds(null, rows, new Map(), [], null)].sort(), ["pub", "sub", "task"], "with no tree, any room clue waits");
  });
  check("a note holding only a room's id: the account's rooms say what it is, for a sub-room, an old name and a room only a private project names", () => {
    const withRoomOnly = [...nodes, note("p-roomonly", "Projects/Room only", ["node", "project"], { parent: "area-sanctum", room: "room-only-vow", folder: "~/quiet/only" })];
    const rooms = [{ id: "hub-sub", name: "stillwater/build" }, { id: "hub-old", name: "old-stillwater" }, { id: "hub-only", name: "room-only-vow" }, { id: "hub-guild", name: "guild" }];
    const placed = (channel: string) => { const w = workFrom({ nodes: withRoomOnly, runs: [run("r-id", { node: "node-uni", channel, starter_room: "uni" })], tasks, rooms }, NOW); return w.projects.find((p) => p.id === w.sessions[0].project)!.area; };
    for (const c of ["hub-sub", "hub-old", "hub-only"]) assert.equal(placed(c), "area-sanctum", c);
    assert.equal(placed("hub-guild"), "area-guild", "and a public room's id places it in its area");
  });
  check("a note holding an id no note names waits, with no words, until the rooms are read; with a name or a known id it doesn't wait", () => {
    const place = (md: Record<string, unknown>, rooms?: { id: string; name: string }[]) => workFrom({ nodes, runs: [run("r-w", md)], tasks, rooms }, NOW).sessions[0];
    const waiting = place({ node: "area-guild", channel: "hub-who", starter_room: "uni" });
    assert.deepEqual([waiting.project, waiting.ask, waiting.now, waiting.feed], [UNFILED, "A session whose room isn't read yet", null, null]);
    assert.equal(place({ node: "area-guild", channel: "hub-who" }, [{ id: "hub-who", name: "guild" }]).project, "home:area-guild", "the rooms read: placed");
    assert.equal(place({ node: "area-guild", channel: "demo-guild" }).project, "home:area-guild", "an id a note names needs no rooms");
    assert.equal(place({ node: "area-guild", channel: "hub-who", room: "guild" }).project, UNFILED, "a name beside it says nothing of the id: a launcher can name one room and hold another's");
    assert.equal(place({ node: "area-guild", channel: "hub-who", room: "guild" }, [{ id: "hub-who", name: "guild" }]).project, "home:area-guild", "the rooms read: placed");
    assert.equal(place({ node: "area-guild", room: "guild" }).project, "home:area-guild", "no id, nothing to wait for");
  });
  check("an answer read before the rooms arrived isn't kept once they have", () => {
    const list = nodes.flatMap((n) => { const a = parseArea(n as never) ?? parseProject(n as never); return a ? [a] : []; });
    const t = buildTree(list);
    const row = [{ id: "by-id", node: "", task: null, rooms: ["hub-sub"] }];
    assert.deepEqual([...privateRunIds(t, row, new Map(), [], null)], [], "with no rooms, an id says nothing");
    assert.deepEqual([...privateRunIds(t, row, new Map(), [{ id: "hub-sub", name: "stillwater/build" }], null)], ["by-id"], "the same tree, the rooms here: private");
  });
  check("before the tasks are read, a run naming a task waits", () => {
    const list = nodes.flatMap((n) => { const a = parseArea(n as never) ?? parseProject(n as never); return a ? [a] : []; });
    const rows = [{ id: "tasked", node: "Areas/Guild", task: "T-960", rooms: ["guild"] }, { id: "free", node: "Areas/Guild", task: null, rooms: ["guild"] }];
    assert.deepEqual([...privateRunIds(buildTree(list), rows, new Map(), [], null, false)], ["tasked"]);
  });
  check("a run on a public project keeps its project when only a shared folder could say otherwise", () => {
    const w = workFrom({ nodes, runs: [run("r-shared", { node: "p-shared-a", folder: "~/both/here" })], tasks }, NOW);
    assert.equal(w.sessions[0].project, "p-shared-a");
  });
  check("a public name a private project also goes by doesn't make the public room private", () => {
    const shared = nodes.map((n) => (n.id === "p-vow" ? { ...n, metadata: { ...n.metadata, room_was: "guild" } } : n));
    assert.equal(workFrom({ nodes: shared, runs: [run("r-g", { node: "gone", room: "guild" })], tasks }, NOW).sessions[0].project, "home:area-guild");
  });
  check("a project under an archived area has no door: its run is shown from Unfiled instead", () => {
    const shut = nodes.map((n) => (n.id === "area-guild" ? { ...n, metadata: { ...n.metadata, status: "archived" } } : n));
    assert.equal(workFrom({ nodes: shut, runs: [run("r-shut-p", { node: "p-handbook" })], tasks }, NOW).sessions[0].project, UNFILED);
  });
  check("odd notes never throw", () => {
    const odd = [...nodes, { id: 7, path: 9, tags: "x", metadata: "y" }, { id: "n", path: "Projects/Odd", tags: null, metadata: null }, { path: null }] as never[];
    assert.ok(workFrom({ nodes: odd, runs: [run("r-odd", { node: 12, room: { a: 1 }, channel: 3 } as never)], tasks }, NOW).sessions.length === 1);
  });
  check("a project's own older room still says its area", () => {
    const owned = nodes.map((n) => (n.id === "p-mail" ? { ...n, metadata: { ...n.metadata, channel: "demo-mail", room: "mail-room" } } : n));
    assert.equal(workFrom({ nodes: owned, runs: [run("r-old-room", { node: "gone", room: "mail-room" })], tasks }, NOW).sessions[0].project, "home:area-engine");
  });
  check("a note with no start time still shows: when the note was made", () => {
    const { started_at: _, ...md } = run("r-nostart", { node: "area-guild" }).metadata;
    const s = workFrom({ nodes, runs: [{ ...run("r-nostart", {}), metadata: md }], tasks }, NOW).sessions[0];
    assert.equal(s.startedAt, Date.parse(at));
  });
}
check("a note that still says running but hasn't been heard from for hours is silent, not working (and has an end: when it was last heard)", () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString();
  const base = vault.runs.find((r) => r.id === "run-events")!;
  const runs = [
    { ...base, id: "r-heard", metadata: { ...base.metadata, doing_at: at(HEARD_MS - MIN) } },
    { ...base, id: "r-quiet", metadata: { ...base.metadata, doing_at: at(HEARD_MS + MIN) } },
    { ...base, id: "r-new", metadata: { ...base.metadata, doing_at: undefined, started_at: at(60 * MIN) } },
    { ...base, id: "r-old", metadata: { ...base.metadata, doing_at: undefined, started_at: at(11 * 86_400_000) } },
  ];
  const w = workFrom({ nodes: vault.nodes, runs, tasks: vault.tasks }, NOW);
  const st = (id: string) => w.sessions.find((s) => s.id === id)!;
  assert.deepEqual(["r-heard", "r-quiet", "r-new", "r-old"].map((id) => st(id).state), ["running", "silent", "running", "silent"]);
  assert.equal(st("r-quiet").endedAt, NOW - HEARD_MS - MIN); assert.equal(st("r-old").endedAt, NOW - 11 * 86_400_000);
  assert.deepEqual(liveSessions(w, "p-coop").map((s) => s.id).sort(), ["r-heard", "r-new"]);
  assert.deepEqual(problems(w), []);
  assert.equal(stateWords(st("r-old"), NOW), "Silent · last heard 11 days ago");
});
check("round 3: a saved copy ages by the clock: freshen makes a session no one has heard from silent, and leaves the rest as they were", () => {
  const saved = JSON.parse(JSON.stringify(live));
  assert.equal(freshen(saved, NOW), saved, "nothing to change: the same object");
  const later = freshen(saved, NOW + HEARD_MS);
  assert.deepEqual(liveSessions(later, "p-coop"), [], "both co-op sessions were heard 1-2 min before NOW: silent at NOW + 2 h");
  const ev = later.sessions.find((s: { id: string }) => s.id === "run-events")!;
  assert.equal(ev.state, "silent"); assert.equal(ev.endedAt, S("run-events").nowAt);
  assert.equal(later.sessions.find((s: { id: string }) => s.id === "run-about")!.state, "finished");
  assert.deepEqual(problems(later), []);
});
check("a room's own words lose their task numbers on screen", () => {
  assert.equal(plainWords("T-265 civic data layer in fix pass; Commons app (T-257) paused."), "Civic data layer in fix pass; Commons app paused.");
  assert.equal(plainWords("Nothing to strip here."), "Nothing to strip here.");
});
check("review fixes: a folder matches however it is spelled; a [[link]] parent is followed; a worker's line loses its task numbers", () => {
  const base = vault.runs.find((r) => r.id === "run-mail")!;
  const runs = [{ ...base, metadata: { ...base.metadata, folder: "/home/someone/ops/mail-move/", doing_now: "T-903 checking the copy" } }];
  const nodes = vault.nodes.map((n) => (n.id === "p-kiosk" ? { ...n, metadata: { ...n.metadata, parent: "[[Projects/Riverbend co-op site]]" } } : n));
  const part = { ...vault.nodes[0], id: "n-part", path: "Projects/Co-op kiosk/Screens", tags: ["node"], metadata: { parent: "[[Projects/Co-op kiosk]]" } };
  const w = workFrom({ nodes: [...nodes, part], runs: [...runs, { ...base, id: "run-kiosk-part", metadata: { ...base.metadata, node: "n-part", folder: undefined } }], tasks: [] }, NOW);
  assert.equal(w.sessions.find((s) => s.id === "run-mail")?.project, "p-mail");
  // T-304 (allowlist): what it is doing is shown only as a step phrase; free words (with or without a task number) are not
  assert.equal(w.sessions.find((s) => s.id === "run-mail")?.now, "A step");
  assert.equal(w.projects.find((p) => p.id === "p-kiosk")?.area, "area-workshop");
  assert.equal(w.sessions.find((s) => s.id === "run-kiosk-part")?.project, "p-kiosk");
});
check("review finding 7: an area note with no room keeps its projects named, as gaps under that area", () => {
  const nodes = vault.nodes.map((n) => (n.id === "area-engine" ? { ...n, metadata: { ...n.metadata, channel: undefined } } : n));
  const w = workFrom({ nodes, runs: [], tasks: [] }, NOW);
  assert.equal(w.areas.some((a) => a.path === "Areas/Engine Room"), false);
  assert.deepEqual(w.gaps.filter((g) => g.areaPath === "Areas/Engine Room").map((g) => [g.name, g.why]), [["Mail move", "area has no room"], ["Nightly backups", "area has no room"]]);
  assert.deepEqual(problems(w), []);
});
check("round 2: why a session started, from its run note: a fresh start of an earlier one, a pick-up, or one beside others", () => {
  const don = S("run-donate");
  assert.deepEqual(don.why, { kind: "fresh", of: "run-donate-old" });
  assert.equal(whyWords(don, live.sessions), "A fresh start of “Try a donate button”, with a handoff");
  assert.equal(S("run-events").why, null, "the first one working says nothing");
  const base = vault.runs.find((r) => r.id === "run-events")!;
  const at = (min: number) => new Date(NOW - min * MIN).toISOString();
  const runs = [
    { ...base, id: "r-a", metadata: { ...base.metadata, started_at: at(50), doing_at: at(1) } },
    { ...base, id: "r-b", metadata: { ...base.metadata, started_at: at(40), doing_at: at(1) } },
    { ...base, id: "r-c", metadata: { ...base.metadata, started_at: at(30), doing_at: at(1) } },
    { ...base, id: "r-d", path: "Runs/2026-10-20 Pick it up (resume abcd1234)", metadata: { ...base.metadata, started_at: at(20), doing_at: at(1) } },
    { ...base, id: "r-e", metadata: { ...base.metadata, attempt: "abcd1234", state: "failed", started_at: at(90), ended_at: at(60) } },
  ];
  const w = workFrom({ nodes: vault.nodes, runs, tasks: vault.tasks }, NOW);
  const st = (id: string) => w.sessions.find((x) => x.id === id)!;
  assert.deepEqual([st("r-a").why, st("r-b").why, st("r-c").why], [null, { kind: "alongside", others: 1 }, { kind: "alongside", others: 2 }]);
  assert.equal(whyWords(st("r-c"), w.sessions), "Started alongside 2 other sessions working here");
  assert.deepEqual(st("r-d").why, { kind: "resume", of: "r-e" });
  assert.match(whyWords(st("r-d"), w.sessions)!, /^Picks up where “.+” stopped$/);
  assert.doesNotMatch(w.sessions.map((x) => whyWords(x, w.sessions) ?? "").join(" "), /abcd1234|r-[a-e]\b/);
});
check("the room is sent plain words: the project, the session's line and when it started; never an id", () => {
  const coop = P("Riverbend co-op site"), ev = S("run-events");
  const stop = actionMessage({ kind: "stop", project: coop, session: ev }, NOW);
  assert.match(stop, /^Stop the session on “Make the events page read like a noticeboard” \(started .+\) on Riverbend co-op site\.$/);
  assert.match(actionMessage({ kind: "fresh", project: coop, session: ev }, NOW), /^Fresh start on Riverbend co-op site: end the session on “Make the events page.*” \(started .+\) and start a new session on the same project, with a short handoff/);
  assert.equal(actionMessage({ kind: "add", project: coop, ask: " Print  the\nposter " }, NOW), "Add a session on Riverbend co-op site, in ~/work/riverbend-site, alongside any already running: Print the poster");
  assert.equal(actionMessage({ kind: "archive", project: coop, live: liveSessions(live, coop.id) }, NOW), "Archive the project Riverbend co-op site. It has 2 live sessions: stop them first. Keep its folder and its history.");
  assert.equal(actionMessage({ kind: "archive", project: P("Seed library catalogue"), live: [] }, NOW), "Archive the project Seed library catalogue. Keep its folder and its history.");
  assert.equal(actionMessage({ kind: "restore", project: P("Old zine archive") }, NOW), "Bring back the project Old zine archive from the archive.");
  for (const s of live.sessions) assert.ok(!actionMessage({ kind: "stop", project: P("Mail move"), session: s }, NOW).includes(s.id));
});
// ------------------------------------------------------------------------------------------ a session, zoomed in (T-304)
check("why it ended: mts's word when the note has it; the closing line and the state for notes written before", () => {
  assert.equal(endWhy("limit", "mts abcd1234: failed", "failed"), "limit");
  assert.equal(endWhy("nonsense", "mts abcd1234: stopped", "stopped"), "stopped", "an unknown word is not trusted");
  assert.equal(endWhy(null, "mts abcd1234: killed", "failed"), "killed");
  assert.equal(endWhy(null, "mts abcd1234: unknown", "failed"), "lost");
  assert.equal(endWhy(null, "mts abcd1234: failed_to_start", "failed"), "never_started");
  assert.equal(endWhy(null, "unverified: mts abcd1234 completed, no artifact", "waiting"), "unverified");
  assert.equal(endWhy(null, "mts abcd1234: completed, evidence: commit abc1234", "finished"), "done");
  assert.equal(endWhy(null, "mts abcd1234: blocked", "waiting"), "blocked");
  assert.equal(endWhy(null, "mts abcd1234: failed", "failed"), "failed");
  assert.equal(endWhy(null, "mts abcd1234: error", "failed"), "failed", "any other word on a failed note: failed (its end note still shows)");
  assert.equal(endWhy(null, null, "running"), null);
});
check("from the vault: the report mts copied onto the run note, in its four parts; a live session has no end", () => {
  const c = S("run-catalogue").end!;
  assert.equal(c.why, "blocked");
  assert.match(c.needs!, /^Should a variety with two names be one entry or two\?/);
  assert.match(c.did!, /^Read the spreadsheet/);
  assert.equal(S("run-events").end, null); assert.equal(S("run-events").feed, "feed-events");
  assert.equal(S("run-labels").end!.why, "limit"); assert.equal(S("run-labels").end!.resumesAt, NOW + 40 * MIN);
  assert.equal(S("run-donate-old").end!.why, "stopped", "an older note: why, from its closing line");
  assert.equal(S("run-restore").end!.did, null, "an older note has no report");
  assert.equal(S("run-about").end!.needs, null, "a part that says none says nothing");
  const other = workFrom({ nodes: vault.nodes, runs: vault.runs.map((r) => (r.id === "run-catalogue" ? { ...r, metadata: { ...r.metadata, report: { summary: "完了", open: "✅ n/a" } } } : r)), tasks: vault.tasks }, NOW);
  assert.equal(other.sessions.find((s) => s.id === "run-catalogue")!.end!.did, "完了", "words in any script are words");
});
check("didn't finish says why, in a sentence: stopped on purpose, failed, ran out of room (and when it picks up again), lost", () => {
  const head = (id: string) => endWords(S(id), NOW)!.head;
  assert.equal(head("run-donate-old"), "Didn't finish: it was stopped on purpose.");
  assert.equal(head("run-labels"), "Didn't finish: it ran out of room: the Claude account reached its session limit.");
  assert.match(endWords(S("run-labels"), NOW)!.more!, /^It picks up again by itself at /);
  assert.equal(head("run-catalogue"), "Stopped to ask you something.");
  assert.equal(head("run-handbook"), "Says it finished, but nothing it left could be checked yet.");
  assert.equal(head("run-about"), "Finished.");
  const s = { ...S("run-donate-old"), end: { why: "failed" as const, note: "exit status 1", resumesAt: null, did: null, left: null, checks: null, needs: null } };
  assert.equal(endWords(s, NOW)!.more, "What went wrong: exit status 1");
  for (const why of ["turns", "context"] as const) assert.match(endWords({ ...s, end: { ...s.end, why } }, NOW)!.head, /ran out of room/);
  assert.match(endWords({ ...s, end: { ...s.end, why: "lost" } }, NOW)!.head, /worker was lost/);
  assert.match(endWords({ ...s, state: "silent", end: null }, NOW)!.head, /nothing has been heard from it/);
  assert.equal(endWords(S("run-events"), NOW), null);
});
check("one that needs you: the exact ask, and the words that answer it in the room (which session, what it asked)", () => {
  assert.equal(askOf(S("run-catalogue")), "Should a variety with two names be one entry or two? I need that before I can count them.");
  assert.match(askOf(S("run-handbook")), /^It says it finished, but nothing it left could be checked/);
  assert.equal(askOf({ ...S("run-catalogue"), end: null }), "It ended needing you, but its note doesn't say what.");
  assert.equal(answerDraft(S("run-catalogue"), "Seed library catalogue"),
    "About the session on “Estimate a catalogue from the spreadsheet” (Seed library catalogue), which asks: “Should a variety with two names be one entry or two? I need that before I can count them.” — ");
  const long = { ...S("run-catalogue"), end: { ...S("run-catalogue").end!, needs: "word ".repeat(80) } };
  assert.ok(answerDraft(long, "X").length < 260, "a long ask is cut short in the draft");
});
check("what it left: one item a line, a link only where the line holds an https link; bullets and backticks go; none is nothing", () => {
  assert.deepEqual(leftItems(S("run-about").end!.left), [
    { text: "ABOUT.md in ~/work/riverbend-site", url: null },
    { text: "https://example.com/riverbend/about (the preview)", url: "https://example.com/riverbend/about" },
    { text: "commit 1a2b3c4", url: null }]);
  assert.deepEqual(leftItems("none"), []);
  assert.deepEqual(leftItems("javascript:alert(1); http://example.com/x").map((i) => i.url), [null, null], "only https opens");
  assert.deepEqual(leftItems("1. the PR https://example.com/pr/7."), [{ text: "the PR https://example.com/pr/7.", url: "https://example.com/pr/7" }]);
});
check("the steps note, read back: time, step or said, words; anything else in the note is left out; secrets are hidden", () => {
  const items = parseFeed(vault.feeds.find((f) => f.id === "feed-events")!.content);
  assert.equal(items.length, 14);
  assert.deepEqual(items.slice(0, 2).map((i) => [i.kind, i.at]), [["said", NOW - 46 * MIN], ["step", NOW - 45 * MIN]]);
  assert.equal(items[1].text, "Reading EventsPage.tsx");
  assert.ok(items.every((i) => !i.text.includes("abc123")), "token=… is hidden");
  assert.deepEqual(parseFeed("# Steps\n\n- not a line\n- - · step · Running pnpm\n- 2026-10-27T10:00:00Z · shout · no\n"), [{ at: null, kind: "step", text: "Running pnpm", n: 0 }]);
  assert.deepEqual(parseFeed(null), []);
});
// T-319: the whole session, a part at a time. Lines are numbered from the session's first; what is held is always one run of them.
const L = (n: number): FeedItem => ({ at: null, kind: "said", text: `line ${n}`, n });
const run = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => L(a + i));
check("T-319: a steps note's lines are numbered from its first, even past a line that shows nothing", () => {
  const items = parseFeed("# Steps\n\n- - · said · one\n- - · said ·    \n- - · step · Running pnpm\n", 390);
  assert.deepEqual(items.map((i) => [i.n, i.text]), [[390, "one"], [392, "Running pnpm"]]);
});
check("T-319: the steps note's metadata, checked: parts one after another up to its first line; a bad one drops itself and those before", () => {
  assert.equal(feedPages({ run_note: "R1" }), null, "a note from before T-319");
  assert.equal(feedPages({ first: 10, total: 5 }), null);
  const parts = [{ id: "p1", first: 0, n: 200 }, { id: "p2", first: 200, n: 200 }];
  assert.deepEqual(feedPages({ first: 390, total: 450, dropped: 0, parts }), { first: 390, total: 450, dropped: 0, parts });
  assert.deepEqual(feedPages({ first: 390, total: 450, parts: [{ id: "../x", first: 0, n: 200 }, parts[1]] })!.parts, [parts[1]]);
  assert.deepEqual(feedPages({ first: 390, total: 450, parts: [parts[0], { id: "p2", first: 201, n: 200 }] })!.parts, []);
  assert.deepEqual(feedPages({ first: 450, total: 460, parts })!.parts, [], "a gap before the note's first line: no parts");
  assert.deepEqual(feedPages({ first: 100, total: 460, parts: [parts[0], { id: "p2", first: 200, n: 200 }] })!.parts, [], "a part after the note's first");
});
check("T-319: a new read keeps what was held when it reaches the note's first line, and only then", () => {
  const pages = (first: number, total: number) => ({ first, total, dropped: 0, parts: [] });
  const held = { items: run(200, 450), from: 200, to: 450 };
  const next = withHead(held, run(400, 452), pages(400, 452));
  assert.deepEqual(next.items.map((i) => i.n), run(200, 452).map((i) => i.n), "every line once, in order");
  assert.deepEqual([next.from, next.to], [200, 452]);
  // the view was away while 100 more lines were written: the held ones don't reach the note's first, so only the note's show
  assert.deepEqual(withHead(held, run(492, 552), pages(492, 552)), { items: run(492, 552), from: 492, to: 552 });
  assert.deepEqual(withHead(null, run(0, 3), pages(0, 3)), { items: run(0, 3), from: 0, to: 3 });
});
check("Codex zwmejvyc P2: a live view left open on a long session holds no more than mts keeps, and never past HELD_MAX", () => {
  // mts's ring: parts of 200, 25 kept; the steps note holds the lines since the last part (at least 60). Read every 50 lines up to 8,000.
  let held: ReturnType<typeof withHead> | null = null;
  for (let total = 50; total <= 8_000; total += 50) {
    const written = Math.floor(total / 200), first = Math.min(written * 200, Math.max(0, total - 60)), lo = Math.max(0, written - 25);
    held = withHead(held, run(first, total), { first, total, dropped: lo * 200, parts: [] });
    assert.ok(held.items.length <= HELD_MAX, `at ${total}: ${held.items.length} lines held`);
    assert.ok(held.items.every((it) => it.n >= lo * 200), `at ${total}: a line mts no longer keeps is still held`);
    assert.equal(held.from, held.items[0].n);
  }
  assert.equal(held!.items.length, 5_000, "lines 3,000 to 7,999: the 25 parts kept");
  // a note that says it keeps everything still can't make a view hold more than HELD_MAX
  const big = withHead({ items: run(0, 9_000), from: 0, to: 9_000 }, run(9_000, 9_060), { first: 9_000, total: 9_060, dropped: 0, parts: [] });
  assert.equal(big.items.length, HELD_MAX);
  assert.equal(big.from, 9_060 - HELD_MAX);
});
check("T-319: the part before what is held goes in front of it, its overlap left out; one that doesn't reach it changes nothing", () => {
  const pages = { first: 390, total: 450, dropped: 0, parts: [{ id: "p1", first: 0, n: 200 }, { id: "p2", first: 200, n: 200 }] };
  const held = { items: run(390, 450), from: 390, to: 450 };
  assert.deepEqual(partBefore(pages, 390), pages.parts[1]);
  const more = withPart(held, pages.parts[1], run(200, 400));
  assert.deepEqual(more.items.map((i) => i.n), run(200, 450).map((i) => i.n));
  assert.equal(partBefore(pages, more.from), pages.parts[0]);
  assert.equal(partBefore(pages, 0), null);
  assert.equal(withPart(held, pages.parts[0], run(0, 200)), held, "part 1 doesn't reach line 390");
});
// T-304 (redaction-strategy addendum: fail closed): the app's second net runs the same rules as mts, on the same cases (one file, shared)
const VECTORS = new URL("./fixtures/redaction-vectors.json", import.meta.url);
const vdoc = JSON.parse(readFileSync(VECTORS, "utf8"));
const expand = (t: string) => t.replace(/\{\{(.+?)\*(\d+)\}\}/g, (_, x: string, n: string) => x.repeat(Number(n)));
const vcases: { from: string; name: string; in: string; out: string }[] = vdoc.cases.map((c: any) => ({ ...c, in: expand(c.in), out: expand(c.out) }));
check("redaction: the rules are the shared ones (the same list as mts)", () => {
  assert.deepEqual(REDACT_RULES, vdoc.rules);
  assert.deepEqual(FOLD, vdoc.fold);
  assert.equal(DASHES, vdoc.dashes);
  assert.deepEqual(LABEL, vdoc.label);
  assert.deepEqual(PHRASES, vdoc.phrases);
});
check("allowlist: every shared label case (shown only when known plain)", () => {
  for (const c of vdoc.label_cases) assert.equal(labelOk(c.label), c.ok, `${c.name}: ${c.label}`);
});
check("allowlist: every shared step line (a phrase as written, the phrase alone, or A step)", () => {
  for (const c of vdoc.step_lines) assert.equal(safeStep(c.in), c.out, c.name);
  // what mts writes for each shared step case passes the app's net unchanged
  for (const c of vdoc.step_cases.filter((x: any) => x.out)) assert.equal(safeStep(c.out), c.out, c.name);
  // and through the steps note
  assert.deepEqual(parseFeed("- 2026-10-27T10:00:00Z · step · Reading buildsk-abc123xyz\n- 2026-10-27T10:00:01Z · step · Running meadow phrase\n").map((i) => i.text),
    ["Reading a file", "Running a command"]);
  assert.equal(HIDDEN, vdoc.hidden);
});
check("redaction: every shared case (both reviews and the addendum), from the first secret-like key or shape to the end", () => {
  for (const c of vcases) assert.equal(redactRaw(c.in), c.out, `${c.from}: ${c.name}`);
});
check("redaction: the vectors file is mts's (when an mts checkout is at MTS_DIR or ~/Code/mts-launcher)", () => {
  const peer = join(process.env.MTS_DIR ?? join(homedir(), "Code/mts-launcher"), "tests/redaction_vectors.json");
  if (!existsSync(peer)) { console.log(`skip: no mts copy at ${peer}`); return; }
  assert.equal(readFileSync(peer, "utf8"), readFileSync(VECTORS, "utf8"));
});
/** The pieces (4+ letters or digits) of a case's hidden part that show, as whole words, in `out` (and aren't in its visible part). */
function leaks(c: { in: string; out: string }, out: string): string[] {
  const shown = c.out.endsWith(HIDDEN) ? c.out.slice(0, c.out.length - HIDDEN.length) : c.out, gone = c.in.slice(shown.length);
  return [...gone.matchAll(/[\p{L}\p{N}_]{4,}/gu)].map((m) => m[0])
    .filter((w) => !shown.includes(w) && new RegExp(`(?<![\\p{L}\\p{N}_])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_])`, "u").test(out));
}
check("redaction, the full real path: a run note holding each case in every field, read by workFrom, and all the view says of it", () => {
  const base = vault.runs.find((r) => r.id === "run-catalogue")!;
  for (const c of vcases.filter((x) => x.out !== x.in)) {
    const one = c.in.replace(/\n/g, " ");
    const runs = (["blocked", "running"] as const).map((state, i) => ({ ...base, id: `r-${i}`, path: `Runs/2026-10-20 ${one}`,
      metadata: { ...base.metadata, state, doing_now: c.in, doing_at: new Date(NOW - MIN).toISOString(), summary: `mts abcd1234: completed, evidence: file /w/${c.in}`,
        end_note: c.in, video: `https://example.com/${c.in}`, ended: "failed", report: { summary: c.in, artifacts: c.in, checks: c.in, open: c.in } } }));
    const w = workFrom({ nodes: vault.nodes, runs, tasks: vault.tasks }, NOW);
    const shown: string[] = [];
    for (const s of w.sessions) {
      const e = endWords(s, NOW);
      shown.push(s.ask, s.now ?? "", s.result ?? "", s.video ?? "", ...Object.values(s.end ?? {}).map((v) => (typeof v === "string" ? v : "")),
        e?.head ?? "", e?.more ?? "", askOf(s), answerDraft(s, "A project"), ...leftItems(s.end?.left).flatMap((i) => [i.text, i.url ?? ""]));
    }
    assert.equal(w.sessions.length, 2, c.name);
    // the words this test wraps around each case (the link's host, the closing line's) and the view's own words (the Answer draft's
    // "About the session on … which asks") are not the case's
    const wrap = new Set(["https", "example", "evidence", "file", "completed", "abcd1234", "About", "session", "which", "asks"]);
    assert.deepEqual(leaks(c, shown.join("\n")).filter((x) => !wrap.has(x)), [], `${c.from}: ${c.name}`);
  }
});
check("redaction, the full real path: the area's running list (parseRuns) reads a run note's words through redactRaw too", () => {
  const { nodes, rootPath } = parseNodes([{ id: "u", path: "Uni", tags: ["uni"], metadata: {} }, { id: "a", path: "Areas/Larder", tags: ["area"], metadata: { parent: "Uni" } }] as never, "uni");
  const tree = buildTaskTree(nodes, rootPath);
  for (const c of vcases.filter((x) => x.out !== x.in)) {
    const runs = parseRuns([{ id: "r1", path: "Runs/x", tags: ["run"], metadata: { state: "running", node: "Areas/Larder", summary: c.in, result: c.in } }] as never, tree);
    assert.equal(runs.length, 1, c.name);
    assert.deepEqual(leaks(c, `${runs[0].what}\n${runs[0].result ?? ""}`), [], `${c.from}: ${c.name}`);
  }
});
check("redaction, the full real path: a steps note holding each case, read by parseFeed", () => {
  for (const c of vcases.filter((x) => x.out !== x.in)) {
    const one = c.in.replace(/\n/g, " ");
    const items = parseFeed(`# Steps\n\n- 2026-10-27T10:00:00Z · said · ${one}\n- 2026-10-27T10:00:01Z · step · ${one}\n`);
    assert.equal(items.length, 2, c.name);
    assert.deepEqual(leaks(c, items.map((i) => i.text).join("\n")), [], `${c.from}: ${c.name}`);
  }
});
if (failed) process.exit(1);
