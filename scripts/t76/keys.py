#!/usr/bin/env python3
"""T-76: types real keys into the nested cage compositor on request. The in-page driver writes keys.req
({"id": n, "steps": [{"type": "text"} | {"key": "Tab"}]}); this runs wtype for each step and writes keys.ack = id."""
import json, os, subprocess, sys, time
out, display = sys.argv[1], sys.argv[2]
env = dict(os.environ, WAYLAND_DISPLAY=display)
done = None
while True:
    try:
        req = json.load(open(f"{out}/keys.req"))
    except Exception:
        req = None
    if req and req["id"] != done:
        for st in req["steps"]:
            cmd = ["wtype", "-d", "30", st["type"]] if "type" in st else ["wtype", "-k", st["key"]]
            r = subprocess.run(cmd, env=env, capture_output=True, text=True)
            if r.returncode: open(f"{out}/keys.err", "a").write(f"{cmd}: {r.stderr}\n")
            time.sleep(0.15)
        done = req["id"]
        open(f"{out}/keys.ack", "w").write(str(done))
    time.sleep(0.1)
