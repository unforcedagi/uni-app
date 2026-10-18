# T-172 stand-in for the relay's Blossom media route: GET /media/<sha>.<ext> needs
# `Authorization: Nostr <base64url kind-24242 t=get event>`; logs each request.
import base64, json, os, sys, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
port, clip, log = int(sys.argv[1]), sys.argv[2], sys.argv[3]
sha = sys.argv[4]
BIG = "e" * 64  # claims 600 MB, to show the cap's error
def note(**k):
    with open(log, "a") as f: f.write(json.dumps({"t": round(time.time(), 3), **k}) + "\n")
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        if self.path in ("/plain/clip.mp4", "/capped/clip.mp4"):  # control: no auth, honest Range support
            size = os.path.getsize(clip); r = self.headers.get("Range"); note(path=self.path, range=r)
            a, b = 0, size - 1
            if r and r.startswith("bytes="):
                x, _, y = r[6:].split(",")[0].partition("-")
                if x: a = int(x); b = min(int(y), size - 1) if y else size - 1
                else: a = size - int(y)
                if self.path.startswith("/capped"): b = min(b, a + 1024 * 1024 - 1)
                self.send_response(206); self.send_header("Content-Range", f"bytes {a}-{b}/{size}")
            else: self.send_response(200)
            self.send_header("Content-Type", "video/mp4"); self.send_header("Accept-Ranges", "bytes"); self.send_header("Content-Length", str(b - a + 1)); self.end_headers()
            with open(clip, "rb") as f:
                f.seek(a); left = b - a + 1
                while left > 0 and (chunk := f.read(min(left, 256 * 1024))):
                    try: self.wfile.write(chunk)
                    except (BrokenPipeError, ConnectionResetError): break
                    left -= len(chunk)
            return
        auth = self.headers.get("Authorization", "")
        ok = False
        try:
            ev = json.loads(base64.urlsafe_b64decode(auth.split(" ", 1)[1] + "=="))
            tags = {t[0]: t[1] for t in ev["tags"]}
            ok = auth.startswith("Nostr ") and ev["kind"] == 24242 and tags.get("t") == "get" and tags.get("server") == f"127.0.0.1:{port}"
        except Exception: pass
        note(path=self.path, auth_ok=ok, range=self.headers.get("Range"), ua=self.headers.get("User-Agent"))
        if not ok:
            self.send_response(401); self.send_header("Content-Length", "0"); self.end_headers(); return
        if self.path.startswith(f"/media/{BIG}"):
            self.send_response(200); self.send_header("Content-Type", "video/mp4"); self.send_header("Content-Length", str(600 * 1024 * 1024)); self.end_headers(); return
        if not self.path.startswith(f"/media/{sha}"):
            self.send_response(404); self.send_header("Content-Length", "0"); self.end_headers(); return
        size = os.path.getsize(clip)
        self.send_response(200); self.send_header("Content-Type", "video/mp4"); self.send_header("Content-Length", str(size)); self.end_headers()
        sent = 0
        with open(clip, "rb") as f:
            while chunk := f.read(256 * 1024):
                try: self.wfile.write(chunk)
                except BrokenPipeError: break
                sent += len(chunk)
                time.sleep(0.01)  # ~25 MB/s, so the download state is visible
        note(path=self.path, sent=sent)
ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
