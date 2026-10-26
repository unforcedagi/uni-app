#!/usr/bin/env python3
"""T-302: one read of the real vault for the live projects run, read-only (GET only), written OUTSIDE the repo.

    UNI_VAULT_CLIENT=<dir with uni_vault.py> python3 -I scripts/browser/projectsLive.py <out.json>
    PROJECTS_LIVE=<out.json> npx playwright test --config playwright.projects.config.ts

The vault client (its base URL and token) is the operator's own; this script never reads or prints a token. The output holds real
notes: keep it in a scratch folder, never in the repo (check-public refuses it anyway).
"""
import json
import os
import sys

out = sys.argv[1]
if os.path.abspath(out).startswith(os.path.abspath(os.path.dirname(__file__) + "/../..")):
    sys.exit("write the live read outside the repo")
sys.path.insert(0, os.environ["UNI_VAULT_CLIENT"])
from uni_vault import Vault  # noqa: E402

v = Vault()
keep = ("id", "path", "tags", "metadata", "createdAt", "updatedAt")
rows = lambda tag: [{k: n.get(k) for k in keep} for n in v.get_all("notes", tag=tag, include_content="false")]
nodes = rows("node")
usage = v.note("System/Claude accounts")
rooms = [{"id": n["metadata"]["channel"], "name": str(n["metadata"].get("room") or n["path"].split("/")[-1]).split(",")[0].strip()}
         for n in nodes if "area" in n["tags"] and (n.get("metadata") or {}).get("channel")]
data = {"nodes": nodes, "runs": rows("run"), "tasks": rows("task"), "usage": usage and {k: usage.get(k) for k in keep},
        "rooms": [{"id": "uni-room", "name": "uni"}] + rooms}
with open(out, "w") as f:
    json.dump(data, f)
print(f"{len(nodes)} nodes, {len(data['runs'])} runs, {len(data['tasks'])} tasks, {len(rooms)} area rooms, usage {'yes' if usage else 'no'}")
