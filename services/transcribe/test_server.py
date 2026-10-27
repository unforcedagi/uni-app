#!/usr/bin/env python3
"""uni-transcribe's request check (T-313): a request signed for either of the service's names passes; one signed for any
other URL, a replay, or a tampered body doesn't. Keys are made here, never real ones.

Run with the service's own Python (coincurve, faster_whisper): ~/.local/share/uni/transcribe-gpu/venv/bin/python
services/transcribe/test_server.py
"""
import base64, hashlib, json, os, secrets, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import server  # noqa: E402 (the model loads only when run as the service)
from coincurve import PrivateKey  # noqa: E402


def header(sk, u, body, method="POST", at=None):
    pub = sk.public_key_xonly.format().hex()
    tags = [["u", u], ["method", method], ["payload", hashlib.sha256(body).hexdigest()]]
    created = int(at if at is not None else time.time())
    ser = json.dumps([0, pub, created, 27235, tags, ""], separators=(",", ":"), ensure_ascii=False).encode()
    ev = {"pubkey": pub, "created_at": created, "kind": 27235, "tags": tags, "content": ""}
    ev["id"] = hashlib.sha256(ser).hexdigest()
    ev["sig"] = sk.sign_schnorr(bytes.fromhex(ev["id"])).hex()
    return "Nostr " + base64.b64encode(json.dumps(ev).encode()).decode(), pub


def refused(h, body, why):
    try:
        server.verify_nip98(h, body)
    except ValueError as e:
        assert why in str(e), (why, str(e))
        return
    raise AssertionError(f"accepted, expected {why!r}")


sk = PrivateKey(secrets.token_bytes(32))
body = b"made-up audio"
pub = sk.public_key_xonly.format().hex()
server.allowed = lambda: {pub}
old, new = (f"https://{h}.taildf9ce2.ts.net:8445/transcribe" for h in ("uni-1", "uni"))  # public-ok: the service's two names

# both names pass: the app signs for whichever it reached
for u in (old, new):
    h, _ = header(sk, u, body)
    assert server.verify_nip98(h, body) == pub, u
print("ok a request signed for either name passes")

# anything else is refused
h, _ = header(sk, "https://elsewhere.example.com:8445/transcribe", body)
refused(h, body, "different request")
h, _ = header(sk, new, body, method="GET")
refused(h, body, "different request")
h, _ = header(sk, new, body)
refused(h, b"other audio", "payload hash mismatch")
h, _ = header(sk, new, body, at=time.time() - 600)
refused(h, body, "stale")
again = b"made-up audio, sent twice"
h, _ = header(sk, new, again)
server.verify_nip98(h, again)
refused(h, again, "replayed")
stranger = PrivateKey(secrets.token_bytes(32))
h, _ = header(stranger, new, body)
refused(h, body, "pubkey not allowed")
print("ok another URL or method, a changed body, an old or replayed signature and a stranger's key are refused")
print("2 checks passed")
