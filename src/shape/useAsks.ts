// T-335 the shape: the reads and writes around asksCore.ts. The asks come from the one reader's live tasks (src/vault/reader.ts), kept fresh by
// its one poller (shared with every other read of the same tick: no timer of its own). An answer is one compare-and-set on the ask (state ->
// done, with the answer's keys), then the owner's message in the ask's room, in its main line (T-335 one ask: never threaded under its `reply_root`). Seen is the
// same close for a tell or look ask, a guarded metadata patch for a do or choose ask, then one quiet line in its room.
// An answered or seen ask leaves the list at once; if the write fails it comes back with its error line. A post that fails after the write
// landed (the ask is closed in the vault, so it can't come back) is kept as owed, with Retry, on this device until it goes.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { reader } from "../vault/reader.ts";
import type { Note } from "../vault/reader.ts";
import { failureKind } from "../vault/rawNote.ts";
import { activeProfile } from "../areas/profile.ts";
import { findUniMember } from "../uniActions.ts";
import { relayAccepted } from "../voiceOutbox.ts";
import { answerBody, answerMeta, archiveBody, asksByRoom, asksPlaced, doneBody, onCardRows, laterBody, laterMeta, seenBody, seenCloses, seenMeta, visibleAsks, type Gone, type VaultAsk } from "./asksCore.ts";
import type { Ask, ShapeRoom } from "./types.ts";
import type { Tree } from "../areas/treeCore.ts";
import type { RoomsRegistry } from "../areas/roomsRegistry.ts";

type Member = { pubkey: string; name: string };
/** A post its room hasn't had yet (the write landed): kept on this device with its reason until it goes. */
export type Owed = { id: string; what: string; channel: string | null; root: string | null; body: string; quiet: boolean; error: string; at: number };
type Result = { ok: true } | { ok: false; kind: "conflict" | "invalid" | "error"; message: string };

const owedKey = (owner: string) => `uni.asks.owed.v1:${owner}`;
const readOwed = (owner: string): Owed[] => { try { const v = JSON.parse(localStorage.getItem(owedKey(owner)) ?? "[]"); return Array.isArray(v) ? v as Owed[] : []; } catch { return []; } };
const writeOwed = (owner: string, list: Owed[]) => { try { localStorage.setItem(owedKey(owner), JSON.stringify(list)); } catch { /* this session only */ } };
const words = (e: unknown) => (typeof e === "string" ? e : e instanceof Error ? e.message : "it didn't go").replace(/^Error:\s*/, "").slice(0, 140);

/** The owner's message in a room, addressed to the room's Uni when it is there (as every message to it is). A reply whose root this device
 *  hasn't cached yet reads the rooms once and tries again. `quiet` (T-335 Seen): addressed to no one and threaded under nothing, so it wakes
 *  no room's Uni (rooms answer only when addressed or replied to); the line sits in the room for whoever reads it next. */
export async function postIn(channel: string, body: string, root: string | null, quiet = false): Promise<void> {
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
      // the post it threads under is older than this device holds: the answer still goes to its room, as a plain message (it names its ask)
      if (!/not cached/i.test(words(e2))) throw e2;
      root = null;
      await send();
    }
  }
}

/** The close (CONTRACT "Answering an ask"): one compare-and-set on `state` (`from` -> `done`) with the answer's (or Seen's) keys in the same
 *  write, guarded by the revision shown; Rust checks the keys. `close: false`: a guarded metadata merge (Seen on a do or choose ask).
 *  `to`: archived (T-335 fixes, Archive): the same compare-and-set with no keys at all. */
async function write(vault: string, ask: VaultAsk, metadata: Record<string, unknown> | null, close: boolean, to = "done"): Promise<Result> {
  if (!ask.rev) return { ok: false, kind: "conflict", message: "no revision: reload the ask first" };
  try {
    if (close) await invoke("vault_transition", { vault, id: ask.id, from: ask.state, to, ifUpdatedAt: ask.rev, metadata });
    else await invoke("vault_patch_meta", { vault, id: ask.id, metadata, ifUpdatedAt: ask.rev });
    // a write landed: the next read of any list goes to the vault, not to what this tick already read
    reader.invalidate();
    return { ok: true };
  } catch (e) { const message = String(e); return { ok: false, kind: failureKind(message), message }; }
}

/** What a tap does to an ask (T-335 fixes, asks in tune): answer it (a choice), mark it seen (tell, look: it ends; do, choose: Seen's write,
 *  it stays open with its room), later (the snooze: back on his list on `until`), done (I did it: Seen's write, and the room is told,
 *  addressed, to take it back), or archive it (out of his view). */
export type AskDo = { act: "answer"; text: string } | { act: "seen" } | { act: "later"; until: string } | { act: "done" } | { act: "archive" };

/** Forget this device (Settings, "Forget this device key"): every owed post kept here, for every identity and vault. */
export function forgetAsks(): void {
  try { for (const k of Object.keys(localStorage)) if (k.startsWith("uni.asks.owed.v1:")) localStorage.removeItem(k); } catch { /* unavailable storage */ }
}

/** `privateRooms`: rooms (by channel id or name) whose asks stay inside them: drawn in full only in their own chat and strip, never on home. */
export function useAsks(o: { vault: string; identity: string | null; rooms: ShapeRoom[]; uniRoom: string | null; on: boolean; privateRooms?: ReadonlySet<string>;
  /** The node tree (null: not read yet), the registry, the rooms home leaves out: where an ask lands and whether it is private (asksFrom). */
  tree: Tree | null; reg: RoomsRegistry | null; hidden: ReadonlySet<string> }) {
  const on = o.on && !!o.identity;
  const owner = `${o.identity ?? ""}|${o.vault}`;
  const [rows, setRows] = useState<Note<"task">[]>([]);
  const [ready, setReady] = useState(false);
  const [gone, setGone] = useState<ReadonlyMap<string, Gone>>(new Map());
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());
  const [owed, setOwed] = useState<Owed[]>(() => readOwed(owner));
  // one answer at a time per ask (a double tap is one answer): set before the first await, not on the next draw
  const inFlight = useRef(new Set<string>());
  const ownerRef = useRef(owner);
  // another identity or vault: its own list, and its own owed posts
  useEffect(() => {
    if (ownerRef.current === owner) return;
    ownerRef.current = owner;
    setRows([]); setReady(false); setGone(new Map()); setErrors(new Map()); setOwed(readOwed(owner));
  }, [owner]);

  // T-335 one reader: the live tasks from the app's one reader, kept fresh by its one poller
  const read = useCallback(async () => {
    if (!on) return;
    const mine = owner;
    try {
      const r = await reader.liveTasks(o.vault);
      if (ownerRef.current !== mine) return;
      setRows(r.rows);
      setReady(true);
    } catch { /* the next tick tries again; what was read stays */ }
  }, [on, owner, o.vault]);
  useEffect(() => {
    if (!on) return;
    void read();
    return reader.onPoll(() => void read());
  }, [on, read]);

  const placed = useMemo(() => asksPlaced(rows, o.rooms, { uniRoom: o.uniRoom, privateRooms: o.privateRooms, tree: o.tree, reg: o.reg, hidden: o.hidden }),
    [rows, o.rooms, o.uniRoom, o.privateRooms, o.tree, o.reg, o.hidden]);
  const all = placed.asks;
  // what the vault no longer lists is settled: stop hiding it by hand
  useEffect(() => {
    setGone((g) => { const live = new Set(all.map((a) => a.id)); const next = new Map([...g].filter(([id]) => live.has(id))); return next.size === g.size ? g : next; });
  }, [all]);
  const asks = useMemo(() => visibleAsks(all, gone), [all, gone]);
  // T-335 asks in tune: the asks folded into their cards, placed the same way, for the card's join only (never drawn)
  const onCard = useMemo(() => asksPlaced(onCardRows(rows), o.rooms, { uniRoom: o.uniRoom, privateRooms: o.privateRooms, tree: o.tree, reg: o.reg, hidden: o.hidden }).asks,
    [rows, o.rooms, o.uniRoom, o.privateRooms, o.tree, o.reg, o.hidden]);
  const cardByRoom = useMemo(() => asksByRoom(onCard), [onCard]);
  const byRoom = useMemo(() => asksByRoom(asks), [asks]);
  const full = useRef(new Map<string, VaultAsk>());
  full.current = new Map(all.map((a) => [a.id, a]));

  const setErr = (id: string, msg: string | null) => setErrors((m) => { const n = new Map(m); if (msg) n.set(id, msg); else n.delete(id); return n; });
  const keepOwed = (f: (l: Owed[]) => Owed[]) => setOwed((l) => { const next = f(l); writeOwed(ownerRef.current, next); return next; });

  const post = useCallback(async (p: Owed) => {
    if (!p.channel) { keepOwed((l) => [...l.filter((x) => x.id !== p.id), { ...p, error: "no room to send it to" }]); return; }
    try { await postIn(p.channel, p.body, null, p.quiet); keepOwed((l) => l.filter((x) => x.id !== p.id)); }
    catch (e) { keepOwed((l) => [...l.filter((x) => x.id !== p.id), { ...p, error: words(e) }]); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  /** One write, then (only once it is written) the room hears it. The ask leaves the list at once; a failed write brings it back with why. */
  const act = useCallback(async (ask: Ask, d: AskDo) => {
    const a = full.current.get(ask.id);
    if (!a || inFlight.current.has(a.id)) return;
    inFlight.current.add(a.id);
    setBusy((b) => new Set(b).add(a.id));
    setErr(a.id, null);
    // seen, later and done: his again when its room asks again (later: on its day); an answer or an archive: gone
    const again = d.act === "seen" || d.act === "later" || d.act === "done";
    setGone((g) => new Map(g).set(a.id, { at: Date.now(), seen: again }));
    const me = activeProfile().me, at = new Date().toISOString();
    let r: Result;
    try {
      r = d.act === "answer" ? await write(o.vault, a, answerMeta(a, d.text, me, at), true)
        : d.act === "archive" ? await write(o.vault, a, null, true, "archived")
        // Later is the snooze patch alone; the ask stays open with its room
        : d.act === "later" ? await write(o.vault, a, laterMeta(d.until), false)
        // Seen closes a tell or look ask; on a do or choose ask (Seen, I did it) it is a patch: the ask stays open with its room
        : await write(o.vault, a, seenMeta(me, at), d.act === "seen" && seenCloses(a.kind));
    } finally {
      setBusy((b) => { const n = new Set(b); n.delete(a.id); return n; });
      inFlight.current.delete(a.id);
    }
    if (!r.ok) {
      setGone((g) => { const n = new Map(g); n.delete(a.id); return n; });
      const what = { answer: "Couldn't answer", seen: "Couldn't mark it seen", later: "Couldn't put it off", done: "Couldn't mark it done", archive: "Couldn't archive it" }[d.act];
      setErr(a.id, r.kind === "conflict" ? "It changed elsewhere. Showing the latest." : `${what}: ${words(r.message)}`);
      reader.invalidate("task");
      void read();
      return;
    }
    // an answer and I did it wake the room's Uni (addressed); Seen, Later and Archive are one quiet line; all in the main line
    const body = d.act === "answer" ? answerBody(a, d.text) : d.act === "done" ? doneBody(a) : d.act === "later" ? laterBody(a, d.until) : d.act === "archive" ? archiveBody(a) : seenBody(a);
    const quiet = d.act !== "answer" && d.act !== "done";
    // (T-335 one ask: never under its reply_root: an answer sits in the room's main line, never in a thread)
    await post({ id: a.id, what: a.what, channel: a.room, root: null, body, quiet, error: "", at: Date.now() });
    void read();
  }, [o.vault, post, read]); // eslint-disable-line react-hooks/exhaustive-deps

  const answer = useCallback(async (ask: Ask, text: string) => { const said = text.trim(); if (said) await act(ask, { act: "answer", text: said }); }, [act]);
  const seen = useCallback(async (ask: Ask) => { await act(ask, { act: "seen" }); }, [act]);
  const later = useCallback(async (ask: Ask, until: string) => { await act(ask, { act: "later", until }); }, [act]);
  const done = useCallback(async (ask: Ask) => { await act(ask, { act: "done" }); }, [act]);
  const archive = useCallback(async (ask: Ask) => { await act(ask, { act: "archive" }); }, [act]);
  /** Send an owed post again. */
  // one send at a time per owed post: a second tap while the relay is slow must not post it twice
  const resending = useRef(new Set<string>());
  const retry = useCallback(async (id: string) => {
    const p = owed.find((x) => x.id === id);
    if (!p || resending.current.has(id)) return;
    resending.current.add(id);
    try { await post(p); } finally { resending.current.delete(id); }
  }, [owed, post]);

  return { asks, byRoom, cardByRoom, busy, errors, answer, seen, later, done, archive, ready, owed, retry, /** Asks kept out of sight: private, with no private room of their own here. */ unseen: placed.unseen };
}
