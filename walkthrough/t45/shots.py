#!/usr/bin/env python3
"""T-45 walk watcher (T-124's shots.py, frames off): serves the in-page driver's screenshot requests
(shot.req -> <label>.png, shot.ack) with grim on the cage display. usage: shots.py <out dir> <wayland socket>"""
import json, os, subprocess, sys, time
out, display = sys.argv[1], sys.argv[2]
env = dict(os.environ, WAYLAND_DISPLAY=display)
done = None
while not os.path.exists(f"{out}/done") and not os.path.exists(f"{out}/error.txt"):
    try:
        req = json.load(open(f"{out}/shot.req"))
    except Exception:
        req = None
    if req and req["id"] != done:
        subprocess.run(["grim", f"{out}/{req['label']}.png"], env=env, capture_output=True)
        done = req["id"]
        open(f"{out}/shot.ack", "w").write(str(done))
    time.sleep(0.05)
