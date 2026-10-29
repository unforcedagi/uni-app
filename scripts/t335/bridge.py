#!/usr/bin/env python3
"""T-335 live proof: the webview's post commands, answered by the app's real Rust code against a scratch hub.

In Playwright the Tauri shell is replaced by an IPC mock; for the live spec (scripts/browser/toPostLive.spec.ts) the
mock forwards the To post commands here, and this runs them through the same `VaultClient::post_*` methods the
app's `post_approve`, `post_drop` and `post_edit` commands call (`cargo run --example post_verdict`), with a throwaway
key. The queue is read from the scratch vault's REST API. `/takedown` runs uni-post's own delete; `/record` reads the
post back from the Bluesky server. Started by uni-ops post/e2e.py, which owns every server; never the live hub.

Environment: T335_HUB (scratch hub origin), T335_VAULT, T335_TOKEN_FILE (scratch vault token), T335_NSEC_FILE
(throwaway Aaron key), T335_VERDICT (path to the post_verdict binary), T335_UNI_POST (the uni-post command, as a JSON
list), T335_PDS (the Bluesky server), T335_PORT.
"""
from __future__ import annotations

import json
import os
import subprocess
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

E = os.environ


def rest(path: str) -> object:
    token = open(E["T335_TOKEN_FILE"]).read().split()[-1]
    req = urllib.request.Request(f"{E['T335_HUB']}/vault/{E['T335_VAULT']}/api{path}",
                                 headers={"authorization": f"Bearer {token}"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read())


def verdict(args: list[str]) -> object:
    env = {**E, "UNI_NSEC": open(E["T335_NSEC_FILE"]).read().strip(), "UNI_NO_KEYRING": "1"}
    out = subprocess.run([E["T335_VERDICT"], E["T335_HUB"], E["T335_VAULT"], *args], capture_output=True, text=True,
                         env=env, timeout=60)
    res = json.loads(out.stdout.strip().splitlines()[-1])
    if isinstance(res, dict) and "error" in res:
        raise RuntimeError(res["error"])
    return res


def invoke(cmd: str, a: dict) -> object:
    if cmd == "vault_query":
        return rest(f"/notes?{urllib.parse.urlencode({'tag': a['tag'], 'limit': a.get('limit', 200), 'offset': a.get('offset', 0)})}")
    if cmd == "post_approve":
        return verdict([a["id"], a["ifUpdatedAt"], "approve", *([str(a["scheduledFor"])] if a.get("scheduledFor") else [])])
    if cmd == "post_drop":
        return verdict([a["id"], a["ifUpdatedAt"], "drop"])
    if cmd == "post_edit":
        return verdict([a["id"], a["ifUpdatedAt"], "edit", a["text"]])
    raise RuntimeError(f"not bridged: {cmd}")


class H(BaseHTTPRequestHandler):
    def log_message(self, fmt, *a):
        print("bridge:", fmt % a, flush=True)

    def _send(self, code: int, obj: object):
        raw = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("access-control-allow-origin", "*")
        self.send_header("access-control-allow-headers", "content-type")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        try:
            if self.path == "/invoke":
                return self._send(200, {"ok": True, "result": invoke(body["cmd"], body.get("args") or {})})
            if self.path == "/takedown":
                out = subprocess.run([*json.loads(E["T335_UNI_POST"]), "delete", body["id"]], capture_output=True,
                                     text=True, timeout=120)
                return self._send(200, {"ok": out.returncode == 0, "code": out.returncode, "out": out.stdout[-2000:]})
            if self.path == "/record":
                note = rest(f"/notes/{urllib.parse.quote(body['id'])}")
                uri = (note.get("metadata") or {}).get("posted_ref") or ""
                repo, coll, rkey = uri.removeprefix("at://").split("/")
                q = urllib.parse.urlencode({"repo": repo, "collection": coll, "rkey": rkey})
                try:
                    with urllib.request.urlopen(f"{E['T335_PDS']}/xrpc/com.atproto.repo.getRecord?{q}", timeout=20) as r:
                        return self._send(200, {"ok": True, "uri": uri, "text": json.loads(r.read())["value"]["text"]})
                except urllib.error.HTTPError as e:
                    return self._send(200, {"ok": True, "uri": uri, "text": None, "status": e.code})
            self._send(404, {"ok": False, "error": "no such path"})
        except Exception as e:  # noqa: BLE001 — the spec shows the error as the app would
            self._send(200, {"ok": False, "error": str(e)})


if __name__ == "__main__":
    s = ThreadingHTTPServer(("127.0.0.1", int(E.get("T335_PORT", "0"))), H)
    print(f"bridge ready http://127.0.0.1:{s.server_address[1]}", flush=True)
    s.serve_forever()
