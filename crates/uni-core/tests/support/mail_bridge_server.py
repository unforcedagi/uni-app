#!/usr/bin/env python3
"""Read-only mail bridge for the Uni app (T-45): Stalwart JMAP on the hub's host.

The app never holds a mail password. It signs each request with the owner's Nostr
key (NIP-98, same scheme as the transcription service); this bridge checks the
signature against an allowlist and forwards only read-only JMAP methods to
Stalwart with server-side credentials.

POST /mail/jmap   body = {"calls": [[method, args, id], ...]}   -> JMAP methodResponses
POST /mail/raw    body = {"blobId": "..."}                      -> raw RFC 5322 message (text/plain)

Listens on 127.0.0.1 only; Tailscale Serve exposes it tailnet-only.
Config: ~/.config/uni/mail-bridge.json
  {"user": "test@mail.example.com", "password_file": "~/.config/mail-bridge/password",
   "jmap": "https://127.0.0.1:8480", "public_url": "https://uni-1.example.ts.net:8452"}
Allowlist: ~/.config/uni/mail-allow (one hex pubkey per line).
"""
import base64
import hashlib
import json
import os
import ssl
import threading
import time
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from coincurve import PublicKeyXOnly

PORT = int(os.environ.get("UNI_MAIL_PORT", "1951"))
CONF = Path.home() / ".config/uni/mail-bridge.json"
ALLOW_FILE = Path.home() / ".config/uni/mail-allow"
MAX_BODY = 64 * 1024
MAX_RAW = 30 * 1024 * 1024
# Read-only JMAP surface. Anything else (set/import/submission/copy) is refused.
READ_METHODS = {
    "Mailbox/get", "Mailbox/query", "Mailbox/changes",
    "Email/get", "Email/query", "Email/changes", "Email/queryChanges",
    "Thread/get", "Thread/changes", "SearchSnippet/get", "Identity/get",
}
SEEN: dict[str, float] = {}
SEEN_LOCK = threading.Lock()
_session: dict = {}
_session_lock = threading.Lock()
CTX = ssl._create_unverified_context()  # Stalwart's cert is self-signed; loopback only


def conf() -> dict:
    c = json.loads(CONF.read_text())
    c.setdefault("jmap", "https://127.0.0.1:8480")
    c.setdefault("public_url", "https://uni-1.example.ts.net:8452")
    return c


def allowed() -> set[str]:
    if not ALLOW_FILE.exists():
        return set()
    lines = (l.split("#")[0].strip().lower() for l in ALLOW_FILE.read_text().splitlines())
    return {l for l in lines if len(l) == 64}


def verify_nip98(header: str, url: str, body: bytes) -> str:
    if not header.startswith("Nostr "):
        raise ValueError("missing Nostr authorization")
    ev = json.loads(base64.b64decode(header[6:] + "=" * (-len(header[6:]) % 4), altchars=b"-_"))
    if ev.get("kind") != 27235:
        raise ValueError("wrong kind")
    ser = json.dumps([0, ev["pubkey"], ev["created_at"], ev["kind"], ev["tags"], ev["content"]],
                     separators=(",", ":"), ensure_ascii=False).encode()
    if hashlib.sha256(ser).hexdigest() != ev["id"]:
        raise ValueError("bad event id")
    if not PublicKeyXOnly(bytes.fromhex(ev["pubkey"])).verify(bytes.fromhex(ev["sig"]), bytes.fromhex(ev["id"])):
        raise ValueError("bad signature")
    if abs(time.time() - ev["created_at"]) > 120:
        raise ValueError("stale authorization")
    tags = {t[0]: t[1] for t in ev["tags"] if len(t) >= 2}
    if tags.get("u") != url or tags.get("method", "").upper() != "POST":
        raise ValueError("authorization is for a different request")
    if tags.get("payload") != hashlib.sha256(body).hexdigest():
        raise ValueError("payload hash mismatch")
    if ev["pubkey"].lower() not in allowed():
        raise ValueError("pubkey not allowed")
    now = time.time()
    with SEEN_LOCK:
        for k in [k for k, t in SEEN.items() if now - t > 300]:
            del SEEN[k]
        if ev["id"] in SEEN:
            raise ValueError("replayed authorization")
        SEEN[ev["id"]] = now
    return ev["pubkey"]


def auth_header(c: dict) -> str:
    pw = Path(os.path.expanduser(c["password_file"])).read_text().strip()
    return "Basic " + base64.b64encode(f"{c['user']}:{pw}".encode()).decode()


def session(c: dict) -> dict:
    with _session_lock:
        if _session.get("user") != c["user"]:
            req = urllib.request.Request(c["jmap"] + "/jmap/session", headers={"Authorization": auth_header(c)})
            s = json.load(urllib.request.urlopen(req, context=CTX, timeout=15))
            acc = s["primaryAccounts"].get("urn:ietf:params:jmap:mail") or next(iter(s["accounts"]))
            # Stalwart advertises its public hostname; talk to it over loopback instead.
            _session.update(user=c["user"], account=acc, download=s.get("downloadUrl", ""))
        return dict(_session)


def jmap(calls: list) -> dict:
    c = conf()
    s = session(c)
    clean = []
    for call in calls:
        if not (isinstance(call, list) and len(call) == 3 and isinstance(call[1], dict)):
            raise ValueError("malformed method call")
        name, args, cid = call
        if name not in READ_METHODS:
            raise ValueError(f"method not allowed (read-only bridge): {name}")
        args = {**args, "accountId": s["account"]}
        clean.append([name, args, str(cid)])
    body = json.dumps({"using": ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"],
                       "methodCalls": clean}).encode()
    req = urllib.request.Request(c["jmap"] + "/jmap/", data=body,
                                 headers={"Authorization": auth_header(c), "Content-Type": "application/json"})
    out = json.load(urllib.request.urlopen(req, context=CTX, timeout=30))
    return {"account": c["user"], "methodResponses": out.get("methodResponses", [])}


def raw(blob_id: str) -> bytes:
    if not blob_id or any(ch in blob_id for ch in "/?#{} "):
        raise ValueError("bad blobId")
    c = conf()
    s = session(c)
    url = f"{c['jmap']}/jmap/download/{s['account']}/{blob_id}/message.eml?accept=text/plain"
    req = urllib.request.Request(url, headers={"Authorization": auth_header(c)})
    with urllib.request.urlopen(req, context=CTX, timeout=30) as r:
        data = r.read(MAX_RAW + 1)
    if len(data) > MAX_RAW:
        raise ValueError("message too large")
    return data


class Handler(BaseHTTPRequestHandler):
    def send(self, code: int, data: bytes, ctype: str = "application/json") -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self) -> None:
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > MAX_BODY:
                return self.send(413, b'{"error":"bad body size"}')
            body = self.rfile.read(n)
            url = conf()["public_url"] + self.path
            try:
                verify_nip98(self.headers.get("Authorization", ""), url, body)
            except (ValueError, KeyError, json.JSONDecodeError) as e:
                return self.send(401, json.dumps({"error": str(e)}).encode())
            req = json.loads(body)
            if self.path == "/mail/jmap":
                return self.send(200, json.dumps(jmap(req.get("calls") or [])).encode())
            if self.path == "/mail/raw":
                return self.send(200, raw(str(req.get("blobId") or "")), "text/plain; charset=utf-8")
            return self.send(404, b'{"error":"not found"}')
        except ValueError as e:
            return self.send(400, json.dumps({"error": str(e)}).encode())
        except Exception as e:  # upstream failure; never leak credentials
            return self.send(502, json.dumps({"error": f"mail server: {type(e).__name__}"}).encode())

    def log_message(self, fmt, *args):
        print(f"{self.address_string()} {fmt % args}", flush=True)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
