// T-301: the work model's rules. A project lives in exactly one area and has a folder; a project holds any number of sessions, and any
// number of them may be live; stop, finish and retire change only the session they name.
import assert from "node:assert/strict";
import { ModelError, ago, isLive, restoreSession, liveInArea, liveSessions, makeProject, problems, retireSession, retiredOf, sessionsOf, span, startSession, stateWords, stepSession, stopSession, finishSession, timeline, timelineWindow, type Area, type Work } from "../src/projects/model.ts";
import { DEMO_AREAS, demoWork } from "../src/projects/demoData.ts";
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
check("a session needs a project that exists, something to do, and a project that isn't done", () => {
  assert.throws(() => startSession(empty(), "nope", "x", NOW, "s"), /no project/);
  assert.throws(() => startSession(empty(), "p", "  ", NOW, "s"), /something to do/);
  const done = { ...empty(), projects: [{ ...empty().projects[0], status: "done" as const }] };
  assert.throws(() => startSession(done, "p", "x", NOW, "s"), /is done/);
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
check("retire puts a session away: a live one is stopped first; it leaves the list and is kept under retired", () => {
  let w = startSession(startSession(empty(), "p", "One", NOW, "s1"), "p", "Two", NOW + MIN, "s2");
  w = retireSession(w, "s2", NOW + 5 * MIN);
  const s2 = w.sessions.find((s) => s.id === "s2")!;
  assert.equal(s2.state, "stopped"); assert.equal(s2.retired, true); assert.equal(s2.endedAt, NOW + 5 * MIN);
  assert.deepEqual(sessionsOf(w, "p").map((s) => s.id), ["s1"]);
  assert.deepEqual(retiredOf(w, "p").map((s) => s.id), ["s2"]);
  const back = restoreSession(w, "s2");
  assert.deepEqual(sessionsOf(back, "p").map((s) => s.id), ["s1", "s2"], "brought back: in the list again");
  assert.equal(back.sessions.find((s) => s.id === "s2")!.state, "stopped", "brought back stopped: retiring stopped it for good");
  w = finishSession(w, "s1", NOW + 6 * MIN, "Done.");
  w = retireSession(w, "s1", NOW + 7 * MIN);
  assert.equal(w.sessions.find((s) => s.id === "s1")!.state, "finished", "a finished session stays finished when retired");
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
check("a live session's step changes its one line and grows its story; a stopped one takes no step", () => {
  let w = startSession(empty(), "p", "Go", NOW, "s");
  w = stepSession(w, "s", "Reading the folder.", NOW + MIN);
  assert.equal(w.sessions[0].now, "Reading the folder."); assert.equal(w.sessions[0].story.length, 2);
  w = stopSession(w, "s", NOW + 2 * MIN);
  const after = stepSession(w, "s", "Sneaking on.", NOW + 3 * MIN);
  assert.equal(after.sessions[0].now, "Stopped by you."); assert.equal(after.sessions[0].story.length, 3);
});
check("states are said in words, never ids", () => {
  let w = startSession(empty(), "p", "Go", NOW, "s");
  assert.equal(stateWords(w.sessions[0], NOW + 49 * MIN), "Working · 49 min");
  w = finishSession(w, "s", NOW + 50 * MIN, "Done.");
  assert.equal(stateWords(w.sessions[0], NOW + 50 * MIN + 3 * 86_400_000), "Finished 3 days ago");
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
check("the prototype's made-up world holds every rule: seven areas, seven rooms, live sessions in more than one area", () => {
  const w = demoWork(NOW);
  assert.deepEqual(problems(w), []);
  assert.equal(w.areas.length, 7); assert.equal(new Set(w.areas.map((a) => a.room)).size, 7);
  assert.equal(DEMO_AREAS.length, 7);
  assert.ok(w.areas.filter((a) => liveInArea(w, a.id).length > 0).length >= 2);
  assert.ok(w.projects.every((p) => p.folder.startsWith("~/")));
});
if (failed) process.exit(1);
