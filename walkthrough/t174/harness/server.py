# T-174 stand-in for the relay's Blossom media route: GET /media/<sha>.<ext> needs
# `Authorization: Nostr <base64url kind-24242 t=get event>` for this server; serves the files in <dir> by hash.
import base64, hashlib, json, os, sys, time
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
port, data, log = int(sys.argv[1]), sys.argv[2], sys.argv[3]
files = {}
for n in os.listdir(data):
    p = os.path.join(data, n)
    with open(p, "rb") as f: files[hashlib.sha256(f.read()).hexdigest()] = p
def note(**k):
    with open(log, "a") as f: f.write(json.dumps({"t": round(time.time(), 3), **k}) + "\n")
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def do_GET(self):
        auth = self.headers.get("Authorization", "")
        ok = False
        try:
            ev = json.loads(base64.urlsafe_b64decode(auth.split(" ", 1)[1] + "=="))
            tags = {t[0]: t[1] for t in ev["tags"]}
            ok = auth.startswith("Nostr ") and ev["kind"] == 24242 and tags.get("t") == "get" and tags.get("server") == f"127.0.0.1:{port}"
        except Exception: pass
        sha = self.path.rsplit("/", 1)[-1].split(".")[0]
        note(path=self.path, auth_ok=ok, known=sha in files)
        if not ok or sha not in files:
            self.send_response(401 if not ok else 404); self.send_header("Content-Length", "0"); self.end_headers(); return
        size = os.path.getsize(files[sha])
        self.send_response(200); self.send_header("Content-Length", str(size)); self.end_headers()
        with open(files[sha], "rb") as f:
            while chunk := f.read(256 * 1024):
                try: self.wfile.write(chunk)
                except BrokenPipeError: break
                time.sleep(0.01)  # ~25 MB/s, so "Saving…" is visible on the big file
ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()
