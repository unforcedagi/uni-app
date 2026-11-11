// T-335 the shape: everything home, a room's strip and the bar read, in one hook the App holds for as long as it runs (so the Rooms count on
// the bar is right in the Journal and in an applet too). It feeds the shared stores the old home used to feed (the work store's rooms, the
// decisions the chat links to) and reads the rooms registry (System/Rooms: retired and private rooms).
// A private room's asks are drawn only inside it (home: a wordless mark), and its approvals pinned without their words. Privacy waits for what
// it needs: until the registry's first read has settled, no ask or run line is drawn (a room private only by the registry can't be told yet);
// until the node tree is read, no decision is published, an ask whose place can't be judged is not drawn, and every pin is wordless.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Approval } from "../approvals";
import { publishDecisions, setDecidedHook, setDecisionOpener } from "../decisionLinks";
import { findUniRoom } from "../uniActions";
import { parseRegistry, REGISTRY_NOTE, type RoomsRegistry } from "../areas/roomsRegistry";
import type { Tree } from "../areas/treeCore";
import type { RawNote } from "../vault/rawNote";
import { reader } from "../vault/reader";
import { pinsFrom, homeRows, wantsCount } from "./homeCore";
import { decisionsFrom, hiddenRooms, keepAsks, nodeTree, privateRooms } from "./shapeCore";
import { studioLooks } from "./studioCore";
import { useAsks } from "./useAsks";
import { useFeedWorkRooms, useRoomRuns } from "./useRoomRuns";
import type { Ask, RoomRuns, ShapeRoom } from "./types";

const NO_RUNS: ReadonlyMap<string, RoomRuns> = new Map();
const NO_ASKS: ReadonlyMap<string, Ask[]> = new Map();

/**
 * The rooms registry, as last read (kept on the device for the next launch); read again when the window comes back into view. `settled`:
 * one was kept from before, or a read has answered with it or with "there is none": until then privacy can't be told (a failed read, say
 * offline on a first launch, leaves it unsettled; the next read, when the window comes back, tries again).
 */
function useRegistry(vault: string, on: boolean): { reg: RoomsRegistry | null; settled: boolean } {
  const key = `uni.rooms.registry.v1:${vault}`;
  const kept = (k: string) => { try { return parseRegistry(JSON.parse(localStorage.getItem(k) ?? "null")); } catch { return null; } };
  const [st, setSt] = useState<{ key: string; reg: RoomsRegistry | null; settled: boolean }>(() => { const reg = kept(key); return { key, reg, settled: !!reg }; });
  // another vault: its own registry (the one kept for it), never the last vault's
  if (st.key !== key) { const reg = kept(key); setSt({ key, reg, settled: !!reg }); }
  useEffect(() => {
    if (!on) return;
    let gone = false;
    const load = () => invoke<{ note?: { metadata?: unknown } }>("vault_note", { vault, noteRef: REGISTRY_NOTE }).then((r) => {
      if (gone) return;
      const next = parseRegistry(r?.note?.metadata);
      // the same registry again (every return to the window reads it): nothing changes, nothing downstream is worked out again
      setSt((s) => (s.key !== key ? s : next ? (s.settled && JSON.stringify(s.reg) === JSON.stringify(next) ? s : { key, reg: next, settled: true }) : { ...s, settled: true }));
      if (next) try { localStorage.setItem(key, JSON.stringify((r?.note?.metadata as { registry?: unknown })?.registry ?? r?.note?.metadata)); } catch { /* private storage */ }
    }).catch((e) => {
      // none published yet: what the names say is all there is to tell. Offline: the last one read stands; with none, not yet settled
      if (!gone && /not found/i.test(String(e))) setSt((s) => (s.key !== key || s.settled ? s : { ...s, settled: true }));
    });
    void load();
    window.addEventListener("focus", load);
    return () => { gone = true; window.removeEventListener("focus", load); };
  }, [vault, on, key]);
  return st.key === key ? { reg: st.reg, settled: st.settled } : { reg: kept(key), settled: false };
}

/** The areas and projects (the vault's `node` notes) as a tree, read through the one reader on its tick; null until read for this vault (a
 *  failed read keeps what was read; none read: null). Built again only when the reader hands new rows. */
function useNodeTree(vault: string, on: boolean): Tree | null {
  const [got, setGot] = useState<{ vault: string; tree: Tree } | null>(null);
  const current = useRef(on ? vault : null); current.current = on ? vault : null;
  const built = useRef<{ rows: unknown; tree: Tree } | null>(null);
  useEffect(() => {
    setGot(null); built.current = null;
    if (!on) return;
    const read = () => reader.nodes(vault).then((n) => {
      if (current.current !== vault) return;
      if (built.current?.rows === n.rows) return;
      built.current = { rows: n.rows, tree: nodeTree(n.rows as RawNote[]) };
      setGot({ vault, tree: built.current.tree });
    }).catch(() => { /* the next tick tries again */ });
    void read();
    return reader.onPoll(() => void read());
  }, [on, vault]);
  return on && got?.vault === vault ? got.tree : null;
}

/**
 * The open decisions the chat links to (a `[decision T-NN]` marker or a decision's id in a message gets its card, and a room lists its own
 * open ones under its chat), read through the one reader with the node tree (a decision's place, its privacy and its room come from its
 * node). `openNote`: what a decision's link opens now (its note: the old task sheet is gone).
 */
function useDecisionsFeed(o: { vault: string; on: boolean; tree: Tree | null; rooms: readonly ShapeRoom[]; priv: ReadonlySet<string>; hidden: ReadonlySet<string>; reg: RoomsRegistry | null; uniRoom: string | null; openNote: (id: string) => void }) {
  type Read = { vault: string; notes: Awaited<ReturnType<typeof reader.openDecisions>>["rows"] };
  const [got, setGot] = useState<Read | null>(null);
  const open = useRef(o.openNote); open.current = o.openNote;
  // the vault the hook reads now: an answer for another (a switch while a read was out) is dropped
  const current = useRef(o.on ? o.vault : null); current.current = o.on ? o.vault : null;
  const read = useCallback(() => {
    if (!o.on) return;
    const vault = o.vault;
    reader.openDecisions(vault).then((d) => {
      if (current.current !== vault) return;
      setGot({ vault, notes: d.rows });
    }).catch(() => { /* the next tick tries again; what was read stands (none read: nothing is published) */ });
  }, [o.on, o.vault]);
  useEffect(() => {
    setGot(null);
    if (!o.on) return;
    read();
    return reader.onPoll(read);
  }, [o.on, read]);
  useEffect(() => {
    publishDecisions(o.on && o.tree && got?.vault === o.vault ? decisionsFrom(got.notes, o.rooms, o.priv, o.tree, o.uniRoom, { reg: o.reg, hidden: o.hidden }) : []);
  }, [got, o.tree, o.rooms, o.priv, o.hidden, o.reg, o.on, o.vault, o.uniRoom]);
  useEffect(() => {
    if (!o.on) return;
    setDecisionOpener((id) => open.current(id));
    // a card decided one: read the list again now, not on the next tick
    setDecidedHook(() => { reader.invalidate("decision"); read(); });
    return () => { setDecisionOpener(null); setDecidedHook(null); };
  }, [o.on, read]);
}

export type ShapeData = ReturnType<typeof useShape>;

export function useShape(o: {
  rooms: readonly ShapeRoom[];
  /** The rooms list has been read once (the work store waits for it before it can tell a private run). */ roomsReady: boolean;
  identity: string | null; vault: string;
  /** The Uni glue is on (the life vault is Uni's): asks, runs and decisions are read only then. */ on: boolean;
  approvals: readonly Approval[];
  openNote: (id: string) => void;
}) {
  const { reg, settled } = useRegistry(o.vault, o.on && !!o.identity);
  const tree = useNodeTree(o.vault, o.on && !!o.identity);
  const rooms = o.rooms as ShapeRoom[];
  // what is worked out from the rooms is worked out again only when a room's id, name or kind changes, not on every new message
  const roomsKey = rooms.map((r) => `${r.id}\u0001${r.name}\u0001${r.dm ?? ""}`).join("\u0000");
  // the rooms as the asks are placed by them (id, name, DM or not): the same list while those stay the same
  const askRooms = useMemo(() => rooms, [roomsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const hidden = useMemo(() => hiddenRooms(askRooms, reg), [askRooms, reg]);
  // Uni's room is one home shows (a room the registry folded into none is no place to send anything)
  const uniRoom = useMemo(() => findUniRoom(rooms.filter((r) => !hidden.has(r.id)))?.id ?? null, [rooms, hidden]);
  // private by name, by the registry, and (once read) by the tree: a room a private place owns under any name
  const priv = useMemo(() => privateRooms(rooms, reg, tree, uniRoom), [roomsKey, reg, tree, uniRoom]); // eslint-disable-line react-hooks/exhaustive-deps
  // a stable set while its members are the same (the asks re-derive on a new one)
  const privKey = [...priv].sort().join(" ");
  const privStable = useMemo(() => priv, [privKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // the asks know a private room by its channel id and by its name (an ask naming a retired private room finds no room by name)
  const privNames = rooms.filter((r) => privStable.has(r.id)).map((r) => r.name).sort().join("\u0000");
  const privAsks = useMemo(() => new Set([...privStable, ...(privNames ? privNames.split("\u0000") : [])]), [privStable, privNames]);
  useFeedWorkRooms(o.roomsReady ? rooms : null);
  const allRuns = useRoomRuns(rooms);
  // a private room's runs stay inside it: home and its strip draw none (and none at all until privacy can be told)
  const runs = useMemo(() => {
    if (!o.on || !settled) return NO_RUNS;
    const out = new Map(allRuns);
    for (const id of privStable) out.delete(id);
    return out;
  }, [allRuns, privStable, o.on, settled]);
  // a retired room is no place for an ask: one that names it goes where its work went (asksFrom: the registry's successor, its node's room,
  // else Uni's room); its privacy is judged with the tree on where it lands
  const asks = useAsks({ vault: o.vault, identity: o.identity, rooms: askRooms, hidden, reg, tree, uniRoom, on: o.on, privateRooms: privAsks });
  // an ask naming a private room by a name the device has no room for (an old name, a retired private room) stays out too; a private
  // room's own asks stay in it (drawn in full inside, without words on home)
  const byRoom: ReadonlyMap<string, Ask[]> = useMemo(() => (settled ? keepAsks(asks.byRoom, reg) : NO_ASKS), [asks.byRoom, reg, settled]);
  useDecisionsFeed({ vault: o.vault, on: o.on && !!o.identity && settled, tree, rooms, priv: privStable, hidden, reg, uniRoom, openNote: o.openNote });
  // pins leave the moment they lapse: the clock that reads them is bumped when one reaches zero (and once a minute besides)
  const [tick, setTick] = useState(0);
  const lapsed = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => { const t = window.setInterval(lapsed, 60_000); return () => window.clearInterval(t); }, [lapsed]);
  const now = useMemo(() => Date.now() / 1000, [tick, o.approvals, rooms]); // eslint-disable-line react-hooks/exhaustive-deps
  const roomName = useCallback((id: string | null) => (id ? rooms.find((r) => r.id === id)?.name ?? null : null), [rooms]);
  // (an approval still waiting in a retired room is pinned all the same: it still needs you, and "Open in room" opens it)
  // a private room's approval is pinned without its words; with the Uni glue on, every pin is, until the registry and the tree are read
  const privacyKnown = !o.on || (settled && tree !== null);
  const pinPrivate = useCallback((ch: string) => !privacyKnown || privStable.has(ch), [privacyKnown, privStable]);
  const pins = useMemo(() => pinsFrom(o.approvals, roomName, now, pinPrivate), [o.approvals, roomName, now, pinPrivate]);
  const rows = useMemo(() => homeRows(rooms, runs, byRoom, { hidden }), [rooms, runs, byRoom, hidden]);
  const wants = wantsCount(rows, pins);
  // (the Studio board is outside every room: a private room's look pins stay in the room)
  const shown = useMemo(() => [...byRoom.values()].flat().filter((a) => !a.private), [byRoom]);
  const looks = useMemo(() => studioLooks(shown, roomName), [shown, roomName]);
  // (only by room: the flat list holds asks the registry hasn't vetted yet, and private ones; nothing outside a room should read them)
  const { asks: _unvetted, ...answering } = asks;
  return { rows, pins, wants, now, onPinLapsed: lapsed, runs, asks: { ...answering, byRoom }, /* (only once the rooms, the registry and the tree are read: an ask about to be drawn in its room is not "out of sight") */ unseen: privacyKnown && o.on && rooms.length > 0 ? asks.unseen : 0, hidden, priv: privStable, uniRoom, looks, roomName,
    /* (T-335 cards expand) a room whose words stay inside it: private, or not yet known not to be */ isPrivate: pinPrivate };
}
