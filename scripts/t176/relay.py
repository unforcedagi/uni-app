"""A throwaway Buzz-shaped relay for the T-176 end-to-end test. Local only (127.0.0.1), in-process.

The rules the secret handoff depends on, as the production Buzz relay applies them
(buzz-relay handlers/event.rs, ingest.rs; buzz-core P_GATED_KINDS):
- NIP-42: a proactive AUTH challenge; only member pubkeys may authenticate.
- An EVENT must be signed by the authenticated key, except kind 1059 (a gift wrap is signed by a
  throwaway key).
- created_at within ±15 minutes of relay time.
- Kind 1059 is p-gated: served (stored or live) only to a connection authenticated as a `p` it names.
Every accepted event is stored in a SQLite file (the "relay DB") so the test can grep it.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import sqlite3
import sys
import time
from pathlib import Path

import websockets

sys.path.insert(0, os.environ.get("UNI_SECRETS_PLUGIN") or str(Path(__file__).resolve().parents[2] / "hermes-plugin" / "uni-secrets"))
import nostr_crypto as nc  # noqa: E402

P_GATED = {1059}


def _tags(ev: dict, name: str) -> list[str]:
    return [t[1] for t in ev.get("tags", []) if len(t) > 1 and t[0] == name]


def matches(f: dict, ev: dict) -> bool:
    if "ids" in f and ev["id"] not in f["ids"]:
        return False
    if "kinds" in f and ev["kind"] not in f["kinds"]:
        return False
    if "authors" in f and ev["pubkey"] not in f["authors"]:
        return False
    if "since" in f and ev["created_at"] < f["since"]:
        return False
    if "until" in f and ev["created_at"] > f["until"]:
        return False
    for k, vals in f.items():
        if k.startswith("#") and not set(_tags(ev, k[1:])) & set(vals):
            return False
    return True


class Relay:
    def __init__(self, db_path: Path, members: set[str]):
        self.db = sqlite3.connect(db_path, check_same_thread=False)
        self.db.execute("CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, pubkey TEXT, kind INT, "
                        "created_at INT, tags TEXT, content TEXT, raw TEXT)")
        self.db.commit()
        self.members = members
        self.server = None
        self._live: dict[int, dict] = {}
        self.port = 0

    def _visible(self, ev: dict, me: str) -> bool:
        return ev["kind"] not in P_GATED or me in _tags(ev, "p")

    async def handler(self, ws) -> None:
        challenge = secrets.token_hex(16)
        state = {"me": None, "subs": {}, "ws": ws}
        self._live[id(state)] = state
        await ws.send(json.dumps(["AUTH", challenge]))
        try:
            async for raw in ws:
                msg = json.loads(raw)
                if msg[0] == "AUTH":
                    ev = msg[1]
                    ok = (nc.verify_event(ev) and ev["kind"] == 22242 and challenge in _tags(ev, "challenge")
                          and ev["pubkey"] in self.members)
                    if ok:
                        state["me"] = ev["pubkey"]
                    await ws.send(json.dumps(["OK", ev["id"], ok, "" if ok else "restricted: not a relay member"]))
                elif msg[0] == "EVENT":
                    ev = msg[1]
                    why = self._reject(ev, state["me"])
                    await ws.send(json.dumps(["OK", ev.get("id", ""), why is None, why or ""]))
                    if why is None:
                        self.db.execute("INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?,?)",
                                        (ev["id"], ev["pubkey"], ev["kind"], ev["created_at"],
                                         json.dumps(ev["tags"]), ev["content"], json.dumps(ev)))
                        self.db.commit()
                        await self._fan_out(ev)
                elif msg[0] == "REQ":
                    if not state["me"]:
                        await ws.send(json.dumps(["CLOSED", msg[1], "auth-required: authenticate first"]))
                        continue
                    sub, filters = msg[1], msg[2:]
                    state["subs"][sub] = filters
                    rows = self.db.execute("SELECT raw FROM events ORDER BY created_at").fetchall()
                    for (r,) in rows:
                        ev = json.loads(r)
                        if any(matches(f, ev) for f in filters) and self._visible(ev, state["me"]):
                            await ws.send(json.dumps(["EVENT", sub, ev]))
                    await ws.send(json.dumps(["EOSE", sub]))
                elif msg[0] == "CLOSE":
                    state["subs"].pop(msg[1], None)
        except websockets.ConnectionClosed:
            pass
        finally:
            self._live.pop(id(state), None)

    def _reject(self, ev: dict, me: str | None) -> str | None:
        if not me:
            return "auth-required: authenticate first"
        if not nc.verify_event(ev):
            return "invalid: bad signature"
        if ev["pubkey"] != me and ev["kind"] != 1059:
            return "invalid: event pubkey does not match authenticated identity"
        if abs(ev["created_at"] - time.time()) > 900:
            return "invalid: event timestamp too far from server time"
        return None

    async def _fan_out(self, ev: dict) -> None:
        for st in list(self._live.values()):
            if not st["me"] or not self._visible(ev, st["me"]):
                continue
            for sub, filters in st["subs"].items():
                if any(matches(f, ev) for f in filters):
                    try:
                        await st["ws"].send(json.dumps(["EVENT", sub, ev]))
                    except websockets.ConnectionClosed:
                        pass

    async def start(self) -> str:
        self.server = await websockets.serve(self.handler, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]
        return f"ws://127.0.0.1:{self.port}"

    async def stop(self) -> None:
        self.server.close()
        await self.server.wait_closed()
        self.db.close()
