// T-301: the prototype's made-up world. Seven areas, each a room, a few projects with folders, and sessions in every state.
// Everything here is invented (this repo is public); nothing is read from a vault, a relay or a run ledger.
import { makeProject, type Area, type Session, type Work } from "./model.ts";

const MIN = 60_000;
const HOUR = 60 * MIN;

/** The seven areas: name, room, what the area is, and where it stands (the line the front door shows). */
export const DEMO_AREAS: readonly (Area & { slug: string; about: string; stands: string })[] = [
  { id: "hearth", name: "Hearth", slug: "hearth", path: "Areas/Hearth", room: "demo-hearth", about: "Home, health and the week.", stands: "A quiet week. The seed trays are planted; the dentist is Thursday." },
  { id: "workshop", name: "Workshop", slug: "workshop", path: "Areas/Workshop", room: "demo-workshop", about: "Client sites and the small tools behind them.", stands: "The co-op site goes to its board Thursday. Two pages left." },
  { id: "engine", name: "Engine Room", slug: "engine-room", path: "Areas/Engine Room", room: "demo-engine", about: "The machines and services everything runs on.", stands: "Backups ran clean all week. The mail move is half done." },
  { id: "school", name: "Schoolhouse", slug: "schoolhouse", path: "Areas/Schoolhouse", room: "demo-school", about: "Teaching: the course, the readings, the cohort.", stands: "Week 7 opens Monday. The reading pack needs one more pass." },
  { id: "desk", name: "Writing Desk", slug: "writing-desk", path: "Areas/Writing Desk", room: "demo-desk", about: "Essays, letters and the long piece.", stands: "The essay is at two thousand words and wants an ending." },
  { id: "guild", name: "Guild", slug: "guild", path: "Areas/Guild", room: "demo-guild", about: "The member organisation and its shared work.", stands: "The charter vote is Tuesday. The handbook is with the editors." },
  { id: "town", name: "Town Hall", slug: "town-hall", path: "Areas/Town Hall", room: "demo-town", about: "Civic things: the council, the map, the neighbours.", stands: "The council agenda is out; two items to read before Wednesday." },
];

type Line = { who: "me" | "uni"; ago: number; text: string };

/** Each room's recent talk (minutes ago). The workshop's mentions the sessions that ran on its projects, so the timeline lines up. */
const TALK: Record<string, Line[]> = {
  hearth: [
    { who: "me", ago: 26 * 60, text: "Can you move the dentist to Thursday morning?" },
    { who: "uni", ago: 26 * 60 - 3, text: "Done: Thursday 9:30. I put it on the calendar." },
    { who: "me", ago: 5 * 60, text: "Seed trays are in. Remind me to water them on Friday." },
    { who: "uni", ago: 5 * 60 - 1, text: "I'll remind you Friday at 8." },
  ],
  workshop: [
    { who: "me", ago: 21 * 60, text: "The seed library wants a catalogue estimate by next week." },
    { who: "uni", ago: 21 * 60 - 2, text: "I'll have a worker read their spreadsheet and write one up." },
    { who: "uni", ago: 19 * 60, text: "The catalogue estimate is done: three days of work, two options for search. It's in the project." },
    { who: "me", ago: 52, text: "The co-op wants the events page to read like a noticeboard, not a calendar grid." },
    { who: "uni", ago: 50, text: "I'll start a session on the events page with that line, and keep the about page as it is." },
    { who: "me", ago: 12, text: "Keep their own words on the cards, please. No rewriting." },
    { who: "uni", ago: 11, text: "Noted. The session has it." },
  ],
  engine: [
    { who: "uni", ago: 9 * 60, text: "Nightly backups: seven clean runs in a row. The restore test passed." },
    { who: "me", ago: 3 * 60, text: "Let's move the mail service onto the new box this week." },
    { who: "uni", ago: 3 * 60 - 2, text: "Started a session on the mail move. It will copy and check before anything switches over." },
    { who: "me", ago: 40, text: "Don't switch the DNS without me." },
    { who: "uni", ago: 39, text: "It won't. It stops before the switch and asks." },
  ],
  school: [
    { who: "me", ago: 30 * 60, text: "Week 7 is about maps. Three readings, one short exercise." },
    { who: "uni", ago: 30 * 60 - 4, text: "A worker drafted the reading pack; it's in the project folder." },
    { who: "me", ago: 2 * 60, text: "The second reading is too long. Find a shorter one on the same idea." },
    { who: "uni", ago: 2 * 60 - 1, text: "Looking now." },
  ],
  desk: [
    { who: "me", ago: 4 * 24 * 60, text: "The essay is about slow tools. I want it to end on the workbench, not on a lesson." },
    { who: "uni", ago: 4 * 24 * 60 - 5, text: "Kept. I'll hold the outline as it is." },
    { who: "me", ago: 7 * 60, text: "Two thousand words now. I'll write the ending myself." },
  ],
  guild: [
    { who: "uni", ago: 2 * 24 * 60, text: "The handbook draft went to the editors." },
    { who: "me", ago: 20 * 60, text: "The charter vote is Tuesday. Make sure everyone has the text by Friday." },
    { who: "uni", ago: 20 * 60 - 2, text: "It goes out Thursday evening with the agenda." },
  ],
  town: [
    { who: "uni", ago: 6 * 60, text: "The council agenda is out. Two items touch the bike lanes." },
    { who: "me", ago: 4 * 60, text: "Put both on the map, with the meeting date." },
    { who: "uni", ago: 4 * 60 - 1, text: "Added. The map shows them in orange." },
  ],
};

export type DemoMessage = { ref: string; channel: string; mine: boolean; ts: number; body: string };

export function demoTalk(now: number): DemoMessage[] {
  return DEMO_AREAS.flatMap((a) => (TALK[a.id] ?? []).map((l, i) => ({ ref: `${a.id}-${i}`, channel: a.room, mine: l.who === "me", ts: Math.floor((now - l.ago * MIN) / 1000), body: l.text })));
}

const session = (s: Partial<Session> & Pick<Session, "id" | "project" | "ask" | "startedAt">): Session =>
  ({ state: "finished", retired: false, now: "", endedAt: null, story: [], result: null, video: null, ...s });

/** The made-up world at time `now`. */
export function demoWork(now: number): Work {
  const areas: Area[] = DEMO_AREAS.map(({ id, name, path, room }) => ({ id, name, path, room }));
  const p = (id: string, area: string, name: string, folder: string, about: string, status: "active" | "resting" | "done" = "active") => makeProject({ id, area, name, folder, about, status }, areas);
  const projects = [
    p("coop", "workshop", "Riverbend co-op site", "~/work/riverbend-site", "The co-op's site: events, about, donate."),
    p("seeds", "workshop", "Seed library catalogue", "~/work/seed-library", "A catalogue for the seed library's collection."),
    p("mail", "engine", "Mail move", "~/ops/mail-move", "Move the mail service onto the new box."),
    p("backups", "engine", "Nightly backups", "~/ops/backups", "Encrypted nightly backups and a weekly restore test.", "resting"),
    p("week7", "school", "Week 7 reading pack", "~/teaching/week-7", "Three readings on maps and one short exercise."),
    p("course", "school", "Course site", "~/teaching/course-site", "Where students find the week's work.", "resting"),
    p("essay", "desk", "Essay on slow tools", "~/writing/slow-tools", "A long piece; the ending is the writer's own."),
    p("handbook", "guild", "Member handbook", "~/guild/handbook", "The handbook new members get."),
    p("bikemap", "town", "Bike lane map", "~/civic/bike-lanes", "A map of the lanes the council is deciding on."),
  ];
  const t = (minAgo: number) => now - minAgo * MIN;
  const sessions: Session[] = [
    session({ id: "s-events", project: "coop", state: "running", ask: "Make the events page read like a noticeboard: pinned cards, dates set by hand, no grid.", now: "Recording the walkthrough on phone and desktop.", startedAt: t(49),
      story: [{ at: t(49), text: "Started in ~/work/riverbend-site." }, { at: t(46), text: "Read the board's notes and the current events page." }, { at: t(38), text: "Looked at three real community noticeboards for how cards overlap." }, { at: t(27), text: "Built pinned cards, dates set by hand, a \"this week\" strip on top." }, { at: t(11), text: "Put the co-op's own words back on every card." }, { at: t(4), text: "Recording the walkthrough on phone and desktop." }] }),
    session({ id: "s-about", project: "coop", state: "finished", ask: "Rebuild the about page from the coordinator's letter, word for word.", startedAt: t(3 * 24 * 60), endedAt: t(3 * 24 * 60 - 70), now: "Shipped to staging. The coordinator liked it.", result: "Shipped to staging. The coordinator liked it.", video: "https://example.com/walkthrough/about-page",
      story: [{ at: t(3 * 24 * 60), text: "Started in ~/work/riverbend-site." }, { at: t(3 * 24 * 60 - 20), text: "Set the letter into the page, word for word." }, { at: t(3 * 24 * 60 - 60), text: "Checked it on phone and desktop." }, { at: t(3 * 24 * 60 - 70), text: "Finished." }] }),
    session({ id: "s-donate", project: "coop", state: "stopped", ask: "Try a donate page with a sliding amount.", startedAt: t(26 * 60), endedAt: t(26 * 60 - 15), now: "Stopped by you.",
      story: [{ at: t(26 * 60), text: "Started in ~/work/riverbend-site." }, { at: t(26 * 60 - 12), text: "Sketched a sliding amount." }, { at: t(26 * 60 - 15), text: "Stopped by you." }] }),
    session({ id: "s-catalogue", project: "seeds", state: "finished", ask: "Read the library's spreadsheet and estimate a catalogue.", startedAt: t(21 * 60 - 3), endedAt: t(19 * 60 + 2), now: "Three days of work; two options for search.", result: "Three days of work. Two options for search: a simple filter, or full text. The estimate is in the folder.", video: null,
      story: [{ at: t(21 * 60 - 3), text: "Started in ~/work/seed-library." }, { at: t(20 * 60 + 30), text: "Read the spreadsheet: 1,240 seeds, 9 columns." }, { at: t(19 * 60 + 20), text: "Wrote the estimate with two options." }, { at: t(19 * 60 + 2), text: "Finished." }] }),
    session({ id: "s-mail", project: "mail", state: "running", ask: "Copy the mail service onto the new box and check it; stop before switching anything over.", now: "Checking yesterday's mail arrived in full on the new box.", startedAt: t(3 * 60 - 3),
      story: [{ at: t(3 * 60 - 3), text: "Started in ~/ops/mail-move." }, { at: t(2 * 60 + 30), text: "Copied the mail store to the new box." }, { at: t(80), text: "Started the service there, alongside the old one." }, { at: t(9), text: "Checking yesterday's mail arrived in full on the new box." }] }),
    session({ id: "s-restore", project: "backups", state: "finished", ask: "Run the weekly restore test.", startedAt: t(9 * 60 + 20), endedAt: t(9 * 60 + 2), now: "Restore test passed.", result: "Restore test passed: a full restore in 14 minutes, every file checked.", video: null,
      story: [{ at: t(9 * 60 + 20), text: "Started in ~/ops/backups." }, { at: t(9 * 60 + 2), text: "Finished." }] }),
    session({ id: "s-pack", project: "week7", state: "finished", ask: "Draft the week 7 reading pack: three readings on maps and an exercise.", startedAt: t(30 * 60 - 10), endedAt: t(30 * 60 - 50), now: "The pack is drafted.", result: "Drafted: three readings and a twenty-minute exercise. The second reading runs long.", video: "https://example.com/walkthrough/week-7-pack",
      story: [{ at: t(30 * 60 - 10), text: "Started in ~/teaching/week-7." }, { at: t(30 * 60 - 50), text: "Finished." }] }),
    session({ id: "s-shorter", project: "week7", state: "running", ask: "Find a shorter second reading on the same idea.", now: "Reading two candidates side by side.", startedAt: t(2 * 60 - 2),
      story: [{ at: t(2 * 60 - 2), text: "Started in ~/teaching/week-7." }, { at: t(70), text: "Found four candidates under ten pages." }, { at: t(15), text: "Reading two candidates side by side." }] }),
    session({ id: "s-outline", project: "essay", state: "finished", retired: true, ask: "Tidy the essay's outline.", startedAt: t(4 * 24 * 60), endedAt: t(4 * 24 * 60 - 25), now: "Outline tidied.", result: "Outline tidied; the ending left as written.", story: [] }),
    session({ id: "s-handbook", project: "handbook", state: "finished", ask: "Lay out the handbook draft for the editors.", startedAt: t(2 * 24 * 60 + 60), endedAt: t(2 * 24 * 60 + 5), now: "Sent to the editors.", result: "Laid out and sent to the editors as a PDF.", video: null,
      story: [{ at: t(2 * 24 * 60 + 60), text: "Started in ~/guild/handbook." }, { at: t(2 * 24 * 60 + 5), text: "Finished." }] }),
  ];
  return { areas, projects, sessions };
}

/** What a fresh session does, step by step, in the prototype (it is simulated: no worker runs). */
export const FRESH_STEPS = [
  "Reading the brief and the folder.",
  "Looking at what is there now.",
  "Making the change.",
  "Checking it on phone and desktop.",
  "Writing up what it did.",
];
export const FRESH_RESULT = "Done, and checked on phone and desktop. A short walkthrough is ready.";
export const DEMO_HOUR = HOUR;
