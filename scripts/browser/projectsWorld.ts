// T-301/T-302: a made-up world, as the vault holds it: seven area nodes (each with its room), project nodes with folders, `run` notes
// in every state, a few tasks, each room's recent talk and a Claude accounts note. Everything here is invented (this repo is public);
// nothing is read from a vault, a relay or a run ledger. The unit tests and the browser fixture both read it through the app's own
// `workFrom`, so what they check is what the live app does with the same shapes.
// T-304: run notes carry their end (`ended`, `report`, `resumes_at`) and `feed`, the note of steps mts keeps beside them (`feeds`).

const MIN = 60_000;
const ROOT = "node-uni";
const T0 = "2026-10-01T08:00:00.000Z";

type Note = { id: string; path: string; tags: string[]; metadata: Record<string, unknown>; createdAt: string; updatedAt: string };
const note = (id: string, path: string, tags: string[], metadata: Record<string, unknown>, updatedAt = T0): Note => ({ id, path, tags, metadata, createdAt: T0, updatedAt });

/** The seven areas: name, room, and where each stands (the line the front door shows). */
export const DEMO_AREAS = [
  { id: "hearth", name: "Hearth", room: "demo-hearth", stands: "A quiet week. The seed trays are planted; the dentist is Thursday." },
  { id: "workshop", name: "Workshop", room: "demo-workshop", stands: "The co-op site goes to its board Thursday. Two pages left." },
  { id: "engine", name: "Engine Room", room: "demo-engine", stands: "Backups ran clean all week. The mail move is half done." },
  { id: "school", name: "Schoolhouse", room: "demo-school", stands: "Week 7 opens Monday. The reading pack needs one more pass." },
  { id: "desk", name: "Writing Desk", room: "demo-desk", stands: "The essay is at two thousand words and wants an ending." },
  { id: "guild", name: "Guild", room: "demo-guild", stands: "The charter vote is Tuesday. The handbook is with the editors." },
  { id: "town", name: "Town Hall", room: "demo-town", stands: "The council agenda is out; two items to read before Wednesday." },
] as const;
export const slugOf = (name: string) => name.toLowerCase().replace(/\s+/g, "-");

type Line = { who: "me" | "uni"; ago: number; text: string };
/** Each room's recent talk (minutes ago). */
const TALK: Record<string, Line[]> = {
  hearth: [{ who: "me", ago: 5 * 60, text: "Seed trays are in. Remind me to water them on Friday." }, { who: "uni", ago: 5 * 60 - 1, text: "I'll remind you Friday at 8." }],
  workshop: [
    { who: "me", ago: 52, text: "The co-op wants the events page to read like a noticeboard, not a calendar grid." },
    { who: "uni", ago: 50, text: "I'll start a session on the events page with that line, and keep the about page as it is." },
    { who: "me", ago: 12, text: "Keep their own words on the cards, please. No rewriting." },
    { who: "uni", ago: 11, text: "Noted. The session has it." },
  ],
  engine: [{ who: "me", ago: 3 * 60, text: "Let's move the mail service onto the new box this week." }, { who: "uni", ago: 3 * 60 - 2, text: "Started a session on the mail move. It stops before anything switches over." }],
  school: [{ who: "me", ago: 2 * 60, text: "The second reading is too long. Find a shorter one on the same idea." }, { who: "uni", ago: 2 * 60 - 1, text: "Looking now." }],
  desk: [{ who: "me", ago: 7 * 60, text: "Two thousand words now. I'll write the ending myself." }],
  guild: [{ who: "uni", ago: 20 * 60, text: "The charter text goes out Thursday evening with the agenda." }],
  town: [{ who: "uni", ago: 6 * 60, text: "The council agenda is out. Two items touch the bike lanes." }],
};

export type DemoMessage = { ref: string; channel: string; mine: boolean; ts: number; body: string };
export function demoTalk(now: number): DemoMessage[] {
  return DEMO_AREAS.flatMap((a) => (TALK[a.id] ?? []).map((l, i) => ({ ref: `${a.id}-${i}`, channel: a.room, mine: l.who === "me", ts: Math.floor((now - l.ago * MIN) / 1000), body: l.text })));
}

/** The world at time `now`: the vault's notes (node, run, task, the usage note) as the app reads them. */
export function demoVault(now: number) {
  const iso = (minAgo: number) => new Date(now - minAgo * MIN).toISOString();
  const nodes: Note[] = [note(ROOT, "Uni", ["uni", "node"], {})];
  for (const a of DEMO_AREAS) nodes.push(note(`area-${a.id}`, `Areas/${a.name}`, ["node", "area"], { parent: ROOT, channel: a.room, room: slugOf(a.name), status: "foreground", stands: a.stands, stands_at: iso(3 * 60) }));
  const project = (id: string, area: string, name: string, md: Record<string, unknown>) => nodes.push(note(id, `Projects/${name}`, ["node", "project"], { parent: area.startsWith("p-") ? area : `area-${area}`, status: "active", ...md }));
  project("p-coop", "workshop", "Riverbend co-op site", { folder: "~/work/riverbend-site", summary: "The co-op's site: events, about, donate.",
    // a link to another area never makes it live there too
    links: [{ to: "area-town", why: "the co-op meets at the town hall" }] });
  project("p-seeds", "workshop", "Seed library catalogue", { folder: "~/work/seed-library", summary: "A catalogue for the seed library's collection." });
  project("p-kiosk", "p-coop", "Co-op kiosk", { folder: "~/work/riverbend-kiosk", summary: "A screen for the co-op's front window.", status: "dormant" });
  project("p-zine", "workshop", "Old zine archive", { folder: "~/work/zine-archive", status: "archived" });
  project("p-signs", "workshop", "Shop signs", { summary: "Hand-painted signs; no folder yet." });
  project("p-mail", "engine", "Mail move", { folder: "~/ops/mail-move", summary: "Move the mail service onto the new box." });
  project("p-backups", "engine", "Nightly backups", { repo: "~/ops/backups", status: "resting" });
  project("p-week7", "school", "Week 7 reading pack", { folder: "~/teaching/week-7" });
  project("p-essay", "desk", "Essay on slow tools", { folder: "~/writing/slow-tools" });
  project("p-handbook", "guild", "Member handbook", { folder: "~/guild/handbook" });
  project("p-bikemap", "town", "Bike lane map", { folder: "~/civic/bike-lanes" });
  const tasks: Note[] = [
    note("t-901", "Tasks/T-901 Make the events page read like a noticeboard", ["task"], { node: "p-coop", state: "doing", owner: "uni" }),
    note("t-902", "Tasks/T-902 Weekly restore test", ["task"], { node: "p-backups", state: "done", owner: "uni" }),
    note("t-903", "Tasks/T-903 Copy the mail service onto the new box", ["task"], { node: "p-mail", state: "doing", owner: "uni" }),
    // one thing that needs you (the front door's line), asked an hour ago
    note("t-904", "Tasks/T-904 Choose the photo for the about page", ["task"], { node: "p-coop", state: "open", owner: "aaron", next: "Pick one of the three in the folder", asked_at: iso(60) }),
  ];
  const runs: Note[] = [];
  const run = (id: string, title: string, md: Record<string, unknown>) => runs.push(note(id, `Runs/2026-10-20 ${title}`, ["run"], { worker: `mts-${id.slice(-8).padStart(8, "x")}`, ...md }));
  run("run-events", "T-901", { node: "p-coop", task: "T-901", state: "running", started_at: iso(49), doing_now: "Running npx", doing_at: iso(2), steps: 31, room: "workshop", channel: "demo-workshop", feed: "feed-events" });
  run("run-donate", "Donate page with a sliding amount", { node: "p-coop", fresh_from: "dnteold1", state: "running", started_at: iso(20), doing_now: "Editing Donate.tsx", doing_at: iso(1), steps: 9, room: "workshop", channel: "demo-workshop" });
  run("run-about", "Rebuild the about page from the coordinator's letter", { node: "p-coop", state: "done", started_at: iso(3 * 24 * 60), ended_at: iso(3 * 24 * 60 - 70), summary: "mts aaaabbbb: completed, evidence: file /home/someone/work/riverbend-site/ABOUT.md", video: "https://example.com/walkthrough/about-page",
    ended: "done", feed: "feed-about", report: { summary: "Rebuilt the about page from the coordinator's letter, in her words. Three short sections: who we are, where we meet, how to join.",
      artifacts: "- `ABOUT.md` in ~/work/riverbend-site\n- https://example.com/riverbend/about (the preview)\n- commit 1a2b3c4", checks: "Read it on a phone and a desktop; the links all open.", open: "none" } });
  run("run-donate-old", "Try a donate button (resume ccccdddd)", { node: "p-coop", attempt: "dnteold1", state: "failed", started_at: iso(26 * 60), ended_at: iso(26 * 60 - 15), summary: "mts ccccdddd: stopped" });
  run("run-catalogue", "Estimate a catalogue from the spreadsheet", { node: "p-seeds", state: "blocked", started_at: iso(21 * 60), ended_at: iso(19 * 60), summary: "mts eeeeffff: blocked",
    ended: "blocked", report: { summary: "Read the spreadsheet: 412 rows. Three columns disagree on what counts as one variety.", artifacts: "none",
      checks: "Counted the rows twice with API_KEY=made-up-key-123 in the import.", open: "Should a variety with two names be one entry or two? I need that before I can count them." } });
  // ran out of room on the account's session limit; it picks up again by itself in 40 minutes
  run("run-labels", "Print labels for the spring packets", { node: "p-seeds", state: "failed", started_at: iso(5 * 60), ended_at: iso(4 * 60), summary: "mts mmmmnnnn: failed",
    ended: "limit", resumes_at: iso(-40), report: { summary: "Laid out 40 of the 96 labels." } });
  // filed on the area, but run in the mail move's folder: it belongs to the mail move
  run("run-mail", "T-903", { node: "area-engine", state: "running", started_at: iso(3 * 60 - 3), doing_now: "Checking yesterday's mail arrived in full on the new box", doing_at: iso(9), steps: 64, folder: "~/ops/mail-move" });
  // filed on a task whose node is the project (no node of its own on the run)
  run("run-restore", "T-902", { task: "T-902", node: "unknown-node", state: "done", started_at: iso(9 * 60 + 20), ended_at: iso(9 * 60 + 2), summary: "mts gggghhhh: completed, evidence: commit 1a2b3c4 in /home/someone/ops/backups" });
  run("run-shorter", "Find a shorter second reading on the same idea", { node: "p-week7", state: "running", started_at: iso(2 * 60 - 2), steps: 0 });
  run("run-handbook", "Lay out the handbook draft for the editors", { node: "p-handbook", state: "done", started_at: iso(2 * 24 * 60 + 60), ended_at: iso(2 * 24 * 60 + 5), summary: "unverified: mts iiiijjjj completed, no artifact resolves to a commit or an existing file" });
  // a run on an area, in no project's folder: not shown under any project
  run("run-loose", "Tidy the area notes", { node: "area-guild", state: "done", started_at: iso(60), ended_at: iso(30), summary: "mts kkkkllll: completed" });
  const usage = note("usage-1", "System/Claude accounts", ["system", "usage", "claude-accounts"], {
    claude_accounts: { version: 1, read_at: iso(6), stop: 97, preference: "auto",
      accounts: [{ name: "a", signed_in: true, read_at: iso(6), session: { used: 22, resets_at: iso(-140) }, week: { used: 41, resets_at: iso(-3 * 24 * 60) } },
        { name: "b", signed_in: true, read_at: iso(6), session: { used: 4, resets_at: iso(-200) }, week: { used: 12, resets_at: iso(-5 * 24 * 60) } }],
      next: { account: "b", how: "auto", why: "most week left per hour" } },
    account_preference: "auto",
  }, iso(6));
  // T-304: the steps mts keeps beside a run note, as the note holds them (one line each: time · step|said · words)
  const feedOf = (id: string, run: string, lines: [number, "step" | "said", string][]) => note(id, `Runs/Steps/2026-10-20 ${run}`, ["run-feed"], { run_note: run },
    iso(lines[lines.length - 1]?.[0] ?? 0));
  const feedContent = (lines: [number, "step" | "said", string][]) => "# Steps\n\nWhat the session did, newest last. Written by mts while it runs.\n\n" +
    lines.map(([ago, kind, text]) => `- ${iso(ago)} · ${kind} · ${text}`).join("\n") + "\n";
  const EVENTS: [number, "step" | "said", string][] = [
    [46, "said", "I'll start from the events page as it stands, then make the cards read like notices pinned to a board."],
    [45, "step", "Reading EventsPage.tsx"], [43, "step", "Searching the code"], [40, "step", "Editing EventCard.tsx"],
    [36, "said", "The cards now keep the co-op's own words. Next: a column layout that wraps like a noticeboard on a phone."],
    [33, "step", "Editing events.css"], [30, "step", "Running pnpm"], [27, "step", "Running vite"],
    [22, "said", "Tests and the build pass. One card had a very long title; it now wraps instead of running off the edge."],
    [18, "step", "Editing EventCard.tsx"], [12, "step", "Running pnpm"],
    [6, "said", "Recording the walkthrough on a phone and a desktop now. The token=abc123 in the old config is gone."],
    [4, "step", "Updating its to-do list"], [2, "step", "Running npx"],
  ];
  const ABOUT: [number, "step" | "said", string][] = [[3 * 24 * 60 + 5, "said", "Reading the coordinator's letter first."], [3 * 24 * 60 - 60, "step", "Writing ABOUT.md"], [3 * 24 * 60 - 69, "said", "Done. The page is in her words."]];
  const feeds = [{ ...feedOf("feed-events", "run-events", EVENTS), content: feedContent(EVENTS) }, { ...feedOf("feed-about", "run-about", ABOUT), content: feedContent(ABOUT) }];
  return { nodes, runs, tasks, usage, feeds };
}
