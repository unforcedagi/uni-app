#!/usr/bin/env python3
"""T-204: a stand-in Parachute hub for the real-build runs. Answers the MCP `query-notes` call the app's
vault_note makes (POST /mcp, JSON-RPC tools/call) with a note from scripts/fixtures/t204-notes.json, so the
note reaches the UI through the real Rust client. The NIP-98 header is logged as present, not checked.
usage: hub.py <port> <fixture.json> <log>"""
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

port, fixture, log = int(sys.argv[1]), sys.argv[2], open(sys.argv[3], "a", buffering=1)
NOTES = {n["id"]: n for n in json.load(open(fixture, encoding="utf-8"))["notes"]}


class Hub(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get("content-length", 0))) or b"{}")
        args = body.get("params", {}).get("arguments", {})
        tool = body.get("params", {}).get("name")
        log.write(json.dumps({"tool": tool, "args": args, "auth": bool(self.headers.get("authorization"))}) + "\n")
        n = NOTES.get(args.get("id")) if tool == "query-notes" else None
        if n:
            note = {k: n[k] for k in ("id", "path", "content", "createdAt", "updatedAt")} | {"tags": [], "links": []}
            result = {"content": [{"type": "text", "text": json.dumps([note])}]}
        else:
            result = {"content": [{"type": "text", "text": json.dumps([{"error": "not found", "error_type": "not_found"}])}]}
        out = json.dumps({"jsonrpc": "2.0", "id": body.get("id", 1), "result": result}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)


ThreadingHTTPServer(("127.0.0.1", port), Hub).serve_forever()
