// T-301/T-302: the work model's rules. A project lives in exactly one area and has a folder; a project holds any number of sessions, and
// any number of them may be live; stop and finish change only the session they name; archiving is for projects, and an archived project
// has no live sessions. Then the same rules on the vault's own shapes (workFrom), and the words the room is sent.
import assert from "node:assert/strict";
import { ModelError, ago, archivePlan, archiveProject, cannotStart, isLive, liveInArea, liveSessions, makeProject, problems, restoreProject, sessionsOf, span, startSession, stateWords, stepSession, stopSession, finishSession, timeline, timelineWindow, type Area, type Work } from "../src/projects/model.ts";
import { HEARD_MS, plainTitle, plainWords, resultWords, workFrom } from "../src/projects/live.ts";
import { actionMessage } from "../src/projects/actions.ts";
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
  assert.deepEqual(live.gaps, [{ name: "Shop signs", area: "area-workshop", why: "no folder" }]);
  assert.equal(P("Nightly backups").folder, "~/ops/backups", "the repo field stands in for a folder");
  const relative = workFrom({ nodes: vault.nodes.map((n) => (n.id === "p-seeds" ? { ...n, metadata: { ...n.metadata, folder: "seed-library" } } : n)), runs: [], tasks: [] }, NOW);
  assert.ok(relative.gaps.some((g) => g.name === "Seed library catalogue"), "a relative folder is no folder");
  assert.equal(P("Old zine archive").status, "archived"); assert.equal(P("Co-op kiosk").status, "resting");
});
check("from the vault: many sessions on one project, any number live; a run finds its project by node, task or folder", () => {
  assert.deepEqual(liveSessions(live, "p-coop").map((s) => s.id).sort(), ["run-donate", "run-events"]);
  assert.equal(S("run-mail").project, "p-mail", "filed on the area, run in the project's folder");
  assert.equal(S("run-restore").project, "p-backups", "through its task's node");
  assert.equal(live.sessions.some((s) => s.id === "run-loose"), false, "on an area, in no project's folder: not under a project");
  const twoFolders = workFrom({ nodes: [...vault.nodes, { ...vault.nodes.find((n) => n.id === "p-mail")!, id: "p-mail2", path: "Projects/Mail again" }], runs: vault.runs, tasks: vault.tasks }, NOW);
  assert.equal(twoFolders.sessions.some((s) => s.id === "run-mail"), false, "a folder two projects share names neither");
});
check("from the vault: a session says what it is doing in words, its steps, and what it left; never a task number or a run id", () => {
  const ev = S("run-events");
  assert.equal(ev.ask, "Make the events page read like a noticeboard", "a run titled only by its task takes the task's words");
  assert.equal(ev.now, "Recording the walkthrough on phone and desktop"); assert.equal(ev.steps, 31); assert.equal(ev.endedAt, null);
  assert.equal(S("run-about").result, "Left ABOUT.md."); assert.equal(S("run-about").video, "https://example.com/walkthrough/about-page");
  assert.equal(S("run-restore").result, "Left a commit.");
  assert.equal(S("run-handbook").result, "Says it finished; nothing it left could be checked yet.");
  assert.equal(S("run-donate-old").state, "stopped", "stopped by hand: stopped, not failed"); assert.equal(S("run-donate-old").ask, "Try a donate button");
  assert.equal(S("run-catalogue").state, "waiting"); assert.equal(S("run-catalogue").result, null);
  const words = live.sessions.flatMap((s) => [s.ask, s.now ?? "", s.result ?? "", stateWords(s, NOW)]).join("\n");
  assert.doesNotMatch(words, /\bT-\d+|\bmts\b|\b[a-z]{4}[a-z0-9]{4}\b:|run-|\bresume\b/);
  assert.equal(plainTitle("T-302 (2)"), ""); assert.equal(plainTitle("T-288 (resume hsb0mug1)"), ""); assert.equal(plainTitle("LVB week 9 page + homework"), "LVB week 9 page + homework");
  assert.equal(resultWords("mts abcd1234: failed", "failed"), null);
});
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
check("a room's own words lose their task numbers on screen", () => {
  assert.equal(plainWords("T-265 civic data layer in fix pass; Commons app (T-257) paused."), "Civic data layer in fix pass; Commons app paused.");
  assert.equal(plainWords("Nothing to strip here."), "Nothing to strip here.");
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
if (failed) process.exit(1);
