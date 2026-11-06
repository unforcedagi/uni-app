import { ProjectGaps } from "../projects/ProjectStrip";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TaskSheet, UndoBar, ownerLabel } from "./NodeWork";
import { useTasks } from "./useTasks";
import { draftsUnder, runsUnder, type Run } from "./steerCore";
import { CompanionBody, Stands, type CompanionProps, type TaskLoad } from "./Companion";
import { chatPlaceholder, confirmationOf, type Resolved, isMine, needsByRow, needsFeed, needsYou, privateNote, withWaiting, withApprovals, standsHeading, standsLine, asOfDate, daysSince, firstSentence, stateLine, uniPanel, type PrivateNeed } from "./simpleCore";
import { ownRoom, roomByName, type Steward } from "./talkCore";
import type { Area } from "./areasCore";
import { isMe, priorityOf, tasksUnder, type Task, type TaskNode } from "./taskCore";
import type { RoomInfo } from "./TodayView";
import { refreshDraft } from "./briefCore";
import AreaView, { type AppView, type AreaActions } from "./AreaView";
import type { AreaRoom } from "./AreaChat";
import { currentUserAgent, gateMode, platformName } from "../interface/selftest/gate";
import { useAppVersion, useWebviewRuntime } from "../interface/selftest/useAppVersion";
import { useAreas } from "./useAreas";
import { pickRoom } from "./areaLayout";
import { childrenOf, parentPath, ROOT, rootNode, trail, UNI_CHANNEL } from "./treeCore";
import { findUniRoom } from "../uniActions";
import { useStoredSelfTest } from "../interface/selftest/useSelfTest";
import { rolledNeeds } from "./sidebarState";
import { useRailHidden, useWide } from "./homeLayout";
import { isPrivatePath, isPrivateRoom, privateRoot, privateRootIn, roomSlug, roomView, treeRows } from "./treeRooms";
import { publishRoomNodes, roomNodeMap } from "./roomLabels";
import { approvalsAt, rolledUnread, unreadByPath, unreadByRoom } from "./roomUnread";
import { useNav } from "../navContext";
import { useVaultProfile } from "./ProfileContext";
import { Crumbs, TreeScreen } from "./TreeHome";
import { ToPostLine } from "../post/ToPost";
import { showUniGlue } from "./profile";
import { WorkView } from "./WorkView";
import { Body } from "../MessageBody";
import { projectBody } from "./projectBody";
import { onRootOpen, rootOpenMemory, setRootOpenMemory } from "./rootMemory";
import { publishDecisions, setDecidedHook, setDecisionOpener } from "../decisionLinks";
import { taskTitle } from "./whereCore";
import type { NoteRef } from "./noteRefsCore";
import { ApprovalElsewhere, ApprovalRows } from "./ApprovalRows";
import { ApprovalsContext, useApprovalList } from "../approvalsLive";
import type { Approval } from "../approvals";
import "./areas.css";
import type { AllRoom } from "../all/AllView";
import { AllFocusSheet, type AllFocusState, type FocusLine, type FocusView } from "../all/AllFocus";
import { AllEmpty, FrontDoor, type Door, type Needs, type NewRoom } from "../projects/FrontDoor";
import { ProjectStrip } from "../projects/ProjectStrip";
import { ProjectSheet } from "../projects/ProjectSheet";
import { plainWords } from "../projects/live";
import "./tree.css";

const USER_AGENT = currentUserAgent();
const PLATFORM = platformName(USER_AGENT);

/** The note for a room no node owns: its details say so instead of a node's state. */
export const UNFILED = "Not filed under an area yet.";

/** What the host does for the surface: as an area app's actions, except that a note is opened in its own vault (r15), and a room opens in focus
 *  over All (at a message, with the request sheet's question kept over its composer, for the place that talks there, at its details). */
export type ShellActions = Omit<AreaActions, "openNote" | "openRoom"> & { openNote(ref: NoteRef): void;
  openRoom(id: string, focus?: string | null, checking?: string | null, place?: { path?: string | null; view?: FocusView }): void;
  /** T-335 one surface: inside the focus, the conversation, the room's details, all of its work, or its app */
  focusView?: (view: FocusView) => void;
  /** r21 (Codex 9): read the rooms list again (a conversation slow to open before its room is known) */
  retryRooms?: () => void;
  /** r24: scroll to and mark a message of the room open now ("Check in #room first" goes to the first message about the request) */
  focusMessage?: (ref: string | null, room?: string, checking?: string | null) => void;
  /** T-335: the All composer has the keyboard (a phone's bottom bar steps aside, as for a room's) */
  composerFocus?: (on: boolean) => void;
  /** T-335: open the To post queue (one area's posts when `node` is given) */
  openPosts?: (node?: string | null) => void };

/** What is open over the place (a task sheet, a project): Android Back and Alt+← close it first, and it holds Alt+arrow history while open. */
export type Overlay = { close: () => void; modal: boolean; history: boolean };

/** r28: the rechecks are logged once per launch (the module lives as long as the app does) */
const recheckLogged = { done: false };
/** After this long a conversation still opening says so, with a way to try again (r21, Codex 9). */
const CHAT_SLOW_MS = 8000;
/**
 * The conversation's place while it opens (r21, Codex 9): a quiet chat, shaped like the one coming (an empty conversation and its composer's
 * line, greyed), never a status panel beside an empty column. Past 8 seconds it says it is still opening, with Retry.
 */
function ChatWait({ placeholder, retry }: { placeholder: string; retry: (() => void) | null }) {
  const [slow, setSlow] = useState(false);
  const [tries, setTries] = useState(0);
  useEffect(() => { const t = setTimeout(() => setSlow(true), CHAT_SLOW_MS); return () => clearTimeout(t); }, [tries]);
  return <div className="sr-chat-wait" aria-busy="true">
    <p className="sr-chat-wait-line" role="status">{slow ? <>Still opening the conversation{retry && <> · <button type="button" className="cp-retry" onClick={() => { setSlow(false); setTries(tries + 1); retry(); }}>Retry</button></>}</> : "Opening the conversation…"}</p>
    <div className="sr-chat-wait-composer" aria-hidden="true">{placeholder}</div>
  </div>;
}

/** T-140: the area a node was reached through (a project linked to two areas sits under both); its crumbs and Back go there. */
const viaMemory: { path: string | null; via: string | null } = { path: null, via: null };

/**
 * T-335 one surface. With rooms: Uni's home (the places, what needs you, the composer that routes) and All, with a room in focus over it. Every
 * room is shown in that focus and nowhere else; its details (what needs you, its summary, its projects and sessions, all of its work, its app)
 * are a step inside it. Without rooms (a vault whose profile has no chat): the tree of its places, and each place's work.
 */
export default function AreasSurface({ allPlace = null, identity, path, rooms: hostRooms, roomsPending = false, actions, roomFor, onOpenArea, onBackChange, onOverlayChange }: {
  /** T-335: this surface is the All place: every area's room at once, the room in focus over it, and the way back to Uni. */
  allPlace?: { backTo: string; from?: { path?: string; channel?: string } | null; onBack: () => void;
    /** The room in focus over All, and how to put one there (at a message, in a thread, for a place); how it ends; its steps. */
    focus: AllFocusState | null; onFocus: (room: string, ref?: string | null, root?: string | null, place?: { path?: string | null; view?: FocusView }) => void;
    /** Ends the focus (a tap on All behind it). */ onUnfocus: () => void; /** One step back inside the focus, the last one to All. */ onFocusBack: () => void;
    /** The conversation, the room's details, its work, its app. */ onView: (view: FocusView) => void } | null;
  identity: string | null;
  /** T-200: a note is open beside the conversation (the host's layout says so; nothing here changes for it now). */
  noteBeside?: boolean;
  /** A vault without rooms: the place whose work is shown (null: the tree). */
  path: string | null;
  rooms: RoomInfo[]; actions: ShellActions;
  /** The rooms list has not arrived yet (a fresh start): the focus waits for it instead of saying "no room". */
  roomsPending?: boolean;
  /** The host's room view for a room id (or one of its threads, by root): its messages and composer, when that is the one loaded. */
  roomFor: (id: string | null | undefined, threadRoot?: string | null) => AreaRoom | null;
  /** A vault without rooms: open a place's work (path null: the tree) in this tab. */
  onOpenArea: (areaPath: string | null, name: string, room: string | null) => void;
  onBackChange: (back: (() => void) | null) => void;
  /** What is over the place, so the host's Back (Alt+←, Android Back) closes it before it changes places. */
  onOverlayChange?: (o: Overlay | null) => void;
}) {
  // chat.provider null: no Buzz on this surface. No rooms are known here, so nothing resolves a steward, loads messages or opens a room.
  const profile = useVaultProfile();
  const chat = profile.chat.provider === "buzz";
  /** A note named by path or id in this vault (a brief's link, the area app's), opened in this vault, never in another. */
  const openHere = (ref: string) => actions.openNote({ vault: profile.vault, id: ref });
  // T-335: the To post queue's quiet count, on Uni's vault only (posts are Uni glue): the home, and each area's work
  const postsLine = (node: string | null) => actions.openPosts && showUniGlue(profile.vault)
    ? <ToPostLine vault={profile.vault} node={node} onOpen={() => actions.openPosts!(node)} /> : null;
  const appActions: AreaActions = { ...actions, openNote: openHere, openRoom: (id: string) => actions.openRoom(id) };
  const rooms = useMemo<RoomInfo[]>(() => (chat ? hostRooms : []), [chat, hostRooms]);
  const { data, error, loading, signingIn, retry: retryAreas } = useAreas(identity);
  const nav = useNav();
  const wide = useWide();
  /** One rule for global navigation (r14): the app's places show on the home whenever the rail is hidden. */
  const railHidden = useRailHidden();
  const approvalsAll = useApprovalList();
  const version = useAppVersion();
  const runtime = useWebviewRuntime();
  const stored = useStoredSelfTest();
  // Live: a self-test pass (or a revoke) updates an already-open area without a remount.
  const mode = useMemo(() => gateMode(PLATFORM, version, stored, USER_AGENT, undefined, runtime), [version, stored, runtime]);
  const uniRoom = useMemo(() => (rooms.some((r) => r.id === UNI_CHANNEL) ? UNI_CHANNEL : findUniRoom(rooms)?.id ?? null), [rooms]);
  const root = useMemo(() => rootNode(uniRoom ? [uniRoom] : []), [uniRoom]);
  const roomRefs = useMemo(() => rooms.map((r) => ({ id: r.id, name: r.name })), [rooms]);
  const uniRef = useMemo(() => roomRefs.find((r) => r.id === uniRoom) ?? null, [roomRefs, uniRoom]);
  /** A node that names its room only by `room` (no channel id) still opens that room. */
  const withRoom = (a: Area): Area => { if (!chat) return a.rooms.length ? { ...a, rooms: [] } : a; if (a.rooms.length) return a; const r = ownRoom({ room: typeof a.metadata.room === "string" ? a.metadata.room : null, channels: [] }, roomRefs); return r ? { ...a, rooms: [r.id] } : a; };
  // which node owns each room; with the areas unreadable (an error, not a load still under way) only Uni's room is known to be owned
  const owned = useMemo(() => (!chat ? null : data ? roomNodeMap(data.tree, roomRefs, uniRef) : error && !loading ? new Map(uniRef ? [[uniRef.id, { name: "Uni", path: ROOT }]] : []) : null), [data, chat, error, loading, roomRefs, uniRef]);
  useEffect(() => { if (owned) publishRoomNodes(owned); }, [owned]);
  /** The room in focus over All (while it leaves too: it is drawn until it has gone). */
  const focus = allPlace?.focus ?? null;
  /** The place the focus is for: the one it was opened for (a place borrowing the room), else the room's own node. None: a room no node owns. */
  const focusPath = focus ? focus.path ?? owned?.get(focus.room)?.path ?? null : null;
  /** Phone, a vault without rooms: the tree is the home and Uni's own level (all of the work) opens from it. */
  const [rootOpen, setRootOpenState] = useState(rootOpenMemory.open);
  const setRootOpen = (v: boolean) => setRootOpenMemory(v);
  useEffect(() => onRootOpen(setRootOpenState), []);
  // the level shown: the focus's place (with rooms), or the place whose work is open (without)
  const levelPath = chat ? (allPlace ? focusPath : null) : path ?? (rootOpen ? ROOT : null);
  const found = levelPath === null ? null : levelPath === ROOT ? root : data?.tree.nodes.get(levelPath) ?? null;
  const node = found ? withRoom(found) : null;
  /** A project's own note, read when its work is shown (it is there, folded). */
  const [body, setBody] = useState<string | null>(null);
  /** The open task, by id: the sheet always shows the list's current copy (r13), and says so when the task has closed elsewhere. */
  const [sheetId, setSheetId] = useState<string | null>(null);
  const lastSheet = useRef<Task | null>(null);
  const openSheet = (t: Task) => { lastSheet.current = t; setSheetId(t.id); };
  const closeSheet = () => { setSheetId(null); };
  const via = viaMemory.path === path ? viaMemory.via : null;
  /** T-301/T-302: a project (or the Unfiled sessions) opened in place, over the room or the home. */
  const [projectOpen, setProjectOpen] = useState<string | null>(null);
  const closeProject = () => setProjectOpen(null);
  /** A vault without rooms: the place's app, shown in its page's place (Back closes it). */
  const [appOpen, setAppOpen] = useState(false);
  const focusView: FocusView = focus?.view ?? "chat";
  /** Without rooms, a place's page is its work; with rooms, the focus's "all of its work" step. */
  const workShown = !chat ? !!node : focusView === "work";
  const back = chat ? null : path ? () => {
    const up = data ? data.tree.nodes.get(parentPath(data.tree, path, via)) : null;
    if (up && up.path !== ROOT) onOpenArea(up.path, up.name, null); else { setRootOpen(false); onOpenArea(null, "Uni", null); }
  } : rootOpen ? () => setRootOpen(false) : null;
  const overlay: Overlay | null = projectOpen ? { close: closeProject, modal: true, history: false } : sheetId ? { close: closeSheet, modal: true, history: false }
    : appOpen && !chat ? { close: () => setAppOpen(false), modal: false, history: true } : null;
  const overlayKey = `${projectOpen ? "project" : ""}${sheetId ? "sheet" : ""}${appOpen && !chat ? "app" : ""}`;
  // (layout effects: what is over the place is known to the host's Back before the first key can reach it)
  useLayoutEffect(() => {
    onBackChange(projectOpen ? closeProject : sheetId ? closeSheet : appOpen && !chat ? () => setAppOpen(false) : back);
    return () => onBackChange(null);
  }, [path, data, onBackChange, overlayKey, rootOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => { onOverlayChange?.(overlay); }, [overlayKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onOverlayChange?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setBody(null);
    if (!identity || node?.kind !== "project" || !workShown) return;
    let live = true;
    projectBody(identity, node).then((text) => { if (live) setBody(text); }).catch(() => {});
    return () => { live = false; };
  }, [identity, node?.id, node?.updatedAt, workShown]); // eslint-disable-line react-hooks/exhaustive-deps
  // A node can have several rooms (metadata.channel is a list): its app hears the first.
  const nodeRoom = node ? pickRoom(node.rooms, null) : null;
  const roomName = useMemo(() => (id: string) => rooms.find((r) => r.id === id)?.name ?? "room", [rooms]);
  const now = Date.now();
  const fallback = useMemo<TaskNode[]>(() => (data?.areas ?? []).map((a) => ({ id: a.id, path: a.path, name: a.name, parent: a.parent, links: a.links, kind: a.kind, room: typeof a.metadata.room === "string" ? a.metadata.room : null, status: a.status === "archived" || a.status === "done" ? a.status : "active", isRoot: false })), [data?.areas]);
  // The whole tree's tasks are loaded once (the home's counts need every place's) and each level takes its subtree.
  const tasks = useTasks(identity, "", fallback);
  const levelTasks = useMemo(() => (tasks.tree && node ? tasksUnder(tasks.tree, node.path, tasks.tasks) : tasks.tasks), [tasks.tree, tasks.tasks, node?.path]); // eslint-disable-line react-hooks/exhaustive-deps
  // r17: the chat knows the open decisions (never a private area's): a message naming one gets its card; T-212: each with its room (its own
  // `room`, else its node's), where an open decision no message on screen names is listed under the chat
  useEffect(() => {
    const tree = data?.tree;
    const roomOf = (t: { room?: string | null; node: string }) => roomByName(roomRefs, t.room)?.id ?? (tree ? roomView(tree, t.node, roomRefs, uniRef).target?.id : null) ?? null;
    publishDecisions((tasks.all ?? []).filter((t) => t.kind === "decision" && t.state === "open" && !(tree && privateRoot(tree, t.node))).map((t) => ({ id: t.id, tid: taskTitle(t.title).id, forTask: t.forTask ?? null, channel: roomOf(t) })));
  }, [tasks.all, data?.tree, roomRefs, uniRef]);
  useEffect(() => { setDecisionOpener((id) => { setSheetId(id); }); return () => setDecisionOpener(null); }, []);
  const refreshTasks = useRef(tasks.refresh); refreshTasks.current = tasks.refresh;
  useEffect(() => { setDecidedHook(() => refreshTasks.current()); return () => setDecidedHook(null); }, []);
  /** The task list's health, for the details and the tree. */
  const load: TaskLoad = { error: tasks.error, treeError: tasks.treeError, refreshing: tasks.refreshing, lastOk: tasks.lastOk, complete: tasks.complete, retry: tasks.refresh, savedAt: tasks.savedAt, slow: tasks.slow };
  /** "Other rooms": every room no node owns (not Uni's), by name. Known only once the tree is: before that, nothing is listed as unfiled. */
  const others = useMemo(() => (owned ? roomRefs.filter((r) => !owned.has(r.id) && r.id !== uniRoom).sort((a, b) => a.name.localeCompare(b.name)) : []), [owned, roomRefs, uniRoom]);
  // Opening a room re-reads the tasks if the copy is more than a few seconds old (the needs-you feed must not show what is already done).
  useEffect(() => { tasks.refreshIfStale(); }, [node?.path, focus?.room]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setSheetId(null); setProjectOpen(null); setAppOpen(false); }, [node?.path, focus?.room]); // eslint-disable-line react-hooks/exhaustive-deps
  /** Who stewards a node: its own room, else the nearest ancestor's (an archived room's `room_fallback` stands in), else #Uni. */
  const stewardOf = (p: string): Steward => {
    const v = data ? roomView(data.tree, p, roomRefs, uniRef) : { target: uniRef, own: false, heldBy: uniRef };
    return { room: v.target, via: v.own ? "own" : v.heldBy && v.heldBy.id !== uniRef?.id ? "inherited" : "uni", from: null };
  };
  const roomOfNode = (p: string) => stewardOf(p).room;
  // r31: an ask is current because its task note says so (`asked_at` / `confirmed_at` within 3 days), resolved here before any row, count or dot shows it.
  const confirmNow = useMemo(() => Date.now(), [tasks.tasks, tasks.lastOk]); // eslint-disable-line react-hooks/exhaustive-deps
  const confirm = useMemo(() => ({ of: (t: Task): Resolved => confirmationOf(t, confirmNow) }), [confirmNow]);
  // r28: the asks Uni must recheck are told to the rooms once per launch, as task ids in the app's log (the app never writes them to the vault)
  useEffect(() => {
    if (!tasks.ready || tasks.savedAt || recheckLogged.done) return;
    const ids = tasks.tasks.filter((t) => needsYou(t) && confirm.of(t).state === "recheck").map((t) => taskTitle(t.title).id).filter(Boolean) as string[];
    recheckLogged.done = true;
    void invoke("log_line", { line: `recheck: ${ids.join(" ") || "none"}` }).catch(() => {});
  }, [tasks.ready, tasks.tasks, tasks.savedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const decide = (t: Task, o: string) => void tasks.decide(t, o);
  /**
   * A place, from anywhere (the home's places, what needs you there, a place inside another, a crumb): with rooms, the room it talks in, in focus
   * over All, for that place (`view`: its details first); without, its work.
   */
  const openPlace = (p: string, view: FocusView = "chat", through?: string | null) => {
    viaMemory.path = p; viaMemory.via = through ?? null;
    if (!chat) {
      if (p === ROOT) { setRootOpen(true); onOpenArea(null, "Uni", null); return; }
      const n = data?.tree.nodes.get(p); if (n) { setRootOpen(false); onOpenArea(n.path, n.name, null); }
      return;
    }
    const n = p === ROOT ? root : data?.tree.nodes.get(p);
    const room = p === ROOT ? uniRef : n ? stewardOf(p).room ?? (n.channels[0] ? { id: n.channels[0], name: "" } : null) : null;
    if (room) actions.openRoom(room.id, null, null, { path: p, view });
  };
  // T-302 round 2: #Uni is archived, so with chat the tree has no Uni row. A profile without chat keeps its root row: Uni's level is its only view of all the work.
  const navRows0 = data ? treeRows(data.tree, roomRefs, uniRef) : [{ key: "~uni", via: null, path: ROOT, name: "Uni", depth: 0, kind: "root" as const, slash: uniRef ? uniRef.name : null, heldBy: null, heldNode: null, own: !!uniRef, trunk: [], last: true }];
  const navRows = chat ? navRows0.filter((r) => r.kind !== "root") : navRows0;
  /** A row's count is its own node's needs-you items (a parent never counts its children's), by the details' one rule. */
  const rowPaths = useMemo(() => new Set(navRows.map((r) => r.path)), [navRows.map((r) => r.path).join("\n")]); // eslint-disable-line react-hooks/exhaustive-deps
  const navNeeds = useMemo(() => needsByRow(tasks.tasks, rowPaths, (p) => tasks.tree?.parent.get(p) ?? data?.tree.parent.get(p), confirm.of, tasks.runs), [tasks.tasks, tasks.runs, rowPaths, tasks.tree, data?.tree, confirm.of]); // eslint-disable-line react-hooks/exhaustive-deps
  // T-335: what is new in each room (the rooms list's counts; opening a room marks it read, which clears them), and the approvals waiting in each
  const newByRoom = useMemo(() => unreadByRoom(rooms), [rooms]);
  const newByPath = useMemo(() => unreadByPath(newByRoom, owned ?? new Map()), [newByRoom, owned]);
  const asksAt = useMemo(() => approvalsAt(approvalsAll.list, owned), [approvalsAll.list, owned]);
  /** The app's own places (Journal, Vault, Search, Settings), for where the rail is out of reach. */
  const places = nav?.places ?? [];
  const placesRow = railHidden && places.length > 0 && <nav className="th-places" aria-label="App">{places.map((p) => <button key={p.label} type="button" className="th-place" onClick={() => p.go()}>{p.label}</button>)}</nav>;
  const tree = data?.tree;
  const status = <>
    {signingIn && !data && <p className="areas-status" role="status">Signing in…</p>}
    {data?.stale && <p className="areas-status" role="status">{error ? `Saved copy${data.savedAt ? ` from ${new Date(data.savedAt).toLocaleString()}` : ""} · couldn't refresh: ${error}` : "Saved copy · refreshing…"}</p>}
    {!data && error && <p className="note-error" role="alert">Couldn't load areas: {error}</p>}
    {!!data?.truncated.length && <p className="areas-status" role="status">{data.truncated.join(", ")}: showing first 200 notes; more may exist.</p>}
  </>;

  // ------------------------------------------------------------------------------------------ the place's level: what needs you, its work (r13)
  // (the focus's details with rooms; the place's page without)
  const isRoot = node?.path === ROOT;
  const stewardView: Steward | null = !node ? null : isRoot ? { room: uniRef, via: "own", from: null } : stewardOf(node.path);
  const target = stewardView?.room ?? null;
  const nodeName = (p: string) => data?.tree.nodes.get(p)?.name ?? p.split("/").pop() ?? p;
  const here = !node || isRoot ? "" : node.path;
  const rowOf = (p: string) => (tree ? roomView(tree, p, roomRefs, uniRef) : { target: uniRef, slash: null, heldBy: uniRef, own: false, heldNode: null });
  const nodeView = node ? rowOf(node.path) : null;
  /** A node with no room of its own talks in an ancestor's (or Uni's) (r15): the node stays the heading, and one line says where it talks. */
  const borrowed = chat && node && !isRoot && nodeView && !nodeView.own && nodeView.heldBy ? `#${roomSlug(nodeView.heldBy.name)}` : null;
  const askRoom = target?.id ?? null;
  // r21: before the areas are read, privacy is read from the task tree, and nothing is listed while neither is known
  const privateOf = (p: string) => (tree ? privateRoot(tree, p) : tasks.tree ? privateRootIn(tasks.tree, p) : null);
  const privacyKnown = !!tree || !!tasks.tree;
  /** The private area this level is, or sits in: Aaron opened it himself, so its own items show as they are (r14). */
  const selfPrivate = node ? privateOf(node.path) : null;
  /** A private area's words are never shown outside it: not in Uni's panel, a parent's list, runs, drafts or the summary. */
  const hidden = (p: string) => { const r = privateOf(p); return !!r && r.path !== selfPrivate?.path; };
  // r23: each row knows the room that stewards it, as its sheet does ("Ask #techne for the message")
  const drafted = new Set(tasks.drafts.map((d) => d.task?.toUpperCase()).filter(Boolean));
  const feed0 = needsFeed(levelTasks.map((t) => ({ ...t, stewardRoom: roomOfNode(t.node)?.name ?? null, hasDraft: drafted.has(taskTitle(t.title).id?.toUpperCase()) })), privateOf, selfPrivate, undefined, confirm.of);
  const taskTree = tasks.tree;
  const runs = taskTree && node ? runsUnder(taskTree, here, tasks.runs).filter((r) => !hidden(r.node)) : [];
  // r28 (Codex P2-6): a run waiting on the user's answer is in the same feed, counted once with the asks; T-161: Uni's level holds every room's approval prompts
  const feed = withApprovals(withWaiting(feed0, runs), approvalsAll.list.filter((a) => isRoot || a.channel === target?.id));
  const panel = isRoot ? uniPanel(feed) : { ...feed, rest: 0, privateCount: 0 };
  const drafts = taskTree && node ? draftsUnder(taskTree, here, tasks.drafts).filter((d) => !hidden(d.node)) : [];
  const openPrivate = (o: PrivateNeed["open"]) => { closeSheet(); openPlace(o.path, "details"); };
  // r18: one summary for the details and the work: the node's `stands`, else its brief's "Now" (with the brief's own time), else the newest change it names
  const brief = node && !isRoot ? data?.briefs[node.path] ?? null : null;
  const briefStands = brief?.brief.now ? { text: brief.brief.now, at: brief.generatedAt ?? brief.updatedAt ?? null } : null;
  const rawStands = !node ? null : tasks.tree?.stands.get(node.path) ?? (typeof node.metadata.stands === "string" ? { text: node.metadata.stands, at: typeof node.metadata.stands_at === "string" ? node.metadata.stands_at : null } : briefStands);
  /** A vault with no areas yet: Uni says how to start, in plain words (r13). */
  const noAreas = isRoot && !!tree && !error && childrenOf(tree, ROOT).length === 0;
  const stands0 = !node ? null : noAreas ? { text: "No areas yet. Tell Uni here what you want to look after, and it will set up your first area.", ago: "" } : standsLine(rawStands, levelTasks.filter((t) => !hidden(t.node)), now);
  /** r29 (Codex P1-3): a written summary is a dated account: "Last written Oct 14 by #room:" and the text as written. The app doesn't judge whether it still holds. */
  const written = !noAreas && !!rawStands && !!firstSentence(rawStands.text);
  const stands = stands0 && !noAreas ? { ...stands0, written, asOf: written ? asOfDate(rawStands!.at) : null, age: written ? daysSince(rawStands!.at) : null, by: written ? target?.name ?? null : null } : stands0;
  /** The room's composer when it is the one here, else that room's (opened, filled in, never sent). */
  const sayIn = (roomId: string, text: string) => { closeSheet(); closeProject(); const r = roomFor(roomId); if (r && roomId === focus?.room) { allPlace?.onView("chat"); r.compose(text); } else actions.compose(roomId, text); };
  /** From the details or a sheet, "Open #room" for this room is its conversation; another room comes into focus in its place. */
  const openRoomHere = (id: string, at?: string | null, checking?: string | null) => {
    closeSheet(); closeProject();
    if (chat && focus && id === focus.room) { allPlace?.onView("chat"); if (at || checking) actions.focusMessage?.(at ?? null, id, checking ?? null); }
    else actions.openRoom(id, at, checking);
  };
  /** r31: the run's room is its `channel` id, exactly; a run with only a room name is that name, exactly; a run with neither is its node's room. */
  const runRoom = (r: Run) => r.channel ? rooms.find((x) => x.id === r.channel) ?? null : r.room ? rooms.find((x) => x.name.replace(/^#/, "").toLowerCase() === r.room!.toLowerCase()) ?? null : roomOfNode(r.node) ?? target;
  const runMissing = (r: Run) => !roomsPending && rooms.length > 0 && !!(r.channel || r.room) && !runRoom(r);
  /** r30: a run waiting on the user's answer, or an approval prompt, opens its room at that message with the composer ready, writing nothing */
  const openAt = (room: { id: string; name: string }, message: string | null) => {
    closeSheet(); closeProject();
    if (focus && room.id === focus.room) { allPlace?.onView("chat"); roomFor(room.id)?.compose(""); if (message) actions.focusMessage?.(message, room.id, null); }
    else actions.openRoom(room.id, message);
  };
  const openRun = (r: Run) => { const room = runRoom(r); if (room) openAt(room, r.message ?? null); };
  const openApproval = (a: Approval) => { const room = rooms.find((x) => x.id === a.channel); if (room && !a.root) openAt(room, a.ref); else approvalsAll.open(a); };
  const live = sheetId ? tasks.all?.find((t) => t.id === sheetId) ?? null : null;
  if (live) lastSheet.current = live;
  const sheetTask = sheetId ? live ?? (lastSheet.current?.id === sheetId ? lastSheet.current : null) : null;
  const sheetGone = !!sheetId && (!live || !(live.state === "open" || live.state === "doing" || live.state === "waiting") || (tasks.ready && !tasks.tasks.some((t) => t.id === sheetId) && !tasks.leaving.has(sheetId)));
  /** r18: a draft note written for the task (its `task` field names it): its text is the message the sheet copies. */
  const draftOf = (t: Task) => { const tid = taskTitle(t.title).id?.toUpperCase(); const d = tid ? tasks.drafts.find((x) => x.task?.toUpperCase() === tid) : null; return d ? { vault: t.vault ?? profile.vault, id: d.id } : null; };
  const sheetView = sheetTask && <TaskSheet key={sheetTask.id} task={sheetTask} gone={sheetGone} here={here} nodeName={nodeName} room={roomOfNode(sheetTask.node) ?? target} roomNamed={(n) => rooms.find((r) => r.name.replace(/^#/, "").toLowerCase() === n.replace(/^#/, "").toLowerCase()) ?? null} inRoom={focus?.room ?? target?.id} onClose={closeSheet}
    draft={draftOf(sheetTask)} confirmation={confirm.of(sheetTask)}
    onAct={(t, a) => tasks.act(t, a, { sheet: true })} onDecide={(t, o) => tasks.decide(t, o)} onNote={actions.openNote} onOpenRoom={openRoomHere} onSay={chat ? sayIn : undefined} onPriority={(t, p) => void tasks.setPriority(t, p)} onStale={tasks.refresh} />;
  /** r20: a row's area when it is shown outside it (Uni's list holds every area's): its subtitle names it when its title can't say where it is. */
  const placeOf = (t: Task) => (t.node !== here ? nodeName(t.node) : null);
  const toWork = () => { closeSheet(); allPlace?.onView("work"); };
  const companionProps: CompanionProps | null = node ? { stands, ready: tasks.ready && privacyKnown, load, feed: panel, rest: panel.rest, moreTitle: privateNote(panel.privateCount), onPrivate: openPrivate, runs, nodeName: node.name, scope: borrowed ? node.name : null, onTask: openSheet, onRun: openRun, runMissing, scopeAll: isRoot, onNote: actions.openNote, onDecide: decide, placeOf, onEverything: chat ? toWork : null } : null;
  const othersHere = levelTasks.filter((t) => !isMine(t) && !hidden(t.node)).map((t) => ({ task: t, meta: [stateLine(t, (w) => isMe(w), ownerLabel), isMe(t.owner) ? null : `with ${ownerLabel(t.owner)}`, t.node !== here ? `in ${nodeName(t.node)}` : null].filter(Boolean).join(" · ") }));
  const later = levelTasks.filter((t) => isMine(t) && t.kind !== "decision" && priorityOf(t) === "someday" && !hidden(t.node));
  // r19: everything in another private area that isn't in its "N for you" line (a record to tidy there included)
  const privateOther = levelTasks.filter((t) => hidden(t.node) && !needsYou(t)).length;
  // r18: the work says where this stands with the details' own sentence, heading and date ("Where this stands · 2 days ago")
  const top = node && (stands || askRoom) ? <div className="wv-top">
    {stands && <><h3 className="cp-h wv-stands-h">{standsHeading(borrowed ? node.name : null, stands.ago, "asOf" in stands ? stands.asOf : null)}</h3><Stands stands={stands} className="th-lede wv-brief" /></>}
    {askRoom && <p className="th-fresh wv-fresh"><button type="button" className="th-link" onClick={() => actions.compose(askRoom, refreshDraft(node.name, isRoot ? "" : node.path))}>Ask Uni to update this summary</button></p>}
  </div> : null;
  const foot = node?.kind === "project" && body ? <details className="th-note wv-note"><summary>Project note</summary><Body body={body} mentions={[]} me={null} /></details> : null;
  const workTop = !node || isRoot || (tree && privateRoot(tree, node.path)) ? top : <>{top}{postsLine(node.path)}</>;
  const workMain = node ? <><WorkView nodeName={node.name} feed={feed} others={othersHere} later={later} runs={runs} drafts={drafts} privateOther={privateOther} ready={tasks.ready && privacyKnown} load={load} activity={tasks.activity}
    onTask={openSheet} onRun={openRun} runMissing={runMissing} scopeAll={isRoot} onDecide={decide} onNote={actions.openNote} onPrivate={openPrivate} placeOf={placeOf} top={workTop} foot={foot} />{!isRoot && <ProjectGaps areaPath={node.path} />}</> : null;
  // T-301/T-302: the area's projects (and their sessions), each opened in place over the room
  const strip = node && !isRoot ? <ProjectStrip areaPath={node.path} onOpen={(id) => { closeSheet(); setProjectOpen(id); }} /> : null;
  // the timeline's talk is the area's own room only (never a borrowed one's)
  const projectSheet = projectOpen ? <ProjectSheet key={projectOpen} project={projectOpen} room={target ? { id: target.id, name: target.name } : null} roomName={(id) => roomRefs.find((r) => r.id === id)?.name ?? null} talk={nodeView?.own ? (roomFor(target?.id)?.messages ?? []).map((m) => m.ts * 1000) : []} onClose={closeProject}
    onAnswer={chat ? (roomId, text) => { closeProject(); sayIn(roomId, text); } : undefined} /> : null;

  // ------------------------------------------------------------------------------------------ with rooms: Uni's home, and All with a room in focus
  if (chat) {
    // T-301/T-302: the home. Every area's room, each with one line on where it stands (a private area's own words stay inside it), a mark where
    // sessions are working, and a quiet usage line.
    const doorAreas = data ? childrenOf(data.tree, ROOT) : [];
    const doors: Door[] = doorAreas.map((a) => {
      const v = roomView(data!.tree, a.path, roomRefs, uniRef);
      const i = navRows.findIndex((r) => r.path === a.path && r.depth === 1);
      const raw = isPrivatePath(data!.tree, a.path) ? null : tasks.tree?.stands.get(a.path)?.text ?? (typeof a.metadata.stands === "string" ? a.metadata.stands : null);
      const st = raw ? plainWords(raw) : null;
      return { path: a.path, name: a.name, about: isPrivatePath(data!.tree, a.path) ? null : a.purpose || null, slug: v.own && v.slash ? v.slash.replace(/^#/, "") : null, stands: st, lastTs: v.own ? rooms.find((r) => r.id === v.target?.id)?.last_ts ?? null : null,
        room: v.own ? v.target?.id ?? null : null,
        // T-335: everything new in the area's rooms (its own and its projects'); what needs you is what its details list: the tasks
        // under it, and the approval prompts in its own room
        ...(i >= 0 ? { unread: rolledUnread(navRows, newByPath, i), needs: rolledNeeds(navRows, navNeeds, i) + (v.own && v.target ? approvalsAll.list.filter((x) => x.channel === v.target!.id).length : 0) } : {}) };
    });
    /** T-335: rooms no area holds (not the archived #Uni) with something new, newest first: each one tap into its room. */
    const newRooms: NewRoom[] = owned ? rooms.filter((r) => !owned.has(r.id) && r.id !== uniRoom && newByRoom.has(r.id)).sort((a, b) => (b.last_ts ?? 0) - (a.last_ts ?? 0)).map((r) => ({ id: r.id, name: r.name, unread: newByRoom.get(r.id)! })) : [];
    // T-302 round 2: what needs you, across the areas, as one quiet line above the rooms (a private area's items stay a count, its words inside)
    const privAt = (p: string) => (data ? privateRoot(data.tree, p) : null) ?? (tasks.tree ? privateRootIn(tasks.tree, p) : null);
    const allNeeds = needsFeed(tasks.tasks, privAt, null, undefined, confirm.of);
    const needs: Needs = {
      rows: allNeeds.rows.map((t) => ({ id: t.id, title: taskTitle(t.title).rest || t.title, where: data?.tree.nodes.get(t.node)?.name ?? null, path: t.node })),
      privates: allNeeds.privates.map((g) => ({ place: g.place, count: g.count, path: g.open.path })),
    };
    // T-335 All view: every area's own room, interleaved, with a composer that routes; a private area stays out of it
    const privateChannel = (channel: string) => !!data && isPrivateRoom(data.tree, channel, roomRefs, uniRef);
    const allRooms: AllRoom[] = doors.filter((d) => d.room && !isPrivatePath(data!.tree, d.path) && !privateChannel(d.room)).map((d) => ({ id: d.room!, name: d.name, slug: d.slug, stands: d.stands, about: d.about ?? null, lastTs: d.lastTs }));
    const openRoomAt = (room: string, ref?: string | null, threadRoot?: string | null) => { if (allPlace) allPlace.onFocus(room, ref ?? null, threadRoot ?? null); else actions.openRoom(room, ref ?? null); };
    const all = allRooms.length ? { rooms: allRooms, onOpenAt: openRoomAt } : null;
    const needsKnown = tasks.error || tasks.truncated || tasks.treeTruncated || (allNeeds.pending ?? []).some((t) => t.askFailed || t.check?.kind === "unavailable") ? "failed" as const : !tasks.ready || tasks.savedAt || (allNeeds.pending?.length ?? 0) > 0 ? "reading" as const : "known" as const;
    const focusRoomOpen = focus && !focus.leaving ? focus.room : null;
    const home = <>{status}<ApprovalRows approvals={allPlace ? approvalsAll.list.filter((x) => !privateChannel(x.channel)) : approvalsAll.list} className="cp-list cp-approvals th-approvals" />
      <FrontDoor needsKnown={needsKnown} alsoNeeds={approvalsAll.list.length} onRetryNeeds={tasks.refresh} doors={doors} needs={needs} onOpen={(p) => openPlace(p)} onOpenNeed={(p) => openPlace(p, "details")} me={identity} newRooms={newRooms} onOpenRoom={(id) => actions.openRoom(id)}
        otherRooms={allPlace ? [] : others} noAreas={!!data && !error && !doorAreas.length ? (uniRef ? () => actions.openRoom(uniRef.id) : null) : undefined}
        toPost={postsLine(null)} all={all} allPlace={allPlace && { backTo: allPlace.backTo, onBack: allPlace.onBack, focusRoom: focusRoomOpen }} onComposerFocus={actions.composerFocus} />
      {railHidden && places.length > 0 && <div className="th-places-short">{placesRow}</div>}</>;
    if (!allPlace) return <div className="areas-home tree-home-wrap">{home}</div>;
    // T-335: All with nothing read yet, or no area with a room of its own: it says which (the focus still comes up over it)
    const behind = all ? home : <AllEmpty reading={signingIn || loading || !data || roomsPending} error={error && !data ? retryAreas : null} onBack={allPlace.onBack} />;
    // T-335 one fluid surface: All, and over it the room in focus
    const focusChat = focus ? roomFor(focus.room, focus.root) : null;
    const focusInfo = focus ? hostRooms.find((r) => r.id === focus.room) ?? null : null;
    const focusSlug = focusInfo ? roomSlug(focusInfo.name) : null;
    const focusName = node && focusPath !== null ? node.name : focusSlug ? `#${focusSlug}` : roomsPending ? "Opening…" : "Room";
    const focusReplies = focus?.root && focusChat?.loaded ? focusChat.messages.filter((m) => m.ref !== focus.root).length : null;
    // the head's one line: where a place that borrows a room talks, else its summary, saying whose; never a private place's words
    const focusPrivate = !!focus && (privateChannel(focus.room) || (!!node && !!tree && isPrivatePath(tree, node.path)));
    const summary = rawStands && firstSentence(rawStands.text) ? plainWords(rawStands.text) : null;
    const line: FocusLine | null = borrowed ? { src: `Talks in ${borrowed} · no room of its own yet`, text: "" }
      : !focusPrivate && summary && node && !isRoot ? { src: focusSlug ? `#${focusSlug}'s summary` : "Summary", text: summary } : null;
    const placeholder = node && nodeView ? chatPlaceholder({ name: node.name, slash: nodeView.own ? nodeView.slash : null, heldBy: nodeView.heldBy ? nodeView.heldBy.name : null }) : focusSlug ? `Message #${focusSlug}` : "Message";
    /** The places inside this one, each one tap into its own room (a project with no room of its own is in the projects above). */
    const inside = node && tree && !isRoot ? childrenOf(tree, node.path).filter((c) => !hidden(c.path) || c.path === selfPrivate?.path).map((c) => ({ c, v: roomView(tree, c.path, roomRefs, uniRef) })).filter(({ v }) => v.own && v.target) : [];
    const sheet = (app: AppView | null, openApp: ((e: React.MouseEvent) => void) | null) => {
      const details = focusView === "work" ? <div className="fx-work">{workMain}</div>
        : focusView === "app" ? (app ? <div className="fx-app">{app.bar}{app.main}</div> : <p className="cp-none">This place has no app.</p>)
        : <div className="fx">
          <div className="cp fx-cp">{node && companionProps ? <CompanionBody {...companionProps} fit={false} /> : <p className="cp-lede cp-note">{UNFILED}</p>}</div>
          {borrowed && <p className="fx-context">{node!.name} has no room of its own yet: it talks in {borrowed}.</p>}
          {strip && <div className="fx-strip">{strip}</div>}
          {inside.length > 0 && <section className="fx-sec" aria-label={`Inside ${node!.name}`}><h3 className="cp-h">Inside {node!.name}</h3>
            <ul className="fx-places">{inside.map(({ c, v }) => <li key={c.path}><button type="button" className="fx-place" onClick={() => actions.openRoom(v.target!.id, null, null, { path: c.path })}><span>{c.name}</span><small>#{roomSlug(v.target!.name)}</small></button></li>)}</ul></section>}
          {(openApp || (node && !isRoot && postsLine(node.path)) || askRoom) && <section className="fx-sec fx-more" aria-label="More">
            {openApp && <button type="button" className="fx-link" onClick={(e) => openApp(e)}>Open the {node!.name} app ›</button>}
            {node && !isRoot && !focusPrivate && postsLine(node.path)}
            {askRoom && node && <button type="button" className="fx-link" onClick={() => { allPlace.onView("chat"); actions.compose(askRoom, refreshDraft(node.name, isRoot ? "" : node.path)); }}>Ask Uni to update this summary</button>}
          </section>}
        </div>;
      return <>
        <button type="button" className="all-focus-scrim" aria-label="Back to All" tabIndex={-1} onClick={allPlace.onUnfocus} />
        <AllFocusSheet key={focus!.room} id={focus!.room} name={focusName} line={line} root={focus!.root} replies={focusReplies} view={focusView} leaving={focus!.leaving} onBack={allPlace.onFocusBack} onView={allPlace.onView} details={details}>
          <ApprovalElsewhere approvals={approvalsAll.list.filter((x) => !privateChannel(x.channel) || x.channel === focus!.room)} here={focus!.room} />
          <div className="sr-chat" data-chat={focusChat ? "open" : "waiting"}>{focusChat ? focusChat.render(null, placeholder, focusName) : <ChatWait placeholder={placeholder} retry={actions.retryRooms ?? null} />}</div>
        </AllFocusSheet>
        <UndoBar undo={tasks.undo} notice={tasks.notice} onDismiss={tasks.dismissNotice} />
        {sheetView}{projectSheet}
      </>;
    };
    const withApp = (inner: (app: AppView | null, openApp: ((e: React.MouseEvent) => void) | null) => ReactNode) => node && !isRoot
      ? <AreaView key={node.id} area={body !== null ? { ...node, body } : node} mode={mode} roomName={roomName} actions={appActions} room={roomFor(nodeRoom)} open={focusView === "app"} onOpen={(v) => allPlace.onView(v ? "app" : "details")} render={inner} />
      : <>{inner(null, null)}</>;
    return <ApprovalsContext.Provider value={{ ...approvalsAll, open: openApproval }}><div className="areas-home tree-home-wrap all-surface" data-focus={focus ? (focus.leaving ? "leaving" : "open") : undefined}>
      <div className="all-behind" inert={!!focus && !focus.leaving}>{behind}</div>
      {focus && withApp(sheet)}
    </div></ApprovalsContext.Provider>;
  }

  // ------------------------------------------------------------------------------------------ without rooms: the tree of places, and each one's work
  const treeProps = { chat, rows: navRows, needs: navNeeds, asks: asksAt.byPath, onOpen: (p: string, through?: string | null) => openPlace(p, "chat", through), others: [], load, needsReady: tasks.ready, unread: newByPath };
  if (!node) {
    if (path === null) return <div className="areas-home tree-home-wrap"><TreeScreen {...treeProps} status={<>{status}{railHidden && places.length > 0 && <div className="th-places-short">{placesRow}</div>}</>} />
      <UndoBar undo={tasks.undo} notice={tasks.notice} onDismiss={tasks.dismissNotice} /></div>;
    // r15: a place that can't be shown (gone, or the areas couldn't be read) says what happened, and the ways on: Retry, Back, Uni
    const gone = !signingIn && !loading && !error;
    const title = signingIn ? "Signing in…" : loading ? "Opening…" : error ? "Couldn't open this area" : "This area no longer exists";
    return <div className="area-view tree-page"><section className="wp" aria-label={title}><header className="wp-head"><h1 className="wp-title">{title}</h1></header>
      <div className="wv sr-missing" role={error ? "alert" : "status"}>
        {error && <p className="cp-none">The areas couldn't be read: {error.replace(/^Error:\s*/, "").slice(0, 160)}</p>}
        {gone && <p className="cp-none">It may have been renamed, moved or archived. It is not in the tree any more.</p>}
        {!signingIn && !loading && <p className="sr-missing-go">
          {error && <button type="button" className="task-do primary" onClick={retryAreas}>Retry</button>}
          {nav?.canBack && <button type="button" className="task-do" onClick={() => nav.back()}>Back</button>}
          <button type="button" className={`task-do${error ? "" : " primary"}`} onClick={() => { setRootOpen(false); onOpenArea(null, "Uni", null); }}>Open Uni</button>
        </p>}
      </div></section></div>;
  }
  const trailItems = [{ path: ROOT, name: profile.title }, ...(tree && !isRoot ? trail(tree, node.path, via) : isRoot ? [] : [node]).map((n) => ({ path: n.path, name: n.name }))];
  const page = (app: AppView | null, openApp: ((e: React.MouseEvent) => void) | null) => <div className="area-view tree-page">
    <section className="wp" aria-label={app ? `${node.name}'s app` : `${node.name}'s work`}>
      <header className="wp-head">
        {(app || back) && <button type="button" className="note-action wp-back" onClick={app ? () => setAppOpen(false) : back!}><span aria-hidden="true">←</span> {app ? "Work" : "Back"}</button>}
        <div className="wp-titles">{!isRoot && <Crumbs trail={trailItems} onOpen={(p) => openPlace(p)} compact={!wide} />}<h1 className="wp-title">{node.name}</h1></div>
        {openApp && !app && <button type="button" className="note-action wp-app" onClick={openApp}>App ›</button>}
      </header>
      {status}
      {app ? <div className="fx-app">{app.bar}{app.main}</div> : <div className="sr-work">{workMain}</div>}
    </section>
    <UndoBar undo={tasks.undo} notice={tasks.notice} onDismiss={tasks.dismissNotice} />
    {sheetView}{projectSheet}
  </div>;
  return <ApprovalsContext.Provider value={{ ...approvalsAll, open: openApproval }}>{isRoot ? page(null, null)
    : <AreaView key={node.id} area={body !== null ? { ...node, body } : node} mode={mode} roomName={roomName} actions={appActions} room={null} open={appOpen} onOpen={setAppOpen} render={page} />}</ApprovalsContext.Provider>;
}
