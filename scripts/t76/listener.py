#!/usr/bin/env python3
"""T-76: a loopback HTTP listener that logs every request line, to see whether a navigation the host CSP should stop reached the network."""
import sys, http.server, time
log = open(sys.argv[2], 'a', buffering=1)
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        log.write(f"{time.time():.1f} GET {self.path}\n"); self.send_response(200); self.send_header('Content-Type', 'text/html'); self.end_headers(); self.wfile.write(b'<p>reached</p>')
    do_POST = do_GET
    def log_message(self, *a): pass
http.server.HTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
