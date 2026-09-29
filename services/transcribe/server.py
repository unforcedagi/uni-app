#!/usr/bin/env python3
"""Voice-message transcription for the Uni app (faster-whisper on uni-1).

POST /transcribe  body = raw audio (webm/opus, mp4/aac, ogg, wav...)
Authorization: Nostr <base64 NIP-98 event>, signed by an allowlisted pubkey.
The event must be kind 27235 with u = the public URL, method = POST and
payload = sha256(body), created within the last 120 seconds.
Response: {"text", "language", "duration", "seconds"}.

Listens on 127.0.0.1 only; Tailscale Serve exposes it tailnet-only.
Config: ~/.config/uni/transcribe-allow (one hex pubkey per line, # comments).
"""
import base64
import hashlib
import json
import os
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from coincurve import PublicKeyXOnly
from faster_whisper import WhisperModel

PORT = int(os.environ.get("UNI_TRANSCRIBE_PORT", "1950"))
PUBLIC_URL = os.environ.get("UNI_TRANSCRIBE_URL", "https://uni-1.taildf9ce2.ts.net:8445/transcribe")
MODEL = os.environ.get("UNI_WHISPER_MODEL", "small")
MAX_BYTES = 25 * 1024 * 1024
ALLOW_FILE = Path.home() / ".config/uni/transcribe-allow"
SEEN: dict[str, float] = {}
SEEN_LOCK = threading.Lock()
MODEL_LOCK = threading.Lock()
model = WhisperModel(MODEL, device="cpu", compute_type="int8", cpu_threads=4)


def allowed() -> set[str]:
    if not ALLOW_FILE.exists():
        return set()
    lines = (l.split("#")[0].strip().lower() for l in ALLOW_FILE.read_text().splitlines())
    return {l for l in lines if len(l) == 64}


def verify_nip98(header: str, body: bytes) -> str:
    """Return the signer's pubkey or raise ValueError."""
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
    if tags.get("u") != PUBLIC_URL or tags.get("method", "").upper() != "POST":
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


class Handler(BaseHTTPRequestHandler):
    def reply(self, code: int, payload: dict) -> None:
        data = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == "/health":
            self.reply(200, {"ok": True, "model": MODEL})
        else:
            self.reply(404, {"error": "not found"})

    def do_POST(self):
        if self.path != "/transcribe":
            return self.reply(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 < length <= MAX_BYTES:
            return self.reply(413, {"error": "audio is empty or larger than 25 MB"})
        body = self.rfile.read(length)
        try:
            who = verify_nip98(self.headers.get("Authorization", ""), body)
        except (ValueError, KeyError, TypeError, json.JSONDecodeError) as e:
            return self.reply(401, {"error": f"unauthorized: {e}"})
        started = time.time()
        with tempfile.NamedTemporaryFile(suffix=".audio") as f:
            f.write(body)
            f.flush()
            try:
                with MODEL_LOCK:
                    segments, info = model.transcribe(f.name, beam_size=1, vad_filter=True)
                    text = " ".join(s.text.strip() for s in segments).strip()
            except Exception as e:  # undecodable audio
                return self.reply(422, {"error": f"could not transcribe: {e}"})
        took = round(time.time() - started, 2)
        print(f"{who[:8]} {len(body)}B {info.duration:.1f}s audio in {took}s ({info.language})", flush=True)
        self.reply(200, {"text": text, "language": info.language, "duration": round(info.duration, 2), "seconds": took})

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    print(f"uni-transcribe: model={MODEL} on 127.0.0.1:{PORT}, public {PUBLIC_URL}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
