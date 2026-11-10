// For you (0.3.0): the reads and writes around the one data module (forYouCore.ts). The asks come from the task list the home already
// reads (useTasks: live tasks and open decisions, with each note's metadata); the cards are read here (`card` notes, metadata only). An
// answer is one compare-and-set on the ask (vaultTasks.answer; an old decision keeps vaultTasks.decide), then Aaron's message in the ask's
// room, threaded under its `reply_root` when there is one. A post that fails stays on the "Answered today" line with Retry, kept on the
// device until it goes (one with no room named is let go after a day, like a sent one).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { vaultTasks } from "../areas/vaultTasks";
import type { RawNote, Task } from "../areas/taskCore";
import { POLL_MS, reader } from "../vault/reader";
import { activeProfile } from "../areas/profile";
import { findUniMember } from "../uniActions";
import { relayAccepted } from "../voiceOutbox";
import { answerBody, answerMeta, askContext, seenBody, seenCloses, seenMeta, forYou, type Answered, type AskContext, type ForYouView, type Item, type Note, type Place } from "./forYouCore";

type Member = { pubkey: string; name: string };
/** A room as the app knows it: its channel id and name. */
export type RoomRef = { id: string; name: string };
/** An answer on its way to its room (kept on the device until it is sent). */
type Entry = Answered & { channel: string | null; root: string | null; body: string };

const DAY = 86_400_000;
const lookedKey = (owner: string) => `uni.foryou.looked.v1:${owner}`;
const answeredKey = (owner: string) => `uni.foryou.answered.v1:${owner}`;
const read = <T,>(key: string, fallback: T): T => { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; } };
const write = (key: string, v: unknown) => { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* this session only */ } };
/** An answer still owed to its room is kept until it goes; a sent one, or one with no room named, for a day. A post cut off mid-send (the app
 *  closed) comes back as failed, with Retry. */
const kept = (list: Entry[]): Entry[] => list.filter((e) => e.post === "failed" || e.post === "sending" || (e.post === "none" && !!e.room) || Date.now() - e.at < DAY)
  .map((e) => (e.post === "sending" ? { ...e, post: "failed" as const, error: "the app closed before it went" } : e));
const words = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "it didn't go").replace(/^Error:\s*/, "").slice(0, 140);

/** This launch's "last looked", per key and vault. */
const looked = new Map<string, number | null>();
const sinceOf = (owner: string) => { if (!looked.has(owner)) looked.set(owner, read<number | null>(lookedKey(owner), null)); return looked.get(owner)!; };

/** Aaron's message in a room, addressed to the room's Uni when it is there (as every message to it is). A reply whose root this device
 *  hasn't cached yet reads the rooms once and tries again. `quiet` (T-335 Seen): addressed to no one and threaded under nothing, so it wakes
 *  no room's Uni (rooms answer only when addressed or replied to); the line sits in the room for whoever reads it next. */
async function postIn(channel: string, body: string, root: string | null, quiet = false): Promise<void> {
  const send = async () => {
    const uni = quiet ? null : findUniMember(await invoke<Member[]>("get_members", { channel }).catch(() => [] as Member[]));
    try { await invoke("post_message", { channel, body, replyTo: root, recipients: uni ? [uni.pubkey] : [], media: [] }); }
    catch (e) { if (!relayAccepted(e)) throw e; }
  };
  try { await send(); }
  catch (e) {
    if (!root || !/not cached/i.test(words(e))) throw e;
    await invoke("refresh").catch(() => {});
    try { await send(); }
    catch (e2) {
      // the card's post is older than this device holds: the answer still goes to its room, as a plain message (it names its ask)
      if (!/not cached/i.test(words(e2))) throw e2;
      root = null;
      await send();
    }
  }
}

/** A task as a note again (its metadata as read, with the state the list holds now: a check-off shows at once). */
const noteOf = (t: Task): Note => ({ id: t.id, path: t.path, tags: t.raw?.tags ?? [t.kind], updatedAt: t.updatedAt, createdAt: t.raw?.createdAt ?? t.added ?? null,
  metadata: { ...(t.raw?.metadata ?? {}), node: t.node, state: t.state, ...(t.snoozedUntil ? { snoozed_until: t.snoozedUntil } : {}) } });

export function useForYou(o: { identity: string | null; vault: string; tasks: readonly Task[] | null; placeOf: (node: string) => Place;
  /** A room's name as a live room's (an archived room's: where its work went); null: none. */ liveRoom?: (name: string) => string | null;
  /** Whether a room's name is a private place's room. */ privateRoom?: (name: string) => boolean;
  /** The room an item's answer goes to (its `reply_room`, else its room, else its node's), by id. */ roomOf: (item: Item) => RoomRef | null;
  /** Read the task list again (after an answer). */ refresh: () => void; enabled?: boolean }) {
  const owner = `${o.identity ?? ""}|${o.vault}`;
  const enabled = o.enabled !== false && !!o.identity;
  const [cards, setCards] = useState<RawNote[]>([]);
  const [cardsFailed, setCardsFailed] = useState(false);
  // when he last looked: the lines since then are Moving. Read once a launch (a redraw of the home is the same look); the app going out
  // of sight ends this look, and the next launch counts from there
  const since = sinceOf(owner);
  const [entries, setEntries] = useState<Entry[]>(() => kept(read<Entry[]>(answeredKey(owner), [])));
  // the key arrives after the first draw (or another vault is chosen): that owner's answers, kept on this device
  const ownerRef = useRef(owner);
  useEffect(() => { if (ownerRef.current === owner) return; ownerRef.current = owner; setEntries(kept(read<Entry[]>(answeredKey(owner), []))); }, [owner]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const now = Date.now();

  // T-335 one reader: the cards come from the app's one reader, kept fresh by its one poller (shared with the tasks' read of the same tick)
  const readCards = useCallback(async () => {
    if (!enabled) return;
    try { setCards((await reader.cards(o.vault)).rows as RawNote[]); setCardsFailed(false); }
    catch { setCardsFailed(true); }
  }, [enabled, o.vault]);
  useEffect(() => {
    void readCards();
    return reader.onPoll(() => void readCards());
  }, [readCards]);
  useEffect(() => {
    if (!enabled) return;
    const mark = () => write(lookedKey(owner), Date.now());
    const onHide = () => { if (document.visibilityState === "hidden") mark(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", mark);
    return () => { document.removeEventListener("visibilitychange", onHide); window.removeEventListener("pagehide", mark); };
  }, [enabled, owner]);
  const keep = (next: Entry[]) => { write(answeredKey(ownerRef.current), next.filter((e) => e.post !== "sent" || Date.now() - e.at < DAY)); return next; };
  // one answer at a time per ask (a double tap is one answer): set before the first await, not on the next draw
  const inFlight = useRef(new Set<string>());
  const change = (id: string, f: (e: Entry) => Entry) => setEntries((list) => keep(list.map((e) => (e.id === id ? f(e) : e))));

  const asks = useMemo(() => (o.tasks ?? []).map(noteOf), [o.tasks]);
  const view: ForYouView = useMemo(() => forYou({ asks, cards, placeOf: o.placeOf, liveRoom: o.liveRoom, privateRoom: o.privateRoom, me: activeProfile().me, now, lastLooked: since, answered: entries }),
    [asks, cards, o.placeOf, o.liveRoom, o.privateRoom, since, entries, Math.floor(now / POLL_MS)]); // eslint-disable-line react-hooks/exhaustive-deps

  // T-335: each ask's context (why, steps, links, time) is in its own note's body (an older ask's, in its `context_note`). The lists carry no
  // content, so each ask shown is read once per revision (three at a time), never on every poll; a failed read leaves it out until the next
  // revision or launch. Kept for this session and this owner only.
  const [contexts, setContexts] = useState<ReadonlyMap<string, AskContext | null>>(new Map());
  const asked = useRef(new Map<string, string>());
  useEffect(() => { asked.current = new Map(); setContexts(new Map()); }, [owner]);
  useEffect(() => {
    if (!enabled) return;
    const want = [...view.yours, ...view.more, ...view.look].filter((i) => !i.legacy && asked.current.get(i.id) !== `${i.updatedAt}`);
    if (!want.length) return;
    for (const i of want) asked.current.set(i.id, `${i.updatedAt}`);
    const mine = owner;
    const read = async (ref: string) => ((await invoke<{ note?: RawNote } | null>("vault_note", { vault: o.vault, noteRef: ref }))?.note?.content);
    const one = async (i: Item) => {
      try {
        const ctx = askContext(await read(i.id)) ?? (i.contextNote ? askContext(await read(i.contextNote)) : null);
        if (ownerRef.current === mine) setContexts((m) => new Map(m).set(i.id, ctx));
      } catch { if (asked.current.get(i.id) === `${i.updatedAt}`) asked.current.delete(i.id); }
    };
    const queue = [...want];
    void Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => { while (queue.length) await one(queue.shift()!); }));
  }, [view, enabled, owner, o.vault]);

  const post = useCallback(async (e: Entry) => {
    let channel = e.channel;
    if (!channel) {
      // no room found when it was answered: look again (rooms load late); still none, it stays owed with the reason
      const room = o.roomOf({ replyRoom: e.room, node: "" } as Item);
      if (!room) { change(e.id, (x) => ({ ...x, post: "none", error: e.room ? `#${e.room} isn't a room here yet` : "no room to send it to" })); return; }
      channel = room.id;
      change(e.id, (x) => ({ ...x, channel: room.id }));
    }
    change(e.id, (x) => ({ ...x, post: "sending", error: null }));
    try { await postIn(channel, e.body, e.seen ? null : e.root, !!e.seen); change(e.id, (x) => ({ ...x, post: "sent", error: null })); }
    catch (err) { change(e.id, (x) => ({ ...x, post: "failed", error: words(err) })); }
  }, [o.roomOf]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Answer an ask: the compare-and-set first; only once it is written does the room hear it. */
  const answer = useCallback(async (item: Item, text: string) => {
    const said = text.trim();
    if (!said || inFlight.current.has(item.id)) return;
    inFlight.current.add(item.id);
    setBusy((b) => new Set(b).add(item.id));
    setErrors(({ [item.id]: _, ...rest }) => rest);
    const me = activeProfile().me, at = new Date().toISOString();
    let r: Awaited<ReturnType<typeof vaultTasks.answer>>;
    try {
      r = item.legacy
        ? await vaultTasks.decide(item.id, said, me, item.updatedAt ?? "", at)
        : await vaultTasks.answer(item.id, item.state as Task["state"], item.updatedAt ?? "", answerMeta(item, said, me, at));
    } catch (e) { r = { ok: false, kind: "error", message: words(e) }; }
    finally {
      setBusy((b) => { const n = new Set(b); n.delete(item.id); return n; });
      inFlight.current.delete(item.id);
    }
    if (!r.ok) {
      setErrors((x) => ({ ...x, [item.id]: r.kind === "conflict" ? "It changed elsewhere. Showing the latest." : `Couldn't answer: ${words(r.message)}` }));
      o.refresh();
      return;
    }
    const room = o.roomOf(item);
    const entry: Entry = { id: item.id, what: item.what, answer: said, at: Date.now(), room: room?.name.replace(/^#/, "") ?? item.replyRoom, post: room ? "sending" : "none",
      channel: room?.id ?? null, root: item.replyRoot, body: answerBody(item, said), card: item.where.cardPath };
    setEntries((list) => keep([...list.filter((e) => e.id !== item.id), entry]));
    await post(entry);
    o.refresh();
    void readCards();
  }, [o.roomOf, o.refresh, post, readCards]); // eslint-disable-line react-hooks/exhaustive-deps

  /** T-335 Seen: he is aware of it. The write first (a tell or look ask closes; a do or choose ask stays open with its room, out of For you);
   *  only once it is written is the room told, in one quiet line. Kept on the "Answered today" line like an answer (with Retry if the line
   *  didn't go), never as his words on the card. */
  const seen = useCallback(async (item: Item) => {
    if (item.legacy || inFlight.current.has(item.id)) return;
    inFlight.current.add(item.id);
    setBusy((b) => new Set(b).add(item.id));
    setErrors(({ [item.id]: _, ...rest }) => rest);
    const closes = seenCloses(item.kind);
    let r: Awaited<ReturnType<typeof vaultTasks.seen>>;
    try { r = await vaultTasks.seen(item.id, item.state as Task["state"], item.updatedAt ?? "", closes, seenMeta(activeProfile().me, new Date().toISOString())); }
    catch (e) { r = { ok: false, kind: "error", message: words(e) }; }
    finally {
      setBusy((b) => { const n = new Set(b); n.delete(item.id); return n; });
      inFlight.current.delete(item.id);
    }
    if (!r.ok) {
      setErrors((x) => ({ ...x, [item.id]: r.kind === "conflict" ? "It changed elsewhere. Showing the latest." : `Couldn't mark it seen: ${words(r.message)}` }));
      o.refresh();
      return;
    }
    const room = o.roomOf(item);
    const entry: Entry = { id: item.id, what: item.what, answer: "Seen", seen: true, at: Date.now(), room: room?.name.replace(/^#/, "") ?? item.replyRoom, post: room ? "sending" : "none",
      channel: room?.id ?? null, root: null, body: seenBody(item), card: item.where.cardPath };
    setEntries((list) => keep([...list.filter((e) => e.id !== item.id), entry]));
    await post(entry);
    o.refresh();
  }, [o.roomOf, o.refresh, post]); // eslint-disable-line react-hooks/exhaustive-deps

  const retry = useCallback((id: string) => { const e = entries.find((x) => x.id === id); if (e) void post(e); }, [entries, post]);
  return { view, answer, seen, retry, errors, busy, cardsFailed, contexts };
}

/** Speech to text on the hub (the app's transcription path), for hold-to-talk. */
export async function transcribe(blob: Blob, mime: string): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const t = await invoke<{ text?: string }>("voice_transcribe", bytes, { headers: { "x-audio-mime": mime } });
  return (t?.text ?? "").trim();
}
